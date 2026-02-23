# CodeSymbolGraph (CSG)

跨语言（C# + Lua）语义查询 MCP 服务器，通过 LSP 为 AI 代码助手提供精确的符号定义、引用、调用链和跨语言映射能力。

主要面向 Unity + XLua 项目（如 BallClient），但架构上也支持其他 C#/Lua 项目。

## 功能

- **符号定义查找** — 按名字或文件位置精确定位，自动过滤生成代码
- **引用查询** — 全项目级引用搜索，含 grep fallback（应对 LSP 遗漏）+ Lua 跨语言 grep
- **调用链分析** — 方法级 incoming/outgoing 调用链，三层防线确保覆盖率
- **跨语言映射** — C# ↔ Lua（XLua）双向追踪，支持别名链解析 + GetComponent 动态绑定
- **继承树查询** — 接口实现类、子类发现，带 Lua 使用计数
- **影响分析** — 修改某个符号会影响哪些文件（含跨语言 Lua grep fallback）
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
| .NET SDK | **9.x**（必须） | csharp-ls 的运行时 |
| csharp-ls | **0.20.0**（必须） | C# 语义分析 |
| lua-language-server | 最新 | Lua 语义分析 |

> **csharp-ls 版本警告**：0.21/0.22 有 NuGet 打包 bug，必须用 0.20.0。
>
> **.NET SDK 版本警告**：**必须用 .NET 9**。csharp-ls 0.20.0 在 .NET 10 下虽然能启动，但 Roslyn workspace API 会静默失败——`workspace/symbol` 永远返回空结果，导致所有 C# 查询不可用。不要尝试用 `DOTNET_ROLL_FORWARD=LatestMajor` 绕过。

### Windows 安装

```bash
# .NET SDK 9（从 https://dotnet.microsoft.com/download/dotnet/9.0 安装）

# csharp-ls
dotnet tool install --global csharp-ls --version 0.20.0

# lua-language-server（下载 release 解压，放到 ~/tools/ 或加入 PATH）
# https://github.com/LuaLS/lua-language-server/releases

# 确保 PATH 包含：
#   - dotnet CLI 路径
#   - %USERPROFILE%\.dotnet\tools（csharp-ls）
#   - lua-language-server 解压目录
```

### macOS 安装

```bash
# .NET SDK 9（brew 默认安装最新版，需指定 @9）
brew install dotnet@9

# 环境变量（写入 ~/.zshrc）
export DOTNET_ROOT="/opt/homebrew/opt/dotnet@9/libexec"
export PATH="$DOTNET_ROOT:$PATH:$HOME/.dotnet/tools"

# csharp-ls（必须 0.20.0）
dotnet tool install --global csharp-ls --version 0.20.0

# lua-language-server
brew install lua-language-server

# Xcode Command Line Tools（better-sqlite3 编译需要）
xcode-select --install
```

### Linux 安装

```bash
# .NET SDK 9（参考 https://learn.microsoft.com/dotnet/core/install/linux）
# 确保安装的是 9.x 版本，不是 10.x

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
- 检测 Unity 项目（新旧格式 csproj 都支持）并合并为单个 `csg-merged-sdk.csproj`
- **提取 DLL 引用**（UnityEngine.dll 等）写入合并后的 csproj（这是 csharp-ls 正常工作的关键）
- 检测 .sln 文件
- 检测 Lua 根目录（自动搜索 `Assets/LuaScripts`、`Lua` 等常见路径）
- 验证 csharp-ls 和 lua-language-server 是否已安装
- 写入配置到 `.codesymbolgraph/config.json`

可选参数：
```bash
csg init --sln path/to/project.sln --lua-root Lua --csharp-lsp-path ~/.dotnet/tools/csharp-ls
```

> **重新 init**：如果 csharp-ls 启动后 `workspace/symbol` 返回空结果，可能是旧的 `csg-merged-sdk.csproj` 缺少 DLL 引用。删除 `csg-merged-sdk.csproj` 和 `csg-sdk.sln` 后重新 `csg init`。

### 3. 启动服务

**方式 A：Daemon 模式（推荐）**

```bash
csg start              # 启动后台服务（默认端口 3870）
csg status             # 查看服务状态
csg query find-definition GotoMask   # CLI 测试
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
| `csg_find_references` | 查找符号的所有引用（含跨语言 Lua grep fallback） |
| `csg_call_chain` | 查询方法调用链（incoming/outgoing/both） |
| `csg_cross_lang` | 查询 C# ↔ Lua 跨语言映射 |
| `csg_impact` | 分析修改影响范围（含跨语言 Lua grep fallback） |
| `csg_hierarchy` | 查询类的继承树（基类 + 子类/实现类，含 Lua 使用计数） |
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
| `csg query <tool> [args]` | 通过 daemon HTTP API 查询 |
| `csg warmup` | 预热缓存（索引所有文件） |

