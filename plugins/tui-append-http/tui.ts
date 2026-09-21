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

import { Plugin } from "@opencode/plugin/tui";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCK_DIR = path.join(os.homedir(), ".opencode", "ide");

// The composer is a @opentui/core TextareaRenderable; it has no id.
function isComposer(node: any): boolean {
  return (
    !!node &&
    typeof node.insertText === "function" &&
    typeof node.plainText === "string" &&
    node.isDestroyed !== true
  );
}

// 2.0.11 exposes an own getClipboardText() on the composer ref; use it as the
// discriminating feature when several textareas are alive.
function hasClipboardHook(node: any): boolean {
  return typeof node?.getClipboardText === "function";
}

function findComposer(renderer: any): any | undefined {
  const focused = renderer?.currentFocusedEditor;
  if (isComposer(focused) && hasClipboardHook(focused)) return focused;

  const root = renderer?.root;
  if (!root) return undefined;

  const queue: any[] = [root];
  const seen = new Set<any>();
  let fallback: any | undefined;
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
      children = typeof node.getChildren === "function" ? node.getChildren() : undefined;
    } catch {
      children = undefined;
    }
    if (Array.isArray(children)) {
      for (const child of children) queue.push(child);
    }
  }
  return fallback;
}

function injectViaRenderer(renderer: any, text: string): boolean {
  const composer = findComposer(renderer);
  if (!composer) return false;

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
      async fetch(req) {
        const url = new URL(req.url);

        if (req.method === "GET" && url.pathname === "/health") {
          return Response.json({ ok: true, pid: process.pid, port, directory });
        }

        if (req.method !== "POST" || url.pathname !== "/append") {
          return Response.json({ ok: false, error: "not found" }, { status: 404 });
        }

        let text: unknown;
        try {
          const body: any = await req.json();
          text = body?.text;
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
      writeFileSync(
        lockFile,
        JSON.stringify(
          {
            pid: process.pid,
            port: server.port,
            directory,
            startedAt: Date.now(),
          },
          null,
          2,
        ),
        "utf8",
      );
    } catch (err) {
      console.error("[tui-append-http] failed to write lock file:", err);
    }

    try {
      context.ui.toast.show({
        variant: "success",
        title: "append-http",
        message: "listening on 127.0.0.1:" + server.port,
      });
    } catch (err) {
      console.error("[tui-append-http] toast failed:", err);
    }

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
