// TUI plugin: expose a tiny loopback HTTP endpoint that injects text into the
// opencode composer, so the VS Code bridge can target ANY terminal running the
// TUI (not just the integrated terminal / clipboard fallback).
//
// Injection order:
//   1. api.client.tui.appendPrompt({ text })  -- official path (server routes)
//   2. renderer fallback                      -- TextareaRenderable direct write
//
// No npm dependencies: node builtins + Bun globals only.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type AppendPromptClient = {
  tui?: {
    appendPrompt?: (input: { text: string }) => Promise<unknown>;
  };
};

type TuiLifecycle = {
  onDispose?: (fn: () => void) => void;
};

type TuiApi = {
  client?: AppendPromptClient;
  renderer?: any;
  lifecycle?: TuiLifecycle;
};

const LOCK_DIR = path.join(os.homedir(), ".opencode", "ide");

// duck-type match for @opentui/core TextareaRenderable (it has no id)
function isComposer(node: any): boolean {
  return (
    !!node &&
    typeof node.insertText === "function" &&
    typeof node.plainText === "string"
  );
}

function findComposer(renderer: any): any | undefined {
  const focused = renderer?.currentFocusedEditor;
  if (isComposer(focused)) return focused;

  const root = renderer?.root;
  if (!root) return undefined;

  const queue: any[] = [root];
  const seen = new Set<any>();
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    if (isComposer(node)) return node;

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
  return undefined;
}

function injectViaRenderer(renderer: any, text: string): void {
  const composer = findComposer(renderer);
  if (!composer) throw new Error("composer not found");

  let inserted = false;
  try {
    composer.insertText(text);
    inserted = true;
  } catch {
    inserted = false;
  }
  if (!inserted) throw new Error("insertText failed");

  try {
    composer.getLayoutNode()?.markDirty?.();
  } catch {}
  try {
    composer.gotoBufferEnd();
  } catch {}
  try {
    renderer?.requestRender?.();
  } catch {}
}

export default {
  id: "local.tui-append-http",
  tui: async (api: TuiApi) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
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

        if (typeof api.client?.tui?.appendPrompt === "function") {
          try {
            await api.client.tui.appendPrompt({ text });
            return Response.json({ ok: true, via: "api" });
          } catch {
            // server route missing (e.g. 405 on some builds) -> renderer fallback
          }
        }

        try {
          injectViaRenderer(api.renderer, text);
          return Response.json({ ok: true, via: "renderer" });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    });

    const lockFile = path.join(LOCK_DIR, `tui-${process.pid}.json`);
    try {
      fs.mkdirSync(LOCK_DIR, { recursive: true });
      fs.writeFileSync(
        lockFile,
        JSON.stringify(
          {
            pid: process.pid,
            port: server.port,
            directory: process.cwd(),
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

    api.lifecycle?.onDispose?.(() => {
      server.stop(true);
      try {
        fs.unlinkSync(lockFile);
      } catch {}
    });

    console.error("[tui-append-http] listening on 127.0.0.1:" + server.port);
  },
};
