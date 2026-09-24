# vscode-opencode-bridge

## 快速开始 / Quick Start

### 中文

这个仓库提供一个轻量级的本地桥接，让 VS Code 和 opencode 之间可以直接交换编辑器状态、选区和文件引用。它的核心能力是：在 VS Code 中按快捷键生成 `@文件` / `@文件#L12` 引用，并把内容发送到 opencode TUI 会话。

```bash
npm install
npm run build
```

- Windows：使用 `mklink /J` 挂载扩展和 TUI 插件
- macOS / Linux：使用 `ln -sfn` 挂载扩展和 TUI 插件
- 完整安装步骤见后续章节：`安装与配置`

### English

This repository provides a lightweight local bridge between VS Code and opencode, allowing editor state, selection, and file references to flow directly into the opencode TUI. The core flow is: generate `@file` / `@file#L12` references in VS Code and send them into an opencode session.

```bash
npm install
npm run build
```

- Windows: use `mklink /J` to mount the extension and TUI plugin
- macOS / Linux: use `ln -sfn` to mount the extension and TUI plugin
- Full installation details are in the later section: `安装与配置`

## 项目简介

本仓库是 VS Code 与 opencode 之间的极简本地桥接，由**两个产品 + 一份目录契约**组成，运行期零第三方依赖（仅 Node 内置模块），源码为 TypeScript：

| 产品 | 目录 | 角色 |
| --- | --- | --- |
| VS Code 扩展 | `extension/` | `Ctrl+Alt+K` 插入文件引用；提供仅监听本机的 HTTP 服务，并自带其 MCP 客户端 `mcp-shim.js` |
| opencode TUI 插件 | `tui-plugin/` | 在 opencode TUI 进程内监听本地 HTTP，把收到的文本注入输入框 |

两侧通过 `%USERPROFILE%\.opencode\ide\` 下的**锁文件**互相发现，再经 `127.0.0.1` 上的 HTTP 互联。扩展只加载编译产物（`extension/extension.js` / `extension/mcp-shim.js`），TUI 插件则由 opencode 的 Bun 宿主**直接加载 TS 源码**。

> 扩展面板 Details 页的展示文案在 [`extension/README.md`](extension/README.md)；本文件是仓库开发文档，两者内容不重复。

## 架构总览

**插入引用（`Ctrl+Alt+K` → `opencodeBridge.insertFileReference`）**

```mermaid
flowchart TD
    Editor["VS Code 编辑器<br/>选中代码后按 Ctrl+Alt+K（macOS 为 Cmd+Alt+K）"]
    Cmd["命令 opencodeBridge.insertFileReference<br/>生成引用：无选中 @文件 / 单行 @文件#L12 / 多行 @文件#L12-30"]
    Guard{"可发送？<br/>有活动编辑器 · scheme 为 file · 位于 workspace 内"}
    Warn["仅提示：opencode-bridge: no active editor / file not in workspace"]
    P1{"① 选中文件位于某个 TUI 会话目录内？"}
    Append["POST /append（127.0.0.1:TUI端口，2 秒超时）"]
    Tui["opencode TUI 插件<br/>写入 composer"]
    Ok1["提示：sent to opencode TUI"]
    P2{"② 存在活跃终端？"}
    Term["terminal.sendText + terminal.show"]
    Clip["③ clipboard.writeText"]
    Ok3["提示：copied to clipboard"]
    Editor --> Cmd --> Guard
    Guard -- "否" --> Warn
    Guard -- "是" --> P1
    P1 -- "否（目录不匹配或注入失败）" --> P2
    P1 -- "是" --> Append --> Tui --> Ok1
    P2 -- "是" --> Term
    P2 -- "否" --> Clip --> Ok3
```

**读取编辑器状态（MCP）**

```mermaid
flowchart LR
    subgraph OCP["opencode 进程"]
        OC["opencode 服务端"]
        Shim["mcp-shim.js<br/>stdio · NDJSON JSON-RPC"]
    end
    subgraph VSC["VS Code 进程"]
        Ext["扩展 HTTP 服务<br/>POST /rpc · Bearer 鉴权"]
        State["编辑器状态<br/>选区 / 打开的文件 / 工作区"]
    end
    Locks["锁文件发现<br/>%USERPROFILE%\.opencode\ide\<br/>&lt;pid&gt;.json 扩展写 · tui-&lt;pid&gt;.json 插件写"]
    OC -- "initialize / tools/list / tools/call" --> Shim
    Shim -- "Authorization: Bearer &lt;authToken&gt;" --> Ext
    Ext --> State
    Locks -. "mcp-shim 读 port + authToken" .-> Shim
    Locks -. "扩展读 directory + port" .-> Ext
