# vscode-opencode-bridge

极简的 VS Code ↔ opencode 桥接扩展与 MCP 服务器，**运行期零依赖**（仅 Node 内置模块）。

源码使用 TypeScript（`src/`），由 `tsc` 编译为仓库根目录的 `extension.js` / `mcp-shim.js`——VS Code 与 opencode 只加载编译产物，因此 junction、`package.json` 的 `main`、`opencode.json` 的 MCP 命令路径全部无需变更。

## 项目简介

本扩展替代 opencode 官方 VS Code 扩展，承担两件事：

1. **编辑器侧（源码 `src/extension.ts` → 产物 `extension.js`）**
   - `Ctrl+Alt+K`（macOS 为 `Cmd+Alt+K`）插入当前文件的引用：
     - 空选区 → `@相对路径`
     - 单行选区 → `@相对路径#L12`
     - 多行选区 → `@相对路径#L12-30`
   - 若存在活动终端，引用直接发送到该终端；否则写入剪贴板并弹出提示。
   - 若选中文件位于某个运行中的 opencode TUI 会话目录内（`tui-<pid>.json` 锁文件），则优先**跨终端直连注入** TUI 输入框（见下文「TUI 直连注入」）；目录不匹配或注入失败才回退到活跃终端 / 剪贴板。
   - 扩展激活时（`onStartupFinished`）在 `127.0.0.1` 的随机端口启动一个仅监听本机的 HTTP 服务（`POST /rpc`，Bearer 令牌鉴权），并把连接信息写入锁文件 `%USERPROFILE%\.opencode\ide\<pid>.json`。

2. **MCP 侧（源码 `src/mcp-shim.ts` → 产物 `mcp-shim.js`）**
   - 独立的 stdio MCP 服务器（NDJSON 行分隔的 JSON-RPC，非 LSP 的 `Content-Length` 分帧）。
   - 扫描 `%USERPROFILE%\.opencode\ide\*.json`，过滤已死进程，优先匹配当前工作目录，其次取最新启动的实例，然后经 HTTP 转发到 VS Code 扩展。
   - 向 opencode 暴露三个工具：
     - `getCurrentSelection`：当前选区（文件、行号范围、选中文本）
     - `getOpenEditors`：当前打开的编辑器文件列表
     - `getWorkspaceFolders`：工作区根目录列表
   - 无可用 VS Code 实例时，`initialize` / `tools/list` 仍正常响应，仅工具调用返回 `isError` 内容，避免 opencode 因握手失败报错。

## 目录结构

```
vscode-opencode-bridge/
├── src/
│   ├── extension.ts                   # VS Code 扩展源码：HTTP 桥 + 命令实现
│   └── mcp-shim.ts                    # stdio MCP 服务器源码
├── plugins/
│   └── tui-append-http/
│       ├── tui.ts                     # opencode 2.0.11 TUI 插件（TS 源码直跑，不参与 tsc 构建）
│       ├── tsconfig.json              # 插件独立类型检查配置（noEmit）
│       └── types/                     # 宿主 API 的 ambient 声明（不参与运行）
├── tsconfig.json                      # 根 tsc 配置（strict，输出到仓库根）
├── package.json                       # 扩展清单（命令、快捷键、激活事件、engines、scripts、devDependencies）
├── extension.js                       # 【构建产物】src/extension.ts 编译结果（gitignore）
├── mcp-shim.js                        # 【构建产物】src/mcp-shim.ts 编译结果（gitignore）
├── README.md
├── package-lock.json
└── .gitignore
```

> 修改 `src/` 或 `plugins/` 下的源码后必须 `npm run build`，否则加载的仍是旧产物。

运行时产物（不纳入版本管理）：

```
%USERPROFILE%\.opencode\ide\<pid>.json        # 扩展写出的实例锁文件（含 port / authToken / workspaceFolders）
%USERPROFILE%\.opencode\ide\tui-<pid>.json    # TUI 插件写出的实例锁文件（含 port / directory / startedAt）
```

## 开发

克隆后先初始化（安装 devDependencies 并编译出 `extension.js` / `mcp-shim.js`）：

```bash
npm install
npm run build
```

常用脚本：

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 按根 `tsconfig.json` 编译 `src/` → 仓库根 `extension.js` / `mcp-shim.js` |
| `npm run watch` | 同上，watch 模式 |
| `npm run check` | 类型检查：`src/` 与 `plugins/tui-append-http/`（均 `--noEmit`，strict 全开） |

