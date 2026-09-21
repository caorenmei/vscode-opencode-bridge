// Minimal ambient declaration for the Bun globals used by tui.ts.
//
// The opencode npm distribution is a Bun-compiled binary, so `Bun.serve` is
// available in the plugin process at runtime. Only the surface used here is
// declared; no `bun-types` dependency is pulled in.

interface BunServer {
  readonly port: number;
  stop(closeActiveConnections?: boolean): void;
}

declare const Bun: {
  serve(options: {
    hostname?: string;
    port?: number;
    fetch(request: Request): Response | Promise<Response>;
  }): BunServer;
};
