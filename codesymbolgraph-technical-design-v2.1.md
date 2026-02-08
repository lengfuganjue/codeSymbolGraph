# CodeSymbolGraph 详细技术设计

> 状态：技术设计  
> 版本：v2.1  
> 日期：2026-02-06  
> 变更说明：v2.0 审核修订——修复 LSP 协议使用错误、OmniSharp 选型、URI 兼容性、缓存失效漏洞、超时保护等问题
>
> ### v2.0 → v2.1 关键变更一览
>
> | # | 问题 | 修复 |
> |---|------|------|
> | 1 | didOpen 每次调用导致协议违规 | 新增 OpenFileTracker 正确维护打开状态 |
> | 2 | OmniSharp 有非标准行为，选型风险高 | 改为 csharp-ls（纯标准 LSP）为首选，OmniSharp 为备选 |
> | 3 | pathToUri 在 Windows 上生成错误 URI | 统一使用 vscode-uri 库 |
> | 4 | MCP 工具要求用户提供 FQN+行号 | 所有工具支持"按名字查"模式，内部自动 resolve |
> | 5 | 所有 LSP 请求无超时保护 | 新增 withTimeout 包装，统一 5 秒超时 |
> | 6 | 引用缓存跨文件失效遗漏 | 引用缓存改为 TTL=60s 自动过期 |
> | 7 | FTS5 每次写入全量 rebuild | 改为增量同步（触发器或逐条 INSERT） |
> | 8 | memCache.clear() 太粗暴 | 改为按文件路径前缀清除 |
> | 9 | callHierarchy 递归无环检测 | 新增 visited Set 避免死循环 |
> | 10 | XLua 全量扫描逐个验证（O(N)请求） | 先去重类名，批量查询后本地匹配 |
> | 11 | MCP 工具返回格式不统一 | 定义 McpToolResponse 统一格式 |
> | 12 | csg init 行为未定义 | 补充完整实现逻辑 |
> | 13 | 缺少测试策略 | 新增第十一章测试策略 |

---

## 一、架构总览

### 1.1 核心设计理念

**不重新造轮子**：LSP（csharp-ls / LuaLS）已经实现了完整的语义分析。CodeSymbolGraph 的角色是 **LSP 客户端 + 缓存层 + 跨语言桥接 + MCP 适配**。

### 1.2 架构图

```
┌───────────────────────────────────────────────────────────────┐
│                       CodeSymbolGraph                         │
│                                                               │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐  │
│  │ LSP Manager  │  │ Cache Layer  │  │   MCP Server        │  │
│  │             │  │  (SQLite)    │  │                     │  │
│  │ csharp-ls  ◄──►│             ◄──►│  Claude Code        │  │
│  │ LuaLS      │  │ query cache  │  │  (csg_find_def      │  │
│  │             │  │ file index   │  │   csg_find_refs     │  │
│  └──────┬──────┘  │ xlua mapping │  │   csg_call_chain    │  │
│         │         └──────┬───────┘  │   csg_cross_lang    │  │
│  ┌──────┴──────┐         │          │   csg_impact)       │  │
│  │ File Watcher │─────────┘          └─────────────────────┘  │
│  │ (chokidar)  │                                              │
│  └─────────────┘  ┌──────────────┐                            │
│                   │ XLua Bridge  │                            │
│                   │ (跨语言桥接) │                            │
│                   └──────────────┘                            │
└───────────────────────────────────────────────────────────────┘
```

### 1.3 数据流

```
查询请求 (MCP)
    │
    ├─ 输入是"名字" → findDefinition 先解析到 file+line+col
    │
    ▼
┌─────────┐    命中(未过期)  ┌──────────┐
│ 查缓存   │──────────────► │ 返回结果  │
└────┬────┘                └──────────┘
     │ 未命中 / 已过期(TTL)
     ▼
┌─────────────┐            ┌──────────┐
│ 查 LSP       │──────────► │ 写缓存   │──► 返回结果
│ (5s 超时保护) │            └──────────┘
└─────────────┘

文件变更
    │
    ▼
┌─────────┐  维护 open 状态   ┌──────────────┐
│ Watcher  │─────────────────►│ OpenFileTracker│
└────┬────┘                  │ → didOpen/     │
     │                       │   didChange/   │
     ▼                       │   didClose     │
┌─────────────┐              └──────────────┘
│ 缓存失效     │
│ (符号:标stale │
│  引用:等TTL) │
└─────────────┘
```

### 1.4 关键依赖

```json
{
    "dependencies": {
        "vscode-languageserver-protocol": "^3.17.0",
        "vscode-uri": "^3.0.0",
        "@modelcontextprotocol/sdk": "^1.0.0",
        "better-sqlite3": "^11.0.0",
        "chokidar": "^4.0.0",
        "commander": "^12.0.0",
        "glob": "^11.0.0",
        "lodash": "^4.17.21",
        "lru-cache": "^11.0.0",
        "zod": "^3.23.0"
    },
    "devDependencies": {
        "typescript": "^5.5.0",
        "@types/better-sqlite3": "^7.6.0",
        "@types/lodash": "^4.17.0",
        "@types/node": "^20.0.0",
        "vitest": "^2.0.0"
    }
}
```

外部依赖（需要用户安装）：
- **csharp-ls**（首选）：`dotnet tool install --global csharp-ls`
- **OmniSharp**（备选）：standalone release 或 `dotnet tool install --global omnisharp`
- **LuaLS**：GitHub Release 或包管理器

---

## 二、公共工具模块

### 2.1 URI 工具（跨平台）

> **v2.1 修复**：v2.0 中 `file://${abs}` 在 Windows 上生成错误 URI（如 `file://C:\Users\...`）。
> 统一使用 `vscode-uri` 库。

```typescript
// src/utils/uri.ts

import { URI } from 'vscode-uri';
import * as path from 'path';

/** 绝对路径 → file URI（跨平台安全） */
export function pathToUri(absolutePath: string): string {
    return URI.file(absolutePath).toString();
}

/** file URI → 绝对路径 */
export function uriToPath(uri: string): string {
    return URI.parse(uri).fsPath;
}

/** 相对路径 → file URI */
export function relativeToUri(workspaceRoot: string, relativePath: string): string {
    const abs = path.resolve(workspaceRoot, relativePath);
    return pathToUri(abs);
}

/** file URI → 相对路径 */
export function uriToRelative(workspaceRoot: string, uri: string): string {
    const abs = uriToPath(uri);
    return path.relative(workspaceRoot, abs);
}
```

### 2.2 超时包装器

> **v2.1 新增**：所有 LSP 请求必须有超时保护，避免无限挂起。

```typescript
// src/utils/timeout.ts

export class LspTimeoutError extends Error {
    constructor(method: string, timeoutMs: number) {
        super(`LSP request '${method}' timed out after ${timeoutMs}ms`);
        this.name = 'LspTimeoutError';
    }
}

/** 给 Promise 加超时，超时后 reject */
export function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    method: string,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new LspTimeoutError(method, timeoutMs)),
            timeoutMs,
        );

        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); },
        );
    });
}

/** 默认 LSP 请求超时（毫秒） */
export const LSP_TIMEOUT_MS = 5000;
```

### 2.3 统一 MCP 响应格式

> **v2.1 新增**：所有 MCP 工具使用统一的响应结构。

```typescript
// src/utils/mcp-response.ts

export interface McpToolResponse<T = any> {
    success: boolean;
    data?: T;
    error?: {
        code: 'LSP_TIMEOUT' | 'LSP_NOT_READY' | 'NO_MATCH' | 'INTERNAL_ERROR';
        message: string;
    };
    meta: {
        source: 'cache' | 'lsp' | 'cache_stale';
        latencyMs: number;
        lspStatus: {
            csharp: string;  // LspState
            lua: string;     // LspState
        };
    };
}

export function successResponse<T>(
    data: T,
    source: McpToolResponse['meta']['source'],
    latencyMs: number,
    lspStatus: McpToolResponse['meta']['lspStatus'],
): McpToolResponse<T> {
    return { success: true, data, meta: { source, latencyMs, lspStatus } };
}

export function errorResponse(
    code: McpToolResponse['error']['code'],
    message: string,
    latencyMs: number,
    lspStatus: McpToolResponse['meta']['lspStatus'],
): McpToolResponse {
    return {
        success: false,
        error: { code, message },
        meta: { source: 'lsp', latencyMs, lspStatus },
    };
}
```

---

## 三、LSP 客户端管理

### 3.1 LSP 客户端封装