约定：

- `src/` 采用 strict TypeScript（`noUncheckedIndexedAccess` / `noImplicitReturns` / `noUnusedLocals` 等全开），零隐式 any。
- 编译产物必须落在仓库根，才能让 `package.json` 的 `main`、junction 路径与 `opencode.json` 的 MCP 命令路径保持不变。
- `plugins/tui-append-http/tui.ts` 由 opencode 的 Bun 宿主**直接加载 TS 源码**，不参与 `npm run build`；它拥有独立的 `tsconfig.json` 与 `types/*.d.ts`（对 `@opencode/plugin/tui` 与 Bun 全局的 ambient 声明），仅供 `npm run check` 使用。
- `extension.js` / `mcp-shim.js` 是构建产物、不进版本库（见 `.gitignore`），请勿手工编辑。

## 安装方式（junction 方案）

扩展通过 **目录联接（junction）** 安装到 VS Code 扩展目录，使仓库成为唯一数据源，无需打包 `.vsix`，也无需重复拷贝：

```cmd
mklink /J "C:\Users\caoren\.vscode\extensions\local.opencode-bridge-0.0.1" "C:\Users\caoren\Develops\vscode-opencode-bridge"
```

要点：

- 目标目录名必须遵循 `<publisher>.<name>-<version>` 约定（此处为 `local.opencode-bridge-0.0.1`），否则 VS Code 不会将其识别为扩展。
- junction 需要管理员权限或开发者模式；在 `cmd` 中执行（PowerShell 的 `New-Item -ItemType Junction` 亦可）。
- 安装后 `code --list-extensions` 应列出 `local.opencode-bridge`。

## 更新流程

1. 直接修改仓库中的源码（`src/extension.ts` / `src/mcp-shim.ts` / `package.json`）。
2. 执行 `npm run build` 重新生成 `extension.js` / `mcp-shim.js`。
3. 在 VS Code 中执行 `Developer: Reload Window` 即可生效——扩展目录通过 junction 指向仓库，无需重新拷贝文件。
4. `mcp-shim.js` 由 opencode 每次启动 MCP 服务器时读取，重启 opencode 会话即可加载新版本。
5. 若 VS Code 的扩展登记损坏（例如 `code --list-extensions` 不再列出该扩展，或扩展面板报错），按下面步骤重建：

```cmd
rmdir "C:\Users\caoren\.vscode\extensions\local.opencode-bridge-0.0.1"
mklink /J "C:\Users\caoren\.vscode\extensions\local.opencode-bridge-0.0.1" "C:\Users\caoren\Develops\vscode-opencode-bridge"
```

注意：删除 junction 必须用 `rmdir`（或 `Remove-Item` 后确认），**不要**用会递归删除目标内容的命令，以免误删仓库文件。

## TUI 直连注入

让 `Ctrl+Alt+K` 把文件引用注入**任意终端里运行的 opencode TUI 输入框**，不再依赖 VS Code 集成终端或剪贴板兜底。

**架构（一句话）**：

```
VS Code 扩展 --POST 127.0.0.1:<port>/append--> TUI 插件 (plugins/tui-append-http/tui.ts)
             --> api.client.tui.appendPrompt()（前向兼容，2.0.11 服务端已无此路由）
                 否则 renderer 兜底：定位 TextareaRenderable -> insertText -> 光标移到末尾 -> 重绘
```

**插件机制（opencode 2.0.11）**：

- 2.0.11 只**自动发现目录**：`<全局配置目录>/plugins/<子目录>/tui.ts`（或 `tui.tsx`），目录可以是 junction / 符号链接。最小文件集就是单个 `tui.ts`，无需 `index.ts` 或 `package.json`。
- 模块形状为 `import { Plugin } from "@opencode/plugin/tui"` + `export default Plugin.define({ id, setup(context) { ... return cleanup } })`。
- 旧版（dev 分支）的 `export default { id, tui(api) }` 与 `api.lifecycle.onDispose` **在 2.0.11 下不会被加载**；资源清理由 `setup` 返回的 cleanup 函数承担。
- 2.0.11 服务端已移除 `/tui/append-prompt` 路由，因此注入以 renderer 为主路径。

**启用前提**：

