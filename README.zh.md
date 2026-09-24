# vscode-opencode-bridge

这是一个连接 VS Code 与 opencode 的本地桥接项目，核心目标是让编辑器中的文件引用、选区和当前工作区状态能直接进入 opencode TUI。

## 快速开始

```bash
npm install
npm run build
```

- Windows: 使用 `mklink /J` 挂载扩展和插件
- macOS / Linux: 使用 `ln -sfn` 挂载扩展和插件
- 更多详情请见 [README.md](README.md)

## 功能概览

- 通过快捷键生成文件引用
- 将引用插入 opencode TUI 输入框
- 直接读取 VS Code 当前编辑器状态
- 通过本地锁文件和 HTTP 协议完成本机通信

