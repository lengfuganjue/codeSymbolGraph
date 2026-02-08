import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { LspManager, type LspManagerOptions } from '../lsp/lsp-manager.js';
import { CacheManager } from '../cache/cache-manager.js';
import { QueryService } from '../core/query-service.js';
import { XLuaBridge } from '../bridge/xlua-bridge.js';
import { FileWatcher } from '../watcher/file-watcher.js';
import { UpdateCoordinator } from '../core/update-coordinator.js';
import { registerTools } from './tools.js';

export interface CsgServerOptions extends LspManagerOptions {
    dbPath: string;
    luaRoot?: string;
}

export async function startMcpServer(options: CsgServerOptions): Promise<void> {
    const server = new McpServer({
        name: 'CodeSymbolGraph',
        version: '0.1.0',
    });

    const lspManager = new LspManager(options);
    const cache = new CacheManager(options.dbPath);
    const queryService = new QueryService(lspManager, cache, options.workspaceRoot);
    const xluaBridge = new XLuaBridge(
        lspManager, cache, options.workspaceRoot,
        options.luaRoot || options.workspaceRoot,
    );

    // 转发 LSP 日志
    lspManager.on('log', (e: { level: string; message: string }) => {
        console.error(`[CSG] [${e.level}] ${e.message}`);
    });

    // 注册 MCP 工具
    registerTools(server, queryService, xluaBridge, lspManager, cache, options.workspaceRoot);

    // 先连接 MCP transport，让 Claude Code 不会卡住
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[CSG] MCP server running on stdio');

    // 后台启动 LSP（不阻塞 MCP 连接）
    console.error('[CSG] Starting LSP servers in background...');
    lspManager.startAll().then(() => {
        const status = lspManager.getStatus();
        console.error(`[CSG] C# LSP: ${status.csharp.state} (${status.csharp.name})`);
        console.error(`[CSG] Lua LSP: ${status.lua.state} (${status.lua.name})`);

        // LSP 就绪后启动文件监控
        const updateCoordinator = new UpdateCoordinator(
            lspManager, cache, xluaBridge, options.workspaceRoot,
        );
        const fileWatcher = new FileWatcher(options.workspaceRoot);

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

        // 注册清理（需要在这里捕获 fileWatcher 引用）
        const cleanup = async () => {
            console.error('[CSG] Shutting down...');
            await fileWatcher.stop();
            await lspManager.stopAll();
            cache.close();
            process.exit(0);
        };
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
    }).catch((err) => {
        console.error(`[CSG] LSP start failed: ${err}`);
        // MCP 仍然运行，工具调用会返回 LSP_NOT_READY 错误
    });
}
