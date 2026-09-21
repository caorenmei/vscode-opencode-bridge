// Ambient type declarations for the opencode 2.0.11 TUI plugin host.
//
// The host rewrites `import { Plugin } from "@opencode/plugin/tui"` at runtime,
// and only the plugin API actually used by tui.ts is declared here. This file is
// consumed by `tsc --noEmit` only; opencode never loads it.

declare module "@opencode/plugin/tui" {
  /** Options passed to `Plugin.define({ setup })`. */
  export interface TuiPluginContext {
    /** Plugin entry options from the host configuration, if any. */
    readonly options?: Record<string, unknown>;

    /** The OpenTUI renderer driving the TUI. */
    readonly renderer?: {
      /** Root of the render tree (traversed via `getChildren()`). */
      readonly root?: unknown;
      /** Currently focused editor node, when one is focused. */
      readonly currentFocusedEditor?: unknown;
      /** Schedules a repaint. */
      requestRender?(): void;
    };

    /** opencode API client, when the host exposes one. */
    readonly client?: {
      readonly tui?: {
        appendPrompt?(input: { text: string }): Promise<unknown>;
      };
    };

    /** UI helpers offered to plugins. */
    readonly ui?: {
      readonly toast?: {
        show(options: { variant?: string; title?: string; message: string }): void;
      };
    };
  }

  export interface TuiPluginConfig {
    id: string;
    /** Runs on load. The returned function is the plugin's dispose hook. */
    setup(context: TuiPluginContext): (() => void) | void;
  }

  export const Plugin: {
    define(config: TuiPluginConfig): TuiPluginConfig;
  };
}
