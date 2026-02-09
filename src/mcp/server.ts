import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { LspManager, type LspManagerOptions } from '../lsp/lsp-manager.js';
import { CacheManager, type CacheManagerOptions } from '../cache/cache-manager.js';
import { QueryService } from '../core/query-service.js';
import { XLuaBridge } from '../bridge/xlua-bridge.js';
import { FileWatcher } from '../watcher/file-watcher.js';
import { UpdateCoordinator } from '../core/update-coordinator.js';
import { registerTools } from './tools.js';

export interface CsgServerOptions extends LspManagerOptions {
    dbPath: string;
    luaRoot?: string;
    extraThirdPartyNamespaces?: string[];
    cacheOptions?: CacheManagerOptions;
    fileWatcherDebounceMs?: number;
}

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
    registerTools(server, queryService, xluaBridge, lspManager, cache, options.workspaceRoot, indexingReady);

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
        await lspManager.waitForCsharpIndexing();
        resolveIndexing!();
        console.error('[CSG] C# indexing ready, tools unblocked');

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

        // LSP 就绪后自动运行 XLua 扫描（填充跨语言映射缓存）
        if (options.luaRoot) {
            xluaBridge.fullScan().then((scanResult) => {
                console.error(`[CSG] XLua scan: ${scanResult.totalCalls} calls, ${scanResult.verified} verified, ${scanResult.unresolved} unresolved (${scanResult.duration}ms)`);
            }).catch((err) => {
                console.error(`[CSG] XLua scan failed: ${err}`);
            });
        }
    }).catch((err) => {
        console.error(`[CSG] LSP start failed: ${err}`);
        resolveIndexing!(); // 解除工具阻塞，让它们返回 LSP_NOT_READY
    });
}
