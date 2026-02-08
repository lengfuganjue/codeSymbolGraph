# CodeSymbolGraph 产品需求文档 (PRD)

> 版本：v2.1  
> 日期：2026-02-06  
> 状态：待审核  
> 变更说明：v2.0 审核修订——修复 OmniSharp 选型、FQN 闭环、首次体验、验收可操作性等问题

---

## 一、背景与问题

### 1.1 现状

当前使用 Claude Code 作为 AI 编程助手，配合 Rider IDE 进行 Unity 游戏开发（C# + XLua 热更新方案）。

**项目规模：**
- C# 文件：约 10,000 个
- Lua 文件：约 5,000 个
- 使用 Git 多 Worktree 管理多个功能分支，分支间代码约 90% 相同

### 1.2 核心痛点

| 问题 | 描述 | 影响 |
|------|------|------|
| **查代码效率低** | Claude Code 依赖 grep 文本搜索，大项目需要几十秒 | 打断工作流，浪费时间 |
| **理解正确性差** | 同名符号无法区分（如多个 `GetCount()` 方法），误判引用关系 | 生成错误代码，需要人工修正 |
| **跨语言盲区** | Lua 调用 C#（通过 XLua），AI 不理解两者的映射关系 | 无法正确分析调用链和重构影响 |
| **原生 LSP 不可用** | Claude Code 内置 LSP 集成存在 bug，大项目冷启动卡死 | 无法享受语义级代码智能 |

### 1.3 根本原因

Claude Code 原生方案的问题：
1. **LSP 生命周期不可控**：冷启动阻塞主流程，无法后台预加载
2. **无持久化缓存**：每次启动重新初始化 LSP，丢失历史分析结果
3. **无增量更新编排**：不监听文件变化，无法实时同步
4. **不支持跨语言**：C# 和 Lua 的 LSP 相互独立，不知道 XLua 绑定关系

### 1.4 解决思路

**不重新造轮子，而是站在 LSP 的肩膀上**。LSP（OmniSharp / LuaLS）已经实现了完整的语义分析——类型推导、符号解析、引用查找、调用层次等。我们要做的是：

1. **自主管理 LSP 进程**：后台启动、预加载、常驻运行，解决冷启动问题
2. **缓存查询结果**：将 LSP 返回的语义信息持久化到 SQLite，实现毫秒级二次查询
3. **编排增量更新**：监听文件变化，驱动 LSP 增量分析，自动失效相关缓存
4. **桥接跨语言**：在两个 LSP 之上构建 C# ↔ Lua 映射层

---

## 二、产品目标

### 2.1 愿景

为 AI 代码助手提供**IDE 级别精度、毫秒级响应、跨语言感知**的代码语义查询能力，基于 LSP 语义分析而非文本解析。

### 2.2 核心目标

| 目标 | 描述 | 成功指标 |
|------|------|---------|
| **IDE 级精度** | 基于 LSP 语义分析，结果与 Rider/VS Code 一致 | 测试集通过率 > 99%（见 5.5 节） |
| **毫秒级响应** | 缓存热数据，避免每次都走 LSP | 缓存命中时查询响应 < 50ms |
| **跨语言理解** | 打通 C# ↔ Lua 调用链 | 支持 XLua 映射查询 |
| **无感知运行** | 后台自动管理 LSP + 增量更新 | 文件保存后 ≤ 5 秒完成缓存更新 |
| **渐进式可用** | LSP 初始化期间提供基础查询能力 | 启动后立即可做符号名搜索（非首次启动） |

### 2.3 非目标（本期不做）

- 代码自动补全
- 实时诊断/错误检测
- 代码重构执行（只做影响分析）
- 云端部署/多人实时协作
- 自定义解析器（完全依赖现有 LSP）

---

## 三、C# LSP 选型

### 3.1 候选方案对比

