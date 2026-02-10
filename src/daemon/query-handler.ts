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
import type { AssetIndex } from '../core/asset-index.js';
import type { ProtocolIndex } from '../core/protocol-index.js';

export interface QueryContext {
    queryService: QueryService;
    xluaBridge: XLuaBridge;
    lspManager: LspManager;
    cache: CacheManager;
    workspaceRoot: string;
    assetIndex?: AssetIndex;
    protocolIndex?: ProtocolIndex;
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

export async function handleFindAsset(
    ctx: QueryContext,
    args: { name: string },
): Promise<McpToolResponse> {
    const lspStatus = ctx.lspManager.getLspStatusForMcp();

    if (!ctx.assetIndex?.isLoaded) {
        return errorResponse('NOT_AVAILABLE', 'Asset index not loaded (no AssetsNameToolCacheFile.txt found)', lspStatus);
    }

    const results = ctx.assetIndex.find(args.name);
    if (results.length === 0) {
        return errorResponse('NO_MATCH', `No asset found matching: ${args.name}`, lspStatus);
    }

    return successResponse({
        results: results.map(r => ({ shortName: r.shortName, fullPaths: r.fullPaths })),
        count: results.length,
    });
}

export async function handleFindProtocol(
    ctx: QueryContext,
    args: { name: string; field?: string },
): Promise<McpToolResponse> {
    const lspStatus = ctx.lspManager.getLspStatusForMcp();

    if (!ctx.protocolIndex?.isLoaded) {
        return errorResponse('NOT_AVAILABLE', 'Protocol index not loaded (no EmmyLuaAnnotations directory found)', lspStatus);
    }

    const classes = ctx.protocolIndex.find(args.name, args.field);
    if (classes.length === 0) {
        const desc = args.field ? `field "${args.field}"` : `"${args.name}"`;
        return errorResponse('NO_MATCH', `No protocol/config found matching: ${desc}`, lspStatus);
    }

    return successResponse({
        classes: classes.map(c => ({
            name: c.name,
            comment: c.comment,
            source: c.source,
            file: c.file,
            line: c.line,
            fields: c.fields,
        })),
        count: classes.length,
    });
}

export async function handleCheckLua(
    ctx: QueryContext,
    args: { file: string; severity?: string },
): Promise<McpToolResponse> {
    const result = await ctx.lspManager.checkFile(args.file);
    const severity = args.severity || 'all';

    const diagnostics: { errors: unknown[]; warnings: unknown[] } = {
        errors: result.errors.map(d => ({
            line: d.range.start.line + 1,
            message: d.message,
            source: d.source,
        })),
        warnings: result.warnings.map(d => ({
            line: d.range.start.line + 1,
            message: d.message,
            source: d.source,
        })),
    };

    const data: Record<string, unknown> = { file: result.file };
    if (severity === 'error') {
        data.errors = diagnostics.errors;
        data.total = diagnostics.errors.length;
    } else if (severity === 'warning') {
        data.errors = diagnostics.errors;
        data.warnings = diagnostics.warnings;
        data.total = diagnostics.errors.length + diagnostics.warnings.length;
    } else {
        data.errors = diagnostics.errors;
        data.warnings = diagnostics.warnings;
        data.total = diagnostics.errors.length + diagnostics.warnings.length;
    }

    return successResponse(data);
}

/** 匹配 Unity 程序集缺失导致的噪音错误（CS0246/CS0234/CS0103/CS0115 等） */
const UNITY_NOISE_PATTERNS = [
    // CS0246: 未能找到类型或命名空间名
    /未能找到类型或命名空间名/,
    /The type or namespace name .+ could not be found/,
    // CS0234: 命名空间中不存在类型
    /中不存在类型或命名空间名/,
    /does not exist in the namespace/,
    // CS0103: 当前上下文中不存在名称（如 Application, GameObject, Mathf 等 Unity API）
    /当前上下文中不存在名称/,
    /The name .+ does not exist in the current context/,
    // CS0115: 找不到适合的方法来重写（缺少基类）
    /找不到适合的方法来重写/,
    /no suitable method found to override/i,
    // CS0246/CS1061: 缺少程序集引用导致的成员找不到
    /是否缺少 using 指令或程序集引用/,
    /are you missing a using directive or an assembly reference/i,
];

function isUnityNoiseError(message: string): boolean {
    return UNITY_NOISE_PATTERNS.some(p => p.test(message));
}

export async function handleCheckCsharp(
    ctx: QueryContext,
    args: { file: string; severity?: string; filter_noise?: boolean },
): Promise<McpToolResponse> {
    const result = await ctx.lspManager.checkFile(args.file);
    const severity = args.severity || 'all';
    const filterNoise = args.filter_noise !== false; // 默认过滤

    const mapDiag = (d: { range: { start: { line: number } }; message: string; source?: string }) => ({
        line: d.range.start.line + 1,
        message: d.message,
        source: d.source,
    });

    let errors = result.errors.map(mapDiag);
    const warnings = result.warnings.map(mapDiag);

    let filteredCount = 0;
    if (filterNoise) {
        const before = errors.length;
        errors = errors.filter(e => !isUnityNoiseError(e.message));
        filteredCount = before - errors.length;
    }

    const data: Record<string, unknown> = { file: result.file };
    if (severity === 'error') {
        data.errors = errors;
        data.total = errors.length;
    } else if (severity === 'warning') {
        data.errors = errors;
        data.warnings = warnings;
        data.total = errors.length + warnings.length;
    } else {
        data.errors = errors;
        data.warnings = warnings;
        data.total = errors.length + warnings.length;
    }
    if (filteredCount > 0) {
        data.filteredUnityNoise = filteredCount;
    }

    return successResponse(data);
}
