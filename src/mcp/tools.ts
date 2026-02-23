import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { QueryService } from '../core/query-service.js';
import { XLuaBridge } from '../bridge/xlua-bridge.js';
import { LspManager } from '../lsp/lsp-manager.js';
import { CacheManager } from '../cache/cache-manager.js';
import { errorResponse, type McpToolResponse } from '../utils/mcp-response.js';
import { clearSnippetCache } from '../utils/snippet.js';
import { LspTimeoutError } from '../utils/timeout.js';
import { z } from 'zod';
import {
    type QueryContext,
    handleFindDefinition,
    handleFindReferences,
    handleCallChain,
    handleCrossLang,
    handleImpact,
    handleHierarchy,
    handleStatus,
    handleFindAsset,
    handleFindProtocol,
    handleCheckLua,
    handleCheckCsharp,
} from '../daemon/query-handler.js';
import type { AssetIndex } from '../core/asset-index.js';
import type { ProtocolIndex } from '../core/protocol-index.js';

const INDEXING_WAIT_TIMEOUT = 90_000;

/** 统一错误处理包装，自动等待索引完成 */
async function wrapTool<T>(
    lspManager: LspManager,
    indexingReady: Promise<void>,
    fn: () => Promise<McpToolResponse<T>>,
): Promise<{ content: { type: 'text'; text: string }[] }> {
    const lspStatus = lspManager.getLspStatusForMcp();

    // 等待索引完成（带超时保护）
    try {
        await Promise.race([
            indexingReady,
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('C# indexing timeout')), INDEXING_WAIT_TIMEOUT),
            ),
        ]);
    } catch {
        const resp = errorResponse(
            'LSP_NOT_READY',
            'C# indexing still in progress, please retry later',
            lspStatus,
        );
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(resp) }],
        };
    }

    try {
        const result = await fn();
        return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
    } catch (e: unknown) {
        const err = e as Error;
        let resp: McpToolResponse;

        if (e instanceof LspTimeoutError) {
            resp = errorResponse('LSP_TIMEOUT', err.message, lspStatus);
        } else if (err.message?.includes('not ready')) {
            resp = errorResponse('LSP_NOT_READY', err.message, lspStatus);
        } else {
            resp = errorResponse('INTERNAL_ERROR', err.message || 'Unknown error', lspStatus);
        }

        return {
            content: [{ type: 'text' as const, text: JSON.stringify(resp) }],
        };
    } finally {
        clearSnippetCache();
    }
}

export function registerTools(
    server: McpServer,
    queryService: QueryService,
    xluaBridge: XLuaBridge,
    lspManager: LspManager,
    cache: CacheManager,
    workspaceRoot: string,
    indexingReady: Promise<void>,
    assetIndex?: AssetIndex,
    protocolIndex?: ProtocolIndex,
): void {
    const ctx: QueryContext = { queryService, xluaBridge, lspManager, cache, workspaceRoot, assetIndex, protocolIndex };

    // ===== csg_find_definition =====
    server.tool(
        'csg_find_definition',
        '查找符号定义位置。支持按名字搜索（如 "ItemManager"）或按文件位置精确查找。返回定义处代码片段。',
        {
            name: z.string().optional().describe('符号名（支持 FQN 如 "Game.ItemManager" 或短名如 "ItemManager"）'),
            file: z.string().optional().describe('文件路径（按位置查模式）'),
            line: z.number().optional().describe('行号 1-based（按位置查模式）'),
            column: z.number().optional().describe('列号 0-based（按位置查模式）'),
        },
        async (args) => wrapTool(lspManager, indexingReady, () =>
            handleFindDefinition(ctx, args),
        ),
    );

    // ===== csg_find_references =====
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
        async (args) => wrapTool(lspManager, indexingReady, () =>
            handleFindReferences(ctx, args),
        ),
    );

    // ===== csg_call_chain =====
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
        async (args) => wrapTool(lspManager, indexingReady, () =>
            handleCallChain(ctx, args),
        ),
    );

    // ===== csg_cross_lang =====
    server.tool(
        'csg_cross_lang',
        '查询 C# ↔ Lua 跨语言映射。输入 C# FQN 或 Lua CS.xxx 模式。返回调用处代码片段。',
        {
            name: z.string().describe('C# FQN 或 Lua 全局名（如 "CS.Game.ItemManager"）'),
        },
        async (args) => wrapTool(lspManager, indexingReady, () =>
            handleCrossLang(ctx, args),
        ),
    );

    // ===== csg_impact =====
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
        async (args) => wrapTool(lspManager, indexingReady, () =>
            handleImpact(ctx, args),
        ),
    );

    // ===== csg_hierarchy =====
    server.tool(
        'csg_hierarchy',
        '查询 C# 类/接口的继承树：基类、实现的接口、所有子类/实现类。返回各实现类的 Lua 跨语言使用数量。',
        {
            name: z.string().describe('C# 类名或接口名（如 "IInventorySystem" 或 "MonoBehaviour"）'),
        },
        async (args) => wrapTool(lspManager, indexingReady, () =>
            handleHierarchy(ctx, args),
        ),
    );

    // ===== csg_status =====
    server.tool(
        'csg_status',
        '查看 CodeSymbolGraph 运行状态（LSP、缓存、跨语言映射）',
        {},
        async () => {
            const result = await handleStatus(ctx);
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify(result),
                }],
            };
        },
    );

    // ===== csg_find_asset =====
    server.tool(
        'csg_find_asset',
        '按资源短名查找完整路径。支持精确匹配和模糊搜索。例如查找 "music_city" 返回资源完整路径。',
        {
            name: z.string().describe('资源短名（如 "music_city.wav" 或 "uniquetype"）'),
        },
        async (args) => {
            const result = await handleFindAsset(ctx, args);
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            };
        },
    );

    // ===== csg_find_protocol =====
    server.tool(
        'csg_find_protocol',
        '查询 Protobuf 消息定义或配置表 schema。支持按类名或字段名搜索。返回类定义和所有字段。',
        {
            name: z.string().describe('协议/配置表类名（如 "PbNpcDataConfig"、"account_settings"）'),
            field: z.string().optional().describe('按字段名搜索（返回包含此字段的所有类）'),
        },
        async (args) => {
            const result = await handleFindProtocol(ctx, args);
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            };
        },
    );

    // ===== csg_check_lua =====
    server.tool(
        'csg_check_lua',
        '对 Lua 文件执行静态检查（LuaLS diagnostics）。返回错误和警告列表。',
        {
            file: z.string().describe('Lua 文件路径（相对或绝对）'),
            severity: z.enum(['error', 'warning', 'all']).optional().default('all').describe('返回的诊断级别'),
        },
        async (args) => wrapTool(lspManager, indexingReady, () =>
            handleCheckLua(ctx, args),
        ),
    );

    // ===== csg_check_csharp =====
    server.tool(
        'csg_check_csharp',
        '对 C# 文件执行编译检查。返回编译错误和警告列表。默认过滤 Unity 程序集缺失的噪音错误。',
        {
            file: z.string().describe('C# 文件路径（相对或绝对）'),
            severity: z.enum(['error', 'warning', 'all']).optional().default('all').describe('返回的诊断级别'),
            filter_noise: z.boolean().optional().default(true).describe('是否过滤 Unity 程序集缺失的噪音错误（默认 true）'),
        },
        async (args) => wrapTool(lspManager, indexingReady, () =>
            handleCheckCsharp(ctx, args),
        ),
    );
}
