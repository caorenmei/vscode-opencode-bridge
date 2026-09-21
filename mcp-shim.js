#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const LOCK_DIR = path.join(os.homedir(), '.opencode', 'ide');
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'opencode-bridge', version: '0.0.1' };

const TOOLS = [
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

function log(message) {
  process.stderr.write(`[opencode-bridge] ${message}\n`);
}

function normalizePath(value) {
  return path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function findTarget() {
  let entries;
  try {
    entries = fs.readdirSync(LOCK_DIR);
  } catch (err) {
    return null;
  }

  const cwd = normalizePath(process.cwd());
  const candidates = [];

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let info;
    try {
      info = JSON.parse(fs.readFileSync(path.join(LOCK_DIR, entry), 'utf8'));
    } catch (err) {
      continue;
    }
    if (!info || typeof info !== 'object') continue;
    if (!isAlive(info.pid)) continue;
    if (typeof info.port !== 'number' || typeof info.authToken !== 'string') continue;

    const folders = Array.isArray(info.workspaceFolders) ? info.workspaceFolders : [];
    const matched = folders.some((folder) => {
      if (typeof folder !== 'string' || folder.length === 0) return false;
      const normalized = normalizePath(folder);
      return cwd === normalized || cwd.startsWith(normalized + '/');
    });

    candidates.push({
      port: info.port,
      authToken: info.authToken,
      matched,
      startedAt: typeof info.startedAt === 'number' ? info.startedAt : 0,
      pid: info.pid
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.matched !== b.matched) return a.matched ? -1 : 1;
    return b.startedAt - a.startedAt;
  });
  return candidates[0];
}

let target = findTarget();

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolResult(text, isError) {
  const result = { content: [{ type: 'text', text }] };
  if (isError) result.isError = true;
  return result;
}

async function callTool(name, args) {
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

    const payload = await response.json();
    if (payload && payload.error) {
      return toolResult(`VS Code bridge unavailable: ${payload.error}`, true);
    }
    const result = payload ? payload.result : null;
    return toolResult(JSON.stringify(result, null, 2));
  } catch (err) {
    target = null;
    return toolResult(`VS Code bridge unavailable: ${err.message}`, true);
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  const id = message.id;
  const hasId = id !== undefined && id !== null;
  const method = message.method;
  const params = message.params || {};

  if (typeof method !== 'string') {
    if (hasId) replyError(id, -32600, 'Invalid Request');
    return;
  }

  if (method.startsWith('notifications/')) return;

  switch (method) {
    case 'initialize': {
      const protocolVersion =
        typeof params.protocolVersion === 'string' && params.protocolVersion.length > 0
          ? params.protocolVersion
          : DEFAULT_PROTOCOL_VERSION;
      if (hasId) {
        reply(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO
        });
      }
      return;
    }
    case 'ping':
      if (hasId) reply(id, {});
      return;
    case 'tools/list':
      if (hasId) reply(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      if (!hasId) return;
      const name = params.name;
      if (typeof name !== 'string' || !TOOL_NAMES.has(name)) {
        reply(id, toolResult(`Unknown tool: ${String(name)}`, true));
        return;
      }
      reply(id, await callTool(name, params.arguments));
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
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (err) {
    log(`invalid JSON on stdin: ${err.message}`);
    return;
  }
  handleMessage(message).catch((err) => {
    log(`handler failed: ${err && err.stack ? err.stack : err}`);
    if (message && message.id !== undefined && message.id !== null) {
      replyError(message.id, -32603, `Internal error: ${err.message}`);
    }
  });
});

log(`started (cwd: ${process.cwd()}, target: ${target ? `port ${target.port}` : 'none'})`);
