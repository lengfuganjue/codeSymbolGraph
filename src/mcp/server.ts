import * as http from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { LspManager, type LspManagerOptions } from '../lsp/lsp-manager.js';
import { CacheManager, type CacheManagerOptions } from '../cache/cache-manager.js';
import { QueryService } from '../core/query-service.js';
import { XLuaBridge } from '../bridge/xlua-bridge.js';
import { FileWatcher } from '../watcher/file-watcher.js';
import { UpdateCoordinator } from '../core/update-coordinator.js';
import { registerTools } from './tools.js';
import { z } from 'zod';
import type { AssetIndex } from '../core/asset-index.js';
import type { ProtocolIndex } from '../core/protocol-index.js';

export interface CsgServerOptions extends LspManagerOptions {
    dbPath: string;
    luaRoot?: string;
    extraThirdPartyNamespaces?: string[];
    cacheOptions?: CacheManagerOptions;
    fileWatcherDebounceMs?: number;
    assetIndex?: AssetIndex;
    protocolIndex?: ProtocolIndex;
}

/** 独立模式：本地启动 LSP，直接处理查询 */
export async function startMcpServer(options: CsgServerOptions): Promise<void> {
    const server = new McpServer({
        name: 'CodeSymbolGraph',
        version: '0.1.0',
    });

    const lspManager = new LspManager(options);
    const cache = new CacheManager(options.dbPath, options.cacheOptions);
    const queryService = new QueryService(lspManager, cache, options.workspaceRoot);
    const xluaBridge = new XLuaBridge(
        lspManager, cache, options.workspaceRoot,
        options.luaRoot || options.workspaceRoot,
        options.extraThirdPartyNamespaces,
    );

    // 转发 LSP 日志
    lspManager.on('log', (e: { level: string; message: string }) => {
        console.error(`[CSG] [${e.level}] ${e.message}`);
    });

    // 后台索引等待 Promise：工具调用前 await 此 Promise 确保 C# 索引就绪
    let resolveIndexing: () => void;
    const indexingReady = new Promise<void>(r => { resolveIndexing = r; });

    // 注册 MCP 工具
    registerTools(server, queryService, xluaBridge, lspManager, cache, options.workspaceRoot, indexingReady, options.assetIndex, options.protocolIndex);

    // 清理函数：立即可用，fileWatcher 启动后补充
    let fileWatcher: FileWatcher | null = null;
    let cleaningUp = false;
    const cleanup = async () => {
        if (cleaningUp) return;
        cleaningUp = true;
        console.error('[CSG] Shutting down...');
        if (fileWatcher) await fileWatcher.stop();
        await lspManager.stopAll();
        cache.close();
        process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // 先连接 MCP transport，让 Claude Code 不会卡住
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[CSG] MCP server running on stdio');

    // MCP transport 断开时（如 Claude Code 退出）触发清理
    // SDK 的 StdioServerTransport 不监听 stdin 'end'，需要自己处理
    process.stdin.on('end', () => cleanup());

    // 后台启动 LSP（不阻塞 MCP 连接）
    console.error('[CSG] Starting LSP servers in background...');
    lspManager.startAll().then(async () => {
        const status = lspManager.getStatus();
        console.error(`[CSG] C# LSP: ${status.csharp.state} (${status.csharp.name})`);
        console.error(`[CSG] Lua LSP: ${status.lua.state} (${status.lua.name})`);

        // 等待 C# 索引完成
        console.error('[CSG] Waiting for C# indexing...');
        await lspManager.waitForCsharpIndexing(180_000);
        console.error('[CSG] C# indexing ready');

        // XLua 扫描（必须在 resolveIndexing 之前完成，否则工具会查到空表）
        if (options.luaRoot) {
            try {
                const scanResult = await xluaBridge.fullScan();
                console.error(`[CSG] XLua scan: ${scanResult.totalCalls} calls (${scanResult.aliasCallsFound} via alias), ${scanResult.verified} verified, ${scanResult.aliases} aliases (${scanResult.duration}ms)`);
            } catch (err) {
                console.error(`[CSG] XLua scan failed: ${err}`);
            }
        }

        // 索引和扫描都完成后才解除工具阻塞
        resolveIndexing!();
        console.error('[CSG] Tools unblocked');

        // LSP 就绪后启动文件监控
        const updateCoordinator = new UpdateCoordinator(
            lspManager, cache, xluaBridge, options.workspaceRoot,
        );
        fileWatcher = new FileWatcher(options.workspaceRoot, {
            debounceMs: options.fileWatcherDebounceMs,
        });

        fileWatcher.on('changes', async (changes: import('../watcher/file-watcher.js').FileChange[]) => {
            const result = await updateCoordinator.processChanges(changes);
            console.error(`[CSG] File update: ${result.filesProcessed} files (${result.duration}ms)`);
        });

        fileWatcher.start();
        console.error('[CSG] File watcher started');
    }).catch((err) => {
        console.error(`[CSG] LSP start failed: ${err}`);
        resolveIndexing!(); // 解除工具阻塞，让它们返回 LSP_NOT_READY
    });
}

/** 代理模式：通过 HTTP 转发到 daemon 进程 */
export async function startMcpProxyServer(daemonPort: number): Promise<void> {
    const server = new McpServer({
        name: 'CodeSymbolGraph',
        version: '0.1.0',
    });

    const proxyCall = async (endpoint: string, body: Record<string, unknown>) => {
        return new Promise<unknown>((resolve, reject) => {
            const data = JSON.stringify(body);
            const req = http.request({
                hostname: '127.0.0.1',
                port: daemonPort,
                path: endpoint,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
            }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
                    } catch {
                        reject(new Error('Invalid JSON from daemon'));
                    }
                });
            });
            req.on('error', reject);
            req.write(data);
            req.end();
        });
    };

    const proxyGet = async (endpoint: string) => {
        return new Promise<unknown>((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: daemonPort,
                path: endpoint,
                method: 'GET',
            }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
                    } catch {
                        reject(new Error('Invalid JSON from daemon'));
                    }
                });
            });
            req.on('error', reject);
            req.end();
        });
    };

    const toMcpResult = (result: unknown) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    });

    // 注册代理工具（schema 与直连模式保持一致）
    server.tool(
        'csg_find_definition',
        '查找符号定义位置。支持按名字搜索（如 "ItemManager"）或按文件位置精确查找。返回定义处代码片段。',
        {
            name: z.string().optional().describe('符号名（支持 FQN 如 "Game.ItemManager" 或短名如 "ItemManager"）'),
            file: z.string().optional().describe('文件路径（按位置查模式）'),
            line: z.number().optional().describe('行号 1-based（按位置查模式）'),
            column: z.number().optional().describe('列号 0-based（按位置查模式）'),
        },
        async (args) => toMcpResult(await proxyCall('/api/find-definition', args)),
    );

    server.tool(
        'csg_find_references',
        '查找符号的所有引用。支持按名字（如 "ItemManager.AddItem"）或按位置。自动包含跨语言引用。返回引用处代码片段。',
        {
            name: z.string().optional().describe('符号名'),
            file: z.string().optional().describe('文件路径'),
            line: z.number().optional().describe('行号 1-based'),
            column: z.number().optional().describe('列号 0-based'),
            exclude_generated: z.boolean().optional().default(true).describe('排除 XLua/Gen、CSObjectWrap 等生成代码（默认 true）'),
        },
        async (args) => toMcpResult(await proxyCall('/api/find-references', args)),
    );

    server.tool(
        'csg_call_chain',
        '查询方法的调用链（谁调用它 / 它调用谁）。支持按名字或按位置。返回调用处代码片段。',
        {
            name: z.string().optional().describe('方法名'),
            file: z.string().optional().describe('文件路径'),
            line: z.number().optional().describe('行号 1-based'),
            column: z.number().optional().describe('列号 0-based'),
            direction: z.enum(['incoming', 'outgoing', 'both']).default('both'),
            max_depth: z.number().optional().default(3).describe('最大递归深度'),
        },
        async (args) => toMcpResult(await proxyCall('/api/call-chain', args)),
    );

    server.tool(
        'csg_cross_lang',
        '查询 C# ↔ Lua 跨语言映射。输入 C# FQN 或 Lua CS.xxx 模式。返回调用处代码片段。',
        {
            name: z.string().describe('C# FQN 或 Lua 全局名（如 "CS.Game.ItemManager"）'),
        },
        async (args) => toMcpResult(await proxyCall('/api/cross-lang', args)),
    );

    server.tool(
        'csg_impact',
        '分析修改影响范围。支持按名字或按位置。返回 C# 引用 + Lua 跨语言调用，每条带代码片段。',
        {
            name: z.string().optional().describe('符号名'),
            file: z.string().optional().describe('文件路径'),
            line: z.number().optional().describe('行号 1-based'),
            column: z.number().optional().describe('列号 0-based'),
            exclude_generated: z.boolean().optional().default(true).describe('排除 XLua/Gen、CSObjectWrap 等生成代码（默认 true）'),
        },
        async (args) => toMcpResult(await proxyCall('/api/impact', args)),
    );

    server.tool(
        'csg_status',
        '查看 CodeSymbolGraph 运行状态（LSP、缓存、跨语言映射）',
        {},
        async () => toMcpResult(await proxyGet('/api/status')),
    );

    server.tool(
        'csg_find_asset',
        '按资源短名查找完整路径。支持精确匹配和模糊搜索。例如查找 "music_city" 返回资源完整路径。',
        {
            name: z.string().describe('资源短名（如 "music_city.wav" 或 "uniquetype"）'),
        },
        async (args) => toMcpResult(await proxyCall('/api/find-asset', args)),
    );

    server.tool(
        'csg_find_protocol',
        '查询 Protobuf 消息定义或配置表 schema。支持按类名或字段名搜索。返回类定义和所有字段。',
        {
            name: z.string().describe('协议/配置表类名（如 "PbNpcDataConfig"、"account_settings"）'),
            field: z.string().optional().describe('按字段名搜索（返回包含此字段的所有类）'),
        },
        async (args) => toMcpResult(await proxyCall('/api/find-protocol', args)),
    );

    server.tool(
        'csg_check_lua',
        '对 Lua 文件执行静态检查（LuaLS diagnostics）。返回错误和警告列表。',
        {
            file: z.string().describe('Lua 文件路径（相对或绝对）'),
            severity: z.enum(['error', 'warning', 'all']).optional().default('all').describe('返回的诊断级别'),
        },
        async (args) => toMcpResult(await proxyCall('/api/check-lua', args)),
    );

    server.tool(
        'csg_check_csharp',
        '对 C# 文件执行编译检查。返回编译错误和警告列表。默认过滤 Unity 程序集缺失的噪音错误。',
        {
            file: z.string().describe('C# 文件路径（相对或绝对）'),
            severity: z.enum(['error', 'warning', 'all']).optional().default('all').describe('返回的诊断级别'),
            filter_noise: z.boolean().optional().default(true).describe('是否过滤 Unity 程序集缺失的噪音错误（默认 true）'),
        },
        async (args) => toMcpResult(await proxyCall('/api/check-csharp', args)),
    );

    const cleanup = async () => {
        console.error('[CSG] Proxy shutting down...');
        process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[CSG] MCP proxy server running on stdio → daemon :${daemonPort}`);

    process.stdin.on('end', () => cleanup());
}
