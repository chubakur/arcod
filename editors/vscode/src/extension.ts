import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { completionsFor, mapDiagnostics, symbolsFromText, type CompletionKind, type RawDiagnostic, type SymbolSpec } from './model';

let collection: vscode.DiagnosticCollection;
let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function activate(context: vscode.ExtensionContext): void {
  collection = vscode.languages.createDiagnosticCollection('arcod');
  output = vscode.window.createOutputChannel('Arcod');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  status.command = 'arcod.check';
  status.show();
  setStatus(0, 0);

  context.subscriptions.push(collection, output, status);

  context.subscriptions.push(
    vscode.commands.registerCommand('arcod.check', () => {
      const doc = activeDocument();
      if (doc) void checkDocument(doc, true);
    }),
    vscode.commands.registerCommand('arcod.restart', () => {
      collection.clear();
      const doc = activeDocument();
      if (doc) void checkDocument(doc, true);
    }),
    vscode.commands.registerCommand('arcod.plan', () => runInTerminal(['plan'])),
    vscode.commands.registerCommand('arcod.build', () => runInTerminal(['build', '--impl'])),
    vscode.commands.registerCommand('arcod.make', () => runInTerminal(['make'])),
    vscode.commands.registerCommand('arcod.deploy', () => runInTerminal(['deploy'])),
    vscode.commands.registerCommand('arcod.providers', () => runInTerminal(['providers'])),
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.languageId === 'arcod') void checkDocument(doc);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== 'arcod') return;
      if (vscode.workspace.getConfiguration('arcod').get<boolean>('checkOnSave', true)) void checkDocument(doc);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId !== 'arcod') return;
      if (!vscode.workspace.getConfiguration('arcod').get<boolean>('checkOnType', false)) return;
      const id = event.document.uri.toString();
      const previous = timers.get(id);
      if (previous) clearTimeout(previous);
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        if (!event.document.isDirty) return;
        void checkDocument(event.document);
      }, 700));
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri)),
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider('arcod', {
      provideCompletionItems(document, position) {
        const line = document.lineAt(position.line).text.slice(0, position.character);
        const word = document.getWordRangeAtPosition(position);
        const prefix = word ? document.getText(word).replace(/^[.]+/, '') : '';
        const symbols = symbolsFromText(document.getText());
        const items = completionsFor(line, prefix, symbols).map((spec) => toCompletionItem(spec));
        return items;
      },
    }, '.', ':', '>'),
  );

  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider('arcod', {
      provideDocumentSymbols(document) {
        return symbolsFromText(document.getText()).map((symbol) =>
          new vscode.SymbolInformation(
            symbol.name,
            symbolKind(symbol.kind),
            symbol.container ?? '',
            new vscode.Location(document.uri, new vscode.Position(symbol.line, 0)),
          ));
      },
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('arcod')) return;
      const doc = activeDocument();
      if (doc) void checkDocument(doc);
    }),
  );

  const doc = activeDocument();
  if (doc) void checkDocument(doc);
}

export function deactivate(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
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

function checkDocument(document: vscode.TextDocument, verbose = false): Promise<void> {
  return new Promise((resolve) => {
    const tool = resolveTool(document);
    const cwd = path.dirname(document.uri.fsPath);
    const args = [...tool.prefix, 'check', path.basename(document.uri.fsPath), '--json'];

    execFile(tool.command, args, { cwd, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        setStatus(0, 0, true);
        output.appendLine('arcod не найден: ' + tool.command);
        void vscode.window.showWarningMessage(
          'Arcod: CLI не найден. Укажите путь в настройке arcod.path или установите arcod в PATH.',
          'Открыть настройки',
        ).then((choice) => {
          if (choice) void vscode.commands.executeCommand('workbench.action.openSettings', 'arcod.path');
        });
        resolve();
        return;
      }

      const parsed = parseJson(stdout) as RawDiagnostic[] | null;
      if (parsed) {
        applyDiagnostics(document, parsed);
        collectSummary(document, parsed, verbose);
      } else {
        const single = parseStderr(stderr);
        if (single) {
          applyDiagnostics(document, [single]);
          output.appendLine('parse: ' + single.message);
          setStatus(1, 0);
        } else {
          collection.delete(document.uri);
          setStatus(0, 0);
          if (stderr.trim()) output.appendLine(stderr.trim());
        }
      }
      resolve();
    });
  });
}

function parseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

