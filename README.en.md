# vscode-opencode-bridge

This is a local bridge between VS Code and opencode. It lets file references, selections, and workspace state flow directly into the opencode TUI.

## Quick Start

```bash
npm install
npm run build
```

- Windows: use `mklink /J` to mount the extension and plugin
- macOS / Linux: use `ln -sfn` to mount the extension and plugin
- For full details, see [README.md](README.md)

## Highlights

- Generate file references through a keyboard shortcut
- Inject references into the opencode TUI composer
- Read the current VS Code editor state
- Use local lock files and HTTP for local communication