```typescript
// src/lsp/lsp-client.ts

import {
    createConnection,
    StreamMessageReader,
    StreamMessageWriter,
} from 'vscode-languageserver-protocol/node';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { withTimeout, LSP_TIMEOUT_MS, LspTimeoutError } from '../utils/timeout';
import { pathToUri } from '../utils/uri';

export interface LspClientOptions {
    /** LSP server 名称（用于日志） */
    name: string;
    /** 启动命令 */
    command: string;
    /** 启动参数 */
    args: string[];
    /** 工作目录 */
    workspaceRoot: string;
    /** 初始化参数（LSP initializationOptions） */
    initOptions?: Record<string, unknown>;
    /** 健康检查间隔（ms） */
    healthCheckInterval?: number;
}

export type LspState = 'stopped' | 'starting' | 'initializing' | 'ready' | 'error';

export class LspClient extends EventEmitter {
    private process: ChildProcess | null = null;
    private connection: any = null;
    private _state: LspState = 'stopped';
    private restartCount = 0;
    private healthTimer: NodeJS.Timeout | null = null;

    constructor(private options: LspClientOptions) {
        super();
    }

    get state(): LspState { return this._state; }

    async start(): Promise<void> {
        this.setState('starting');

        try {
            // 启动 LSP 进程
            this.process = spawn(this.options.command, this.options.args, {
                cwd: this.options.workspaceRoot,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env },
            });

            // 监听进程退出
            this.process.on('exit', (code, signal) => {
                this.handleProcessExit(code, signal);
            });

            this.process.stderr?.on('data', (data: Buffer) => {
                this.emit('log', { level: 'stderr', message: data.toString() });
            });

            // 建立 LSP 连接
            this.connection = createConnection(
                new StreamMessageReader(this.process.stdout!),
                new StreamMessageWriter(this.process.stdin!),
            );

            this.connection.listen();

            // LSP Initialize
            this.setState('initializing');

            const initResult = await this.connection.sendRequest('initialize', {
                processId: process.pid,
                rootUri: pathToUri(this.options.workspaceRoot),
                capabilities: this.getClientCapabilities(),
                initializationOptions: this.options.initOptions,
            });

            await this.connection.sendNotification('initialized', {});

            this.setState('ready');
            this.restartCount = 0;

            // 启动健康检查
            this.startHealthCheck();

            this.emit('ready', initResult);

        } catch (error) {
            this.setState('error');
            this.emit('error', error);
            throw error;
        }
    }

    async stop(): Promise<void> {
        this.stopHealthCheck();

        if (this.connection) {
            try {
                await this.connection.sendRequest('shutdown');
                await this.connection.sendNotification('exit');
            } catch {
                // 忽略关闭时的错误
            }
        }

        if (this.process) {
            this.process.kill('SIGTERM');
            // 给 5 秒优雅关闭，否则强杀
            setTimeout(() => {
                if (this.process && !this.process.killed) {
                    this.process.kill('SIGKILL');
                }
            }, 5000);
        }

        this.setState('stopped');
    }

    // ===== LSP 请求封装（全部带超时保护） =====
    // v2.1: 所有请求通过 withTimeout 包装

    async definition(uri: string, line: number, character: number): Promise<any> {
        this.ensureReady();
        return withTimeout(
            this.connection.sendRequest('textDocument/definition', {
                textDocument: { uri },
                position: { line, character },
            }),
            LSP_TIMEOUT_MS,
            'textDocument/definition',
        );
    }

    async references(
        uri: string,
        line: number,
        character: number,
        includeDeclaration = false
    ): Promise<any[]> {
        this.ensureReady();
        return withTimeout(
            this.connection.sendRequest('textDocument/references', {
                textDocument: { uri },
                position: { line, character },
                context: { includeDeclaration },
            }),
            LSP_TIMEOUT_MS,
            'textDocument/references',
        );
    }

    async workspaceSymbol(query: string): Promise<any[]> {
        this.ensureReady();
        return withTimeout(
            this.connection.sendRequest('workspace/symbol', { query }),
            LSP_TIMEOUT_MS,
            'workspace/symbol',
        );
    }

    async documentSymbol(uri: string): Promise<any[]> {
        this.ensureReady();
        return withTimeout(
            this.connection.sendRequest('textDocument/documentSymbol', {
                textDocument: { uri },
            }),
            LSP_TIMEOUT_MS,
            'textDocument/documentSymbol',
        );
    }

    async callHierarchyPrepare(
        uri: string,
        line: number,
        character: number
    ): Promise<any[]> {
        this.ensureReady();
        return withTimeout(
            this.connection.sendRequest('textDocument/prepareCallHierarchy', {
                textDocument: { uri },
                position: { line, character },
            }),
            LSP_TIMEOUT_MS,
            'textDocument/prepareCallHierarchy',
        );
    }

    async callHierarchyIncoming(item: any): Promise<any[]> {
        this.ensureReady();
        return withTimeout(
            this.connection.sendRequest('callHierarchy/incomingCalls', { item }),
            LSP_TIMEOUT_MS,
            'callHierarchy/incomingCalls',
        );
    }

    async callHierarchyOutgoing(item: any): Promise<any[]> {
        this.ensureReady();
        return withTimeout(
            this.connection.sendRequest('callHierarchy/outgoingCalls', { item }),
            LSP_TIMEOUT_MS,
            'callHierarchy/outgoingCalls',
        );
    }

    async hover(uri: string, line: number, character: number): Promise<any> {
        this.ensureReady();
        return withTimeout(
            this.connection.sendRequest('textDocument/hover', {
                textDocument: { uri },
                position: { line, character },
            }),
            LSP_TIMEOUT_MS,
            'textDocument/hover',
        );
    }

    // ===== LSP 文件通知 =====
    // 注意：这些是通知（notification），不需要超时包装
    // 但仍需 ensureReady 检查

    async didOpen(uri: string, languageId: string, content: string): Promise<void> {
        this.ensureReady();
        await this.connection.sendNotification('textDocument/didOpen', {
            textDocument: { uri, languageId, version: 1, text: content },
        });
    }

    async didChange(uri: string, content: string, version: number): Promise<void> {
        this.ensureReady();
        await this.connection.sendNotification('textDocument/didChange', {
            textDocument: { uri, version },
            contentChanges: [{ text: content }],
        });
    }

    async didClose(uri: string): Promise<void> {
        this.ensureReady();
        await this.connection.sendNotification('textDocument/didClose', {
            textDocument: { uri },
        });
    }

    async didSave(uri: string): Promise<void> {
        this.ensureReady();
        await this.connection.sendNotification('textDocument/didSave', {
            textDocument: { uri },
        });
    }

    // ===== 内部方法 =====

    private ensureReady(): void {
        if (this._state !== 'ready') {
            throw new Error(`LSP ${this.options.name} is not ready (state: ${this._state})`);
        }
    }

    private setState(state: LspState): void {
        const prev = this._state;
        this._state = state;
        this.emit('stateChange', { from: prev, to: state });
    }

    private getClientCapabilities(): any {
        return {
            textDocument: {
                definition: { dynamicRegistration: false },
                references: { dynamicRegistration: false },
                documentSymbol: {
                    dynamicRegistration: false,
                    hierarchicalDocumentSymbolSupport: true,
                },
                callHierarchy: { dynamicRegistration: false },
                hover: {
                    dynamicRegistration: false,
                    contentFormat: ['markdown', 'plaintext'],
                },
                synchronization: {
                    didSave: true,
                    willSave: false,
                    willSaveWaitUntil: false,
                },
            },
            workspace: {
                symbol: { dynamicRegistration: false },
                workspaceFolders: true,
            },
        };
    }

    private handleProcessExit(code: number | null, signal: string | null): void {
        this.emit('log', {
            level: 'warn',
            message: `LSP ${this.options.name} exited (code: ${code}, signal: ${signal})`,
        });

        if (this._state !== 'stopped') {
            this.setState('error');
            this.tryRestart();
        }
    }

    private async tryRestart(): Promise<void> {
        const maxRestarts = 5;
        const backoffMs = Math.min(1000 * Math.pow(2, this.restartCount), 30000);

        if (this.restartCount >= maxRestarts) {
            this.emit('error', new Error(
                `LSP ${this.options.name} crashed ${maxRestarts} times, giving up`
            ));
            return;
        }

        this.restartCount++;
        this.emit('log', {
            level: 'info',
            message: `Restarting ${this.options.name} in ${backoffMs}ms (attempt ${this.restartCount})`,
        });

        await new Promise(r => setTimeout(r, backoffMs));
        await this.start();
    }

    private startHealthCheck(): void {
        const interval = this.options.healthCheckInterval || 30000;

        this.healthTimer = setInterval(async () => {
            try {
                // 用一个轻量请求测试连接（空查询）
                await withTimeout(
                    this.connection.sendRequest('workspace/symbol', { query: '' }),
                    5000,
                    'healthCheck',
                );

                // 检查内存（仅记录，不强杀）
                if (this.process?.pid) {
                    const memMB = await this.getProcessMemoryMB(this.process.pid);
                    this.emit('healthCheck', { memoryMB: memMB, status: 'ok' });
                }
            } catch (error) {
                this.emit('healthCheck', { status: 'unhealthy', error });
            }
        }, interval);
    }

    private stopHealthCheck(): void {
        if (this.healthTimer) {
            clearInterval(this.healthTimer);
            this.healthTimer = null;
        }
    }

    private async getProcessMemoryMB(pid: number): Promise<number> {
        const { execSync } = require('child_process');
        try {
            if (process.platform === 'win32') {
                const output = execSync(
                    `tasklist /FI "PID eq ${pid}" /FO CSV /NH`
                ).toString();
                const match = output.match(/"([\d,]+)\sK"/);
                return match ? parseInt(match[1].replace(/,/g, '')) / 1024 : 0;
            } else {
                const output = execSync(`ps -o rss= -p ${pid}`).toString().trim();
                return parseInt(output) / 1024;
            }
        } catch {
            return 0;
        }
    }
}
```

### 3.2 LSP 文件打开状态追踪器

> **v2.1 新增**：LSP 协议要求 `didOpen` 只在文件首次打开时调用，已打开的文件用 `didChange`。
> v2.0 中每次文件变更都调 `didOpen` 是协议违规。

```typescript
// src/lsp/open-file-tracker.ts

import { LspClient } from './lsp-client';

/**
 * 维护 LSP 的文件打开状态。
 *
 * LSP 协议规则：
 * - didOpen: 只在文件首次打开时调用
 * - didChange: 已打开的文件内容变化时调用
 * - didClose: 文件关闭后才能再次 didOpen
 * - 对未打开的文件调 didChange 是协议违规
 *
 * 本类确保这些规则被正确遵守。
 */
export class OpenFileTracker {
    /** uri → 当前版本号 */
    private openFiles = new Map<string, number>();

    /** 通知 LSP 文件变更（自动处理 open/change 状态） */
    async notifyChange(
        client: LspClient,
        uri: string,
        languageId: string,
        content: string,
    ): Promise<void> {
        if (this.openFiles.has(uri)) {
            // 已打开 → didChange（递增版本号）
            const version = this.openFiles.get(uri)! + 1;
            this.openFiles.set(uri, version);
            await client.didChange(uri, content, version);
        } else {
            // 未打开 → didOpen
            this.openFiles.set(uri, 1);
            await client.didOpen(uri, languageId, content);
        }
    }

    /** 通知 LSP 文件保存 */
    async notifySave(client: LspClient, uri: string): Promise<void> {
        if (this.openFiles.has(uri)) {
            await client.didSave(uri);
        }
        // 未打开的文件不需要发 save 通知
    }

    /** 通知 LSP 文件删除/关闭 */
    async notifyDelete(client: LspClient, uri: string): Promise<void> {
        if (this.openFiles.has(uri)) {
            await client.didClose(uri);
            this.openFiles.delete(uri);
        }
    }

    /** 检查文件是否已打开 */
    isOpen(uri: string): boolean {
        return this.openFiles.has(uri);
    }

    /** LSP 重启后清空状态（因为新进程不知道旧的 open 状态） */
    reset(): void {
        this.openFiles.clear();
    }

    /** 当前打开的文件数 */
    get openCount(): number {
        return this.openFiles.size;
    }
}
```

### 3.3 LSP Manager（多 LSP 协调）

> **v2.1 变更**：默认使用 csharp-ls，OmniSharp 为可配置备选。

```typescript
// src/lsp/lsp-manager.ts

import { LspClient, LspClientOptions, LspState } from './lsp-client';
import { OpenFileTracker } from './open-file-tracker';
import * as path from 'path';

export type CSharpLspKind = 'csharp-ls' | 'omnisharp';

export interface LspManagerOptions {
    workspaceRoot: string;
    slnPath?: string;
    luaRoot?: string;
    csharpLsp?: CSharpLspKind;        // 默认 'csharp-ls'
    csharpLspPath?: string;           // 自定义路径
    lualsPath?: string;
}

export class LspManager {
    private csharpClient: LspClient;
    private luaLs: LspClient;

    /** v2.1: 每个 LSP 有独立的 OpenFileTracker */
    readonly csharpTracker = new OpenFileTracker();
    readonly luaTracker = new OpenFileTracker();

    constructor(private options: LspManagerOptions) {
        this.csharpClient = new LspClient(this.getCSharpOptions());
        this.luaLs = new LspClient(this.getLuaLSOptions());

        // 转发事件
        for (const client of [this.csharpClient, this.luaLs]) {
            client.on('stateChange', (e) => this.onClientStateChange(client, e));
            client.on('error', (e) => this.onClientError(client, e));
        }

        // LSP 重启后重置 tracker
        this.csharpClient.on('ready', () => this.csharpTracker.reset());
        this.luaLs.on('ready', () => this.luaTracker.reset());
    }

    async startAll(): Promise<void> {
        await Promise.allSettled([
            this.csharpClient.start(),
            this.luaLs.start(),
        ]);
    }

    async stopAll(): Promise<void> {
        await Promise.allSettled([
            this.csharpClient.stop(),
            this.luaLs.stop(),
        ]);
    }

    /** 根据文件类型选择正确的 LSP 客户端 */
    getClientForFile(filePath: string): LspClient {
        if (filePath.endsWith('.cs')) return this.csharpClient;
        if (filePath.endsWith('.lua')) return this.luaLs;
        throw new Error(`Unsupported file type: ${filePath}`);
    }

    /** 根据文件类型选择对应的 OpenFileTracker */
    getTrackerForFile(filePath: string): OpenFileTracker {
        if (filePath.endsWith('.cs')) return this.csharpTracker;
        if (filePath.endsWith('.lua')) return this.luaTracker;
        throw new Error(`Unsupported file type: ${filePath}`);
    }

    /** 根据语言选择 LSP 客户端 */
    getClientForLanguage(language: 'csharp' | 'lua'): LspClient {
        return language === 'csharp' ? this.csharpClient : this.luaLs;
    }

    getStatus(): LspManagerStatus {
        return {
            csharp: {
                state: this.csharpClient.state,
                name: this.options.csharpLsp || 'csharp-ls',
            },
            lua: {
                state: this.luaLs.state,
                name: 'LuaLS',
            },
            allReady: this.csharpClient.state === 'ready' && this.luaLs.state === 'ready',
        };
    }

    private getCSharpOptions(): LspClientOptions {
        const kind = this.options.csharpLsp || 'csharp-ls';

        if (kind === 'csharp-ls') {
            // csharp-ls：纯标准 LSP，通过 dotnet tool 安装
            const command = this.options.csharpLspPath || 'csharp-ls';
            const args: string[] = [];

            // csharp-ls 自动检测 .sln，也可以手动指定
            if (this.options.slnPath) {
                args.push('--solution', this.options.slnPath);
            }

            return {
                name: 'csharp-ls',
                command,
                args,
                workspaceRoot: this.options.workspaceRoot,
                healthCheckInterval: 30000,
            };
        } else {
            // OmniSharp 备选
            const command = this.options.csharpLspPath || 'OmniSharp';
            const args: string[] = [
                '--languageserver',
                '--encoding', 'utf-8',
                '--hostPID', String(process.pid),
            ];

            if (this.options.slnPath) {
                args.push('-s', this.options.slnPath);
            }

            return {
                name: 'omnisharp',
                command,
                args,
                workspaceRoot: this.options.workspaceRoot,
                healthCheckInterval: 30000,
            };
        }
    }

    private getLuaLSOptions(): LspClientOptions {
        const lualsPath = this.options.lualsPath || 'lua-language-server';

        return {
            name: 'luals',
            command: lualsPath,
            args: ['--stdio'],
            workspaceRoot: this.options.luaRoot || this.options.workspaceRoot,
            initOptions: {
                settings: {
                    Lua: {
                        workspace: {
                            library: [],
                            maxPreload: 10000,
                            preloadFileSize: 500,
                        },
                        runtime: {
                            version: 'Lua 5.3',
                        },
                        diagnostics: {
                            enable: false,
                        },
                    },
                },
            },
            healthCheckInterval: 30000,
        };
    }

    private onClientStateChange(client: LspClient, event: any): void {
        this.emit('log', {
            level: 'info',
            message: `LSP state: ${event.from} → ${event.to}`,
        });
    }

    private onClientError(client: LspClient, error: Error): void {
        this.emit('log', {
            level: 'error',
            message: `LSP error: ${error.message}`,
        });
    }

    // 继承 EventEmitter 以转发日志
    private emit(event: string, data: any): void {
        // 转发给外部监听器
    }
}

export interface LspManagerStatus {
    csharp: { state: LspState; name: string };
    lua: { state: LspState; name: string };
    allReady: boolean;
}
```

