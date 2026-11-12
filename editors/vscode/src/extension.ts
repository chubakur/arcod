import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { LspClient } from './lsp-client';

let client: LspClient;
let collection: vscode.DiagnosticCollection;
let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;

// ------------------------------------------------------------ LSP → VS Code --

function toPosition(pos: { line: number; character: number }): vscode.Position {
  return new vscode.Position(pos.line, pos.character);
}

function toRange(range: { start: { line: number; character: number }; end: { line: number; character: number } }): vscode.Range {
  return new vscode.Range(toPosition(range.start), toPosition(range.end));
}

const SEVERITY: Record<number, vscode.DiagnosticSeverity> = {
  1: vscode.DiagnosticSeverity.Error,
  2: vscode.DiagnosticSeverity.Warning,
  3: vscode.DiagnosticSeverity.Information,
  4: vscode.DiagnosticSeverity.Hint,
};

function toDiagnostic(item: any): vscode.Diagnostic {
  const d = new vscode.Diagnostic(
    toRange(item.range),
    item.message,
    SEVERITY[item.severity] ?? vscode.DiagnosticSeverity.Error,
  );
  d.code = item.code;
  d.source = item.source ?? 'arcod';
  return d;
}

function toCompletionItem(item: any): vscode.CompletionItem {
  const ci = new vscode.CompletionItem(item.label, (item.kind ?? 1) as vscode.CompletionItemKind);
  if (item.detail) ci.detail = item.detail;
  if (item.insertText) ci.insertText = item.insertText;
  if (item.sortText) ci.sortText = item.sortText;
  return ci;
}

function toDocumentSymbol(item: any): vscode.DocumentSymbol {
  const symbol = new vscode.DocumentSymbol(
    item.name,
    item.detail ?? '',
    (item.kind ?? 0) as vscode.SymbolKind,
    toRange(item.range),
    toRange(item.selectionRange),
  );
  if (Array.isArray(item.children)) symbol.children = item.children.map(toDocumentSymbol);
  return symbol;
}

function toLocation(item: any): vscode.Location {
  return new vscode.Location(vscode.Uri.parse(item.uri), toRange(item.range));
}

// ---------------------------------------------------------------- lifecycle --

export function activate(context: vscode.ExtensionContext): void {
  collection = vscode.languages.createDiagnosticCollection('arcod');
  output = vscode.window.createOutputChannel('Arcod');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  status.command = 'arcod.check';
  status.show();
  setStatus(0, 0);

  client = new LspClient();
  client.onNotification('textDocument/publishDiagnostics', (params: any) => {
    const uri = vscode.Uri.parse(params.uri);
    const diags = (params.diagnostics ?? []).map(toDiagnostic);
    collection.set(uri, diags);
    updateStatus();
  });
  client.onExit((code) => {
    output.appendLine('arcod lsp exited with code ' + code);
  });

  const tool = resolveLsp();
  client.start(tool.command, tool.args);
  client.request('initialize', {
    processId: process.pid,
    rootUri: workspaceUri(),
    capabilities: {},
  }).then((result: any) => {
    client.notify('initialized', {});
    output.appendLine('arcod lsp ready: ' + JSON.stringify(result?.serverInfo ?? {}));
  }).catch((error: Error) => {
    output.appendLine('arcod lsp failed to initialize: ' + error.message);
  });

  registerProviders(context);
  registerCommands(context);

  // Sync already-open documents, then follow open/change/close.
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.languageId === 'arcod') openDocument(doc);
  }
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.languageId === 'arcod') openDocument(doc);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId === 'arcod') changeDocument(event.document);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.languageId === 'arcod') closeDocument(doc);
    }),
    vscode.workspace.onDidChangeConfiguration(() => updateStatus()),
  );

  context.subscriptions.push({ dispose: () => client.dispose() });
}

export function deactivate(): void {
  client?.dispose();
}

// -------------------------------------------------------------- documents ---

function openDocument(doc: vscode.TextDocument): void {
  client.notify('textDocument/didOpen', {
    textDocument: { uri: doc.uri.toString(), languageId: 'arcod', version: doc.version, text: doc.getText() },
  });
}

function changeDocument(doc: vscode.TextDocument): void {
  client.notify('textDocument/didChange', {
    textDocument: { uri: doc.uri.toString(), version: doc.version },
    contentChanges: [{ text: doc.getText() }],
  });
}

function closeDocument(doc: vscode.TextDocument): void {
  client.notify('textDocument/didClose', { textDocument: { uri: doc.uri.toString() } });
  collection.delete(doc.uri);
  updateStatus();
}

function updateStatus(): void {
  let errors = 0;
  let warnings = 0;
  for (const [, diags] of collection) {
    for (const d of diags) {
      if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
      else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
    }
  }
  setStatus(errors, warnings);
}

function setStatus(errors: number, warnings: number): void {
  status.text = '$(check) Arcod ' + (errors > 0 ? errors + ' err, ' : '') + warnings + ' warn';
  status.tooltip = errors + ' error(s), ' + warnings + ' warning(s)';
  status.color = errors > 0 ? new vscode.ThemeColor('statusBarItem.errorForeground') : undefined;
}