| 维度 | OmniSharp | csharp-ls | Roslyn LSP (C# Dev Kit) |
|------|-----------|-----------|------------------------|
| 协议兼容性 | 基本标准 LSP + 大量自定义扩展 | **纯标准 LSP** | 需要 C# Dev Kit 授权 |
| stdio 模式 | 支持，但有非标准行为 | **支持，标准行为** | 不支持独立 stdio |
| workspace/symbol | 有，但返回格式略有差异 | **标准格式** | N/A |
| callHierarchy | 支持 | **支持** | N/A |
| 大项目稳定性 | 中（有已知内存泄漏问题） | **高** | 高但不可独立使用 |
| 安装方式 | dotnet tool 或 standalone release | **dotnet tool (`dotnet tool install csharp-ls`)** | VS Code 扩展内嵌 |
| 维护状态 | 活跃度下降，微软逐步迁移 | **活跃，社区维护** | 微软内部维护 |
| Unity .sln 支持 | ✅ | ✅ | ❌ 需要 Dev Kit |

### 3.2 推荐方案

**首选：csharp-ls**（`dotnet tool install --global csharp-ls`）

理由：
- 纯标准 LSP 协议，没有自定义扩展的坑
- stdio 模式行为可预测
- 基于 Roslyn，语义分析能力与 OmniSharp 一致
- 安装简单，一条命令

**备选：OmniSharp**

如果 csharp-ls 在某些 Unity 项目上有兼容性问题（如特殊的 .sln 结构），回退到 OmniSharp。

### 3.3 实施约束

无论选哪个，实现时必须遵守：
- 通过配置项切换 C# LSP 实现（`config.csharpLsp: 'csharp-ls' | 'omnisharp'`）
- LSP 客户端只使用标准 LSP 方法，不依赖任何实现的自定义扩展
- `csg init` 时自动检测已安装的 C# LSP，给出安装提示

---

## 四、用户与场景

### 4.1 目标用户

**主要用户**：使用 Claude Code 的 Unity 开发者（个人）

### 4.2 使用场景

#### 场景 1：理解陌生模块

> **用户故事**：作为开发者，我需要快速理解一个不熟悉的模块，以便进行修改。

**期望流程**：
1. 让 Claude 查找某个类的定义 → Claude 调用 `csg_find_definition(name="ItemManager")`
2. 工具**自动搜索、排序、返回**精确定义列表（无需人工提供 FQN）
3. Claude 调用 `csg_find_references(name="ItemManager.AddItem")` 查引用 → 工具**内部自动 resolve 到 file+line+column，再查 LSP**
4. 一次交互即可理清模块结构

#### 场景 2：修改代码前的影响分析

**期望流程**：
1. Claude 调用 `csg_impact(name="ItemManager.AddItem")` → 工具内部完成名称解析+引用查询+跨语言查询
2. 返回结果包含 C# 引用列表 + Lua 端 `CS.xxx` 调用列表
3. 按文件分组，显示具体行号

#### 场景 3：跨语言调用追踪

**期望流程**：
1. Claude 调用 `csg_cross_lang(name="CS.Game.ItemManager:AddItem")`
2. 直接返回 C# 类定义位置、完整签名、Lua 端所有调用位置

#### 场景 4：首次启动（冷启动）

> **关键场景**：用户首次安装并运行 `csg start`。

**期望行为**：
1. `csg start` 后台启动 LSP 进程
2. CLI 显示实时进度：`OmniSharp: 初始化中 34%... | LuaLS: 初始化中 78%...`
3. **首次启动期间，缓存为空，查询返回明确提示**：`"LSP initializing (34%), no cache available. Please wait or retry."`
4. LSP 就绪后，自动执行 warmup（遍历所有文件的 documentSymbol，填充符号缓存）
5. warmup 完成后，后续重启即可使用缓存降级

**约束**：
- 首次完整可用需要等待：LSP 初始化（1-3 分钟）+ warmup（2-5 分钟）
- 这是一次性成本，此后每次启动可立即使用缓存
- PRD 不承诺"首次启动即可用"，但承诺"第二次启动即可用"

#### 场景 5：非首次启动（热启动）

**期望行为**：
- 启动后立即可用：基于 SQLite 缓存提供历史查询结果
- LSP 就绪后自动切换到实时查询模式
- 查询返回结果标记 `source: "cache"` 或 `source: "lsp"`

---

## 五、功能需求

### 5.1 MCP 工具设计（核心接口）

> **关键设计原则：所有工具都支持"按名字查"模式。** Claude Code 不可能知道某个符号的精确 FQN、行号、列号。工具内部必须自动完成名称解析。

| 工具名 | 输入（按名字） | 输入（按位置） | 输出 |
|--------|---------------|---------------|------|
| `csg_find_definition` | `name: "ItemManager"` | `file + line + column` | 匹配的定义列表 |
| `csg_find_references` | `name: "ItemManager.AddItem"` | `file + line + column` | 引用列表 + 跨语言引用 |
| `csg_call_chain` | `name: "StartBattle"` | `file + line + column` | 调用链树 |
| `csg_cross_lang` | `name: "CS.Game.ItemManager"` | - | 跨语言映射详情 |
| `csg_impact` | `name: "ItemManager.AddItem"` | `file + line + column` | 影响范围分析 |
| `csg_status` | - | - | 运行状态 |

**"按名字查"的内部流程**：

```
用户输入: name="ItemManager.AddItem"
    │
    ▼
1. 查 symbol_cache（FTS 模糊匹配）
    │
    ├─ 命中 → 取出 file + line + column
    │
    └─ 未命中 → 调 LSP workspace/symbol
                  │
                  ▼
              取出 file + line + column
    │
    ▼
2. 用 file + line + column 调具体 LSP 方法
   (references / callHierarchy / definition)
    │
    ▼
3. 返回结果
```

**这意味着每个"高级"工具内部都依赖 `findDefinition` 做名称解析。如果名称匹配到多个符号，返回所有匹配并让 Claude 选择。**

### 5.2 功能优先级列表

| 优先级 | 功能 | 描述 |
|--------|------|------|
| P0 | LSP 进程管理 | 后台启动/停止/监控 csharp-ls + LuaLS |
| P0 | 符号定义查询 | 支持按名字 + 按位置两种模式 |
| P0 | 符号引用查询 | 支持按名字 + 按位置两种模式 |
| P0 | 增量更新 | 监听文件变化，驱动 LSP 更新 + 缓存失效 |
| P0 | Claude Code 集成 | 通过 MCP 协议暴露查询工具 |
| P0 | 多 Worktree 缓存共享 | 基于内容哈希的缓存复用 |
| P1 | 调用链查询 | 基于 LSP `callHierarchy` |
| P1 | 跨语言映射 | 双 LSP 桥接 C# ↔ Lua |
| P1 | 影响分析 | 组合引用查询 + 跨语言映射 |
| P2 | 工作区符号搜索 | 基于 LSP `workspace/symbol` + FTS 缓存 |
| P2 | 文件结构查询 | 基于 LSP `textDocument/documentSymbol` |

### 5.3 功能详述

#### 5.3.1 LSP 进程管理 (P0)

**管理的 LSP 服务：**

| LSP Server | 语言 | 安装方式 |
|------------|------|---------|
| csharp-ls（首选） | C# | `dotnet tool install --global csharp-ls` |
| OmniSharp（备选） | C# | standalone release 或 `dotnet tool install --global omnisharp` |
| LuaLS (sumneko) | Lua | GitHub Release 或包管理器 |

**生命周期：**
- `csg start` 时后台启动两个 LSP 进程
- LSP 进程加载项目（csharp-ls 1-3 分钟，LuaLS 约 30 秒）
- 加载完成后常驻内存，响应查询
- `csg stop` 时优雅关闭

**健康检查：**
- 每 30 秒检查 LSP 进程存活状态和响应延迟
- 进程崩溃后自动重启（指数退避，最多 5 次）
- 记录 LSP 内存使用（不设硬性上限，仅报警）

**约束**：
- LSP 内存占用取决于项目规模和复杂度，不预设上限
- 首次运行后记录实际内存用量，写入日志，供用户参考
- 用户可通过配置 `config.maxMemoryMB` 设置软上限（超过时告警，不强杀）

#### 5.3.2 符号定义查询 (P0)

**两种输入模式**：

模式 A — 按名字查（主要模式，Claude Code 使用）：
- `name`: 符号名（必填，支持 FQN 或短名）
- `kind`: 符号类型过滤（可选）

模式 B — 按位置查：
- `file`: 文件路径
- `line`: 行号（1-based）
- `column`: 列号（0-based）

**处理流程**：
1. 模式 A：查缓存 FTS → 命中则直接返回 → 未命中调 LSP `workspace/symbol`
2. 模式 B：直接调 LSP `textDocument/definition`
3. 对结果可选调 `hover` 获取签名（并发执行，不阻塞主流程）
4. 写入缓存

**输出**：
- 匹配的符号列表（最多 10 个），每个包含：
  - `name`, `fqn`, `kind`, `language`
  - `file`, `line`, `column`（精确位置，可用于后续工具调用）
  - `signature`（如有）
  - `source`: `"cache"` | `"lsp"` | `"cache_stale"`

**约束**：
- 缓存命中响应 < 50ms
- LSP 实时查询响应 < 500ms（含超时保护，最长 5 秒）
- 所有 LSP 请求包含 5 秒超时，超时返回错误而非挂起

#### 5.3.3 符号引用查询 (P0)

**两种输入模式**：

模式 A — 按名字查：
- `name`: 符号 FQN 或短名
- 内部先调 `findDefinition(name)` 解析到位置，再调 `references`
- 如果匹配多个符号，对每个都查引用，合并返回（标记来源符号）

模式 B — 按位置查：
- `file`, `line`, `column`

**缓存策略**：
- 引用缓存设置 **TTL = 60 秒**
- 60 秒内相同查询返回缓存
- 超过 60 秒自动走 LSP 刷新
- 原因：引用的跨文件依赖关系复杂，精确失效成本过高，短 TTL 是更好的权衡

#### 5.3.4 增量更新 (P0)

**触发条件**：文件新增/修改/删除

**处理流程**：
1. File Watcher 监听 `.cs` / `.lua` 文件变化
2. 300ms 防抖合并多个变更
3. **正确维护 LSP 文件打开状态**（已打开的文件用 `didChange`，新文件用 `didOpen`，删除的文件用 `didClose`）
4. 失效该文件的符号缓存
5. 标记引用缓存和调用链缓存为 stale（但不删除，等 TTL 过期或下次查询时刷新）
6. 更新状态显示

#### 5.3.5 多 Worktree 缓存共享 (P0)

**方案**：
- 缓存键基于**文件内容哈希**而非路径
- 所有 Worktree 共享同一个缓存数据库
- 每个 Worktree 独立运行 LSP 进程
- 但符号缓存可跨 Worktree 复用（同内容=同缓存）
- 引用缓存和调用链缓存**不跨 Worktree 共享**（因为项目上下文不同）

#### 5.3.6 跨语言映射 (P1)

**数据来源**（双 LSP + 正则扫描）：

| 信息 | 来源 | 方法 |
|------|------|------|
| Lua 端所有 `CS.xxx` 调用 | Lua 文件 | 正则扫描 |
| C# 端对应符号定义 | csharp-ls | `workspace/symbol` + 验证 |
| Lua 端别名 (`local X = CS.xxx`) | Lua 文件 | 正则扫描 + LuaLS references |

**性能约束**：
- 全量扫描时，先对 C# 类名去重（2000 调用 → ~200 个唯一类名）
- 批量查询去重后的类名（200 次 workspaceSymbol，而非 2000 次）
- 方法级验证在本地匹配（不额外请求 LSP）

**已知不支持的 XLua 调用模式**：
- `_G[dynamicName]()` — 动态字符串构造的调用
- 通过 `require` 间接引用的 CS 对象
- `CS.xxx` 赋值到 table 字段后的间接调用（如 `self.mgr = CS.xxx; self.mgr:Method()`）

---

## 六、非功能需求

### 6.1 性能

| 指标 | 要求 |
|------|------|
| LSP 初始化时间 | csharp-ls ≤ 3 分钟，LuaLS ≤ 1 分钟 |
| 缓存命中查询 | < 50ms |
| LSP 实时查询 | < 500ms（definition）、< 1s（references） |
| LSP 请求超时 | 所有 LSP 请求硬超时 5 秒，超时返回错误 |
| 增量更新延迟 | ≤ 5 秒 |
| 调用链查询 | < 2s（深度 3 以内） |
| 缓存磁盘占用 | < 200MB |

注意：LSP 内存占用取决于项目，不设固定上限。首次运行后在 `csg status` 中展示实际用量。

### 6.2 可靠性

| 指标 | 要求 |
|------|------|
| LSP 进程崩溃恢复 | 自动重启，指数退避，最多 5 次 |
| LSP 请求超时保护 | 所有请求 5 秒超时，不会无限挂起 |
| 缓存数据一致性 | 符号缓存按文件失效；引用缓存 TTL 60 秒自动过期 |
| 降级策略 | LSP 不可用时返回缓存数据（标记 `source: cache_stale`） |
| 首次使用 | 无缓存时返回明确错误提示，不返回空数据假装成功 |
| 错误隔离 | 单文件 LSP 错误不影响其他查询 |

### 6.3 易用性

| 指标 | 要求 |
|------|------|
| 安装 | `npm install -g codesymbolgraph` |
| 依赖检测 | `csg init` 自动检测 csharp-ls / OmniSharp / LuaLS，未安装时给出安装命令 |
| 配置 | 零配置启动，自动检测 .sln 文件和 Lua 目录 |
| 集成 | 一行配置接入 Claude Code |
| Windows 兼容 | 文件路径和 URI 转换正确处理 Windows 反斜杠 |

### 6.4 兼容性

| 平台 | 支持 |
|------|------|
| Windows | ✓ (主要开发平台) |
| macOS | ✓ |
| Linux | ✓ |
| Node.js | ≥ 18.0 |
| .NET SDK | ≥ 6.0（csharp-ls 运行依赖） |

### 6.5 精度保证与验收方法

**验收方法：自动化测试集**

准备一个 test fixture 项目（~50 个 C# 文件 + ~20 个 Lua 文件），覆盖以下语法特性：

| 测试类别 | 用例数 | 覆盖特性 |
|---------|--------|---------|
| 符号定义 | 30 | 普通类、泛型类、partial 类、嵌套类、扩展方法、接口、枚举 |
| 符号引用 | 20 | 直接调用、多态调用、扩展方法调用、属性访问、LINQ |
| 调用链 | 10 | 直接调用链、递归、跨类调用 |
| 跨语言 | 20 | CS.xxx 直接调用、别名调用、嵌套命名空间 |

每个用例包含：
- 输入（符号名或位置）
- 预期输出（ground truth：定义位置或引用列表）
- 验证脚本自动对比

**验收标准**：
- 符号定义：30/30 通过
- 符号引用：19/20 通过（允许 1 个边界 case）
- 调用链：9/10 通过
- 跨语言：18/20 通过

---

## 七、错误处理场景

以下场景必须有明确的处理行为，不允许 AI 实现时自由发挥：

| 场景 | 期望行为 |
|------|---------|
| .sln 文件不存在 | `csg init` 报错 "No .sln file found"，提示手动指定路径 |
| .sln 文件损坏或引用缺失项目 | csharp-ls 会部分加载，`csg status` 显示加载的项目数和失败项目列表 |
| csharp-ls / LuaLS 未安装 | `csg init` 检测后给出安装命令；`csg start` 检测后拒绝启动并提示 |
| C# 文件有语法错误 | LSP 跳过该文件的分析，其他文件不受影响；`csg status` 可查看错误文件列表 |
| `CS.xxx` 调用指向 Unity 引擎内部类（不在 .sln 中） | 跨语言映射标记为 `unresolved`，不报错，在返回中说明原因 |
| LSP 请求超时（5 秒） | 返回 `{ success: false, error: { code: "LSP_TIMEOUT", message: "..." } }`，不挂起 |
| 按名字查找匹配到 0 个符号 | 返回空列表 `{ results: [], count: 0 }`，不报错 |
| 按名字查找匹配到 > 10 个符号 | 只返回前 10 个（按相关性排序），并附 `truncated: true` |
| SQLite 数据库损坏 | 删除重建，记录日志，提示用户执行 `csg warmup` |

---

## 八、交互设计

### 8.1 CLI 命令

| 命令 | 功能 | 行为详述 |
|------|------|---------|
| `csg init` | 初始化项目 | 1) 搜索 .sln 文件 2) 检测 csharp-ls / LuaLS 安装 3) 自动识别 Lua 目录 4) 生成 `.codesymbolgraph/config.json` 5) 提示添加到 .gitignore |
| `csg start` | 启动后台服务 | 1) 验证 init 已完成 2) 启动 LSP 3) 启动 File Watcher 4) 启动 MCP Server (stdio) 5) 首次启动时 LSP 就绪后自动 warmup |
| `csg stop` | 停止服务 | 优雅关闭所有组件，保留缓存 |
| `csg status` | 查看状态 | LSP 状态 + 内存用量 + 缓存统计 + 错误文件列表 |
| `csg warmup` | 预热缓存 | 遍历所有文件调 documentSymbol 填充符号缓存 |
| `csg mcp` | MCP 模式 | 以 stdio MCP Server 运行，供 Claude Code 集成 |