1. 插件目录已通过 **junction** 暴露给全局配置目录（单一数据源，改仓库即改插件）：

   ```cmd
   mklink /J "C:\Users\caoren\.config\opencode\plugins\tui-append-http" "C:\Users\caoren\Develops\vscode-opencode-bridge\plugins\tui-append-http"
   ```

2. 全局 CLI 配置 `%USERPROFILE%\.config\opencode\cli.json` 的 `plugins` 数组注册该目录（相对路径基于 `cli.json` 所在目录；指向目录时若目录内无 tui 入口会弹 toast，便于排查）：

   ```json
   "plugins": [
     "oh-my-opencode-slim",
     "./plugins/tui-append-http"
   ]
   ```

   自动发现与 `plugins` 注册按 href 去重，不会重复加载。`tui.json` 在 `cli.json` 存在时不被 2.0.11 读取，条目保留仅作历史记录。
3. 插件加载成功会在 TUI 弹出 toast：`append-http / listening on 127.0.0.1:<port>`。
4. VS Code 侧执行 `Developer: Reload Window`，让扩展加载新的命令逻辑。

**锁文件**：

TUI 插件启动时在 `127.0.0.1` 上监听随机端口，并把实例信息写到：

```
%USERPROFILE%\.opencode\ide\tui-<pid>.json
{ "pid": ..., "port": ..., "directory": <TUI 启动目录>, "startedAt": ... }
```

插件 dispose 时（TUI 退出）会停止 HTTP 服务并删除该锁文件。扩展只扫描 `tui-` 前缀的文件，不会碰 MCP 用的 `<pid>.json` 锁文件。

**HTTP 契约**（锁文件与路由均为扩展侧依赖，勿随意变更）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 返回 `{ ok: true, pid, port, directory }` |
| `POST` | `/append` | JSON `{ text }`；成功 `{ ok: true, via: "renderer" \| "api" }`；`text` 非字符串或为空 → `400 { ok: false, error: "text required" }`；找不到 composer → `503 { ok: false, error: "composer not found" }` |

composer 定位顺序：`renderer.currentFocusedEditor`（需同时满足 duck-type 且带 `getClipboardText`）→ 否则从 `renderer.root` 递归 `getChildren()`，优先带 `getClipboardText` 的节点，否则取第一个 duck-type 匹配节点。

**快捷键优先级链**（`opencodeBridge.insertFileReference`）：

1. **TUI 直连**：扫描 `~/.opencode/ide/tui-*.json`，过滤死进程，仅保留目录匹配的实例（见下方「目录兼容性」）；多个匹配时选 `directory` 最长（最具体）者。`POST /append`（2 秒超时）成功即提示 `opencode-bridge: sent to opencode TUI`。
2. **活动终端**：`terminal.sendText` 发送到当前活动终端（仅 `vscode.window.activeTerminal`，不按名查找、不自动新建）。
3. **剪贴板兜底**：无活动终端时写入剪贴板并提示。

**目录兼容性**：

判断基准是**选中文件自身的路径**，而不是编辑器所在的 workspace folder。比较前双方统一小写、`\` 转 `/`、去掉尾部 `/`，再做**路径段级**前缀匹配：

- 匹配条件：`filePath === directory` 或 `filePath.startsWith(directory + "/")`，即文件位于该 TUI 会话打开目录**之内**（含子目录）。
- 段边界判断可避免 `foo/bar2/x.cpp` 误配到 `/foo/bar`。
- **不匹配即跳过**：若没有任何 TUI 实例的 `directory` 覆盖该文件（例如 TUI 在别的目录启动），不会回退到「最新实例」，而是直接落到活跃终端 / 剪贴板，避免把引用误注入到无关会话。

## opencode MCP 配置

在 opencode 全局配置 `%USERPROFILE%\.config\opencode\opencode.json` 的 `mcp.servers` 下注册：

```json
{
  "mcp": {
    "servers": {
      "vscode": {
        "type": "local",
        "command": [
          "node",
          "C:\\Users\\caoren\\.vscode\\extensions\\local.opencode-bridge-0.0.1\\mcp-shim.js"
        ],
        "enabled": true
      }
    }
  }
}
```

说明：

- 配置中的路径指向 **junction 路径**（`~/.vscode/extensions/...`），因此不随源码目录的移动或改动而变化，无需维护两份路径。
- 该路径经 junction 直达本仓库的 `mcp-shim.js`，修改源码后无需修改此配置。

## 环境要求

- Node.js 18+（依赖全局 `fetch`）
- VS Code 1.85.0 及以上