```

## 目录结构

```text
vscode-opencode-bridge/                 # 私有根工作区（不发布）
├── package.json                        # devDependencies(typescript/@types/node/@types/vscode) + scripts
├── tsconfig.base.json                  # 共享 strict 编译选项（两个产品共同 extends）
├── extension/                          # 产品①：VS Code 扩展域
│   ├── package.json                    #   VS Code 扩展清单（name/publisher/version/engines/main/contributes/icon/categories/license）
│   ├── tsconfig.json                   #   extends ../tsconfig.base.json；rootDir "src"、outDir "."
│   ├── README.md                       #   扩展面板 Details 页正文（VS Code 读取此文件）
│   ├── LICENSE                         #   MIT 许可证全文
│   ├── images/icon.png                 #   扩展图标（128×128 PNG）
│   ├── src/
│   │   ├── extension.ts                #   HTTP 桥 + Ctrl+Alt+K 命令
│   │   └── mcp-shim.ts                 #   stdio MCP 服务器
│   ├── extension.js                    #   【构建产物】gitignore
│   └── mcp-shim.js                     #   【构建产物】gitignore
├── tui-plugin/                         # 产品②：opencode TUI 插件域
│   ├── tui.ts                          #   TS 源码直跑（Bun 宿主加载），不参与 tsc 构建
│   ├── tsconfig.json                   #   extends ../tsconfig.base.json；noEmit，仅类型检查
│   └── types/                          #   宿主 API 的 ambient 声明（不参与运行）
├── README.md                           # 本文件（仓库开发文档）
├── package-lock.json
└── .gitignore
```

> 修改 `extension/src/` 或 `tui-plugin/` 下的源码后必须 `npm run build`，否则加载的仍是旧产物。

## 安装与配置

### 环境要求

- **opencode CLI ≥ 2.0**（当前适配 2.0.11，见「版本兼容性」）
- **VS Code ≥ 1.85.0**
- Node.js 18+（构建时需要；扩展宿主已自带运行时）

### 1. 安装 VS Code 扩展

用目录链接把仓库的 `extension/` 暴露给 VS Code，仓库即唯一数据源，无需打包 `.vsix`。

#### Windows

以下命令**在仓库根目录执行**（`%CD%` 即仓库根）

```cmd
mklink /J "%USERPROFILE%\.vscode\extensions\local.opencode-bridge-0.0.1" "%CD%\extension"
```

#### macOS / Linux

```bash
mkdir -p "$HOME/.vscode/extensions"
ln -sfn "$(pwd)/extension" "$HOME/.vscode/extensions/local.opencode-bridge-0.0.1"
```

- 扩展目录名必须遵循 `<publisher>.<name>-<version>` 约定（此处为 `local.opencode-bridge-0.0.1`），否则 VS Code 不会将其识别为扩展。
- 安装后执行 `code --list-extensions` 应列出 `local.opencode-bridge`。

### 2. 安装 TUI 插件（同一仓库目录挂载到 opencode 插件目录）

直连注入需要配套插件。这里同样使用目录链接/符号链接把 `tui-plugin/` 挂到 opencode 的插件目录。

#### Windows

```cmd
mklink /J "%USERPROFILE%\.config\opencode\plugins\tui-append-http" "%CD%\tui-plugin"
```

#### macOS / Linux

```bash
mkdir -p "$HOME/.config/opencode/plugins"
ln -sfn "$(pwd)/tui-plugin" "$HOME/.config/opencode/plugins/tui-append-http"
```

再把它登记进全局 CLI 配置：

- Windows: `%USERPROFILE%\.config\opencode\cli.json`
- macOS / Linux: `$HOME/.config/opencode/cli.json`

在 `plugins` 数组中追加一项：

```json
"plugins": [
  "./plugins/tui-append-http"
]
```

- 相对路径基于 `cli.json` 所在目录。
- 插件加载成功时 TUI 会弹出 toast：`append-http / listening on 127.0.0.1:<port>`；若指向的目录内没有 tui 入口也会弹 toast，便于排查。
- 自动发现与 `plugins` 登记按 href 去重，不会重复加载。

> 说明：Windows 使用 `mklink /J`（junction）；macOS / Linux 使用 `ln -sfn`。其目的相同：让 opencode 与 VS Code 直接读到本仓库中的真实源码和构建产物，而不需要复制一份副本。

### 3. 注册 MCP 服务器（opencode.json）

在 opencode 全局配置 `%USERPROFILE%\.config\opencode\opencode.json` 中添加：

```json
{
  "mcp": {
    "servers": {
      "vscode": {
        "type": "local",
        "command": [
          "node",
          "%USERPROFILE%\\.vscode\\extensions\\local.opencode-bridge-0.0.1\\mcp-shim.js"
        ],
        "enabled": true
      }
    }
  }
}
```

> `opencode.json` 不会展开环境变量，上面的 `%USERPROFILE%` 只是占位；实际写入时需替换为真实绝对路径（可在 `cmd` 中执行 `echo %USERPROFILE%` 查看）。

命令路径指向 **junction 路径**，因此经 junction 直达仓库的 `extension/mcp-shim.js`；源码目录移动或重构后此配置无需改动。

### junction 维护注意

- 创建 junction 需要管理员权限或开发者模式，在 `cmd` 中执行（PowerShell 的 `New-Item -ItemType Junction` 亦可）。
- **删除 junction 只能用 `rmdir`（或确认后的 `Remove-Item`），它只删除链接本身**；不要使用会递归删除目标内容的命令，否则会连带删掉仓库文件。
- 若 VS Code 的扩展登记损坏（`code --list-extensions` 不再列出该扩展，或扩展面板报错），按下面两步重建（在仓库根目录执行）：

```cmd
rmdir "%USERPROFILE%\.vscode\extensions\local.opencode-bridge-0.0.1"
mklink /J "%USERPROFILE%\.vscode\extensions\local.opencode-bridge-0.0.1" "%CD%\extension"
```

## 使用方式

### 插入文件引用（`Ctrl+Alt+K`，macOS `Cmd+Alt+K`）

快捷键 `opencodeBridge.insertFileReference` 按当前选区生成引用：

| 当前选区 | 插入内容 |
| --- | --- |
| 无选中 | `@相对路径` |
| 单行选中 | `@相对路径#L12` |
| 多行选中 | `@相对路径#L12-30` |

