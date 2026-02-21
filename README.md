# CodeSymbolGraph (CSG)

跨语言（C# + Lua）语义查询 MCP 服务器，通过 LSP 为 AI 代码助手提供精确的符号定义、引用、调用链和跨语言映射能力。

主要面向 Unity + XLua 项目（如 BallClient），但架构上也支持其他 C#/Lua 项目。

## 功能

- **符号定义查找** — 按名字或文件位置精确定位，自动过滤生成代码
- **引用查询** — 全项目级引用搜索，含 grep fallback（应对 LSP 遗漏）
- **调用链分析** — 方法级 incoming/outgoing 调用链，三层防线确保覆盖率
- **跨语言映射** — C# ↔ Lua（XLua）双向追踪，支持别名链解析
- **影响分析** — 修改某个符号会影响哪些文件
- **资源名反查** — 按短名查找资源完整路径
- **协议查询** — 搜索 Protobuf/EmmyLua 注解定义的消息和配置表
- **Lua/C# 静态检查** — 基于 LuaLS diagnostics / csharp-ls 编译诊断

## 架构

```
src/
├── cli/           # CLI 入口 (csg init/start/stop/mcp/query/...)
├── mcp/           # MCP server + tool 注册
├── daemon/        # HTTP daemon 服务 + 查询处理
├── lsp/           # LSP client 封装 (csharp-ls, LuaLS)
├── core/          # 查询服务、资源索引、协议索引
├── bridge/        # XLua 跨语言桥接（别名链解析引擎）
├── cache/         # SQLite + LRU 缓存
├── watcher/       # 文件监控（chokidar）
├── utils/         # 工具函数
└── config.ts      # 配置定义
```

两种运行模式：
1. **Daemon 模式**（推荐）：`csg start` 启动常驻后台服务，`csg mcp` 自动代理到 daemon，工具调用零延迟
2. **冷启动模式**：`csg mcp` 直接启动 MCP server（首次索引需 60-70s）

## 前置依赖

| 依赖 | 版本要求 | 用途 |
|------|---------|------|
| Node.js | >= 20 | 运行环境 |
| .NET SDK | >= 8.0 | csharp-ls 的运行时 |
| csharp-ls | **0.20.0**（必须） | C# 语义分析 |
| lua-language-server | 最新 | Lua 语义分析 |

> **csharp-ls 版本警告**：0.21/0.22 有 NuGet 打包 bug，必须用 0.20.0。

### Windows 安装

```bash
# .NET SDK（从 https://dotnet.microsoft.com/download 安装）

# csharp-ls
dotnet tool install --global csharp-ls --version 0.20.0

# lua-language-server（下载 release 解压，放到 ~/tools/ 或加入 PATH）
# https://github.com/LuaLS/lua-language-server/releases
```

### macOS 安装

```bash
# .NET SDK
brew install dotnet-sdk

# csharp-ls（必须 0.20.0）
dotnet tool install --global csharp-ls --version 0.20.0

# lua-language-server
brew install lua-language-server

# Xcode Command Line Tools（better-sqlite3 编译需要）
xcode-select --install
```

### Linux 安装

```bash
# .NET SDK（参考 https://learn.microsoft.com/dotnet/core/install/linux）

# csharp-ls
dotnet tool install --global csharp-ls --version 0.20.0

# lua-language-server（下载对应平台 release 或用包管理器）
# https://github.com/LuaLS/lua-language-server/releases
```

## 快速开始

### 1. 构建 CSG

```bash
git clone <repo-url> && cd codeSymbolGraph
npm install
npm run build
npm link    # 全局注册 csg 命令
```

### 2. 初始化目标项目

```bash
cd /path/to/your-unity-project
csg init
```

`csg init` 会自动：
- 检测 Unity 项目并转换旧格式 .csproj 为 SDK-style（合并为单个 `csg-merged-sdk.csproj`）
- 检测 .sln 文件
- 检测 Lua 根目录（自动搜索 `Assets/LuaScripts`、`Lua` 等常见路径）
- 验证 csharp-ls 和 lua-language-server 是否已安装
- 写入配置到 `.codesymbolgraph/config.json`

可选参数：
```bash
csg init --sln path/to/project.sln --lua-root Lua --csharp-lsp-path ~/.dotnet/tools/csharp-ls
```

### 3. 启动服务

**方式 A：Daemon 模式（推荐）**

```bash
csg start              # 启动后台服务（默认端口 3870）
csg status             # 查看服务状态
csg query find-definition '{"name":"ItemManager"}'   # CLI 测试
csg stop               # 停止服务
```

**方式 B：MCP 直连模式**

```bash
csg mcp                # 启动 MCP stdio server（自动检测 daemon，有则代理）
```

### 4. 接入 Claude Code

在目标项目根目录创建 `.mcp.json`：

**macOS / Linux：**
```json
{
  "mcpServers": {
    "csg": {
      "command": "csg",
      "args": ["mcp"]
    }
  }
}
```