### 8.2 `csg init` 输出示例

```
🔍 检测项目...

✅ 找到 .sln 文件: BallClient.sln
✅ C# 文件: 10,234 个 (Assets/Scripts/)
✅ Lua 文件: 5,012 个 (Assets/LuaScripts/)

🔍 检测 LSP...

✅ csharp-ls: v0.13.0 (dotnet tool)
✅ lua-language-server: v3.9.1 (/usr/local/bin/)

📄 已生成配置: .codesymbolgraph/config.json

💡 建议: 将 .codesymbolgraph/ 添加到 .gitignore
```

### 8.3 `csg init` 失败示例

```
🔍 检测项目...

✅ 找到 .sln 文件: BallClient.sln

🔍 检测 LSP...

❌ csharp-ls 未安装
   安装命令: dotnet tool install --global csharp-ls
   
✅ lua-language-server: v3.9.1

⚠️  请安装缺失的 LSP 后重新运行 csg init
```

### 8.4 Claude Code 集成

配置文件 `~/.claude/mcp.json`：
```json
{
    "mcpServers": {
        "codesymbolgraph": {
            "command": "csg",
            "args": ["mcp"]
        }
    }
}
```

---

## 九、验收标准

### 9.1 MVP 验收（Phase 1-2）

- [ ] `csg init` 能正确检测 .sln + LSP 安装状态
- [ ] csharp-ls 能正确加载 10,000 C# 文件的 .sln 项目
- [ ] LuaLS 能正确加载 5,000 Lua 文件的工作区
- [ ] LSP 崩溃后自动重启（验证：手动 kill 进程后观察恢复）
- [ ] 所有 LSP 请求有 5 秒超时保护（验证：断开 LSP 连接后查询不挂起）
- [ ] `csg_find_definition(name="PlayerManager")` 返回正确结果
- [ ] `csg_find_references(name="PlayerManager.Init")` 返回正确引用列表
- [ ] 文件修改后 5 秒内符号缓存更新
- [ ] Claude Code 能通过 MCP 调用查询工具
- [ ] Windows 路径正确处理（`C:\Users\...` → `file:///C:/Users/...`）
- [ ] 自动化测试集通过率达标

