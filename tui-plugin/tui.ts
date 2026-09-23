// opencode 2.0.11 TUI plugin (directory discovery form: plugins/<dir>/tui.ts).
//
// Exposes a tiny loopback HTTP endpoint that injects text into the opencode
// composer, so the VS Code bridge can target ANY terminal running the TUI (not
// just the integrated terminal / clipboard fallback).
//
// Injection order:
//   1. client.tui.appendPrompt({ text })  -- forward-compat official path
//      (the server route is gone in 2.0.11, kept for builds that still ship it)
//   2. renderer fallback                  -- TextareaRenderable direct write
//
// No npm dependencies: node builtins + Bun globals only. Plain TS, no JSX.
// Type-checked by plugins/tui-append-http/tsconfig.json (`npm run check`).

import { Plugin } from "@opencode/plugin/tui";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCK_DIR = path.join(os.homedir(), ".opencode", "ide");

/** Instance lock file consumed by the VS Code extension (`tui-<pid>.json`). */
interface TuiAppendLockFile {
  pid: number;
  port: number;
  directory: string;
  startedAt: number;
}

/** The @opentui/core TextareaRenderable subset used for prompt injection. */
interface ComposerNode {
  insertText(text: string): void;
  readonly plainText: string;
  readonly isDestroyed?: boolean;
  getClipboardText?(): string;
  getLayoutNode?(): { markDirty?(): void } | undefined;
  gotoBufferEnd?(): void;
}

/** Renderer subset the injection path depends on. */
interface RendererLike {
  readonly root?: unknown;
  readonly currentFocusedEditor?: unknown;
  requestRender?(): void;
}

/** Node carrying the 2.0.11 clipboard hook used to disambiguate the composer. */
interface ClipboardAware {
  getClipboardText(): string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The composer is a @opentui/core TextareaRenderable; it has no id.
function isComposer(node: unknown): node is ComposerNode {
  return (
    isObject(node) &&
    typeof node["insertText"] === "function" &&
    typeof node["plainText"] === "string" &&
    node["isDestroyed"] !== true
  );
}

// 2.0.11 exposes an own getClipboardText() on the composer ref; use it as the
// discriminating feature when several textareas are alive.
function hasClipboardHook(node: unknown): node is ClipboardAware {
  return isObject(node) && typeof node["getClipboardText"] === "function";
}

function findComposer(renderer: RendererLike | undefined): ComposerNode | undefined {
  const focused = renderer?.currentFocusedEditor;
  if (isComposer(focused) && hasClipboardHook(focused)) return focused;

  const root = renderer?.root;
  if (!root) return undefined;

  const queue: unknown[] = [root];
  const seen = new Set<unknown>();
  let fallback: ComposerNode | undefined;
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || seen.has(node)) continue;
    seen.add(node);

    if (isComposer(node)) {
      if (hasClipboardHook(node)) return node;
      if (fallback === undefined) fallback = node;
    }

    let children: unknown;
    try {
      children =
        isObject(node) && typeof node["getChildren"] === "function"
          ? node["getChildren"]()
          : undefined;
    } catch {
      children = undefined;
    }
    if (Array.isArray(children)) {
      for (const child of children) queue.push(child);
    }
  }
  return fallback;
}

function injectViaRenderer(renderer: RendererLike | undefined, text: string): boolean {
  const composer = findComposer(renderer);
  if (composer === undefined) return false;

  let inserted = false;
  try {
    composer.insertText(text);
    inserted = true;
  } catch {
    inserted = false;
  }
  if (!inserted) return false;

  try {
    composer.getLayoutNode?.()?.markDirty?.();
  } catch {}
  try {
    composer.gotoBufferEnd?.();
  } catch {}
  try {
    renderer?.requestRender?.();
  } catch {}
  return true;
}

export default Plugin.define({
  id: "local.tui-append-http",
  setup(context) {
    const directory = process.cwd();
    let port = 0;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/health") {
          return Response.json({ ok: true, pid: process.pid, port, directory });
        }

        if (request.method !== "POST" || url.pathname !== "/append") {
          return Response.json({ ok: false, error: "not found" }, { status: 404 });
        }

        let text: unknown;
        try {
          const body: unknown = await request.json();
          text = isObject(body) ? body["text"] : undefined;
        } catch {
          text = undefined;
        }
        if (typeof text !== "string" || text.length === 0) {
          return Response.json({ ok: false, error: "text required" }, { status: 400 });
        }

        try {
          if (typeof context.client?.tui?.appendPrompt === "function") {
            await context.client.tui.appendPrompt({ text });
            return Response.json({ ok: true, via: "api" });
          }
        } catch {}

        if (injectViaRenderer(context.renderer, text)) {
          return Response.json({ ok: true, via: "renderer" });
        }
        return Response.json({ ok: false, error: "composer not found" }, { status: 503 });
      },
    });
    port = server.port;

    // Deliberately outside the plugin directory: writing next to tui.ts would
    // retrigger the plugin watcher.
    const lockFile = path.join(LOCK_DIR, `tui-${process.pid}.json`);
    try {
      mkdirSync(LOCK_DIR, { recursive: true });
      const payload: TuiAppendLockFile = {
        pid: process.pid,
        port: server.port,
        directory,
        startedAt: Date.now(),
      };
      writeFileSync(lockFile, JSON.stringify(payload, null, 2), "utf8");
    } catch (err) {
      console.error("[tui-append-http] failed to write lock file:", err);
    }

    // No startup toast: the lock file + /health endpoint are enough for
    // diagnosis, and a bubble on every TUI launch is just noise.

    return () => {
      try {
        server.stop(true);
      } catch {}
      try {
        rmSync(lockFile, { force: true });
      } catch {}
    };
  },
});
