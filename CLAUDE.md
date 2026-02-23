# CodeSymbolGraph 项目指南

## 项目概要

TypeScript/Node.js MCP 服务器，通过 LSP（csharp-ls + LuaLS）为 AI 代码助手提供跨语言（C# + Lua）语义查询。主要面向 Unity + XLua 项目。

## 构建和测试

```bash
npm run build        # 编译 TypeScript
npm test             # 运行测试（vitest, 118 单测）
npm run dev          # watch 模式开发
npm link             # 全局注册 csg 命令
```

## 项目结构

```
src/
├── cli/index.ts           # CLI 入口 (csg init/start/stop/mcp/query)
├── mcp/server.ts          # MCP stdio server
├── mcp/tools.ts           # 11 个 MCP 工具注册
├── daemon/http-server.ts  # HTTP daemon 服务
├── daemon/query-handler.ts# 共享查询逻辑（MCP 和 HTTP 复用）
├── lsp/lsp-client.ts      # LSP 客户端（通用，管理子进程 + JSON-RPC）
├── lsp/lsp-manager.ts     # 双 LSP 管理（csharp-ls + LuaLS）
├── core/query-service.ts  # 核心查询服务（定义、引用、调用链、继承树、grep fallback）
├── core/asset-index.ts    # 资源名反查索引
├── core/protocol-index.ts # 协议/配置表索引
├── bridge/xlua-bridge.ts  # XLua 跨语言桥接（别名链解析引擎 + GetComponent 字段映射）
├── cache/cache-manager.ts # SQLite 持久缓存 + LRU 内存缓存
├── watcher/file-watcher.ts# 文件变更监控
├── utils/unity-csproj.ts  # Unity csproj 合并转换（支持旧格式 + 新版 SDK-style）
├── utils/timeout.ts       # LspTimeoutError 定义
├── utils/snippet.ts       # 代码片段提取
├── utils/uri.ts           # URI/路径工具
└── config.ts              # 配置接口和默认值
```

## 关键技术决策

### csharp-ls
- **必须用 0.20.0**（0.21/0.22 有 NuGet 打包 bug）
- **必须用 .NET 9 SDK**（.NET 10 下 Roslyn workspace API 静默失败，`workspace/symbol` 永远返回空结果。这是一个已验证的兼容性问题，不要尝试用 `DOTNET_ROLL_FORWARD=LatestMajor` 绕过）
- 初始化时必须响应 `window/workDoneProgress/create`、`workspace/configuration`、`client/registerCapability`，否则 LSP 永远不加载
- `workspace/symbol` 的 `containerName` 始终为 null，名字格式为 `ReturnType Container.Member(params)`，需正则解析
- 对 virtual/override 方法的 callHierarchy/references 常返回空 → 三层防线：callHierarchy → references → grep+documentSymbol

### Unity csproj 合并
- Unity 项目（无论旧格式还是新版 SDK-style）的多个 .csproj 都会被合并为单个 `csg-merged-sdk.csproj`
- `src/utils/unity-csproj.ts` 提取所有有效 .csproj 的 `<Compile>` 项 **和 `<Reference>` + `<HintPath>` DLL 引用**
- DLL 引用（UnityEngine.dll 等）是必须的：没有引用 Roslyn 无法编译，csharp-ls 的 workspace/symbol 会返回空
- 不存在的 DLL 路径会被自动过滤（`fs.existsSync` 检查）
- `isUnityProject()` 检测包含 `UnityProjectGenerator` 的 csproj（不论是否 SDK-style）
- TargetFramework 用 `netstandard2.1`，含 `<NoWarn>` 抑制常见缺失类型警告

### XLua 别名链解析
- 两阶段扫描：Phase1 提取原始赋值 → Phase1.5 提取 GetComponent 字段 → Phase2 迭代解析链
- 支持多级链如 `Yoozoo=CS.Yoozoo` → `C_GameHelper=Yoozoo.Gta.Common.GameHelper`
- GetComponent 动态绑定：`self.field = self:GetComponent(typeof(CS.Type))` 映射 field→Type
- 引擎 API 别名（UnityEngine/System）不跟踪调用
- `bridge/xlua-bridge.ts` 是核心文件

### 跨语言 grep fallback
- 当 `xlua_mappings` 没有某 C# 方法的 Lua 调用记录时，自动 grep Lua 文件查找 `[:.]\s*methodName\s*\(` 模式
- 适用于 `handleFindReferences`、`handleImpact`、`handleCallChain` 三个 handler
- 返回的 crossLanguageImpact 条目标记 `status: "lua_grep"` 以区分来源

### 缓存策略
- 空结果不缓存（避免后续查询持续返回 0）
- LSP 超时结果不缓存（下次可重试 LSP）
- grep 补充阈值 100（覆盖 csharp-ls 遗漏的 references）
- cache-manager 含 `getcomponent_fields` 表存储 GetComponent 字段映射

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

## 改进路线图

详见 `docs/scenario-coverage.md`，按 P0→P3 优先级排列。

### 已完成
- P0-1: Outgoing 调用链（`callHierarchyOutgoing` 已接入 `findCallChain`）
- P0-2: `csg_hierarchy` 工具（接口实现类 + 子类查询，grep 扫描 `.cs` 文件）
- 跨语言 grep fallback（Lua 方法调用 grep 补充 xlua_mappings 盲区）
- GetComponent 动态绑定字段映射

### 待实现（P1）
- `csg_file_deps`：文件依赖图
- Lua require 依赖解析
- MonoBehaviour / `[LuaCallCSharp]` 类扫描
- `csg_rename_preview`：重命名影响预览