**Windows：**
```json
{
  "mcpServers": {
    "csg": {
      "command": "cmd",
      "args": ["/c", "csg", "mcp"]
    }
  }
}
```

> Windows 上 `spawn('csg')` 找不到 npm link 的 `.cmd` 文件，需要通过 `cmd /c` 调用。

然后在项目 `CLAUDE.md` 中说明 MCP 工具的用途（Claude 不会自动发现 MCP 工具的使用场景）。

## MCP 工具列表

| 工具 | 说明 |
|------|------|
| `csg_find_definition` | 查找符号定义位置（支持名字或文件位置） |
| `csg_find_references` | 查找符号的所有引用（含跨语言） |
| `csg_call_chain` | 查询方法调用链（incoming/outgoing/both） |
| `csg_cross_lang` | 查询 C# ↔ Lua 跨语言映射 |
| `csg_impact` | 分析修改影响范围 |
| `csg_find_asset` | 按短名查找资源完整路径 |
| `csg_find_protocol` | 查询协议/配置表定义 |
| `csg_check_lua` | Lua 文件静态检查 |
| `csg_check_csharp` | C# 文件编译检查 |
| `csg_status` | 查看 CSG 运行状态 |

## CLI 命令

| 命令 | 说明 |
|------|------|
| `csg init` | 初始化项目配置 |
| `csg start [--port N]` | 启动 daemon（默认端口 3870） |
| `csg stop` | 停止 daemon |
| `csg status` | 查看服务状态 |
| `csg mcp` | 启动 MCP stdio server（自动代理到 daemon） |
| `csg query <tool> [json]` | 通过 daemon HTTP API 查询 |
| `csg warmup` | 预热缓存（索引所有文件） |

## HTTP API（Daemon 模式）

Daemon 启动后提供以下 HTTP 端点（默认 `http://localhost:3870`）：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | 服务状态 |
| POST | `/api/find-definition` | 查找定义 |
| POST | `/api/find-references` | 查找引用 |
| POST | `/api/call-chain` | 调用链 |
| POST | `/api/cross-lang` | 跨语言映射 |
| POST | `/api/impact` | 影响分析 |
| POST | `/api/find-asset` | 资源查找 |
| POST | `/api/find-protocol` | 协议查询 |
| POST | `/api/check-lua` | Lua 检查 |
| POST | `/api/check-csharp` | C# 检查 |

## 配置

配置文件位于 `.codesymbolgraph/config.json`（由 `csg init` 生成）：

```jsonc
{
  "slnPath": "csg-merged-sdk.sln",   // .sln 文件路径
  "luaRoot": "Lua",                   // Lua 根目录
  "csharpLsp": "csharp-ls",           // C# LSP 类型
  "csharpLspPath": null,              // 自定义 csharp-ls 路径
  "lualsPath": null,                  // 自定义 lua-language-server 路径
  "assetsNameFile": null,             // 资源名映射文件（可选，自动检测）
  "protocolAnnotationsDir": null,     // 协议注解目录（可选，自动检测）
  "advanced": {                       // 高级调优（全部可选）
    "luaVersion": "Lua 5.3",
    "lualsMaxPreload": 10000,
    "lspTimeoutMs": 5000,
    "lspInitTimeoutMs": 60000,
    "cacheMaxEntries": 5000,
    "cacheTtlMinutes": 10,
    "extraThirdPartyNamespaces": []
  }
}
```

## 跨平台注意事项

项目使用 `path.join`/`path.resolve` + 统一的 `replace(/\\/g, '/')` 路径归一化，**Windows / macOS / Linux 均可运行**，无平台特定代码。

### macOS 特有说明

- `npm install` 时 `better-sqlite3` 会编译原生模块，需要 Xcode Command Line Tools
- `.mcp.json` 中直接写 `"command": "csg"` 即可，不需要 Windows 的 `cmd /c` hack
- `csharp-ls` 安装在 `~/.dotnet/tools/`，确保该路径在 `PATH` 中（`export PATH="$HOME/.dotnet/tools:$PATH"`）
- `lua-language-server` 通过 brew 安装后自动在 PATH 中

### 性能参考（BallClient, 6896 .cs + 3897 .lua）

| 阶段 | 耗时 |
|------|------|
| C# 索引 | ~38-50s |
| XLua 扫描 | ~20s |
| 总就绪时间 | ~60-70s |

Daemon 模式下首次启动需等待索引，之后 MCP 工具调用零延迟。

## 开发

```bash
npm run dev          # TypeScript watch 模式
npm test             # 运行测试（vitest）
npm run build        # 构建
```

## 项目文件说明

| 文件/目录 | 说明 |
|-----------|------|
| `.codesymbolgraph/` | 运行时数据（配置、缓存、daemon info），加入 .gitignore |
| `csg-merged-sdk.csproj` | Unity 项目转换后的合并 csproj（由 csg init 生成） |
| `csg-merged-sdk.sln` | 对应的 .sln 文件 |