---

## 四、缓存层

### 4.1 缓存设计原则

- **缓存键基于内容哈希**：同样的文件内容产生同样的符号缓存，支持多 Worktree 共享
- **按文件粒度失效**：文件变更时，标记该文件的符号缓存为 stale
- **引用缓存用 TTL 代替精确失效**：引用涉及跨文件依赖，精确失效成本过高，用 60 秒 TTL 自动过期
- **两级结构**：热数据在内存 LRU，冷数据在 SQLite
- **标记而非删除**：符号缓存失效时标记为 stale，仍可作为降级数据返回
- **内存缓存按文件前缀清除**：不再 clear() 全部（v2.1 修复）

### 4.2 SQLite 表结构

```sql
-- ========== 文件索引 ==========
CREATE TABLE files (
    relative_path TEXT NOT NULL,
    worktree_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,       -- SHA256 前 16 位
    mtime INTEGER NOT NULL,
    size INTEGER NOT NULL,
    language TEXT NOT NULL,            -- 'csharp' | 'lua'
    last_indexed_at INTEGER,
    PRIMARY KEY (relative_path, worktree_id)
);

CREATE INDEX idx_files_hash ON files(content_hash);

-- ========== 符号缓存 ==========
CREATE TABLE symbol_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_hash TEXT NOT NULL,
    file_path TEXT NOT NULL,
    name TEXT NOT NULL,
    fqn TEXT NOT NULL,
    kind INTEGER NOT NULL,             -- LSP SymbolKind 枚举值
    language TEXT NOT NULL,
    container_name TEXT,

    -- 位置（LSP 0-based）
    range_start_line INTEGER NOT NULL,
    range_start_char INTEGER NOT NULL,
    range_end_line INTEGER NOT NULL,
    range_end_char INTEGER NOT NULL,

    -- 签名和文档（从 hover 获取，可为 null）
    signature TEXT,
    doc_comment TEXT,

    -- 缓存元信息
    cached_at INTEGER NOT NULL,
    stale INTEGER DEFAULT 0
);

CREATE INDEX idx_sym_hash ON symbol_cache(content_hash);
CREATE INDEX idx_sym_name ON symbol_cache(name);
CREATE INDEX idx_sym_fqn ON symbol_cache(fqn);
CREATE INDEX idx_sym_file ON symbol_cache(file_path);

-- 全文搜索（通过触发器自动同步，不再手动 rebuild）
CREATE VIRTUAL TABLE symbol_fts USING fts5(
    name,
    fqn,
    signature,
    content='symbol_cache',
    content_rowid='id'
);

-- v2.1: FTS 自动同步触发器（不再 rebuild）
CREATE TRIGGER symbol_fts_insert AFTER INSERT ON symbol_cache BEGIN
    INSERT INTO symbol_fts(rowid, name, fqn, signature)
    VALUES (new.id, new.name, new.fqn, new.signature);
END;

CREATE TRIGGER symbol_fts_delete AFTER DELETE ON symbol_cache BEGIN
    INSERT INTO symbol_fts(symbol_fts, rowid, name, fqn, signature)
    VALUES('delete', old.id, old.name, old.fqn, old.signature);
END;

CREATE TRIGGER symbol_fts_update AFTER UPDATE ON symbol_cache BEGIN
    INSERT INTO symbol_fts(symbol_fts, rowid, name, fqn, signature)
    VALUES('delete', old.id, old.name, old.fqn, old.signature);
    INSERT INTO symbol_fts(rowid, name, fqn, signature)
    VALUES (new.id, new.name, new.fqn, new.signature);
END;

-- ========== 引用缓存 ==========
-- v2.1: 引用缓存使用 TTL 过期策略（60 秒），不依赖精确的跨文件失效
CREATE TABLE reference_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_fqn TEXT NOT NULL,
    target_file TEXT NOT NULL,
    target_line INTEGER NOT NULL,
    target_char INTEGER NOT NULL,

    ref_file TEXT NOT NULL,
    ref_line INTEGER NOT NULL,
    ref_char INTEGER NOT NULL,

    -- v2.1: cached_at 用于 TTL 判断
    cached_at INTEGER NOT NULL
);

CREATE INDEX idx_ref_target ON reference_cache(target_fqn);
CREATE INDEX idx_ref_cached ON reference_cache(cached_at);

-- ========== 调用链缓存 ==========
CREATE TABLE call_chain_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_fqn TEXT NOT NULL,
    root_file TEXT NOT NULL,
    root_line INTEGER NOT NULL,
    direction TEXT NOT NULL,
    depth INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    cached_at INTEGER NOT NULL
);

CREATE INDEX idx_cc_root ON call_chain_cache(root_fqn);
CREATE INDEX idx_cc_cached ON call_chain_cache(cached_at);

-- ========== XLua 跨语言映射 ==========
CREATE TABLE xlua_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lua_call_pattern TEXT NOT NULL,
    lua_file TEXT NOT NULL,
    lua_line INTEGER NOT NULL,
    lua_caller_fqn TEXT,
    lua_file_hash TEXT NOT NULL,

    csharp_fqn TEXT,
    csharp_file TEXT,
    csharp_line INTEGER,
    csharp_signature TEXT,

    status TEXT DEFAULT 'pending',
    verified_at INTEGER,

    UNIQUE(lua_call_pattern, lua_file, lua_line)
);

CREATE INDEX idx_xlua_lua ON xlua_mappings(lua_call_pattern);
CREATE INDEX idx_xlua_csharp ON xlua_mappings(csharp_fqn);
CREATE INDEX idx_xlua_lua_file ON xlua_mappings(lua_file);

-- ========== Lua 别名映射 ==========
CREATE TABLE lua_aliases (
    alias_name TEXT NOT NULL,
    alias_file TEXT NOT NULL,
    alias_line INTEGER NOT NULL,
    original_cs_pattern TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    PRIMARY KEY (alias_name, alias_file, alias_line)
);

CREATE INDEX idx_alias_file ON lua_aliases(alias_file);

-- ========== 元信息 ==========
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

INSERT INTO meta (key, value) VALUES
    ('schema_version', '3'),
    ('created_at', '');
```

### 4.3 缓存管理器

