import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { QueryService } from '../core/query-service.js';
import { XLuaBridge, type CrossLangResult } from '../bridge/xlua-bridge.js';
import { LspManager } from '../lsp/lsp-manager.js';
import { CacheManager } from '../cache/cache-manager.js';
import { successResponse, errorResponse, type McpToolResponse } from '../utils/mcp-response.js';
import { readSnippet, clearSnippetCache } from '../utils/snippet.js';
import { LspTimeoutError } from '../utils/timeout.js';
import { z } from 'zod';
import type { CallChainNode } from '../core/query-service.js';

/** 统一错误处理包装 */
async function wrapTool<T>(
    lspManager: LspManager,
    fn: () => Promise<McpToolResponse<T>>,
): Promise<{ content: { type: 'text'; text: string }[] }> {
    const lspStatus = lspManager.getLspStatusForMcp();

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
): void {

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
        async (args) => wrapTool(lspManager, async () => {
            const results = await queryService.findDefinition({
                name: args.name,
                file: args.file,
                line: args.line,
                character: args.column,
            });

            const lspStatus = lspManager.getLspStatusForMcp();

            if (results.length === 0) {
                return errorResponse(
                    'NO_MATCH',
                    `No definition found for: ${args.name || args.file}`,
                    lspStatus,
                );
            }

            return successResponse(
                results.slice(0, 10).map(r => ({
                    name: r.name,
                    fqn: r.fqn,
                    kind: r.kind,
                    language: r.language,
                    file: r.file,
                    line: r.line,
                    snippet: readSnippet(workspaceRoot, r.file, r.line, 2),
                })),
            );
        }),
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
        },
        async (args) => wrapTool(lspManager, async () => {
            const result = await queryService.findReferences({
                name: args.name,
                file: args.file,
                line: args.line,
                character: args.column,
            });

            let xluaRefs: unknown = null;
            if (result.symbolFqn) {
                try {
                    xluaRefs = await xluaBridge.queryCrossLang(result.symbolFqn);
                } catch { /* don't block */ }
            }

            const xluaResult = xluaRefs as { lua?: { callSites?: { file: string; line: number }[] } } | null;
            const crossLang = xluaResult?.lua?.callSites || [];

            // 前 50 条带 snippet，超出只带行号
            const refs = result.references.map((r, i) => ({
                file: r.file,
                line: r.line,
                ...(i < 50 ? { snippet: readSnippet(workspaceRoot, r.file, r.line, 1) } : {}),
            }));

            // 跨语言引用也带 snippet（前 50 条）
            const crossLangWithSnippet = crossLang.map((c: { file: string; line: number }, i: number) => ({
                ...c,
                ...(i < 50 ? { snippet: readSnippet(workspaceRoot, c.file, c.line, 1) } : {}),
            }));

            return successResponse({
                symbol: result.symbolFqn,
                references: refs,
                count: result.count,
                crossLanguage: crossLangWithSnippet,
            });
        }),
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
        async (args) => wrapTool(lspManager, async () => {
            const result = await queryService.findCallChain({
                name: args.name,
                file: args.file,
                line: args.line,
                character: args.column,
                direction: args.direction,
                maxDepth: args.max_depth,
            });

            // 为 CallChainNode 树添加 snippet，总量限制 30 条
            let snippetCount = 0;
            const addSnippets = (nodes: CallChainNode[]): (CallChainNode & { snippet?: string })[] =>
                nodes.map(n => ({
                    ...n,
                    ...(snippetCount < 30
                        ? (snippetCount++, { snippet: readSnippet(workspaceRoot, n.file, n.line, 1) })
                        : {}),
                    children: addSnippets(n.children),
                }));

            return successResponse({
                root: result.root,
                incoming: addSnippets(result.incoming),
                outgoing: addSnippets(result.outgoing),
            });
        }),
    );

    // ===== csg_cross_lang =====
    server.tool(
        'csg_cross_lang',
        '查询 C# ↔ Lua 跨语言映射。输入 C# FQN 或 Lua CS.xxx 模式。返回调用处代码片段。',
        {
            name: z.string().describe('C# FQN 或 Lua 全局名（如 "CS.Game.ItemManager"）'),
        },
        async (args) => wrapTool(lspManager, async () => {
            const result = await xluaBridge.queryCrossLang(args.name);

            const lspStatus = lspManager.getLspStatusForMcp();

            if (!result) {
                return errorResponse(
                    'NO_MATCH',
                    `No XLua mapping found for: ${args.name}`,
                    lspStatus,
                );
            }

            // 前 50 条 callSites 带 snippet
            const callSites = result.lua.callSites.map((c, i) => ({
                ...c,
                ...(i < 50 ? { snippet: readSnippet(workspaceRoot, c.file, c.line, 1) } : {}),
            }));

            return successResponse({
                csharp: result.csharp,
                lua: { globalName: result.lua.globalName, callSites },
            });
        }),
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
        },
        async (args) => wrapTool(lspManager, async () => {
            const refs = await queryService.findReferences({
                name: args.name,
                file: args.file,
                line: args.line,
                character: args.column,
            });

            let xluaResult: CrossLangResult | null = null;
            if (refs.symbolFqn) {
                try {
                    xluaResult = await xluaBridge.queryCrossLang(refs.symbolFqn);
                } catch { /* don't block */ }
            }

            const fileGroups = new Map<string, { file: string; line: number; character: number }[]>();
            for (const ref of refs.references) {
                if (!fileGroups.has(ref.file)) fileGroups.set(ref.file, []);
                fileGroups.get(ref.file)!.push(ref);
            }

            // 每文件最多 5 条 snippet，总上限 50 条
            let totalSnippets = 0;
            const affectedFiles = Array.from(fileGroups.entries())
                .map(([f, locs]) => {
                    let fileSnippets = 0;
                    return {
                        file: f,
                        count: locs.length,
                        locations: locs.map(loc => ({
                            line: loc.line,
                            ...(fileSnippets < 5 && totalSnippets < 50
                                ? (fileSnippets++, totalSnippets++, { snippet: readSnippet(workspaceRoot, f, loc.line, 1) })
                                : {}),
                        })),
                    };
                })
                .sort((a, b) => b.count - a.count);

            const crossLangImpact = (xluaResult?.lua?.callSites || []).map((c, i) => ({
                ...c,
                ...(i < 50 ? { snippet: readSnippet(workspaceRoot, c.file, c.line, 1) } : {}),
            }));

            return successResponse({
                symbol: refs.symbolFqn,
                totalReferences: refs.count,
                affectedFiles,
                crossLanguageImpact: crossLangImpact,
            });
        }),
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
                        successResponse({ lsp: lspStatus, cache: cacheStats }),
                    ),
                }],
            };
        },
    );
}