### 9.2 完整版验收（Phase 3-4）

- [ ] `csg_cross_lang(name="CS.Game.ItemManager")` 返回正确映射
- [ ] 跨语言映射自动化测试 18/20 通过
- [ ] `csg_call_chain` 正确展开调用链（含环检测）
- [ ] `csg_impact` 组合返回 C# 引用 + Lua 跨语言调用

---

## 十、风险与对策

| 风险 | 可能性 | 影响 | 对策 |
|------|--------|------|------|
| csharp-ls 对 Unity .sln 兼容性问题 | 中 | 无法加载项目 | 配置项切换到 OmniSharp 备选方案 |
| LSP 初始化过慢（> 5 分钟） | 中 | 首次使用体验差 | 进度条 + 明确告知用户等待 + 缓存降级 |
| LSP 请求偶发超时 | 中 | 单次查询失败 | 5 秒超时 + 返回缓存降级数据 |
| Lua 别名调用漏检 | 中 | 跨语言映射不完整 | Phase 3 实现别名追踪 |
| `better-sqlite3` 安装需要 C++ 编译工具 | 中 | 安装失败 | 文档说明前置条件；备选 `sql.js` (WASM) |

---

## 十一、里程碑

| 阶段 | 交付内容 | 预计时间 |
|------|---------|---------|
| **Phase 0** | **最小验证原型**：手动启动 csharp-ls → 初始化 → 发一个 workspace/symbol 请求 → 确认能跑通 | **2 天** |
| Phase 1 | LSP 管理 + 基础查询 + 缓存 + MCP + CLI | 2 周 |
| Phase 2 | 增量更新 + 多 Worktree 缓存 + 降级策略 + 自动化测试 | 1.5 周 |
| Phase 3 | XLua 跨语言桥接（含别名追踪） | 1.5 周 |
| Phase 4 | 调用链 + 影响分析 | 1 周 |