```typescript
// src/cache/cache-manager.ts

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';

/** 引用缓存 TTL（毫秒） */
const REFERENCE_CACHE_TTL_MS = 60 * 1000;  // 60 秒

/** 调用链缓存 TTL（毫秒） */
const CALL_CHAIN_CACHE_TTL_MS = 120 * 1000;  // 2 分钟

export class CacheManager {
    private _db: Database.Database;
    private memCache: LRUCache<string, any>;

    constructor(dbPath: string) {
        this._db = new Database(dbPath);
        this._db.pragma('journal_mode = WAL');
        this._db.pragma('synchronous = NORMAL');
        this._db.pragma('cache_size = -64000');

        this.memCache = new LRUCache({
            max: 5000,
            ttl: 1000 * 60 * 10,  // 10 分钟
        });

        this.initSchema();
    }

    /** 暴露 db 给 XLuaBridge 等模块直接操作（只读建议） */
    get db(): Database.Database { return this._db; }

    // ===== 符号缓存 =====

    findSymbols(query: {
        name?: string;
        fqn?: string;
        filePath?: string;
        kind?: number;
        fuzzy?: boolean;
        limit?: number;
    }): CachedSymbol[] | null {
        const cacheKey = `sym:${JSON.stringify(query)}`;

        // 1. 内存缓存
        const memResult = this.memCache.get(cacheKey);
        if (memResult) return memResult as CachedSymbol[];

        // 2. SQLite 缓存
        let sql = 'SELECT * FROM symbol_cache WHERE 1=1';
        const params: any[] = [];

        if (query.fqn) {
            sql += ' AND fqn = ?';
            params.push(query.fqn);
        } else if (query.name && query.fuzzy) {
            // FTS5 前缀匹配
            const ftsResults = this._db.prepare(
                `SELECT rowid FROM symbol_fts WHERE symbol_fts MATCH ?`
            ).all(this.escapeFtsQuery(query.name) + '*');

            if (ftsResults.length === 0) return null;

            const ids = ftsResults.map((r: any) => r.rowid);
            sql += ` AND id IN (${ids.map(() => '?').join(',')})`;
            params.push(...ids);
        } else if (query.name) {
            sql += ' AND name = ?';
            params.push(query.name);
        }

        if (query.filePath) {
            sql += ' AND file_path = ?';
            params.push(query.filePath);
        }

        if (query.kind) {
            sql += ' AND kind = ?';
            params.push(query.kind);
        }

        sql += ' ORDER BY stale ASC, cached_at DESC';
        sql += ` LIMIT ?`;
        params.push(query.limit || 10);

        const results = this._db.prepare(sql).all(...params) as CachedSymbol[];

        if (results.length > 0) {
            this.memCache.set(cacheKey, results);
            return results;
        }

        return null;
    }

    /** 写入符号缓存（FTS 通过触发器自动同步，无需手动 rebuild） */
    cacheSymbols(fileHash: string, symbols: CachedSymbol[]): void {
        const insert = this._db.prepare(`
            INSERT OR REPLACE INTO symbol_cache
            (content_hash, file_path, name, fqn, kind, language,
             container_name, range_start_line, range_start_char,
             range_end_line, range_end_char, signature, doc_comment, cached_at, stale)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `);

        const transaction = this._db.transaction((syms: CachedSymbol[]) => {
            for (const s of syms) {
                insert.run(
                    fileHash, s.file_path, s.name, s.fqn, s.kind, s.language,
                    s.container_name, s.range_start_line, s.range_start_char,
                    s.range_end_line, s.range_end_char, s.signature,
                    s.doc_comment, Date.now()
                );
            }
        });

        transaction(symbols);
    }

    // ===== 引用缓存（TTL 策略） =====

    /**
     * 查找引用缓存。
     * v2.1: 使用 TTL 策略——只返回 REFERENCE_CACHE_TTL_MS 内的新鲜数据。
     */
    findReferences(targetFqn: string): CachedReference[] | null {
        const cacheKey = `ref:${targetFqn}`;
        const memResult = this.memCache.get(cacheKey);
        if (memResult) return memResult as CachedReference[];

        const cutoff = Date.now() - REFERENCE_CACHE_TTL_MS;
        const results = this._db.prepare(`
            SELECT * FROM reference_cache
            WHERE target_fqn = ? AND cached_at > ?
            ORDER BY ref_file, ref_line
        `).all(targetFqn, cutoff) as CachedReference[];

        if (results.length > 0) {
            this.memCache.set(cacheKey, results);
            return results;
        }

        return null;
    }

    cacheReferences(targetFqn: string, targetLoc: any, refs: CachedReference[]): void {
        const insert = this._db.prepare(`
            INSERT INTO reference_cache
            (target_fqn, target_file, target_line, target_char,
             ref_file, ref_line, ref_char, cached_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const transaction = this._db.transaction((references: CachedReference[]) => {
            // 清除旧数据（不论 TTL）
            this._db.prepare('DELETE FROM reference_cache WHERE target_fqn = ?')
                .run(targetFqn);

            for (const r of references) {
                insert.run(
                    targetFqn, targetLoc.file, targetLoc.line, targetLoc.char,
                    r.ref_file, r.ref_line, r.ref_char, Date.now()
                );
            }
        });

        transaction(refs);
    }

    // ===== 缓存失效 =====

    /**
     * 文件变更时，失效相关缓存。
     *
     * v2.1 策略:
     * - 符号缓存：标记为 stale（该文件中的符号）
     * - 引用缓存：不主动失效，靠 TTL 自动过期（60 秒）
     * - 调用链缓存：不主动失效，靠 TTL 自动过期（120 秒）
     * - XLua 映射：如果是 .lua 文件，标记为 pending
     * - 内存缓存：只清除与该文件相关的条目（不再 clear 全部）
     */
    invalidateFile(filePath: string): void {
        // 1. 标记符号缓存为 stale
        this._db.prepare(
            'UPDATE symbol_cache SET stale = 1 WHERE file_path = ?'
        ).run(filePath);

        // 2. XLua 映射失效
        if (filePath.endsWith('.lua')) {
            this._db.prepare(
                `UPDATE xlua_mappings SET status = 'pending' WHERE lua_file = ?`
            ).run(filePath);
        }

        // 3. 内存缓存：按文件前缀清除（不再 clear 全部）
        this.invalidateMemCacheForFile(filePath);
    }

    /**
     * v2.1: 精确清除内存缓存中与指定文件相关的条目。
     * LRU 缓存不支持按 tag 清除，所以遍历所有 key 判断是否关联。
     */
    private invalidateMemCacheForFile(filePath: string): void {
        // 遍历所有 key，清除包含该文件路径的缓存条目
        for (const key of this.memCache.keys()) {
            if (key.includes(filePath)) {
                this.memCache.delete(key);
            }
        }
        // 同时清除引用缓存（因为引用可能跨文件）
        // 引用缓存靠 TTL 管理，这里清除内存副本以确保下次从 SQLite 读取
        for (const key of this.memCache.keys()) {
            if (key.startsWith('ref:')) {
                this.memCache.delete(key);
            }
        }
    }

    /** 定期清理过期数据 */
    cleanup(): void {
        const symCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;  // 7 天
        this._db.prepare('DELETE FROM symbol_cache WHERE stale = 1 AND cached_at < ?')
            .run(symCutoff);

        // 引用缓存：删除超过 1 小时的
        const refCutoff = Date.now() - 60 * 60 * 1000;
        this._db.prepare('DELETE FROM reference_cache WHERE cached_at < ?')
            .run(refCutoff);

        // 调用链缓存：删除超过 1 小时的
        this._db.prepare('DELETE FROM call_chain_cache WHERE cached_at < ?')
            .run(refCutoff);
    }

    // ===== 工具方法 =====

    static computeFileHash(content: string): string {
        return createHash('sha256').update(content).digest('hex').substring(0, 16);
    }

    getStats(): CacheStats {
        const symbolCount = (this._db.prepare(
            'SELECT COUNT(*) as c FROM symbol_cache WHERE stale = 0'
        ).get() as any).c;
        const refCount = (this._db.prepare(
            'SELECT COUNT(*) as c FROM reference_cache'
        ).get() as any).c;
        const xluaCount = (this._db.prepare(
            'SELECT COUNT(*) as c FROM xlua_mappings'
        ).get() as any).c;
        const xluaVerified = (this._db.prepare(
            `SELECT COUNT(*) as c FROM xlua_mappings WHERE status = 'verified'`
        ).get() as any).c;

        return {
            symbols: symbolCount,
            references: refCount,
            xluaMappings: xluaCount,
            xluaVerified: xluaVerified,
            memCacheSize: this.memCache.size,
        };
    }

    /** 转义 FTS5 查询中的特殊字符 */
    private escapeFtsQuery(query: string): string {
        // FTS5 中 * " 等需要转义
        return query.replace(/['"\\]/g, '');
    }

    private initSchema(): void {
        // 执行上述 CREATE TABLE / CREATE TRIGGER 语句
        // 使用 IF NOT EXISTS 保证幂等
    }
}

// ===== 类型定义 =====

export interface CachedSymbol {
    id?: number;
    content_hash: string;
    file_path: string;
    name: string;
    fqn: string;
    kind: number;
    language: string;
    container_name?: string;
    range_start_line: number;
    range_start_char: number;
    range_end_line: number;
    range_end_char: number;
    signature?: string;
    doc_comment?: string;
    cached_at: number;
    stale: number;
}

export interface CachedReference {
    ref_file: string;
    ref_line: number;
    ref_char: number;
    cached_at: number;
}

export interface CacheStats {
    symbols: number;
    references: number;
    xluaMappings: number;
    xluaVerified: number;
    memCacheSize: number;
}
```

---

## 五、查询服务层

### 5.1 核心设计：按名字查的 resolve 流程

> **v2.1 关键变更**：所有工具都支持"按名字查"模式。内部统一通过 `resolveSymbol` 将名字解析为 file+line+col。

```
MCP 工具输入: name="ItemManager.AddItem"
    │
    ▼
resolveSymbol(name)
    │
    ├─ 1. 查 symbol_cache（精确匹配 fqn 或 name）
    │     └─ 命中 → 返回 { file, line, col, fqn }
    │
    ├─ 2. 查 symbol_fts（模糊匹配）
    │     └─ 命中 → 返回 { file, line, col, fqn }
    │
    └─ 3. 调 LSP workspace/symbol
          └─ 命中 → 缓存 → 返回 { file, line, col, fqn }
          └─ 未命中 → 返回 null

如果 resolveSymbol 返回多个结果，调用方决定如何处理：
  - findDefinition: 直接返回所有结果
  - findReferences: 对每个结果分别查引用（或提示 Claude 先选一个）
```

### 5.2 统一查询服务

```typescript
// src/core/query-service.ts

import { LspManager } from '../lsp/lsp-manager';
import { CacheManager, CachedSymbol } from '../cache/cache-manager';
import { relativeToUri, uriToRelative, uriToPath } from '../utils/uri';
import { LspTimeoutError } from '../utils/timeout';
import * as path from 'path';
import * as fs from 'fs/promises';

export class QueryService {
    constructor(
        private lspManager: LspManager,
        private cache: CacheManager,
        private workspaceRoot: string,
    ) {}

    // ===== 符号解析（名字 → 位置） =====

    /**
     * 将符号名解析为精确位置。
     * 这是所有"按名字查"操作的基础。
     */
    async resolveSymbol(name: string, kind?: number): Promise<ResolvedSymbol[]> {
        // 1. 先查缓存（精确 fqn 匹配）
        let cached = this.cache.findSymbols({ fqn: name, kind, limit: 10 });
        if (cached && cached.length > 0 && cached.some(c => !c.stale)) {
            return cached.filter(c => !c.stale).map(this.cachedToResolved);
        }

        // 2. 缓存未精确命中 → 尝试 name 精确匹配
        cached = this.cache.findSymbols({ name, kind, limit: 10 });
        if (cached && cached.length > 0 && cached.some(c => !c.stale)) {
            return cached.filter(c => !c.stale).map(this.cachedToResolved);
        }

        // 3. 尝试 FTS 模糊匹配
        cached = this.cache.findSymbols({ name, fuzzy: true, kind, limit: 10 });
        if (cached && cached.length > 0 && cached.some(c => !c.stale)) {
            return cached.filter(c => !c.stale).map(this.cachedToResolved);
        }

        // 4. 缓存全未命中 → 走 LSP
        const lspStatus = this.lspManager.getStatus();

        if (!lspStatus.allReady) {
            // LSP 未就绪 → 返回 stale 缓存
            if (cached && cached.length > 0) {
                return cached.map(c => ({ ...this.cachedToResolved(c), stale: true }));
            }
            return [];
        }

        return this.resolveViaLsp(name);
    }

    private async resolveViaLsp(name: string): Promise<ResolvedSymbol[]> {
        const results: ResolvedSymbol[] = [];

        // 搜索名字的最后一段（如 "ItemManager.AddItem" → "AddItem"）
        const searchTerm = name.includes('.') ? name.split('.').pop()! : name;

        // 在两个 LSP 中搜索
        for (const lang of ['csharp', 'lua'] as const) {
            try {
                const client = this.lspManager.getClientForLanguage(lang);
                if (client.state !== 'ready') continue;

                const symbols = await client.workspaceSymbol(searchTerm);

                for (const sym of (symbols || [])) {
                    const symFqn = sym.containerName
                        ? `${sym.containerName}.${sym.name}`
                        : sym.name;

                    // 筛选：FQN 必须包含搜索名
                    if (symFqn.includes(name) || sym.name === name ||
                        symFqn.endsWith(name)) {
                        results.push({
                            name: sym.name,
                            fqn: symFqn,
                            kind: sym.kind,
                            language: lang === 'csharp' ? 'csharp' : 'lua',
                            file: uriToRelative(this.workspaceRoot, sym.location.uri),
                            line: sym.location.range.start.line,      // 0-based
                            character: sym.location.range.start.character, // 0-based
                            stale: false,
                        });
                    }
                }
            } catch (e) {
                if (e instanceof LspTimeoutError) {
                    // 超时不阻塞，继续搜另一个 LSP
                    continue;
                }
                throw e;
            }
        }

        return results.slice(0, 10);
    }

    // ===== 符号定义查询 =====

    async findDefinition(query: {
        name?: string;
        file?: string;
        line?: number;         // 1-based
        character?: number;    // 0-based
        kind?: number;
    }): Promise<DefinitionResult[]> {
        const startTime = Date.now();

        if (query.name) {
            // 模式 A：按名字查
            const resolved = await this.resolveSymbol(query.name, query.kind);

            // 可选：对每个结果丰富签名（并发执行）
            const enriched = await Promise.all(
                resolved.map(r => this.enrichWithHover(r))
            );

            return enriched.map(r => ({
                ...r,
                line: r.line + 1,  // 输出转为 1-based
                source: r.stale ? 'cache_stale' as const : 'lsp' as const,
                latencyMs: Date.now() - startTime,
            }));
        } else if (query.file && query.line != null) {
            // 模式 B：按位置查
            const client = this.lspManager.getClientForFile(query.file);
            const uri = relativeToUri(this.workspaceRoot, query.file);

            const result = await client.definition(
                uri, query.line - 1, query.character || 0
            );

            if (!result) return [];

            // definition 可能返回单个或数组
            const locations = Array.isArray(result) ? result : [result];
            return locations.map((loc: any) => ({
                name: '',  // definition 不返回名字
                fqn: '',
                kind: 0,
                language: query.file!.endsWith('.cs') ? 'csharp' : 'lua',
                file: uriToRelative(this.workspaceRoot, loc.uri),
                line: loc.range.start.line + 1,
                character: loc.range.start.character,
                source: 'lsp' as const,
                latencyMs: Date.now() - startTime,
            }));
        }

        return [];
    }

    // ===== 符号引用查询 =====

    async findReferences(query: {
        name?: string;
        fqn?: string;
        file?: string;
        line?: number;         // 1-based
        character?: number;
    }): Promise<ReferenceResult> {
        const startTime = Date.now();

        // 如果只有名字，先 resolve 到位置
        let file = query.file;
        let line = query.line;
        let character = query.character || 0;
        let fqn = query.fqn || query.name || '';

        if (!file && query.name) {
            const resolved = await this.resolveSymbol(query.name);
            if (resolved.length === 0) {
                return { symbolFqn: fqn, references: [], count: 0, source: 'lsp' };
            }
            // 使用第一个匹配
            const first = resolved[0];
            file = first.file;
            line = first.line + 1;  // 转为 1-based
            character = first.character;
            fqn = first.fqn;
        }

        if (!file || line == null) {
            return { symbolFqn: fqn, references: [], count: 0, source: 'lsp' };
        }

        // 查缓存（TTL 策略）
        const cached = this.cache.findReferences(fqn);
        if (cached) {
            return {
                symbolFqn: fqn,
                references: cached.map(r => ({
                    file: r.ref_file,
                    line: r.ref_line + 1,
                    character: r.ref_char,
                })),
                count: cached.length,
                source: 'cache',
            };
        }

        // 走 LSP
        try {
            const client = this.lspManager.getClientForFile(file);
            const uri = relativeToUri(this.workspaceRoot, file);

            const lspRefs = await client.references(
                uri, line - 1, character, false
            );

            const results = (lspRefs || []).map((ref: any) => ({
                file: uriToRelative(this.workspaceRoot, ref.uri),
                line: ref.range.start.line + 1,
                character: ref.range.start.character,
            }));

            // 写入缓存
            this.cache.cacheReferences(
                fqn,
                { file, line: line - 1, char: character },
                results.map((r: any) => ({
                    ref_file: r.file,
                    ref_line: r.line - 1,
                    ref_char: r.character,
                    cached_at: Date.now(),
                }))
            );

            return {
                symbolFqn: fqn,
                references: results,
                count: results.length,
                source: 'lsp',
            };
        } catch (e) {
            if (e instanceof LspTimeoutError) {
                return {
                    symbolFqn: fqn,
                    references: [],
                    count: 0,
                    source: 'lsp',
                    error: 'LSP_TIMEOUT',
                };
            }
            throw e;
        }
    }

    // ===== 调用链查询 =====

    async findCallChain(query: {
        name?: string;
        file?: string;
        line?: number;
        character?: number;
        direction: 'incoming' | 'outgoing' | 'both';
        maxDepth?: number;
    }): Promise<CallChainResult> {
        const maxDepth = query.maxDepth ?? 3;

        // 如果只有名字，先 resolve
        let file = query.file;
        let line = query.line;
        let character = query.character || 0;
        let rootFqn = query.name || '';

        if (!file && query.name) {
            const resolved = await this.resolveSymbol(query.name);
            if (resolved.length === 0) {
                return { root: rootFqn, incoming: [], outgoing: [] };
            }
            const first = resolved[0];
            file = first.file;
            line = first.line + 1;
            character = first.character;
            rootFqn = first.fqn;
        }

        if (!file || line == null) {
            return { root: rootFqn, incoming: [], outgoing: [] };
        }

        const client = this.lspManager.getClientForFile(file);
        const uri = relativeToUri(this.workspaceRoot, file);

        const items = await client.callHierarchyPrepare(
            uri, line - 1, character
        );

        if (!items || items.length === 0) {
            return { root: rootFqn, incoming: [], outgoing: [] };
        }

        const rootItem = items[0];
        const result: CallChainResult = {
            root: rootFqn,
            incoming: [],
            outgoing: [],
        };

        // v2.1: 使用 visited set 做环检测
        if (query.direction !== 'outgoing') {
            result.incoming = await this.traverseCallHierarchy(
                client, rootItem, 'incoming', maxDepth, 0, new Set()
            );
        }

        if (query.direction !== 'incoming') {
            result.outgoing = await this.traverseCallHierarchy(
                client, rootItem, 'outgoing', maxDepth, 0, new Set()
            );
        }

        return result;
    }

    /**
     * v2.1: 递归遍历调用层次，带环检测。
     * visited 用符号的 uri+line 作为唯一标识，避免递归调用导致死循环。
     */
    private async traverseCallHierarchy(
        client: any,
        item: any,
        direction: 'incoming' | 'outgoing',
        maxDepth: number,
        currentDepth: number,
        visited: Set<string>,
    ): Promise<CallChainNode[]> {
        if (currentDepth >= maxDepth) return [];

        // 环检测：用 uri + 起始行唯一标识符号
        const itemKey = `${item.uri}:${item.range.start.line}`;
        if (visited.has(itemKey)) return [];  // 已访问，跳过
        visited.add(itemKey);

        try {
            const calls = direction === 'incoming'
                ? await client.callHierarchyIncoming(item)
                : await client.callHierarchyOutgoing(item);

            if (!calls) return [];

            const nodes: CallChainNode[] = [];

            for (const call of calls) {
                const callItem = direction === 'incoming' ? call.from : call.to;
                const node: CallChainNode = {
                    name: callItem.name,
                    fqn: callItem.detail
                        ? `${callItem.detail}.${callItem.name}`
                        : callItem.name,
                    kind: callItem.kind,
                    file: uriToRelative(this.workspaceRoot, callItem.uri),
                    line: callItem.range.start.line + 1,
                    children: await this.traverseCallHierarchy(
                        client, callItem, direction, maxDepth,
                        currentDepth + 1, visited
                    ),
                };
                nodes.push(node);
            }

            return nodes;
        } catch (e) {
            if (e instanceof LspTimeoutError) return [];
            throw e;
        }
    }

    // ===== 辅助方法 =====

    private cachedToResolved(cached: CachedSymbol): ResolvedSymbol {
        return {
            name: cached.name,
            fqn: cached.fqn,
            kind: cached.kind,
            language: cached.language,
            file: cached.file_path,
            line: cached.range_start_line,
            character: cached.range_start_char,
            stale: cached.stale === 1,
        };
    }

    /** 通过 hover 丰富符号信息（获取签名和文档） */
    private async enrichWithHover(sym: ResolvedSymbol): Promise<ResolvedSymbol> {
        try {
            const client = this.lspManager.getClientForFile(sym.file);
            if (client.state !== 'ready') return sym;

            const uri = relativeToUri(this.workspaceRoot, sym.file);
            const hover = await client.hover(uri, sym.line, sym.character);

            if (hover?.contents) {
                const text = this.extractHoverText(hover.contents);
                sym.signature = this.extractSignature(text);
                sym.doc = this.extractDoc(text);
            }
        } catch {
            // hover 失败不影响主流程
        }
        return sym;
    }

    private extractHoverText(contents: any): string {
        if (typeof contents === 'string') return contents;
        if (contents.value) return contents.value;
        if (Array.isArray(contents)) {
            return contents.map((c: any) =>
                typeof c === 'string' ? c : c.value || ''
            ).join('\n');
        }
        return '';
    }

    private extractSignature(hoverText: string): string | undefined {
        const match = hoverText.match(/```\w*\n([\s\S]*?)```/);
        return match?.[1]?.trim();
    }

    private extractDoc(hoverText: string): string | undefined {
        const parts = hoverText.split('```');
        return parts.length >= 3 ? parts[2]?.trim()?.substring(0, 200) : undefined;
    }
}

// ===== 类型定义 =====

interface ResolvedSymbol {
    name: string;
    fqn: string;
    kind: number;
    language: string;
    file: string;
    line: number;       // 0-based（内部使用）
    character: number;  // 0-based
    stale?: boolean;
    signature?: string;
    doc?: string;
}

interface DefinitionResult extends ResolvedSymbol {
    source: 'cache' | 'lsp' | 'cache_stale';
    latencyMs: number;
}

interface ReferenceResult {
    symbolFqn: string;
    references: { file: string; line: number; character: number }[];
    count: number;
    source: 'cache' | 'lsp';
    error?: string;
}

interface CallChainResult {
    root: string;
    incoming: CallChainNode[];
    outgoing: CallChainNode[];
}

interface CallChainNode {
    name: string;
    fqn: string;
    kind: number;
    file: string;
    line: number;
    children: CallChainNode[];
}
```

---

## 六、XLua 跨语言桥接

### 6.1 桥接原理（同 v2.0，无变更）

```
Lua 端                                    C# 端
──────                                    ──────
CS.Game.ItemManager:AddItem(id, count)    [LuaCallCSharp]
                                          public class ItemManager {
    ↓ 正则扫描                                public void AddItem(...) { }
    ↓                                     }
CS.Game.ItemManager:AddItem                   ↑
    ↓ 命名规则转换                            ↑ csharp-ls 验证
    ↓                                         ↑
Game.ItemManager.AddItem  ──────────────────→ ✓ 验证通过，建立映射
```

### 6.2 跨语言桥接器

> **v2.1 关键变更**：全量扫描时先对 C# 类名去重，批量查询后本地匹配（O(U) 而非 O(N) 请求，U=唯一类名数）。

```typescript
// src/bridge/xlua-bridge.ts

import { LspManager } from '../lsp/lsp-manager';
import { CacheManager } from '../cache/cache-manager';
import { relativeToUri, uriToRelative } from '../utils/uri';
import { LspTimeoutError } from '../utils/timeout';
import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';

const CS_CALL_PATTERN = /CS\.([\w.]+)[:\.](\w+)\s*\(/g;
const CS_ALIAS_PATTERN = /local\s+(\w+)\s*=\s*CS\.([\w.]+)\s*$/gm;

interface XLuaCall {
    pattern: string;
    className: string;
    memberName: string;
    file: string;
    line: number;
    callerFqn?: string;
}

interface XLuaAlias {
    aliasName: string;
    originalPattern: string;
    file: string;
    line: number;
}

export class XLuaBridge {
    constructor(
        private lspManager: LspManager,
        private cache: CacheManager,
        private workspaceRoot: string,
        private luaRoot: string,
    ) {}

    // ===== 全量扫描 =====

    async fullScan(): Promise<ScanResult> {
        const result: ScanResult = {
            totalCalls: 0, verified: 0, unresolved: 0, aliases: 0, duration: 0,
        };
        const startTime = Date.now();

        // 1. 扫描所有 Lua 文件
        const luaFiles = await glob('**/*.lua', {
            cwd: this.luaRoot,
            absolute: false,
        });

        const allCalls: XLuaCall[] = [];
        const allAliases: XLuaAlias[] = [];

        for (const file of luaFiles) {
            const absPath = path.join(this.luaRoot, file);
            const content = await fs.readFile(absPath, 'utf-8');
            allCalls.push(...this.extractCsCalls(file, content));
            allAliases.push(...this.extractAliases(file, content));
        }

        result.totalCalls = allCalls.length;
        result.aliases = allAliases.length;

        // 2. 获取 Lua 调用者信息（LuaLS）
        await this.enrichCallerInfo(allCalls);

        // 3. v2.1: 批量验证 C# 端符号（去重 + 批量查询）
        const verifyResults = await this.batchVerifyWithCSharp(allCalls);

        // 4. 写入数据库
        const insertVerified = this.cache.db.prepare(`
            INSERT OR REPLACE INTO xlua_mappings
            (lua_call_pattern, lua_file, lua_line, lua_caller_fqn,
             lua_file_hash, csharp_fqn, csharp_file, csharp_line,
             csharp_signature, status, verified_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?)
        `);

        const insertUnresolved = this.cache.db.prepare(`
            INSERT OR REPLACE INTO xlua_mappings
            (lua_call_pattern, lua_file, lua_line, lua_caller_fqn,
             lua_file_hash, status)
            VALUES (?, ?, ?, ?, ?, 'unresolved')
        `);

        const transaction = this.cache.db.transaction(() => {
            for (const call of allCalls) {
                const verified = verifyResults.get(
                    `${call.className}.${call.memberName}`
                );

                if (verified) {
                    result.verified++;
                    insertVerified.run(
                        call.pattern, call.file, call.line, call.callerFqn,
                        '', verified.fqn, verified.file, verified.line,
                        verified.signature, Date.now()
                    );
                } else {
                    result.unresolved++;
                    insertUnresolved.run(
                        call.pattern, call.file, call.line, call.callerFqn, ''
                    );
                }
            }

            // 存储别名
            for (const alias of allAliases) {
                this.cache.db.prepare(`
                    INSERT OR REPLACE INTO lua_aliases
                    (alias_name, alias_file, alias_line, original_cs_pattern, file_hash)
                    VALUES (?, ?, ?, ?, '')
                `).run(alias.aliasName, alias.file, alias.line, alias.originalPattern);
            }
        });

        transaction();

        result.duration = Date.now() - startTime;
        return result;
    }

    /**
     * v2.1: 批量验证 C# 符号。
     *
     * 策略：
     * 1. 从所有调用中提取唯一类名（2000 调用 → ~200 类名）
     * 2. 对每个类名调一次 workspaceSymbol（200 次请求而非 2000 次）
     * 3. 缓存类的所有成员
     * 4. 在本地匹配方法名
     */
    private async batchVerifyWithCSharp(
        calls: XLuaCall[]
    ): Promise<Map<string, VerifiedSymbol>> {
        const result = new Map<string, VerifiedSymbol>();

        const csharpClient = this.lspManager.getClientForLanguage('csharp');
        if (csharpClient.state !== 'ready') return result;

        // 1. 提取唯一的 C# 类名
        const uniqueClasses = new Set(calls.map(c => c.className));

        // 2. 批量查询每个类名
        // classSymbols: className → LSP 符号列表
        const classSymbols = new Map<string, any[]>();

        for (const className of uniqueClasses) {
            // 用类名的最后一段搜索（"Game.ItemManager" → "ItemManager"）
            const shortName = className.split('.').pop()!;
            try {
                const symbols = await csharpClient.workspaceSymbol(shortName);
                classSymbols.set(className, symbols || []);
            } catch (e) {
                if (e instanceof LspTimeoutError) continue;
                // 其他错误继续
                classSymbols.set(className, []);
            }
        }

        // 3. 本地匹配：对每个调用，在缓存的类符号中查找
        for (const call of calls) {
            const key = `${call.className}.${call.memberName}`;
            if (result.has(key)) continue;  // 已验证过的跳过

            const symbols = classSymbols.get(call.className) || [];
            const matched = symbols.find((s: any) => {
                const symFqn = s.containerName
                    ? `${s.containerName}.${s.name}`
                    : s.name;
                return (
                    (symFqn === key || symFqn.endsWith(key)) &&
                    s.name === call.memberName
                );
            });

            if (matched) {
                result.set(key, {
                    fqn: key,
                    file: uriToRelative(this.workspaceRoot, matched.location.uri),
                    line: matched.location.range.start.line + 1,
                    signature: undefined,  // 可选后续 hover 丰富
                });
            }
        }

        return result;
    }

    // ===== 增量更新 =====

    async updateFile(filePath: string, content: string): Promise<void> {
        if (!filePath.endsWith('.lua')) return;

        // 删除旧映射
        this.cache.db.prepare('DELETE FROM xlua_mappings WHERE lua_file = ?')
            .run(filePath);
        this.cache.db.prepare('DELETE FROM lua_aliases WHERE alias_file = ?')
            .run(filePath);

        // 重新扫描
        const calls = this.extractCsCalls(filePath, content);
        const aliases = this.extractAliases(filePath, content);

        await this.enrichCallerInfo(calls);

        // 增量验证（单文件的调用通常不多，逐个验证可接受）
        const verifyResults = await this.batchVerifyWithCSharp(calls);

        const transaction = this.cache.db.transaction(() => {
            for (const call of calls) {
                const verified = verifyResults.get(
                    `${call.className}.${call.memberName}`
                );
                if (verified) {
                    this.cache.db.prepare(`
                        INSERT OR REPLACE INTO xlua_mappings
                        (lua_call_pattern, lua_file, lua_line, lua_caller_fqn,
                         lua_file_hash, csharp_fqn, csharp_file, csharp_line,
                         csharp_signature, status, verified_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?)
                    `).run(
                        call.pattern, call.file, call.line, call.callerFqn,
                        '', verified.fqn, verified.file, verified.line,
                        verified.signature, Date.now()
                    );
                } else {
                    this.cache.db.prepare(`
                        INSERT OR REPLACE INTO xlua_mappings
                        (lua_call_pattern, lua_file, lua_line, lua_caller_fqn,
                         lua_file_hash, status)
                        VALUES (?, ?, ?, ?, ?, 'unresolved')
                    `).run(call.pattern, call.file, call.line, call.callerFqn, '');
                }
            }

            for (const alias of aliases) {
                this.cache.db.prepare(`
                    INSERT OR REPLACE INTO lua_aliases
                    (alias_name, alias_file, alias_line, original_cs_pattern, file_hash)
                    VALUES (?, ?, ?, ?, '')
                `).run(alias.aliasName, alias.file, alias.line, alias.originalPattern);
            }
        });

        transaction();
    }

    // ===== 查询 =====

    async queryCrossLang(name: string): Promise<CrossLangResult | null> {
        let csharpFqn: string;

        if (name.startsWith('CS.')) {
            csharpFqn = name.replace(/^CS\./, '').replace(':', '.');
        } else {
            csharpFqn = name;
        }

        const mappings = this.cache.db.prepare(`
            SELECT * FROM xlua_mappings
            WHERE csharp_fqn LIKE ? OR lua_call_pattern LIKE ?
            ORDER BY status ASC
        `).all(`${csharpFqn}%`, `%${csharpFqn}%`) as any[];

        if (mappings.length === 0) return null;

        return {
            csharp: {
                fqn: csharpFqn,
                file: mappings[0]?.csharp_file,
                line: mappings[0]?.csharp_line,
                signature: mappings[0]?.csharp_signature,
            },
            lua: {
                globalName: `CS.${csharpFqn}`,
                callSites: mappings.map((m: any) => ({
                    file: m.lua_file,
                    line: m.lua_line,
                    callerFqn: m.lua_caller_fqn,
                    pattern: m.lua_call_pattern,
                    status: m.status,
                })),
            },
        };
    }

    // ===== 内部方法（同 v2.0） =====

    private extractCsCalls(filePath: string, content: string): XLuaCall[] {
        const calls: XLuaCall[] = [];
        let match;
        CS_CALL_PATTERN.lastIndex = 0;

        while ((match = CS_CALL_PATTERN.exec(content)) !== null) {
            const line = this.getLineNumber(content, match.index);
            const className = match[1];
            const memberName = match[2];
            const separator = match[0].includes(':') ? ':' : '.';

            calls.push({
                pattern: `CS.${className}${separator}${memberName}`,
                className, memberName, file: filePath, line,
            });
        }
        return calls;
    }

    private extractAliases(filePath: string, content: string): XLuaAlias[] {
        const aliases: XLuaAlias[] = [];
        let match;
        CS_ALIAS_PATTERN.lastIndex = 0;

        while ((match = CS_ALIAS_PATTERN.exec(content)) !== null) {
            aliases.push({
                aliasName: match[1],
                originalPattern: `CS.${match[2]}`,
                file: filePath,
                line: this.getLineNumber(content, match.index),
            });
        }
        return aliases;
    }

    private async enrichCallerInfo(calls: XLuaCall[]): Promise<void> {
        const luaLs = this.lspManager.getClientForLanguage('lua');
        if (luaLs.state !== 'ready') return;

        const byFile = new Map<string, XLuaCall[]>();
        for (const call of calls) {
            if (!byFile.has(call.file)) byFile.set(call.file, []);
            byFile.get(call.file)!.push(call);
        }

        for (const [file, fileCalls] of byFile) {
            try {
                const uri = relativeToUri(this.luaRoot, file);
                const symbols = await luaLs.documentSymbol(uri);
                for (const call of fileCalls) {
                    call.callerFqn = this.findEnclosingSymbol(symbols, call.line);
                }
            } catch { /* 失败不阻塞 */ }
        }
    }

    private findEnclosingSymbol(symbols: any[], line: number): string | undefined {
        for (const sym of symbols) {
            if (sym.range &&
                sym.range.start.line <= line - 1 &&
                sym.range.end.line >= line - 1) {
                if (sym.children) {
                    const inner = this.findEnclosingSymbol(sym.children, line);
                    if (inner) return inner;
                }
                return sym.name;
            }
        }
        return undefined;
    }

    private getLineNumber(content: string, offset: number): number {
        let line = 1;
        for (let i = 0; i < offset; i++) {
            if (content[i] === '\n') line++;
        }
        return line;
    }
}

// ===== 类型 =====

interface VerifiedSymbol {
    fqn: string;
    file: string;
    line: number;
    signature?: string;
}

interface ScanResult {
    totalCalls: number;
    verified: number;
    unresolved: number;
    aliases: number;
    duration: number;
}

interface CrossLangResult {
    csharp: { fqn: string; file?: string; line?: number; signature?: string };
    lua: {
        globalName: string;
        callSites: {
            file: string; line: number; callerFqn?: string;
            pattern: string; status: string;
        }[];
    };
}
```

---

## 七、增量更新引擎

### 7.1 File Watcher（同 v2.0，无变更）

```typescript
// src/watcher/file-watcher.ts
// 代码同 v2.0（chokidar + debounce + 队列），此处省略重复
```

### 7.2 增量更新协调器

> **v2.1 关键修复**：使用 OpenFileTracker 正确维护 LSP 文件打开状态。

```typescript
// src/core/update-coordinator.ts

import { LspManager } from '../lsp/lsp-manager';
import { CacheManager } from '../cache/cache-manager';
import { XLuaBridge } from '../bridge/xlua-bridge';
import { FileChange } from '../watcher/file-watcher';
import { relativeToUri } from '../utils/uri';
import * as fs from 'fs/promises';
import * as path from 'path';

export class UpdateCoordinator {
    constructor(
        private lspManager: LspManager,
        private cache: CacheManager,
        private xluaBridge: XLuaBridge,
        private workspaceRoot: string,
    ) {}

    async processChanges(changes: FileChange[]): Promise<UpdateResult> {
        const startTime = Date.now();
        const result: UpdateResult = {
            filesProcessed: 0,
            cacheInvalidated: 0,
            xluaUpdated: 0,
            duration: 0,
        };

        for (const change of changes) {
            try {
                if (change.type === 'delete') {
                    await this.handleDelete(change);
                } else {
                    await this.handleAddOrChange(change);
                }
                result.filesProcessed++;
            } catch (error) {
                console.error(`Failed to process ${change.relativePath}:`, error);
            }
        }

        result.duration = Date.now() - startTime;
        return result;
    }

    private async handleDelete(change: FileChange): Promise<void> {
        const { relativePath } = change;

        // 1. 失效缓存
        this.cache.invalidateFile(relativePath);

        // 2. 通知 LSP（通过 tracker 正确处理 didClose）
        const client = this.lspManager.getClientForFile(relativePath);
        const tracker = this.lspManager.getTrackerForFile(relativePath);
        const uri = relativeToUri(this.workspaceRoot, relativePath);

        try {
            await tracker.notifyDelete(client, uri);
        } catch { /* 通知失败不阻塞 */ }
    }

    /**
     * v2.1 修复：使用 OpenFileTracker 正确维护文件打开状态。
     *
     * - 首次变更的文件：tracker 发送 didOpen
     * - 后续变更的文件：tracker 发送 didChange（版本号自动递增）
     * - 不再每次都调 didOpen（这是 LSP 协议违规）
     */
    private async handleAddOrChange(change: FileChange): Promise<void> {
        const { relativePath, absolutePath } = change;

        // 1. 读取文件内容
        const content = await fs.readFile(absolutePath, 'utf-8');
        const contentHash = CacheManager.computeFileHash(content);

        // 2. 失效缓存
        this.cache.invalidateFile(relativePath);

        // 3. 通知 LSP（通过 tracker 自动选择 didOpen 或 didChange）
        const client = this.lspManager.getClientForFile(relativePath);
        const tracker = this.lspManager.getTrackerForFile(relativePath);
        const uri = relativeToUri(this.workspaceRoot, relativePath);
        const languageId = relativePath.endsWith('.cs') ? 'csharp' : 'lua';

        try {
            await tracker.notifyChange(client, uri, languageId, content);
            await tracker.notifySave(client, uri);
        } catch { /* 通知失败不阻塞 */ }

        // 4. 更新 XLua 映射（如果是 Lua 文件）
        if (relativePath.endsWith('.lua')) {
            try {
                await this.xluaBridge.updateFile(relativePath, content);
            } catch { /* XLua 更新失败不阻塞 */ }
        }

        // 5. 更新文件索引
        this.cache.db.prepare(`
            INSERT OR REPLACE INTO files
            (relative_path, worktree_id, content_hash, mtime, size, language, last_indexed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            relativePath, this.getWorktreeId(), contentHash,
            Date.now(), Buffer.byteLength(content),
            languageId, Date.now()
        );
    }

    private getWorktreeId(): string {
        return CacheManager.computeFileHash(this.workspaceRoot);
    }
}

interface UpdateResult {
    filesProcessed: number;
    cacheInvalidated: number;
    xluaUpdated: number;
    duration: number;
}
```

---

## 八、MCP 工具接口

> **v2.1 关键变更**：
> 1. 所有工具支持"按名字查"（`name` 参数），不再强制要求 `fqn` + `file` + `line`
> 2. 统一使用 McpToolResponse 格式
> 3. 错误处理统一

```typescript
// src/mcp/tools.ts

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { QueryService } from '../core/query-service';
import { XLuaBridge } from '../bridge/xlua-bridge';
import { LspManager } from '../lsp/lsp-manager';
import { CacheManager } from '../cache/cache-manager';
import { successResponse, errorResponse, McpToolResponse } from '../utils/mcp-response';
import { LspTimeoutError } from '../utils/timeout';
import { z } from 'zod';

/** 包装 MCP 工具调用，统一错误处理和响应格式 */
async function wrapTool<T>(
    lspManager: LspManager,
    fn: () => Promise<McpToolResponse<T>>
): Promise<{ content: { type: 'text'; text: string }[] }> {
    const startTime = Date.now();
    const lspStatus = {
        csharp: lspManager.getStatus().csharp.state,
        lua: lspManager.getStatus().lua.state,
    };

    try {
        const result = await fn();
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
    } catch (e: any) {
        const latencyMs = Date.now() - startTime;
        let resp: McpToolResponse;

        if (e instanceof LspTimeoutError) {
            resp = errorResponse('LSP_TIMEOUT', e.message, latencyMs, lspStatus);
        } else if (e.message?.includes('not ready')) {
            resp = errorResponse('LSP_NOT_READY', e.message, latencyMs, lspStatus);
        } else {
            resp = errorResponse('INTERNAL_ERROR', e.message, latencyMs, lspStatus);
        }

        return {
            content: [{ type: 'text' as const, text: JSON.stringify(resp, null, 2) }],
        };
    }
}

export function registerTools(
    server: McpServer,
    queryService: QueryService,
    xluaBridge: XLuaBridge,
    lspManager: LspManager,
    cache: CacheManager,
): void {

    // ===== csg_find_definition =====
    server.tool(
        'csg_find_definition',
        '查找符号定义位置。支持按名字搜索（如 "ItemManager"）或按文件位置精确查找。',
        {
            name: z.string().optional().describe('符号名（支持 FQN 如 "Game.ItemManager" 或短名如 "ItemManager"）'),
            file: z.string().optional().describe('文件路径（按位置查模式）'),
            line: z.number().optional().describe('行号 1-based（按位置查模式）'),
            column: z.number().optional().describe('列号 0-based（按位置查模式）'),
        },
        async (args) => wrapTool(lspManager, async () => {
            const startTime = Date.now();
            const results = await queryService.findDefinition({
                name: args.name,
                file: args.file,
                line: args.line,
                character: args.column,
            });

            const lspStatus = {
                csharp: lspManager.getStatus().csharp.state,
                lua: lspManager.getStatus().lua.state,
            };

            if (results.length === 0) {
                return errorResponse(
                    'NO_MATCH',
                    `No definition found for: ${args.name || args.file}`,
                    Date.now() - startTime,
                    lspStatus,
                );
            }

            return successResponse(
                {
                    results: results.map(r => ({
                        name: r.name,
                        fqn: r.fqn,
                        kind: r.kind,
                        language: r.language,
                        file: r.file,
                        line: r.line,
                        column: r.character,
                        signature: r.signature,
                        doc: r.doc,
                    })),
                    count: results.length,
                    truncated: results.length >= 10,
                },
                results[0].source,
                Date.now() - startTime,
                lspStatus,
            );
        })
    );

    // ===== csg_find_references =====
    server.tool(
        'csg_find_references',
        '查找符号的所有引用。支持按名字（如 "ItemManager.AddItem"）或按位置。自动包含跨语言引用。',
        {
            name: z.string().optional().describe('符号名'),
            file: z.string().optional().describe('文件路径'),
            line: z.number().optional().describe('行号 1-based'),
            column: z.number().optional().describe('列号 0-based'),
        },
        async (args) => wrapTool(lspManager, async () => {
            const startTime = Date.now();
            const result = await queryService.findReferences({
                name: args.name,
                file: args.file,
                line: args.line,
                character: args.column,
            });

            // 同时查跨语言引用
            let xluaRefs: any = null;
            if (result.symbolFqn) {
                try {
                    xluaRefs = await xluaBridge.queryCrossLang(result.symbolFqn);
                } catch { /* 不阻塞 */ }
            }

            const lspStatus = {
                csharp: lspManager.getStatus().csharp.state,
                lua: lspManager.getStatus().lua.state,
            };

            return successResponse(
                {
                    symbol: result.symbolFqn,
                    references: result.references,
                    count: result.count,
                    crossLanguage: xluaRefs?.lua.callSites || [],
                },
                result.source,
                Date.now() - startTime,
                lspStatus,
            );
        })
    );

    // ===== csg_call_chain =====
    server.tool(
        'csg_call_chain',
        '查询方法的调用链（谁调用它 / 它调用谁）。支持按名字或按位置。',
        {
            name: z.string().optional().describe('方法名'),
            file: z.string().optional().describe('文件路径'),
            line: z.number().optional().describe('行号 1-based'),
            column: z.number().optional().describe('列号 0-based'),
            direction: z.enum(['incoming', 'outgoing', 'both']).default('both'),
            max_depth: z.number().optional().default(3).describe('最大递归深度'),
        },
        async (args) => wrapTool(lspManager, async () => {
            const startTime = Date.now();
            const result = await queryService.findCallChain({
                name: args.name,
                file: args.file,
                line: args.line,
                character: args.column,
                direction: args.direction,
                maxDepth: args.max_depth,
            });

            const lspStatus = {
                csharp: lspManager.getStatus().csharp.state,
                lua: lspManager.getStatus().lua.state,
            };

            return successResponse(result, 'lsp', Date.now() - startTime, lspStatus);
        })
    );

    // ===== csg_cross_lang =====
    server.tool(
        'csg_cross_lang',
        '查询 C# ↔ Lua 跨语言映射。输入 C# FQN 或 Lua CS.xxx 模式。',
        {
            name: z.string().describe('C# FQN 或 Lua 全局名（如 "CS.Game.ItemManager"）'),
        },
        async (args) => wrapTool(lspManager, async () => {
            const startTime = Date.now();
            const result = await xluaBridge.queryCrossLang(args.name);

            const lspStatus = {
                csharp: lspManager.getStatus().csharp.state,
                lua: lspManager.getStatus().lua.state,
            };

            if (!result) {
                return errorResponse(
                    'NO_MATCH',
                    `No XLua mapping found for: ${args.name}`,
                    Date.now() - startTime,
                    lspStatus,
                );
            }

            return successResponse(result, 'cache', Date.now() - startTime, lspStatus);
        })
    );

    // ===== csg_impact =====
    server.tool(
        'csg_impact',
        '分析修改影响范围。支持按名字或按位置。返回 C# 引用 + Lua 跨语言调用。',
        {
            name: z.string().optional().describe('符号名'),
            file: z.string().optional().describe('文件路径'),
            line: z.number().optional().describe('行号 1-based'),
            column: z.number().optional().describe('列号 0-based'),
        },
        async (args) => wrapTool(lspManager, async () => {
            const startTime = Date.now();

            // 1. 查引用
            const refs = await queryService.findReferences({
                name: args.name,
                file: args.file,
                line: args.line,
                character: args.column,
            });

            // 2. 查跨语言影响
            let xluaResult: any = null;
            if (refs.symbolFqn) {
                try {
                    xluaResult = await xluaBridge.queryCrossLang(refs.symbolFqn);
                } catch { /* 不阻塞 */ }
            }

            // 3. 按文件分组
            const fileGroups = new Map<string, any[]>();
            for (const ref of refs.references) {
                if (!fileGroups.has(ref.file)) fileGroups.set(ref.file, []);
                fileGroups.get(ref.file)!.push(ref);
            }

            const lspStatus = {
                csharp: lspManager.getStatus().csharp.state,
                lua: lspManager.getStatus().lua.state,
            };

            return successResponse(
                {
                    symbol: refs.symbolFqn,
                    totalReferences: refs.count,
                    affectedFiles: Array.from(fileGroups.entries())
                        .map(([f, locs]) => ({ file: f, locations: locs, count: locs.length }))
                        .sort((a, b) => b.count - a.count),
                    crossLanguageImpact: xluaResult?.lua.callSites || [],
                },
                refs.source,
                Date.now() - startTime,
                lspStatus,
            );
        })
    );

    // ===== csg_status =====
    server.tool(
        'csg_status',
        '查看 CodeSymbolGraph 运行状态（LSP、缓存、跨语言映射）',
        {},
        async () => {
            const lspStatus = lspManager.getStatus();
            const cacheStats = cache.getStats();

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify(
                        successResponse(
                            { lsp: lspStatus, cache: cacheStats },
                            'cache',
                            0,
                            { csharp: lspStatus.csharp.state, lua: lspStatus.lua.state },
                        ),
                        null, 2
                    ),
                }],
            };
        }
    );
}
```

---

## 九、CLI 入口

> **v2.1 变更**：补充 `csg init` 的完整实现逻辑。

```typescript
// src/cli/index.ts

import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { execSync } from 'child_process';

const program = new Command();

program
    .name('csg')
    .description('CodeSymbolGraph - 基于 LSP 的 AI 代码助手语义查询层')
    .version('0.1.0');

// ===== csg init =====
program
    .command('init')
    .description('初始化项目（检测 .sln、LSP 安装状态）')
    .option('--sln <path>', '手动指定 .sln 文件路径')
    .option('--lua-root <path>', '手动指定 Lua 文件根目录')
    .option('--csharp-lsp <kind>', 'C# LSP 实现: csharp-ls (默认) 或 omnisharp')
    .action(async (options) => {
        console.log('🔍 检测项目...\n');

        // 1. 检测 .sln
        let slnPath = options.sln;
        if (!slnPath) {
            const slnFiles = await glob('*.sln', { cwd: process.cwd() });
            if (slnFiles.length === 0) {
                console.error('❌ 未找到 .sln 文件');
                console.error('   请在项目根目录运行，或使用 --sln <path> 指定');
                process.exit(1);
            }
            slnPath = slnFiles[0];
            if (slnFiles.length > 1) {
                console.warn(`⚠️  找到多个 .sln 文件，使用: ${slnPath}`);
            }
        }
        console.log(`✅ .sln 文件: ${slnPath}`);

        // 2. 检测文件数量
        const csFiles = await glob('Assets/**/*.cs', { cwd: process.cwd() });
        console.log(`✅ C# 文件: ${csFiles.length} 个`);

        let luaRoot = options.luaRoot;
        const luaDirs = ['Assets/LuaScripts', 'Assets/Lua', 'LuaScripts'];
        if (!luaRoot) {
            for (const dir of luaDirs) {
                try {
                    await fs.access(path.join(process.cwd(), dir));
                    luaRoot = dir;
                    break;
                } catch { /* 不存在继续 */ }
            }
        }

        let luaCount = 0;
        if (luaRoot) {
            const luaFiles = await glob(`${luaRoot}/**/*.lua`, { cwd: process.cwd() });
            luaCount = luaFiles.length;
            console.log(`✅ Lua 文件: ${luaCount} 个 (${luaRoot}/)`);
        } else {
            console.log('ℹ️  未找到 Lua 目录（跳过 LuaLS 配置）');
        }

        // 3. 检测 LSP 安装
        console.log('\n🔍 检测 LSP...\n');

        const csharpLsp = options.csharpLsp || 'csharp-ls';
        let csharpOk = false;
        let luaOk = false;

        if (csharpLsp === 'csharp-ls') {
            try {
                execSync('csharp-ls --version', { stdio: 'pipe' });
                console.log('✅ csharp-ls: 已安装');
                csharpOk = true;
            } catch {
                console.error('❌ csharp-ls 未安装');
                console.error('   安装命令: dotnet tool install --global csharp-ls');
            }
        } else {
            try {
                execSync('OmniSharp --version', { stdio: 'pipe' });
                console.log('✅ OmniSharp: 已安装');
                csharpOk = true;
            } catch {
                console.error('❌ OmniSharp 未安装');
                console.error('   下载: https://github.com/OmniSharp/omnisharp-roslyn/releases');
            }
        }

        try {
            execSync('lua-language-server --version', { stdio: 'pipe' });
            console.log('✅ lua-language-server: 已安装');
            luaOk = true;
        } catch {
            if (luaCount > 0) {
                console.error('❌ lua-language-server 未安装');
                console.error('   下载: https://github.com/LuaLS/lua-language-server/releases');
            } else {
                console.log('ℹ️  lua-language-server: 未安装（无 Lua 文件，可跳过）');
                luaOk = true;
            }
        }

        // 4. 生成配置文件
        if (!csharpOk || !luaOk) {
            console.log('\n⚠️  请安装缺失的 LSP 后重新运行 csg init');
            process.exit(1);
        }

        const configDir = path.join(process.cwd(), '.codesymbolgraph');
        await fs.mkdir(configDir, { recursive: true });

        const config = {
            slnPath,
            luaRoot: luaRoot || null,
            csharpLsp,
            csharpLspPath: null,   // 使用 PATH 中的默认路径
            lualsPath: null,       // 使用 PATH 中的默认路径
        };

        await fs.writeFile(
            path.join(configDir, 'config.json'),
            JSON.stringify(config, null, 2),
        );

        console.log(`\n📄 已生成配置: .codesymbolgraph/config.json`);
        console.log('💡 建议: 将 .codesymbolgraph/ 添加到 .gitignore');
        console.log('\n下一步: 运行 csg start 启动服务');
    });

// ===== csg start =====
program
    .command('start')
    .description('启动后台服务（LSP + File Watcher + MCP Server）')
    .action(async () => {
        // 1. 读取 config.json
        // 2. 创建 LspManager + CacheManager + QueryService + XLuaBridge + FileWatcher
        // 3. 启动 LspManager（并行初始化两个 LSP）
        // 4. 启动 FileWatcher
        // 5. 启动 MCP Server (stdio)
        // 6. LSP 就绪后检查缓存是否为空 → 空则自动 warmup
        // 7. 显示实时状态

        // 实现细节参见各组件的 API
        console.log('🚀 启动 CodeSymbolGraph...');
    });

// ===== csg stop =====
program
    .command('stop')
    .description('停止后台服务')
    .action(async () => {
        // 发送 SIGTERM 给后台进程
        console.log('⏹️  停止 CodeSymbolGraph');
    });

// ===== csg status =====
program
    .command('status')
    .description('查看运行状态')
    .action(async () => {
        // 连接到运行中的服务，读取状态
        // 或读取 .codesymbolgraph/state.json
    });

// ===== csg warmup =====
program
    .command('warmup')
    .description('预热缓存（遍历所有文件）')
    .action(async () => {
        // 1. 连接 LSP
        // 2. 遍历所有 .cs/.lua 文件
        // 3. 对每个文件调 documentSymbol 获取符号
        // 4. 写入符号缓存
        // 5. 执行 XLua 全量扫描
        console.log('🔥 预热缓存...');
    });

// ===== csg mcp =====
program
    .command('mcp')
    .description('以 MCP Server 模式运行（供 Claude Code 集成）')
    .action(async () => {
        // 以 stdio 模式启动 MCP Server
        // 这是 Claude Code 集成的入口
    });

program.parse();
```

---

## 十、项目结构

```
codesymbolgraph/
├── package.json
├── tsconfig.json
├── src/
│   ├── cli/
│   │   └── index.ts            # CLI 入口
│   │
│   ├── utils/                   # v2.1 新增
│   │   ├── uri.ts              # 跨平台 URI 工具
│   │   ├── timeout.ts          # LSP 超时包装
│   │   └── mcp-response.ts     # 统一 MCP 响应格式
│   │
│   ├── lsp/
│   │   ├── lsp-client.ts       # 通用 LSP 客户端
│   │   ├── lsp-manager.ts      # 多 LSP 协调
│   │   └── open-file-tracker.ts # v2.1 新增: 文件打开状态追踪
│   │
│   ├── cache/
│   │   └── cache-manager.ts
│   │
│   ├── core/
│   │   ├── query-service.ts     # 统一查询（含 resolveSymbol）
│   │   └── update-coordinator.ts
│   │
│   ├── bridge/
│   │   └── xlua-bridge.ts
│   │
│   ├── watcher/
│   │   └── file-watcher.ts
│   │
│   └── mcp/
│       ├── server.ts
│       └── tools.ts
│
└── tests/
    ├── fixtures/                 # 测试项目
    │   ├── csharp/              # 50+ C# 文件
    │   ├── lua/                 # 20+ Lua 文件
    │   └── expected/            # 预期结果 (ground truth)
    ├── unit/
    │   ├── uri.test.ts
    │   ├── timeout.test.ts
    │   ├── cache-manager.test.ts
    │   ├── open-file-tracker.test.ts
    │   └── xlua-extract.test.ts
    ├── integration/
    │   ├── lsp-client.test.ts
    │   ├── query-service.test.ts
    │   └── xlua-bridge.test.ts
    └── e2e/
        └── mcp-tools.test.ts
```

---

## 十一、测试策略

> **v2.1 新增**。

### 11.1 测试层级

| 层级 | 目的 | 依赖 | 运行频率 |
|------|------|------|---------|
| 单元测试 | 验证独立模块逻辑 | 无外部依赖（mock LSP） | 每次提交 |
| 集成测试 | 验证 LSP 交互正确性 | 需要 csharp-ls + LuaLS | 每日 / PR |
| E2E 测试 | 验证 MCP 工具端到端 | 完整环境 | 发版前 |

### 11.2 单元测试（不需要 LSP）

```typescript
// tests/unit/uri.test.ts — 验证 Windows/Mac/Linux URI 转换
describe('URI utils', () => {
    test('Windows path → file URI', () => {
        expect(pathToUri('C:\\Users\\dev\\project\\foo.cs'))
            .toBe('file:///C%3A/Users/dev/project/foo.cs');
    });

    test('Unix path → file URI', () => {
        expect(pathToUri('/home/dev/project/foo.cs'))
            .toBe('file:///home/dev/project/foo.cs');
    });
});

// tests/unit/open-file-tracker.test.ts — 验证 LSP 协议正确性
describe('OpenFileTracker', () => {
    test('首次变更发 didOpen', async () => {
        const mockClient = { didOpen: vi.fn(), didChange: vi.fn() };
        const tracker = new OpenFileTracker();

        await tracker.notifyChange(mockClient, 'file:///foo.cs', 'csharp', 'content');

        expect(mockClient.didOpen).toHaveBeenCalledOnce();
        expect(mockClient.didChange).not.toHaveBeenCalled();
    });

    test('二次变更发 didChange（版本号递增）', async () => {
        const mockClient = { didOpen: vi.fn(), didChange: vi.fn() };
        const tracker = new OpenFileTracker();

        await tracker.notifyChange(mockClient, 'file:///foo.cs', 'csharp', 'v1');
        await tracker.notifyChange(mockClient, 'file:///foo.cs', 'csharp', 'v2');

        expect(mockClient.didOpen).toHaveBeenCalledOnce();
        expect(mockClient.didChange).toHaveBeenCalledWith('file:///foo.cs', 'v2', 2);
    });
});

// tests/unit/cache-manager.test.ts — 验证缓存逻辑
describe('CacheManager', () => {
    test('引用缓存 TTL 过期后返回 null');
    test('符号缓存 stale 标记后仍可查到');
    test('invalidateFile 不清空无关文件的内存缓存');
    test('FTS 搜索在 INSERT 后自动可用（触发器）');
});

// tests/unit/xlua-extract.test.ts — 验证正则提取
describe('XLua extraction', () => {
    test('提取 CS.Game.ItemManager:AddItem 调用');
    test('提取 CS.Game.ItemManager.StaticProp 调用');
    test('提取 local mgr = CS.Game.ItemManager 别名');
    test('忽略注释中的 CS.xxx');
});
```

### 11.3 集成测试（需要 LSP 环境）

```typescript
// tests/integration/query-service.test.ts
describe('QueryService with real LSP', () => {
    // 使用 tests/fixtures/ 目录下的测试项目
    // 启动 csharp-ls + LuaLS，等待就绪

    test('findDefinition("TestClass") 返回正确位置');
    test('findReferences("TestClass.Method") 包含所有调用点');
    test('findCallChain 不会在递归调用中死循环');
    test('LSP 超时 5 秒内返回错误');
});
```

### 11.4 测试 Fixture 项目

`tests/fixtures/` 包含一个小型但完整的测试项目：

```
tests/fixtures/
├── TestProject.sln
├── TestProject/
│   ├── TestProject.csproj
│   ├── Models/
│   │   ├── Player.cs           # 普通类
│   │   └── GenericContainer.cs # 泛型类
│   ├── Services/
│   │   ├── IService.cs         # 接口
│   │   ├── PlayerService.cs    # 实现 + 扩展方法
│   │   └── BattleService.cs    # 调用链测试
│   └── XLuaExports/
│       └── LuaCallCSharp.cs    # [LuaCallCSharp] 标记
├── lua/
│   ├── game_logic.lua          # CS.xxx 直接调用
│   ├── alias_test.lua          # local X = CS.xxx 别名
│   └── nested_call.lua         # 嵌套调用
└── expected/
    ├── definitions.json        # 预期定义位置
    ├── references.json         # 预期引用列表
    └── xlua_mappings.json      # 预期跨语言映射
```

---

## 十二、实现计划

### Phase 0：最小验证原型（2 天）

> **目标**：验证 csharp-ls + LuaLS 的 stdio LSP 模式在目标项目上能正常工作。

- [ ] 手写一个 50 行脚本：spawn csharp-ls → 发送 initialize → 发送 workspace/symbol("Player") → 打印结果
- [ ] 确认 csharp-ls 能加载项目的 .sln
- [ ] 确认 workspace/symbol 返回标准格式
- [ ] 确认 callHierarchy 可用
- [ ] 对 LuaLS 做同样验证
- [ ] 记录实际初始化时间和内存占用
- [ ] 如果 csharp-ls 有问题，切换到 OmniSharp 重试

**产出**：验证结果文档 + 确定最终选型

### Phase 1：MVP（2 周）

- [ ] `src/utils/` — URI、超时、MCP 响应工具
- [ ] `src/lsp/lsp-client.ts` — LSP 客户端封装（含超时保护）
- [ ] `src/lsp/open-file-tracker.ts` — 文件打开状态追踪
- [ ] `src/lsp/lsp-manager.ts` — 多 LSP 协调
- [ ] `src/cache/cache-manager.ts` — SQLite 缓存（含 FTS 触发器）
- [ ] `src/core/query-service.ts` — resolveSymbol + findDefinition + findReferences
- [ ] `src/mcp/tools.ts` — csg_find_definition, csg_find_references, csg_status
- [ ] `src/cli/index.ts` — init, start, stop, status, mcp
- [ ] 单元测试：URI、OpenFileTracker、CacheManager
- [ ] 集成测试：基本 LSP 交互

### Phase 2：增量更新 + 缓存共享（1.5 周）

- [ ] `src/watcher/file-watcher.ts` — chokidar + 防抖
- [ ] `src/core/update-coordinator.ts` — 增量更新（使用 OpenFileTracker）
- [ ] 多 Worktree 缓存共享（content hash 键）
- [ ] 缓存降级策略
- [ ] warmup 命令
- [ ] 测试：增量更新后缓存正确失效

### Phase 3：XLua 跨语言桥接（1.5 周）

- [ ] `src/bridge/xlua-bridge.ts` — CS.xxx 扫描 + 批量验证
- [ ] 别名追踪
- [ ] MCP 工具：csg_cross_lang
- [ ] 增量 XLua 映射更新
- [ ] 测试：跨语言映射验证

### Phase 4：高级查询（1 周）

- [ ] 调用链查询（含环检测）
- [ ] 影响分析
- [ ] MCP 工具：csg_call_chain, csg_impact
- [ ] E2E 测试

**核心功能：6 周 + 2 天原型验证**
