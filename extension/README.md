# opencode-bridge

**VS Code ↔ opencode 桥接**：一键把当前文件引用送进 opencode，并让 opencode 主动读取 VS Code 的编辑器状态。

---

## 功能

### 1. 插入文件引用 — `Ctrl+Alt+K`（macOS `Cmd+Alt+K`）

按当前选区自动生成引用并送到 opencode：

| 当前选区 | 插入内容 |
| --- | --- |
| 无选中 | `@相对路径` |
| 单行选中 | `@相对路径#L12` |
| 多行选中 | `@相对路径#L12-30` |

### 2. 发送优先级链

1. **直连 opencode TUI**（首选）——若选中文件位于某个运行中的 TUI 会话打开目录**或其子目录**内，经本地 HTTP 直接把引用注入该 TUI 的输入框，并提示 `sent to opencode TUI`。
   - 需安装配套的 **TUI 插件**（本仓库 `tui-plugin/`）。
   - 采用**严格目录匹配**：文件不在任何 TUI 会话目录内时不会误注入，直接进入下一级。
2. **活跃终端** —— 向当前活动终端 `sendText`。
3. **剪贴板兜底** —— 没有活动终端时写入剪贴板并提示。

### 3. 本地 HTTP 服务 + MCP 工具

扩展激活后在 `127.0.0.1` 随机端口启动一个**仅监听本机**的 HTTP 服务（`POST /rpc`，Bearer 令牌鉴权），并把连接信息写入 `%USERPROFILE%\.opencode\ide\<pid>.json`。

配套的 stdio MCP 服务器（`mcp-shim.js`）据此向 opencode 暴露三个工具，让 opencode 能主动读取编辑器状态：

| 工具 | 作用 |
| --- | --- |
| `getCurrentSelection` | 当前选区：文件、行号范围、选中文本 |
| `getOpenEditors` | 当前打开过的编辑器文件列表 |
| `getWorkspaceFolders` | 工作区根目录列表 |

---

## 环境要求

- **opencode CLI ≥ 2.0**
- **VS Code ≥ 1.85.0**
- Node.js 18+（构建时需要；扩展宿主已自带运行时）

## 安装

**① 安装扩展** —— 用目录联接（junction）把本仓库的 `extension/` 暴露给 VS Code，仓库即唯一数据源：

```cmd
mklink /J "C:\Users\<you>\.vscode\extensions\local.opencode-bridge-0.0.1" "<repo>\extension"
```

**② 安装配套 TUI 插件**（可选；直连注入需要它）——同样用 junction 暴露给 opencode 全局配置目录：

```cmd
mklink /J "C:\Users\<you>\.config\opencode\plugins\tui-append-http" "<repo>\tui-plugin"
```

并在 `~/.config/opencode/cli.json` 中登记：

```json
"plugins": ["oh-my-opencode-slim", "./plugins/tui-append-http"]
```

**③ 注册 MCP 服务器** —— 在 opencode 全局配置 `~/.config/opencode/opencode.json` 中添加（命令路径指向 junction）：

```json
{
  "mcp": {
    "servers": {
      "vscode": {
        "type": "local",
        "command": ["node", "C:\\Users\\<you>\\.vscode\\extensions\\local.opencode-bridge-0.0.1\\mcp-shim.js"],
        "enabled": true
      }
    }
  }
}
```

**④ 生效** —— 重启 VS Code（或执行 `Developer: Reload Window`），并重新打开 opencode 会话以拉起 MCP 服务器。

## 从源码构建

扩展只加载 JavaScript，TypeScript 源码（`src/`）需先编译出 `extension.js` / `mcp-shim.js`：

```bash
npm install
npm run build   # extension/src/ -> extension/extension.js + extension/mcp-shim.js
npm run check   # 类型检查（extension/ 与 tui-plugin/，strict）
```

## 许可证

本项目以 **MIT** 许可证发布，全文见仓库中的 `LICENSE` 文件。