**核心功能：6 周 + 2 天原型验证**

Phase 5（Web 可视化）不在核心计划中。如果核心功能提前完成且质量达标，可作为扩展选项。

---

## 十二、MCP 工具统一响应格式

所有 MCP 工具返回统一的 JSON 格式，AI 实现时必须遵守：

```json
{
    "success": true,
    "data": { ... },
    "meta": {
        "source": "cache | lsp | cache_stale",
        "latencyMs": 42,
        "lspStatus": {
            "csharp": "ready",
            "lua": "ready"
        }
    }
}
```

错误时：
```json
{
    "success": false,
    "error": {
        "code": "LSP_TIMEOUT | LSP_NOT_READY | NO_MATCH | INTERNAL_ERROR",
        "message": "Human-readable error description"
    },
    "meta": { ... }
}
```

---

## 附录 A：术语表

| 术语 | 定义 |
|------|------|
| LSP | Language Server Protocol，语言服务协议 |
| csharp-ls | 基于 Roslyn 的 C# Language Server（纯标准 LSP） |
| OmniSharp | 另一个 C# LSP 实现（备选） |
| LuaLS | Lua Language Server（sumneko） |
| FQN | 全限定名，如 `Game.Player.PlayerManager.Init` |
| XLua | 腾讯开源的 Unity Lua 热更新方案 |
| Worktree | Git 多工作目录功能 |
| MCP | Model Context Protocol，Claude Code 的工具协议 |

## 附录 B：参考资料

- [csharp-ls GitHub](https://github.com/razzmatazz/csharp-language-server)
- [Language Server Protocol 规范](https://microsoft.github.io/language-server-protocol/)
- [OmniSharp 文档](https://www.omnisharp.net/)（备选方案）
- [LuaLS 文档](https://luals.github.io/)
- [XLua GitHub](https://github.com/Tencent/xLua)
- [MCP SDK 文档](https://modelcontextprotocol.io/)
