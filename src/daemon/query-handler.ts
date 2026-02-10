/**
 * 共享查询逻辑，供 MCP tools 和 HTTP daemon 共用。
 * 所有方法返回统一的 McpToolResponse 格式。
 */
import { QueryService, isGeneratedCode } from '../core/query-service.js';
import { XLuaBridge, type CrossLangResult } from '../bridge/xlua-bridge.js';
import { LspManager } from '../lsp/lsp-manager.js';
import { CacheManager } from '../cache/cache-manager.js';
import { successResponse, errorResponse, type McpToolResponse } from '../utils/mcp-response.js';
import { readSnippet, clearSnippetCache } from '../utils/snippet.js';
import type { CallChainNode } from '../core/query-service.js';

export interface QueryContext {
    queryService: QueryService;
    xluaBridge: XLuaBridge;
    lspManager: LspManager;
    cache: CacheManager;
    workspaceRoot: string;
}

export async function handleFindDefinition(
    ctx: QueryContext,
    args: { name?: string; file?: string; line?: number; column?: number },
): Promise<McpToolResponse> {
    try {
        const results = await ctx.queryService.findDefinition({
            name: args.name,
            file: args.file,
            line: args.line,
            character: args.column,
        });

        const lspStatus = ctx.lspManager.getLspStatusForMcp();

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
                snippet: readSnippet(ctx.workspaceRoot, r.file, r.line, 2),
            })),
        );
    } finally {
        clearSnippetCache();
    }
}

export async function handleFindReferences(
    ctx: QueryContext,
    args: { name?: string; file?: string; line?: number; column?: number; exclude_generated?: boolean },
): Promise<McpToolResponse> {
    try {
        const result = await ctx.queryService.findReferences({
            name: args.name,
            file: args.file,
            line: args.line,
            character: args.column,
        });

        let xluaRefs: unknown = null;
        if (result.symbolFqn) {
            try {
                xluaRefs = await ctx.xluaBridge.queryCrossLang(result.symbolFqn);
            } catch { /* don't block */ }
        }

        const xluaResult = xluaRefs as { lua?: { callSites?: { file: string; line: number }[] } } | null;
        const crossLang = xluaResult?.lua?.callSites || [];

        const excludeGenerated = args.exclude_generated !== false;
        const filteredRefs = excludeGenerated
            ? result.references.filter(r => !isGeneratedCode(r.file))
            : result.references;

        const refs = filteredRefs.map((r, i) => ({
            file: r.file,
            line: r.line,
            ...(i < 50 ? { snippet: readSnippet(ctx.workspaceRoot, r.file, r.line, 1) } : {}),
        }));

        const crossLangWithSnippet = crossLang.map((c: { file: string; line: number }, i: number) => ({
            ...c,
            ...(i < 50 ? { snippet: readSnippet(ctx.workspaceRoot, c.file, c.line, 1) } : {}),
        }));

        return successResponse({
            symbol: result.symbolFqn,
            references: refs,
            count: refs.length,
            totalBeforeFilter: result.count,
            crossLanguage: crossLangWithSnippet,
        });
    } finally {
        clearSnippetCache();
    }
}

export async function handleCallChain(
    ctx: QueryContext,
    args: { name?: string; file?: string; line?: number; column?: number; direction?: string; max_depth?: number },
): Promise<McpToolResponse> {
    try {
        const result = await ctx.queryService.findCallChain({
            name: args.name,
            file: args.file,
            line: args.line,
            character: args.column,
            direction: (args.direction || 'both') as 'incoming' | 'outgoing' | 'both',
            maxDepth: args.max_depth ?? 3,
        });

        let snippetCount = 0;
        const addSnippets = (nodes: CallChainNode[]): (CallChainNode & { snippet?: string })[] =>
            nodes.map(n => ({
                ...n,
                ...(snippetCount < 30
                    ? (snippetCount++, { snippet: readSnippet(ctx.workspaceRoot, n.file, n.line, 1) })
                    : {}),
                children: addSnippets(n.children),
            }));

        return successResponse({
            root: result.root,
            incoming: addSnippets(result.incoming),
            outgoing: addSnippets(result.outgoing),
        });
    } finally {
        clearSnippetCache();
    }
}

export async function handleCrossLang(
    ctx: QueryContext,
    args: { name: string },
): Promise<McpToolResponse> {
    try {
        const result = await ctx.xluaBridge.queryCrossLang(args.name);
        const lspStatus = ctx.lspManager.getLspStatusForMcp();

        if (!result) {
            return errorResponse(
                'NO_MATCH',
                `No XLua mapping found for: ${args.name}`,
                lspStatus,
            );
        }

        const callSites = result.lua.callSites.map((c, i) => ({
            ...c,
            ...(i < 50 ? { snippet: readSnippet(ctx.workspaceRoot, c.file, c.line, 1) } : {}),
        }));

        return successResponse({
            csharp: result.csharp,
            lua: { globalName: result.lua.globalName, callSites },
        });
    } finally {
        clearSnippetCache();
    }
}

export async function handleImpact(
    ctx: QueryContext,
    args: { name?: string; file?: string; line?: number; column?: number; exclude_generated?: boolean },
): Promise<McpToolResponse> {
    try {
        const refs = await ctx.queryService.findReferences({
            name: args.name,
            file: args.file,
            line: args.line,
            character: args.column,
        });

        let xluaResult: CrossLangResult | null = null;
        if (refs.symbolFqn) {
            try {
                xluaResult = await ctx.xluaBridge.queryCrossLang(refs.symbolFqn);
            } catch { /* don't block */ }
        }

        const excludeGenerated = args.exclude_generated !== false;
        const filteredRefs = excludeGenerated
            ? refs.references.filter(r => !isGeneratedCode(r.file))
            : refs.references;

        const fileGroups = new Map<string, { file: string; line: number; character: number }[]>();
        for (const ref of filteredRefs) {
            if (!fileGroups.has(ref.file)) fileGroups.set(ref.file, []);
            fileGroups.get(ref.file)!.push(ref);
        }

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
                            ? (fileSnippets++, totalSnippets++, { snippet: readSnippet(ctx.workspaceRoot, f, loc.line, 1) })
                            : {}),
                    })),
                };
            })
            .sort((a, b) => b.count - a.count);

        const crossLangImpact = (xluaResult?.lua?.callSites || []).map((c, i) => ({
            ...c,
            ...(i < 50 ? { snippet: readSnippet(ctx.workspaceRoot, c.file, c.line, 1) } : {}),
        }));

        return successResponse({
            symbol: refs.symbolFqn,
            totalReferences: filteredRefs.length,
            totalBeforeFilter: refs.count,
            affectedFiles,
            crossLanguageImpact: crossLangImpact,
        });
    } finally {
        clearSnippetCache();
    }
}

export async function handleStatus(
    ctx: QueryContext,
): Promise<McpToolResponse> {
    const lspStatus = ctx.lspManager.getStatus();
    const cacheStats = ctx.cache.getStats();
    return successResponse({ lsp: lspStatus, cache: cacheStats });
}
