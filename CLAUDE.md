# CodeSymbolGraph 项目指南

## 项目概要

TypeScript/Node.js MCP 服务器，通过 LSP（csharp-ls + LuaLS）为 AI 代码助手提供跨语言（C# + Lua）语义查询。主要面向 Unity + XLua 项目。

## 构建和测试

```bash
npm run build        # 编译 TypeScript
npm test             # 运行测试（vitest, 100+ 单测）
npm run dev          # watch 模式开发
npm link             # 全局注册 csg 命令
```

## 项目结构

```
src/
├── cli/index.ts           # CLI 入口 (csg init/start/stop/mcp/query)
├── mcp/server.ts          # MCP stdio server
├── mcp/tools.ts           # 10 个 MCP 工具注册
├── daemon/http-server.ts  # HTTP daemon 服务
├── daemon/query-handler.ts# 共享查询逻辑（MCP 和 HTTP 复用）
├── lsp/lsp-client.ts      # LSP 客户端（通用，管理子进程 + JSON-RPC）
├── lsp/lsp-manager.ts     # 双 LSP 管理（csharp-ls + LuaLS）
├── core/query-service.ts  # 核心查询服务（定义、引用、调用链、grep fallback）
├── core/asset-index.ts    # 资源名反查索引
├── core/protocol-index.ts # 协议/配置表索引
├── bridge/xlua-bridge.ts  # XLua 跨语言桥接（别名链解析引擎）
├── cache/cache-manager.ts # SQLite 持久缓存 + LRU 内存缓存
├── watcher/file-watcher.ts# 文件变更监控
├── utils/unity-csproj.ts  # Unity 旧格式 csproj → SDK-style 转换
├── utils/timeout.ts       # LspTimeoutError 定义
├── utils/snippet.ts       # 代码片段提取
├── utils/uri.ts           # URI/路径工具
└── config.ts              # 配置接口和默认值
```

## 关键技术决策

### csharp-ls
- **必须用 0.20.0**（0.21/0.22 有 NuGet 打包 bug）
- 初始化时必须响应 `window/workDoneProgress/create`、`workspace/configuration`、`client/registerCapability`，否则 LSP 永远不加载
- `workspace/symbol` 的 `containerName` 始终为 null，名字格式为 `ReturnType Container.Member(params)`，需正则解析
- 对 virtual/override 方法的 callHierarchy/references 常返回空 → 三层防线：callHierarchy → references → grep+documentSymbol

### Unity csproj 转换
- Unity 生成的旧格式 .csproj 不被 csharp-ls 支持
- `src/utils/unity-csproj.ts` 将所有有效 .csproj 的 `<Compile>` 项合并为单个 SDK-style `csg-merged-sdk.csproj`
- TargetFramework 用 `netstandard2.1`

### XLua 别名链解析
- 两阶段扫描：Phase1 提取原始赋值 → Phase2 迭代解析链
- 支持多级链如 `Yoozoo=CS.Yoozoo` → `C_GameHelper=Yoozoo.Gta.Common.GameHelper`
- 引擎 API 别名（UnityEngine/System）不跟踪调用
- `bridge/xlua-bridge.ts` 是核心文件

### 缓存策略
- 空结果不缓存（避免后续查询持续返回 0）
- LSP 超时结果不缓存（下次可重试 LSP）
- grep 补充阈值 100（覆盖 csharp-ls 遗漏的 references）

### 进程管理
- cleanup handler 必须在 startAll() 之前注册
- MCP stdio server 监听 `process.stdin.on('end')` 处理 client 断开
- Windows 上 Ctrl+C 信号会先传播到子进程，`stop()` 必须先设 state='stopped' 再清理

## 运行模式

1. **Daemon 模式**（推荐）：`csg start` → HTTP 服务 + 常驻 LSP；`csg mcp` 自动代理到 daemon
2. **冷启动模式**：`csg mcp` 直接启动（首次索引 60-70s）

## 跨平台

代码无平台特定逻辑（无 `process.platform` 分支），路径统一用 `path.join` + `replace(/\\/g, '/')` 归一化。Windows/macOS/Linux 均可运行。

macOS 上 `.mcp.json` 直接用 `"command": "csg"` 即可（不需要 Windows 的 `cmd /c` hack）。

## 代码风格

- TypeScript strict mode
- ES2022 target, Node16 module
- 用 vitest 做单元测试
- git commit message: `type: 一句话中文描述`