// -------------------------------------------------------------- providers ---

function registerProviders(context: vscode.ExtensionContext): void {
  const selector = { language: 'arcod', scheme: 'file' };

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(selector, {
      provideCompletionItems: async (doc, position) => {
        const result = await client.request<any[]>('textDocument/completion', {
          textDocument: { uri: doc.uri.toString() },
          position,
        }).catch(() => []);
        return result.map(toCompletionItem);
      },
    }, ':', '.', '@'),

    vscode.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols: async (doc) => {
        const result = await client.request<any[]>('textDocument/documentSymbol', {
          textDocument: { uri: doc.uri.toString() },
        }).catch(() => []);
        return result.map(toDocumentSymbol);
      },
    }),

    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition: async (doc, position) => {
        const result = await client.request<any[]>('textDocument/definition', {
          textDocument: { uri: doc.uri.toString() },
          position,
        }).catch(() => []);
        return result.map(toLocation);
      },
    }),

    vscode.languages.registerReferenceProvider(selector, {
      provideReferences: async (doc, position) => {
        const result = await client.request<any[]>('textDocument/references', {
          textDocument: { uri: doc.uri.toString() },
          position,
          context: { includeDeclaration: true },
        }).catch(() => []);
        return result.map(toLocation);
      },
    }),

    vscode.languages.registerHoverProvider(selector, {
      provideHover: async (doc, position) => {
        const result = await client.request<any>('textDocument/hover', {
          textDocument: { uri: doc.uri.toString() },
          position,
        }).catch(() => null);
        if (!result?.contents) return null;
        const value = result.contents.value;
        const contents = result.contents.kind === 'markdown' ? new vscode.MarkdownString(value) : value;
        return new vscode.Hover(contents, result.range ? toRange(result.range) : undefined);
      },
    }),

    vscode.languages.registerDocumentFormattingEditProvider(selector, {
      provideDocumentFormattingEdits: async (doc) => {
        const result = await client.request<any[]>('textDocument/formatting', {
          textDocument: { uri: doc.uri.toString() },
          options: { tabSize: 2, insertSpaces: true },
        }).catch(() => []);
        return result.map((edit) => vscode.TextEdit.replace(toRange(edit.range), edit.newText));
      },
    }),
  );
}

// --------------------------------------------------------------- commands ---

function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('arcod.check', () => runInTerminal(['check'])),
    vscode.commands.registerCommand('arcod.plan', () => runInTerminal(['plan'])),
    vscode.commands.registerCommand('arcod.build', () => runInTerminal(['build', '--impl'])),
    vscode.commands.registerCommand('arcod.make', () => runInTerminal(['make'])),
    vscode.commands.registerCommand('arcod.deploy', () => runInTerminal(['deploy'])),
    vscode.commands.registerCommand('arcod.providers', () => runInTerminal(['providers'])),
  );
}

// ------------------------------------------------------------------ tooling ---

function workspaceUri(): string | null {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? folder.uri.toString() : null;
}

function resolveLsp(): { command: string; args: string[] } {
  const configured = (vscode.workspace.getConfiguration('arcod').get<string>('path') ?? '').trim();
  if (configured && configured !== 'arcod') return { command: configured, args: ['lsp'] };

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const script = path.join(folder.uri.fsPath, 'bin', 'arcod.mjs');
    if (existsSync(script)) return { command: process.platform === 'win32' ? 'node.exe' : 'node', args: [script, 'lsp'] };
  }
  return { command: 'arcod', args: ['lsp'] };
}

function activeDocument(): vscode.TextDocument | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === 'arcod') return editor.document;
  return vscode.workspace.textDocuments.find((doc) => doc.languageId === 'arcod');
}

interface Tool {
  command: string;
  prefix: string[];
}

function resolveTool(document: vscode.TextDocument): Tool {
  const configured = (vscode.workspace.getConfiguration('arcod').get<string>('path') ?? '').trim();
  if (configured && configured !== 'arcod') return { command: configured, prefix: [] };

  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (folder) {
    const script = path.join(folder.uri.fsPath, 'bin', 'arcod.mjs');
    if (existsSync(script)) return { command: process.platform === 'win32' ? 'node.exe' : 'node', prefix: [script] };
  }
  return { command: 'arcod', prefix: [] };
}

function runInTerminal(args: string[]): void {
  const doc = activeDocument();
  if (!doc) {
    vscode.window.showInformationMessage('Open a .arc specification first.');
    return;
  }
  const tool = resolveTool(doc);
  const terminal = vscode.window.createTerminal({ name: 'Arcod', cwd: path.dirname(doc.uri.fsPath) });
  terminal.show();
  const command = [tool.command, ...tool.prefix, ...args, path.basename(doc.uri.fsPath)]
    .map(quote)
    .join(' ');
  terminal.sendText(command);
}

function quote(value: string): string {
  return /[\s"]/.test(value) ? '"' + value.replace(/"/g, '\\"') + '"' : value;
}
