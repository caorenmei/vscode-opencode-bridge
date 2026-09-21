// VS Code extension entry point.
//
// Two jobs:
//   1. serve editor state over a loopback HTTP endpoint (consumed by mcp-shim.js),
//   2. implement the `opencodeBridge.insertFileReference` command (Ctrl+Alt+K).
//
// Compiled to `../extension.js` by `npm run build`; `package.json` "main" points
// at the compiled artifact because VS Code only loads JavaScript.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

const LOCK_DIR = path.join(os.homedir(), '.opencode', 'ide');
const TUI_LOCK_PREFIX = 'tui-';
const TUI_APPEND_TIMEOUT_MS = 2000;
const MAX_BODY_BYTES = 1024 * 1024;
const AUTH_TOKEN = crypto.randomUUID();

/** Instance lock file written by the opencode TUI plugin (`tui-<pid>.json`). */
interface TuiLockFile {
  pid: number;
  port: number;
  directory: string;
  startedAt: number;
}

/** Lock file written by this extension (`<pid>.json`), read by mcp-shim.js. */
interface BridgeLockFile {
  pid: number;
  port: number;
  authToken: string;
  workspaceFolders: string[];
  ideName: string;
  startedAt: number;
}

interface SelectionInfo {
  file: string;
  absolutePath: string;
  startLine: number;
  endLine: number;
  isEmpty: boolean;
  text: string;
}

interface OpenEditorInfo {
  file: string;
  isActive: boolean;
}

interface RpcResultBody<T> {
  result: T;
}

interface RpcErrorBody {
  error: string;
}

type RpcBody = RpcResultBody<unknown> | RpcErrorBody;

interface RpcOutcome {
  status: number;
  body: RpcBody;
}

let server: http.Server | undefined;
let lockFilePath: string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function relativePath(uri: vscode.Uri): string {
  return toPosix(vscode.workspace.asRelativePath(uri, false));
}

function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
}

function currentSelection(): SelectionInfo | null {
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

function openEditors(): OpenEditorInfo[] {
  const active = vscode.window.activeTextEditor;
  const byPath = new Map<string, OpenEditorInfo>();
  const add = (editor: vscode.TextEditor): void => {
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

function handleRpc(method: string): RpcOutcome {
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

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
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

async function onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'POST' || req.url !== '/rpc') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  if (req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }
  let message: unknown;
  try {
    message = JSON.parse(await readBody(req));
  } catch (err) {
    sendJson(res, 400, { error: `Bad request: ${errorMessage(err)}` });
    return;
  }
  if (!isRecord(message) || typeof message.method !== 'string') {
    sendJson(res, 400, { error: 'Bad request: missing method' });
    return;
  }
  const outcome = handleRpc(message.method);
  sendJson(res, outcome.status, outcome.body);
}

function writeLockFile(port: number): void {
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    lockFilePath = path.join(LOCK_DIR, `${process.pid}.json`);
    const payload: BridgeLockFile = {
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

function removeLockFile(): void {
  if (!lockFilePath) return;
  try {
    fs.unlinkSync(lockFilePath);
  } catch {
    // Already gone (or never written) - nothing to clean up.
  }
  lockFilePath = undefined;
}

function stopServer(): void {
  if (server) {
    const closing = server;
    server = undefined;
    try {
      closing.close();
    } catch {
      // Server already stopped.
    }
  }
  removeLockFile();
}

function buildReference(editor: vscode.TextEditor): string {
  const file = relativePath(editor.document.uri);
  const selection = editor.selection;
  if (selection.isEmpty) return `@${file}`;
  const start = selection.start.line + 1;
  const end = selection.end.line + 1;
  if (start === end) return `@${file}#L${start}`;
  return `@${file}#L${start}-${end}`;
}

function normalizePath(value: string): string {
  if (value.length === 0) return '';
  let normalized = toPosix(value).toLowerCase();
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

function isAlivePid(pid: unknown): pid is number {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by someone else.
    return isErrnoException(err) && err.code === 'EPERM';
  }
}

function parseTuiLock(text: string): TuiLockFile | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(payload)) return undefined;
  if (!isAlivePid(payload.pid)) return undefined;
  if (typeof payload.port !== 'number' || !Number.isInteger(payload.port) || payload.port <= 0) {
    return undefined;
  }
  return {
    pid: payload.pid,
    port: payload.port,
    directory: typeof payload.directory === 'string' ? payload.directory : '',
    startedAt: typeof payload.startedAt === 'number' ? payload.startedAt : 0
  };
}

function listTuiInstances(): TuiLockFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(LOCK_DIR);
  } catch {
    return [];
  }
  const instances: TuiLockFile[] = [];
  for (const name of names) {
    if (!name.startsWith(TUI_LOCK_PREFIX) || !name.endsWith('.json')) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(LOCK_DIR, name), 'utf8');
    } catch {
      continue;
    }
    const instance = parseTuiLock(text);
    if (instance) instances.push(instance);
  }
  return instances;
}

// Strict directory match: the selected file itself must live in the TUI
// instance's directory (or below it). The target is the file path, NOT the
// workspace folder, so a TUI session opened elsewhere is never injected into.
// Segment-boundary comparison keeps "foo/bar2" from matching "foo/bar".
function matchTuiInstances(instances: TuiLockFile[], filePath: string): TuiLockFile[] {
  const file = normalizePath(filePath);
  if (!file) return [];
  const matches: Array<{ instance: TuiLockFile; depth: number }> = [];
  for (const instance of instances) {
    const dir = normalizePath(instance.directory);
    if (!dir) continue;
    if (file !== dir && !file.startsWith(dir + '/')) continue;
    matches.push({ instance, depth: dir.length });
  }
  // Most specific (longest) directory wins; ties fall back to newest instance.
  matches.sort((a, b) => {
    if (b.depth !== a.depth) return b.depth - a.depth;
    return b.instance.startedAt - a.instance.startedAt;
  });
  return matches.map((entry) => entry.instance);
}

async function postToTui(port: number, text: string): Promise<boolean> {
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
    const payload: unknown = await response.json().catch(() => null);
    return isRecord(payload) && payload.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function sendToTuiGateways(text: string, editor: vscode.TextEditor): Promise<boolean> {
  const candidates = matchTuiInstances(listTuiInstances(), editor.document.uri.fsPath);
  for (const instance of candidates) {
    if (await postToTui(instance.port, text)) return true;
  }
  return false;
}

async function insertFileReference(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (
    !editor
    || editor.document.uri.scheme !== 'file'
    || !vscode.workspace.getWorkspaceFolder(editor.document.uri)
  ) {
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
  void vscode.env.clipboard.writeText(text).then(() => {
    vscode.window.showInformationMessage('opencode-bridge: copied to clipboard: ' + reference);
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const httpServer = http.createServer((req, res) => {
    onRequest(req, res).catch((err: unknown) => {
      console.error('[opencode-bridge] request failed:', err);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: errorMessage(err) });
    });
  });
  server = httpServer;

  httpServer.on('error', (err: Error) => {
    console.error('[opencode-bridge] server error:', err);
  });

  context.subscriptions.push({
    dispose(): void {
      stopServer();
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('opencodeBridge.insertFileReference', insertFileReference)
  );

  httpServer.listen(0, '127.0.0.1', () => {
    const address = httpServer.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    writeLockFile(port);
    console.log(`[opencode-bridge] listening on 127.0.0.1:${port} (lock: ${lockFilePath})`);
  });
}

export function deactivate(): void {
  stopServer();
}