前置条件：存在活动编辑器、`uri.scheme` 为 `file`、且文件位于某个 workspace folder 内；否则仅提示 `opencode-bridge: no active editor / file not in workspace`，不发送任何内容。引用末尾会补一个空格。

### 发送优先级链

1. **直连 opencode TUI（首选）** —— 扫描 `%USERPROFILE%\.opencode\ide\tui-*.json`，过滤死进程，仅保留目录匹配的实例；多个匹配时按「`directory` 最长（最具体）→ `startedAt` 最新」排序，依次尝试 `POST /append`（2 秒超时）。成功即提示 `opencode-bridge: sent to opencode TUI`。
2. **活跃终端** —— 向 `vscode.window.activeTerminal` 执行 `sendText` 并 `show()`（不按名查找、不自动新建终端）。
3. **剪贴板兜底** —— 没有活动终端时写入剪贴板，并提示 `opencode-bridge: copied to clipboard: <引用>`。

### 目录兼容性（严格匹配）

匹配基准是**选中文件自身的路径**，而不是编辑器所在的 workspace folder。比较前双方统一小写、`\` 转 `/`、去掉尾部 `/`，再做**路径段级**前缀匹配：

- 命中条件：`filePath === directory` 或 `filePath.startsWith(directory + "/")`，即文件位于该 TUI 会话打开目录**之内**（含子目录）。
- 段边界比较可避免 `foo/bar2/x.cpp` 误配到 `/foo/bar`。
- **不匹配即跳过**：若没有任何 TUI 实例的 `directory` 覆盖该文件（例如 TUI 在别的目录启动），不会回退到「最新实例」，而是直接落到活跃终端 / 剪贴板，避免把引用误注入无关会话。

### MCP 工具

opencode 通过 MCP 主动读取编辑器状态，共三个工具：

| 工具 | 返回内容 | 底层方法 |
| --- | --- | --- |
| `getCurrentSelection` | 当前选区：文件、绝对路径、起止行号、是否空选区、选中文本 | `getCurrentSelection` |
| `getOpenEditors` | 当前打开的编辑器文件列表（按路径去重，标记活跃项） | `getOpenEditors` |
| `getWorkspaceFolders` | 工作区根目录绝对路径列表 | `getWorkspaceFolders` |

无可用 VS Code 实例时，`initialize` / `tools/list` 仍正常响应，仅工具调用返回 `isError` 文本，避免 opencode 因握手失败报错。

## 开发

### 克隆后初始化

```bash
npm install
npm run build   # 编译扩展产物，否则扩展无法加载
```

### 常用脚本

均从仓库根执行：

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 按 `extension/tsconfig.json` 编译 `extension/src/` → `extension/extension.js` / `extension/mcp-shim.js` |
| `npm run watch` | 同上，watch 模式 |
| `npm run check` | 类型检查：`extension/` 与 `tui-plugin/` 两套 tsconfig（均 `--noEmit`，strict 全开） |

### 约定

- 两个产品各自 `extends` 根 `tsconfig.base.json`；base 只放共享 strict 选项，`module` / `moduleResolution` / `rootDir` / `outDir` / `include` 由各产品覆写。
- `extension/` 采用 strict TypeScript（`noUncheckedIndexedAccess` / `noImplicitReturns` / `noUnusedLocals` 等全开），零隐式 any。
- `tui-plugin/tui.ts` 由 opencode 的 Bun 宿主直接加载 TS 源码，不参与 `npm run build`；其 `tsconfig.json` 与 `types/*.d.ts`（对 `@opencode/plugin/tui` 与 Bun 全局的 ambient 声明）仅供 `npm run check` 使用。
- `extension/extension.js` / `extension/mcp-shim.js` 是构建产物、不进版本库（见 `.gitignore`），请勿手工编辑。
- `extension/README.md` / `extension/LICENSE` / `extension/images/icon.png` 是扩展面板 Details 页的展示内容，经 junction 自动可见。

### 生效与更新

1. 修改 `extension/src/` 或扩展清单后执行 `npm run build`；
2. VS Code 中执行 `Developer: Reload Window`（扩展目录经 junction 指向仓库，无需重新拷贝文件）；
3. `mcp-shim.js` 由 opencode 每次拉起 MCP 服务器时读取，重开 opencode 会话即可加载新版本；
4. `tui-plugin/` 改动由 opencode 侧热加载/重启 TUI 生效。

## 内部契约

以下契约被两个产品互相依赖（扩展侧为消费方），修改前请同步对方。

### 锁文件

| 文件 | 写入方 | 读取方 | 字段 |
| --- | --- | --- | --- |
| `%USERPROFILE%\.opencode\ide\<pid>.json` | VS Code 扩展 | `mcp-shim.js` | `pid`、`port`、`authToken`、`workspaceFolders`、`ideName`、`startedAt` |
| `%USERPROFILE%\.opencode\ide\tui-<pid>.json` | TUI 插件 | VS Code 扩展 | `pid`、`port`、`directory`、`startedAt` |

- 双方都用 `process.kill(pid, 0)` 探活（`EPERM` 视为存活），进程已死或 `port` 非法时跳过该文件。
- 扩展只读取 `tui-*.json`；`mcp-shim` 遍历所有 `*.json`，但要求 `authToken` 为字符串，因此 TUI 锁文件会被自然排除，两类锁互不干扰。
- 扩展退出（`deactivate` / dispose）时停服并删除自己的锁文件；TUI 插件由 `setup` 返回的 cleanup 停止服务并删除 `tui-<pid>.json`。

### 扩展 HTTP 服务

仅监听 `127.0.0.1` 的随机端口，单一端点 `POST /rpc`，请求体 `{ "method": "<name>", "params": { ... } }`，需携带 `Authorization: Bearer <authToken>`（令牌取自扩展锁文件）。请求体上限 1 MiB。

| 情况 | 状态码 | 响应体 |
| --- | --- | --- |
| 非 `POST /rpc` | `404` | `{ "error": "Not found" }` |
| 令牌缺失或错误 | `401` | `{ "error": "Unauthorized" }` |
| 请求体不是合法 JSON | `400` | `{ "error": "Bad request: <详情>" }` |
| 请求体缺少 `method` | `400` | `{ "error": "Bad request: missing method" }` |
| `method: "getCurrentSelection"` | `200` | `{ "result": { file, absolutePath, startLine, endLine, isEmpty, text } }` |
| `method: "getOpenEditors"` | `200` | `{ "result": [ { file, isActive } ] }` |
| `method: "getWorkspaceFolders"` | `200` | `{ "result": [ "<绝对路径>" ] }` |
| 未知 `method` | `404` | `{ "error": "Unknown method: <method>" }` |
| 内部异常 | `500` | `{ "error": "<详情>" }` |

### TUI 插件 HTTP 服务

同样仅监听 `127.0.0.1` 的随机端口（端口随锁文件公布）。

| 方法与路径 | 情况 | 状态码 | 响应体 |
| --- | --- | --- | --- |
| `GET /health` | 恒成功 | `200` | `{ "ok": true, "pid", "port", "directory" }` |
| `POST /append` | 经 `client.tui.appendPrompt` 成功 | `200` | `{ "ok": true, "via": "api" }` |
| `POST /append` | 经 renderer 写入成功 | `200` | `{ "ok": true, "via": "renderer" }` |
| `POST /append` | `text` 缺失 / 非字符串 / 空串 | `400` | `{ "ok": false, "error": "text required" }` |
| `POST /append` | 找不到 composer 节点 | `503` | `{ "ok": false, "error": "composer not found" }` |
| 其它 | — | `404` | `{ "ok": false, "error": "not found" }` |

composer 定位顺序：`renderer.currentFocusedEditor`（需同时满足 duck-type 且带 `getClipboardText`）→ 否则从 `renderer.root` 递归 `getChildren()`，优先带 `getClipboardText` 的节点，否则取第一个 duck-type 匹配节点。写入序列：`insertText` → `getLayoutNode().markDirty()` → `gotoBufferEnd()` → `requestRender()`。

### MCP 协议行为

`mcp-shim.js` 是 stdio MCP 服务器，采用 **NDJSON 行分隔的 JSON-RPC**（非 LSP 的 `Content-Length` 分帧），`stdout` 只承载协议消息，诊断信息一律走 `stderr`。

| 方法 | 行为 |
| --- | --- |
| `initialize` | 回显请求的 `protocolVersion`（缺省 `2024-11-05`），返回 `capabilities.tools` 与 `serverInfo` |
| `ping` | 返回空结果 |
| `tools/list` | 返回三个工具定义 |
| `tools/call` | 转发到扩展 `/rpc`；无可用实例或 HTTP 失败时返回 `isError` 文本 |
| `shutdown` | 返回空结果 |
| `exit` | 关闭 stdin 并退出 |
| `notifications/*` | 静默忽略 |
| 其它未知方法 | `-32601 Method not found` |

实例选择顺序：优先 `workspaceFolders` 覆盖当前工作目录的实例，其次取 `startedAt` 最新者。

## 版本兼容性

当前适配 **opencode 2.0.11**，要点：

- **目录自动发现**：`<全局配置目录>/plugins/<子目录>/tui.ts`（或 `tui.tsx`），目录可以是 junction / 符号链接；最小文件集就是单个 `tui.ts`，无需 `index.ts` 或 `package.json`。
- **模块形状**：`import { Plugin } from "@opencode/plugin/tui"` + `export default Plugin.define({ id, setup(context) { /* ... */ return cleanup } })`；资源清理由 `setup` 返回的 cleanup 承担（2.0.11 没有 `api.lifecycle.onDispose`）。
- **注入路径**：2.0.11 服务端已移除 `/tui/append-prompt` 路由，因此以 renderer 直写为主路径；同时保留前向兼容——若宿主暴露 `client.tui.appendPrompt` 则优先走该 API（响应 `via: "api"`）。
- **历史注记**：早期版本把插件登记在 `tui.json` 的 `plugin` 数组；2.0.11 在 `cli.json` 存在时不读取 `tui.json`，现由 `cli.json` 的 `plugins` 与目录自动发现按 href 去重后加载。
- 旧 dev 分支的 `export default { id, tui(api) }` 形状**在 2.0.11 下不会被加载**。