### CLI query 用法

```bash
# 位置参数（第一个参数为 name）
csg query find-definition GotoMask

# key=value 参数
csg query call-chain ClickOption direction=both max_depth=3

# 混合模式（位置参数 + key=value）
csg query call-chain ClickOption direction=outgoing
```

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
| POST | `/api/hierarchy` | 继承树查询 |
| POST | `/api/find-asset` | 资源查找 |
| POST | `/api/find-protocol` | 协议查询 |
| POST | `/api/check-lua` | Lua 检查 |
| POST | `/api/check-csharp` | C# 检查 |

## 配置

配置文件位于 `.codesymbolgraph/config.json`（由 `csg init` 生成）：

```jsonc
{
  "slnPath": "csg-sdk.sln",           // .sln 文件路径（Unity 项目为 csg-sdk.sln）
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

### Windows 特有说明

- `.mcp.json` 中需要 `"command": "cmd", "args": ["/c", "csg", "mcp"]`
- `csharp-ls` 安装在 `%USERPROFILE%\.dotnet\tools\`，确保在 PATH 中
- Unity Hub 默认安装在 `C:\Program Files\Unity\Hub\Editor\`，DLL 引用路径会自动从原始 csproj 提取

### macOS 特有说明

- `npm install` 时 `better-sqlite3` 会编译原生模块，需要 Xcode Command Line Tools
- `.mcp.json` 中直接写 `"command": "csg"` 即可
- **必须用 `dotnet@9`**（`brew install dotnet@9`），设置 `DOTNET_ROOT="/opt/homebrew/opt/dotnet@9/libexec"`
- `csharp-ls` 安装在 `~/.dotnet/tools/`，确保该路径在 `PATH` 中
- `lua-language-server` 通过 brew 安装后自动在 PATH 中

### 性能参考（BallClient, 5311 .cs + 3933 .lua + 345 DLL refs）

| 阶段 | .NET 9 耗时 |
|------|-----------|
| C# 索引 | ~15s |
| Lua 索引 | ~3s |
| XLua 扫描 | ~6s |
| 总就绪时间 | ~25s |

> 之前用 .NET 10 时 C# 索引显示 180s 超时且无结果——切换到 .NET 9 后降至 15s 且正常工作。

Daemon 模式下首次启动需等待索引，之后 MCP 工具调用零延迟。

## 开发

```bash
npm run dev          # TypeScript watch 模式
npm test             # 运行测试（vitest, 118 tests）
npm run build        # 构建
```

## 项目文件说明

| 文件/目录 | 说明 |
|-----------|------|
| `.codesymbolgraph/` | 运行时数据（配置、缓存、daemon info），加入 .gitignore |
| `csg-merged-sdk.csproj` | Unity 项目合并的 csproj（含 Compile 项 + DLL 引用，由 csg init 生成） |
| `csg-sdk.sln` | 对应的 .sln 文件 |
| `docs/scenario-coverage.md` | 场景覆盖分析 & 改进路线图（P0-P3） |

## 故障排查

### csharp-ls workspace/symbol 返回空结果
1. 检查 .NET SDK 版本：`dotnet --version` 必须是 9.x（不是 10.x）
2. 检查 csg-merged-sdk.csproj 是否包含 `<Reference>` + `<HintPath>`（DLL 引用）
3. 如果缺少 DLL 引用，删除 `csg-merged-sdk.csproj` + `csg-sdk.sln` 后重新 `csg init`
4. 检查 daemon 日志中 `C# symbols loaded (N symbols, Xs)` — N 应 > 0

### C# indexed: yes 但查询全部为空
这通常是 .NET 版本问题。`waitForCsharpIndexing` 轮询 180s 超时后会强行标记 `indexed: yes`，但实际上 workspace/symbol 从未返回结果。换回 .NET 9 即可解决。
