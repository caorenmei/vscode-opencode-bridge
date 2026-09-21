'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const LOCK_DIR = path.join(os.homedir(), '.opencode', 'ide');
const MAX_BODY_BYTES = 1024 * 1024;
const AUTH_TOKEN = crypto.randomUUID();

let server;
let lockFilePath;

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function relativePath(uri) {
  return toPosix(vscode.workspace.asRelativePath(uri, false));
}

function workspaceFolders() {
  return (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
}

function currentSelection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  const selection = editor.selection;
  return {
    file: relativePath(editor.document.uri),
    absolutePath: editor.document.uri.fsPath,
    startLine: selection.start.line + 1,
    endLine: selection.end.line + 1,
    isEmpty: selection.isEmpty,
    text: editor.document.getText(selection)
  };
}

function openEditors() {
  const active = vscode.window.activeTextEditor;
  const byPath = new Map();
  const add = (editor) => {
    const key = editor.document.uri.fsPath.toLowerCase();
    const isActive = editor === active;
    const existing = byPath.get(key);
    if (existing) {
      if (isActive) existing.isActive = true;
      return;
    }
    byPath.set(key, { file: relativePath(editor.document.uri), isActive });
  };
  vscode.window.visibleTextEditors.forEach(add);
  if (active) add(active);
  return Array.from(byPath.values());
}

function handleRpc(method) {
  switch (method) {
    case 'getCurrentSelection':
      return { status: 200, body: { result: currentSelection() } };
    case 'getOpenEditors':
      return { status: 200, body: { result: openEditors() } };
    case 'getWorkspaceFolders':
      return { status: 200, body: { result: workspaceFolders() } };
    default:
      return { status: 404, body: { error: `Unknown method: ${method}` } };
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function onRequest(req, res) {
  if (req.method !== 'POST' || req.url !== '/rpc') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  if ((req.headers.authorization || '') !== `Bearer ${AUTH_TOKEN}`) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }
  let message;
  try {
    message = JSON.parse(await readBody(req));
  } catch (err) {
    sendJson(res, 400, { error: `Bad request: ${err.message}` });
    return;
  }
  if (!message || typeof message.method !== 'string') {
    sendJson(res, 400, { error: 'Bad request: missing method' });
    return;
  }
  const outcome = handleRpc(message.method);
  sendJson(res, outcome.status, outcome.body);
}

function writeLockFile(port) {
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    lockFilePath = path.join(LOCK_DIR, `${process.pid}.json`);
    const payload = {
      pid: process.pid,
      port,
      authToken: AUTH_TOKEN,
      workspaceFolders: workspaceFolders(),
      ideName: 'VS Code',
      startedAt: Date.now()
    };
    fs.writeFileSync(lockFilePath, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    lockFilePath = undefined;
    console.error('[opencode-bridge] failed to write lock file:', err);
  }
}

function removeLockFile() {
  if (!lockFilePath) return;
  try {
    fs.unlinkSync(lockFilePath);
  } catch (err) {
    // Already gone (or never written) - nothing to clean up.
  }
  lockFilePath = undefined;
}

function stopServer() {
  if (server) {
    const closing = server;
    server = undefined;
    try {
      closing.close();
    } catch (err) {
      // Server already stopped.
    }
  }
  removeLockFile();
}

function buildReference(editor) {
  const file = relativePath(editor.document.uri);
  const selection = editor.selection;
  if (selection.isEmpty) return `@${file}`;
  const start = selection.start.line + 1;
  const end = selection.end.line + 1;
  if (start === end) return `@${file}#L${start}`;
  return `@${file}#L${start}-${end}`;
}

function insertFileReference() {
  const editor = vscode.window.activeTextEditor;
  const usable = editor && editor.document.uri.scheme === 'file'
    && vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!usable) {
    vscode.window.showWarningMessage('opencode-bridge: no active editor / file not in workspace');
    return;
  }
  const reference = buildReference(editor);
  const terminal = vscode.window.activeTerminal;
  if (terminal) {
    terminal.sendText(reference + ' ', false);
    terminal.show();
    return;
  }
  vscode.env.clipboard.writeText(reference + ' ').then(() => {
    vscode.window.showInformationMessage('opencode-bridge: copied to clipboard: ' + reference);
  });
}

function activate(context) {
  server = http.createServer((req, res) => {
    onRequest(req, res).catch((err) => {
      console.error('[opencode-bridge] request failed:', err);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: err.message });
    });
  });

  server.on('error', (err) => {
    console.error('[opencode-bridge] server error:', err);
  });

  context.subscriptions.push({
    dispose() {
      stopServer();
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('opencodeBridge.insertFileReference', insertFileReference)
  );

  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    writeLockFile(port);
    console.log(`[opencode-bridge] listening on 127.0.0.1:${port} (lock: ${lockFilePath})`);
  });
}

function deactivate() {
  stopServer();
}

module.exports = { activate, deactivate };
