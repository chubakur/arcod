const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function diagnosticsFor(uri, predicate, timeout = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const list = vscode.languages.getDiagnostics(uri);
    if (predicate(list)) return list;
    await sleep(300);
  }
  return vscode.languages.getDiagnostics(uri);
}

exports.run = async function run() {
  const extension = vscode.extensions.getExtension('chubakur.arcod');
  assert.ok(extension, 'extension is installed');
  await extension.activate();
  assert.ok(extension.isActive, 'extension activates');
  console.log('suite: activated ' + extension.id + '@' + extension.packageJSON.version);

  const languages = await vscode.languages.getLanguages();
  assert.ok(languages.includes('arcod'), 'the arcod language is registered');

  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  assert.ok(folder, 'a workspace folder is open');
  const repo = folder.uri.fsPath;
  const chat = path.join(repo, 'examples', 'chat', 'main.arc');
  const document = await vscode.workspace.openTextDocument(chat);
  assert.equal(document.languageId, 'arcod', 'the .arc file is recognised');
  await vscode.window.showTextDocument(document);

  const warnings = await diagnosticsFor(document.uri, (list) => list.length > 0);
  assert.ok(warnings.length > 0, 'check ran on open');
  assert.ok(warnings.every((item) => item.source === 'arcod'), 'diagnostics come from arcod');

  const text = document.getText();
  const lines = text.split(/\r?\n/);
  const opLine = lines.findIndex((line) => /^\s*public op history\b/.test(line));
  const usageLine = lines.findIndex((line) => /history:\s*Chat\.history/.test(line));
  assert.ok(opLine >= 0 && usageLine >= 0, 'the spec has a declaration and a usage');

  const usagePosition = new vscode.Position(usageLine, lines[usageLine].indexOf('history: Chat.history') + 'history: Chat.'.length + 1);
  const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, usagePosition);
  assert.ok(Array.isArray(definitions) && definitions.length > 0, 'Cmd+Click finds a definition');
  assert.equal(definitions[0].uri.toString(), document.uri.toString());
  assert.equal(definitions[0].range.start.line, opLine, 'the definition is the operation declaration');

  const references = await vscode.commands.executeCommand('vscode.executeReferenceProvider', document.uri, usagePosition);
  assert.ok(Array.isArray(references) && references.length >= 2, 'references include declaration and usage');

  const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, usagePosition);
  assert.ok(Array.isArray(hovers) && hovers.length > 0, 'hover describes the symbol');
  console.log('suite: navigation ok, history -> line ' + opLine);

  const temporary = path.join(repo, '.tmp-extension-test.arc');
  fs.writeFileSync(temporary, [
    'module broken @0.1.0 {',
    '  meta {',
    '    owner: "@andrey"',
    '    status: draft',
    '  }',
    '}',
    '',
    'use capability arcod.std.kv @1',
    '',
    'service Broken : http {',
    '  uses store: kv(ttl: 999s)',
    '',
    '  contract {',
    '    public op ping() -> string {',
    '      route: "GET /v1/ping"',
    '      effects: store.scan',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n'), 'utf8');

  try {
    const broken = await vscode.workspace.openTextDocument(temporary);
    await vscode.window.showTextDocument(broken);
    const errors = await diagnosticsFor(broken.uri, (list) => list.some((item) => item.code === 'A002'));
    assert.ok(errors.some((item) => item.code === 'A002' && item.severity === vscode.DiagnosticSeverity.Error), 'A002 is reported');
    assert.ok(errors.some((item) => item.code === 'A002' && item.range.start.line === 10), 'the error points at the capability use');
    console.log('suite: diagnostics ok, A002 at line 10');
  } finally {
    fs.rmSync(temporary, { force: true });
  }
};
