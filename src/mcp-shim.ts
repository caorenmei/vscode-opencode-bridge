#!/usr/bin/env node
// stdio MCP server (NDJSON JSON-RPC, not LSP framing) that forwards tool calls
// to the VS Code extension's loopback HTTP endpoint.
//
// stdout carries protocol messages ONLY; every diagnostic goes to stderr.
// Compiled to `../mcp-shim.js` by `npm run build` (opencode.json points there).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';

const LOCK_DIR = path.join(os.homedir(), '.opencode', 'ide');
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'opencode-bridge', version: '0.0.1' } as const;

interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

interface ToolTextContent {
  type: 'text';
  text: string;
}

interface ToolCallResult {
  content: ToolTextContent[];
  isError?: boolean;
}

interface InitializeResult {
  protocolVersion: string;
  capabilities: { tools: Record<string, never> };
  serverInfo: { name: string; version: string };
}

interface ToolsListResult {
  tools: ToolDefinition[];
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: unknown;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: unknown;
  error: { code: number; message: string };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** Lock file written by the VS Code extension (`<pid>.json`). */
interface BridgeLockFile {
  pid: number;
  port: number;
  authToken: string;
  workspaceFolders: string[];
  startedAt: number;
}

/** Usable bridge instance, ranked by findTarget(). */
interface TargetCandidate {
  port: number;
  authToken: string;
  matched: boolean;
  startedAt: number;
  pid: number;
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'getCurrentSelection',
    description:
      "Get the user's current selection in VS Code (file, line range, selected text). Use this when the user refers to 'this code', 'selected lines', or '当前选中'.",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'getOpenEditors',
    description: 'List files currently open in VS Code editors.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'getWorkspaceFolders',
    description: 'List workspace folder root paths open in VS Code.',
    inputSchema: { type: 'object', properties: {} }
  }
];

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

function log(message: string): void {
  process.stderr.write(`[opencode-bridge] ${message}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function errorMessage(err: unknown): string {
  if (isRecord(err) && 'message' in err) return String(err['message']);
  return String(err);
}

function errorStack(err: unknown): string {
  if (isRecord(err) && 'stack' in err && err['stack']) return String(err['stack']);
  return String(err);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isAlive(pid: unknown): pid is number {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isErrnoException(err) && err.code === 'EPERM';
  }
}

function parseBridgeLock(info: unknown): BridgeLockFile | undefined {
  if (!isRecord(info)) return undefined;
  const pid = info['pid'];
  if (!isAlive(pid)) return undefined;
  const port = info['port'];
  const authToken = info['authToken'];
  if (typeof port !== 'number' || typeof authToken !== 'string') return undefined;
  const folders = Array.isArray(info['workspaceFolders']) ? info['workspaceFolders'] : [];
  return {
    pid,
    port,
    authToken,
    workspaceFolders: folders.filter(
      (folder): folder is string => typeof folder === 'string' && folder.length > 0
    ),
    startedAt: typeof info['startedAt'] === 'number' ? info['startedAt'] : 0
  };
}

function findTarget(): TargetCandidate | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(LOCK_DIR);
  } catch {
    return null;
  }

  const cwd = normalizePath(process.cwd());
  const candidates: TargetCandidate[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let info: unknown;
    try {
      info = JSON.parse(fs.readFileSync(path.join(LOCK_DIR, entry), 'utf8'));
    } catch {
      continue;
    }
    const lock = parseBridgeLock(info);
    if (!lock) continue;

    const matched = lock.workspaceFolders.some((folder) => {
      const normalized = normalizePath(folder);
      return cwd === normalized || cwd.startsWith(normalized + '/');
    });

    candidates.push({
      port: lock.port,
      authToken: lock.authToken,
      matched,
      startedAt: lock.startedAt,
      pid: lock.pid
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.matched !== b.matched) return a.matched ? -1 : 1;
    return b.startedAt - a.startedAt;
  });
  return candidates[0] ?? null;
}

let target = findTarget();

function send(message: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolResult(text: string, isError?: boolean): ToolCallResult {
  const result: ToolCallResult = { content: [{ type: 'text', text }] };
  if (isError) result.isError = true;
  return result;
}

async function callTool(name: string, args: unknown): Promise<ToolCallResult> {
  if (!target) target = findTarget();
  if (!target) {
    return toolResult('VS Code bridge unavailable: no live VS Code lock file found', true);
  }

  const url = `http://127.0.0.1:${target.port}/rpc`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${target.authToken}`,
        connection: 'close'
      },
      body: JSON.stringify({ method: name, params: args || {} })
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return toolResult(
        `VS Code bridge unavailable: HTTP ${response.status}${detail ? ` ${detail}` : ''}`,
        true
      );
    }

    const payload: unknown = await response.json();
    if (payload && isRecord(payload) && payload['error']) {
      return toolResult(`VS Code bridge unavailable: ${String(payload['error'])}`, true);
    }
    const result = payload ? (isRecord(payload) ? payload['result'] : undefined) : null;
    return toolResult(JSON.stringify(result, null, 2));
  } catch (err) {
    target = null;
    return toolResult(`VS Code bridge unavailable: ${errorMessage(err)}`, true);
  }
}

async function handleMessage(raw: unknown): Promise<void> {
  if (!isRecord(raw)) return;
  const id = raw['id'];
  const hasId = id !== undefined && id !== null;
  const method = raw['method'];
  const params = isRecord(raw['params']) ? raw['params'] : {};

  if (typeof method !== 'string') {
    if (hasId) replyError(id, -32600, 'Invalid Request');
    return;
  }

  if (method.startsWith('notifications/')) return;

  switch (method) {
    case 'initialize': {
      const requested = readString(params, 'protocolVersion');
      const protocolVersion =
        requested !== undefined && requested.length > 0 ? requested : DEFAULT_PROTOCOL_VERSION;
      if (hasId) {
        const result: InitializeResult = {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO
        };
        reply(id, result);
      }
      return;
    }
    case 'ping':
      if (hasId) reply(id, {});
      return;
    case 'tools/list': {
      if (hasId) {
        const result: ToolsListResult = { tools: TOOLS };
        reply(id, result);
      }
      return;
    }
    case 'tools/call': {
      if (!hasId) return;
      const name = params['name'];
      if (typeof name !== 'string' || !TOOL_NAMES.has(name)) {
        reply(id, toolResult(`Unknown tool: ${String(name)}`, true));
        return;
      }
      reply(id, await callTool(name, params['arguments']));
      return;
    }
    case 'shutdown':
      if (hasId) reply(id, {});
      return;
    case 'exit':
      rl.close();
      process.stdin.destroy();
      return;
    default:
      if (hasId) replyError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });

// In-flight requests keep the event loop alive, so closing stdin (or a client shutdown)
// never truncates a response that is still being produced.
rl.on('line', (line: string) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let message: unknown;
  try {
    message = JSON.parse(trimmed);
  } catch (err) {
    log(`invalid JSON on stdin: ${errorMessage(err)}`);
    return;
  }
  handleMessage(message).catch((err: unknown) => {
    log(`handler failed: ${errorStack(err)}`);
    if (!isRecord(message)) return;
    const id = message['id'];
    if (id === undefined || id === null) return;
    replyError(id, -32603, `Internal error: ${errorMessage(err)}`);
  });
});

log(`started (cwd: ${process.cwd()}, target: ${target ? `port ${target.port}` : 'none'})`);
