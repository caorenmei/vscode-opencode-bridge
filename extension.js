'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const LOCK_DIR = path.join(os.homedir(), '.opencode', 'ide');
const TUI_LOCK_PREFIX = 'tui-';
const TUI_APPEND_TIMEOUT_MS = 2000;
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

function normalizeDir(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  let normalized = toPosix(value).toLowerCase();
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

function isAlivePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by someone else.
    return !!err && err.code === 'EPERM';
  }
}

function listTuiInstances() {
  let names;
  try {
    names = fs.readdirSync(LOCK_DIR);
  } catch (err) {
    return [];
  }
  const instances = [];
  for (const name of names) {
    if (!name.startsWith(TUI_LOCK_PREFIX) || !name.endsWith('.json')) continue;
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(path.join(LOCK_DIR, name), 'utf8'));
    } catch (err) {
      continue;
    }
    if (!payload || !isAlivePid(payload.pid)) continue;
    if (!Number.isInteger(payload.port) || payload.port <= 0) continue;
    instances.push(payload);
  }
  return instances;
}

function selectTuiInstance(instances, workspaceDir) {
  const target = normalizeDir(workspaceDir);
  const matches = target
    ? instances.filter((instance) => {
      const dir = normalizeDir(instance.directory);
      if (!dir) return false;
      return dir === target || dir.startsWith(target + '/') || target.startsWith(dir + '/');
    })
    : [];
  const pool = matches.length > 0 ? matches : instances;
  let best;
  for (const instance of pool) {
    if (!best || (instance.startedAt || 0) > (best.startedAt || 0)) best = instance;
  }
  return best;
}

async function postToTui(port, text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TUI_APPEND_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal
    });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => null);
    return !!payload && payload.ok === true;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function sendToTuiGateways(text, editor) {
  const instances = listTuiInstances();
  if (instances.length === 0) return false;
  const workspaceDir = editor ? editor.document.uri.fsPath : undefined;
  const ordered = [];
  let remaining = instances.slice();
  while (remaining.length > 0) {
    const picked = selectTuiInstance(remaining, workspaceDir);
    if (!picked) break;
    ordered.push(picked);
    remaining = remaining.filter((instance) => instance !== picked);
  }
  for (const instance of ordered) {
    if (await postToTui(instance.port, text)) return true;
  }
  return false;
}

async function insertFileReference() {
  const editor = vscode.window.activeTextEditor;
  const usable = editor && editor.document.uri.scheme === 'file'
    && vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!usable) {
    vscode.window.showWarningMessage('opencode-bridge: no active editor / file not in workspace');
    return;
  }
  const reference = buildReference(editor);
  const text = reference + ' ';

  if (await sendToTuiGateways(text, editor)) {
    vscode.window.showInformationMessage('opencode-bridge: sent to opencode TUI');
    return;
  }

  const terminal = vscode.window.activeTerminal;
  if (terminal) {
    terminal.sendText(text, false);
    terminal.show();
    return;
  }
  vscode.env.clipboard.writeText(text).then(() => {
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