// A parse error arrives on stderr as "main.arc:12:5  error  parse  message".
function parseStderr(stderr: string): RawDiagnostic | null {
  const match = /^(.*?):(\d+):(\d+)\s+error\s+(\w+)\s+(.*)$/m.exec(stderr);
  if (!match) return null;
  const line = Number(match[2]);
  const col = Number(match[3]);
  return {
    code: match[4],
    severity: 'error',
    message: match[5],
    file: match[1],
    range: { line, col, endLine: line, endCol: col + 1 },
  };
}

function applyDiagnostics(document: vscode.TextDocument, raw: RawDiagnostic[]): void {
  const lines: string[] = [];
  for (let index = 0; index < document.lineCount; index++) lines.push(document.lineAt(index).text);
  const diagnostics = mapDiagnostics(raw, lines).map((item) => {
    const range = new vscode.Range(item.line, item.col, item.endLine, item.endCol);
    const severity = item.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
    const diagnostic = new vscode.Diagnostic(range, item.message, severity);
    diagnostic.code = item.code;
    diagnostic.source = 'arcod';
    return diagnostic;
  });
  collection.set(document.uri, diagnostics);
}

function collectSummary(document: vscode.TextDocument, raw: RawDiagnostic[], verbose: boolean): void {
  const errors = raw.filter((item) => item.severity === 'error').length;
  const warnings = raw.length - errors;
  setStatus(errors, warnings);
  output.appendLine(path.basename(document.uri.fsPath) + ': ' + errors + ' error(s), ' + warnings + ' warning(s)');
  if (verbose) {
    if (raw.length === 0) {
      output.appendLine('модель чистая');
    } else {
      for (const item of raw) {
        output.appendLine('  ' + item.range.line + ':' + item.range.col + '  ' + item.severity + '  ' + item.code + '  ' + item.message);
      }
    }
    output.show(true);
  }
}

function setStatus(errors: number, warnings: number, missing = false): void {
  if (missing) {
    status.text = '$(warning) Arcod';
    status.tooltip = 'CLI arcod не найден';
    return;
  }
  if (errors > 0) {
    status.text = '$(error) Arcod: ' + errors;
    status.tooltip = 'Arcod: ' + errors + ' ошибок, ' + warnings + ' предупреждений';
  } else if (warnings > 0) {
    status.text = '$(warning) Arcod: ' + warnings;
    status.tooltip = 'Arcod: ' + warnings + ' предупреждений';
  } else {
    status.text = '$(check) Arcod';
    status.tooltip = 'Arcod: ошибок нет';
  }
}

const COMPLETION_KIND: Record<CompletionKind, vscode.CompletionItemKind> = {
  keyword: vscode.CompletionItemKind.Keyword,
  type: vscode.CompletionItemKind.TypeParameter,
  error: vscode.CompletionItemKind.Class,
  service: vscode.CompletionItemKind.Class,
  operation: vscode.CompletionItemKind.Function,
  value: vscode.CompletionItemKind.Value,
  property: vscode.CompletionItemKind.Property,
};

function toCompletionItem(spec: { label: string; kind: CompletionKind; detail?: string; sortText?: string }): vscode.CompletionItem {
  const item = new vscode.CompletionItem(spec.label, COMPLETION_KIND[spec.kind]);
  item.detail = spec.detail;
  item.sortText = spec.sortText;
  return item;
}

function symbolKind(kind: SymbolSpec['kind']): vscode.SymbolKind {
  switch (kind) {
    case 'module': return vscode.SymbolKind.Module;
    case 'environment': return vscode.SymbolKind.Namespace;
    case 'ui': return vscode.SymbolKind.Interface;
    case 'type': return vscode.SymbolKind.TypeParameter;
    case 'enum': return vscode.SymbolKind.Enum;
    case 'error': return vscode.SymbolKind.Class;
    case 'operation':
    case 'step': return vscode.SymbolKind.Function;
    default: return vscode.SymbolKind.Class;
  }
}

function runInTerminal(args: string[]): void {
  const doc = activeDocument();
  if (!doc) {
    void vscode.window.showInformationMessage('Arcod: откройте .arc файл');
    return;
  }
  const tool = resolveTool(doc);
  const terminal = vscode.window.terminals.find((item) => item.name === 'Arcod')
    ?? vscode.window.createTerminal({ name: 'Arcod', cwd: path.dirname(doc.uri.fsPath) });
  terminal.show();
  const command = [tool.command, ...tool.prefix, ...args, path.basename(doc.uri.fsPath)]
    .map(quote)
    .join(' ');
  terminal.sendText(command);
}

function quote(value: string): string {
  return /[\s"]/.test(value) ? '"' + value.replace(/"/g, '\\"') + '"' : value;
}
