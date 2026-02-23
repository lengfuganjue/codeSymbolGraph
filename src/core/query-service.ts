import { LspManager } from '../lsp/lsp-manager.js';
import { CacheManager, type CachedSymbol } from '../cache/cache-manager.js';
import { relativeToUri, uriToRelative } from '../utils/uri.js';
import { LspTimeoutError } from '../utils/timeout.js';
import type { Location, DocumentSymbol, SymbolInformation, WorkspaceEdit, TextEdit } from 'vscode-languageserver-protocol';
import { glob } from 'glob';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

/** 检测是否是 XLua/代码生成器输出的文件（不应作为定义结果优先返回） */
export function isGeneratedCode(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    return /\bXLua\/Gen\b/i.test(normalized)
        || /\bCSObjectWrap\b/i.test(normalized)
        || /Wrap\.cs$/i.test(normalized);
}

/**
 * 对定义结果排序：源码优先，生成代码靠后。
 * 同等条件下 Packages/ 和 Assets/ 优先于其他路径。
 */
function definitionPriority(filePath: string): number {
    if (isGeneratedCode(filePath)) return 100;
    const normalized = filePath.replace(/\\/g, '/');
    if (normalized.includes('Packages/') || normalized.includes('Assets/')) return 0;
    return 50;
}

/**
 * 行级语义上下文分类（启发式）。
 * 判断某一行代码是注释、字符串、定义还是调用。
 */
export function classifyLineContext(
    line: string,
    language: 'csharp' | 'lua',
): 'call' | 'definition' | 'comment' | 'string' | 'unknown' {
    const trimmed = line.trimStart();

    if (language === 'csharp') {
        // 注释：行以 // 开头 或 以 /* 开头（块注释起始行） 或 以 * 开头（块注释中间行）
        if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
            return 'comment';
        }
        // 字符串：简单启发式 - 行以引号包围的字面量为主体
        // 如果 trimmed 去掉前面的赋值/return 后以 " 或 @" 或 $" 开头，标记为 string
        if (/^\s*"/.test(trimmed) || /^\s*\$"/.test(trimmed) || /^\s*@"/.test(trimmed)) {
            return 'string';
        }
        // 定义：包含类/方法/属性定义关键字
        if (/\b(class|interface|enum|struct)\s+\w/.test(trimmed)) {
            return 'definition';
        }
        if (/\b(public|private|protected|internal|static|virtual|override|abstract|async)\s+/.test(trimmed)
            && /\b(void|int|bool|string|float|double|long|decimal|byte|char|object|var|Task|IEnumerable|List|Dictionary)\s+\w+\s*[({]/.test(trimmed)) {
            return 'definition';
        }
        if (/\b(public|private|protected|internal|static)\s+/.test(trimmed)
            && /\b(class|interface|enum|struct|void)\b/.test(trimmed)) {
            return 'definition';
        }
        // 包含方法返回类型 + 方法名 + ( 的模式
        if (/\b(public|private|protected|internal|static|virtual|override|abstract|async)\s+/.test(trimmed)
            && /\w+\s+\w+\s*\(/.test(trimmed)
            && !trimmed.includes('=')) {
            return 'definition';
        }
        // 剩余归为 call
        return 'call';
    }

    if (language === 'lua') {
        // 注释：行以 -- 开头
        if (trimmed.startsWith('--')) {
            return 'comment';
        }
        // 字符串：行以引号开头（赋值到字符串变量场景）
        if (/^\s*["']/.test(trimmed) || /^\s*\[\[/.test(trimmed)) {
            return 'string';
        }
        // 定义：包含 function 关键字（定义形式）
        if (/\bfunction\s+\w/.test(trimmed)
            || /\blocal\s+function\s+\w/.test(trimmed)
            || /=\s*function\s*\(/.test(trimmed)) {
            return 'definition';
        }
        // 剩余归为 call
        return 'call';
    }

    return 'unknown';
}

/** normalizeDocSymbols 的返回类型 */
interface NormalizedSymbols {
    symbols: DocumentSymbol[];
    /** true = 来自 SymbolInformation（flat），range 只是标识符行，不可用于 containment */
    isFlat: boolean;
}

export class QueryService {
    constructor(
        private lspManager: LspManager,
        private cache: CacheManager,
        private workspaceRoot: string,
    ) {}

    // ===== 符号解析（名字 → 位置） =====

    async resolveSymbol(name: string, kind?: number): Promise<ResolvedSymbol[]> {
        // 1. 精确 fqn 匹配
        let cached = this.cache.findSymbols({ fqn: name, kind, limit: 10 });
        if (cached && cached.length > 0 && cached.some(c => !c.stale)) {
            return cached.filter(c => !c.stale).map(this.cachedToResolved);
        }

        // 2. name 精确匹配
        cached = this.cache.findSymbols({ name, kind, limit: 10 });
        if (cached && cached.length > 0 && cached.some(c => !c.stale)) {
            return cached.filter(c => !c.stale).map(this.cachedToResolved);
        }

        // 3. FTS 模糊匹配
        cached = this.cache.findSymbols({ name, fuzzy: true, kind, limit: 10 });
        if (cached && cached.length > 0 && cached.some(c => !c.stale)) {
            return cached.filter(c => !c.stale).map(this.cachedToResolved);
        }

        // 4. LSP 兜底
        const lspStatus = this.lspManager.getStatus();

        if (!lspStatus.csharp.state && !lspStatus.lua.state) {
            // 返回 stale 缓存
            if (cached && cached.length > 0) {
                return cached.map(c => ({ ...this.cachedToResolved(c), stale: true }));
            }
            return [];
        }

        return this.resolveViaLsp(name);
    }

    private async resolveViaLsp(name: string): Promise<ResolvedSymbol[]> {
        const exactResults: ResolvedSymbol[] = [];
        const fuzzyResults: ResolvedSymbol[] = [];
        const searchTerm = name.includes('.') ? name.split('.').pop()! : name;

        for (const lang of ['csharp', 'lua'] as const) {
            try {
                const client = this.lspManager.getClientForLanguage(lang);
                if (client.state !== 'ready') continue;

                const symbols = await client.workspaceSymbol(searchTerm);

                for (const sym of symbols) {
                    // LuaLS 可能用 ":" 做方法分隔符，统一为 "." 比较
                    const containerNorm = sym.containerName?.replace(/:/g, '.') || '';
                    const symFqn = containerNorm
                        ? `${containerNorm}.${sym.name}`
                        : sym.name;

                    const resolved: ResolvedSymbol = {
                        name: sym.name,
                        fqn: symFqn,
                        kind: sym.kind,
                        language: lang,
                        file: uriToRelative(this.workspaceRoot, sym.location.uri),
                        line: sym.location.range.start.line,
                        character: sym.location.range.start.character,
                        stale: false,
                    };

                    // 精确匹配: sym.name 完全等于 name，或 fqn 精确结尾
                    if (sym.name === name || symFqn === name || symFqn.endsWith(`.${name}`)) {
                        exactResults.push(resolved);
                    } else if (symFqn.includes(name)) {
                        fuzzyResults.push(resolved);
                    } else if (name !== searchTerm && sym.name === searchTerm) {
                        // dotted name 查询时，短名匹配也加入 fuzzy（如 LuaLS 不返回 containerName）
                        fuzzyResults.push(resolved);
                    }
                }

                if (symbols.length > 0) {
                    console.error(`[CSG] resolveViaLsp("${name}"): ${lang} workspace/symbol("${searchTerm}") → ${symbols.length} results`);
                }
            } catch (e) {
                if (e instanceof LspTimeoutError) {
                    console.error(`[CSG] resolveViaLsp("${name}"): ${lang} timeout`);
                    continue;
                }
                throw e;
            }
        }

        console.error(`[CSG] resolveViaLsp("${name}"): exact=${exactResults.length} fuzzy=${fuzzyResults.length}`);

        // 排序：源码优先，生成代码靠后
        const sortByPriority = (arr: ResolvedSymbol[]) =>
            arr.sort((a, b) => definitionPriority(a.file) - definitionPriority(b.file));

        // 精确匹配有结果就用精确的
        let results = exactResults.length > 0 ? sortByPriority(exactResults) : [];

        // dotted name 没有精确匹配时，优先用 container+documentSymbol（比 fuzzy 精确）
        if (results.length === 0 && name.includes('.')) {
            results = await this.resolveMethodViaContainer(name);
        }

        // 最后才用 fuzzy（也按优先级排序，源码优先于生成代码）
        if (results.length === 0) {
            results = sortByPriority(fuzzyResults);
        }

        // Lua 模块按文件名兜底（local 变量不在 workspace/symbol 索引中）
        if (results.length === 0) {
            results = await this.resolveByFileName(name);
        }

        if (results.length > 0) {
            console.error(`[CSG] resolveViaLsp("${name}"): resolved to ${results[0].fqn} (${results[0].language}) at ${results[0].file}:${results[0].line + 1}`);
        }

        return results.slice(0, 10);
    }

    /** 按文件名查找 Lua 模块，用于 local 变量不在 workspace/symbol 索引中的场景 */
    private async resolveByFileName(name: string): Promise<ResolvedSymbol[]> {
        // 只对不含 . 的简单名字做文件搜索（避免搜 "Game.Player" → "Player.lua"）
        if (name.includes('.')) return [];

        try {
            const files = await glob(`**/${name}.lua`, {
                cwd: this.workspaceRoot,
                nodir: true,
                ignore: ['**/node_modules/**'],
            });

            if (files.length === 0) return [];

            const file = files[0].replace(/\\/g, '/');
            console.error(`[CSG] resolveByFileName("${name}"): found ${file}`);

            const client = this.lspManager.getClientForFile(file);
            const uri = relativeToUri(this.workspaceRoot, file);

            let docSymbols: (import('vscode-languageserver-protocol').SymbolInformation | import('vscode-languageserver-protocol').DocumentSymbol)[] = [];
            try {
                docSymbols = await client.documentSymbol(uri);
            } catch (e) {
                console.error(`[CSG] resolveByFileName: documentSymbol failed for ${file}: ${(e as Error).message}`);
            }

            console.error(`[CSG] resolveByFileName: documentSymbol returned ${docSymbols.length} symbols for ${file}`);

            if (docSymbols.length > 0) {
                // 取第一个符号作为模块代表
                const first = docSymbols[0];
                const range = 'location' in first ? first.location.range : first.range;
                return [{
                    name,
                    fqn: name,
                    kind: first.kind,
                    language: 'lua',
                    file,
                    line: range.start.line,
                    character: range.start.character,
                    stale: false,
                }];
            }

            // documentSymbol 为空时，仍然返回文件级合成符号（line 0）
            // Lua local 模块可能不在 LuaLS 索引中，但文件确实存在
            console.error(`[CSG] resolveByFileName: documentSymbol empty, returning synthetic symbol at ${file}:1`);
            return [{
                name,
                fqn: name,
                kind: 13, // Variable
                language: 'lua',
                file,
                line: 0,
                character: 0,
                stale: false,
            }];
        } catch (e) {
            console.error(`[CSG] resolveByFileName("${name}"): error: ${(e as Error).message}`);
            return [];
        }
    }

    /**
     * 对 "Container.Method" 格式的名字：先 resolve Container，再用 documentSymbol 找 Method
     * 用于 LuaLS workspace/symbol 不返回方法级符号的场景
     */
    private async resolveMethodViaContainer(dottedName: string): Promise<ResolvedSymbol[]> {
        const parts = dottedName.split('.');
        const methodName = parts.pop()!;
        const containerName = parts.join('.');

        console.error(`[CSG] resolveMethodViaContainer: container="${containerName}" method="${methodName}"`);

        let containers = await this.resolveSymbol(containerName);
        if (containers.length === 0) {
            // Lua local 模块按文件名兜底
            containers = await this.resolveByFileName(containerName);
        }
        if (containers.length === 0) {
            console.error(`[CSG]   container "${containerName}" not found`);
            return [];
        }

        for (const container of containers.slice(0, 3)) {
            try {
                const client = this.lspManager.getClientForFile(container.file);
                const uri = relativeToUri(this.workspaceRoot, container.file);
                const docSymbols = await client.documentSymbol(uri);
                console.error(`[CSG]   container ${container.file}: documentSymbol returned ${docSymbols.length} symbols`);

                const method = this.findSymbolByName(docSymbols, methodName);
                if (method) {
                    console.error(`[CSG]   found "${methodName}" at ${container.file}:${method.range.start.line + 1} (kind=${method.kind})`);
                    return [{
                        name: methodName,
                        fqn: dottedName,
                        kind: method.kind,
                        language: container.language,
                        file: container.file,
                        line: method.range.start.line,
                        character: method.range.start.character,
                        stale: false,
                    }];
                }

                if (docSymbols.length > 0) {
                    const names = docSymbols.slice(0, 10).map(s => s.name).join(', ');
                    console.error(`[CSG]   "${methodName}" not in [${names}]`);
                }
            } catch (e) {
                console.error(`[CSG]   resolveMethodViaContainer error for ${container.file}: ${(e as Error).message}`);
                continue;
            }
        }

        console.error(`[CSG]   method "${methodName}" not found in any container`);
        return [];
    }

    /** 在 documentSymbol 结果中递归搜索指定名字的符号 */
    private findSymbolByName(
        symbols: (SymbolInformation | DocumentSymbol)[],
        name: string,
    ): { range: DocumentSymbol['range']; kind: number } | undefined {
        for (const sym of symbols) {
            // LuaLS 的方法名可能带 colon/dot 前缀，如 "PlayerApi:Initialize"
            const matches = sym.name === name
                || sym.name.endsWith(`:${name}`)
                || sym.name.endsWith(`.${name}`);

            if ('location' in sym) {
                // SymbolInformation
                if (matches) {
                    return { range: sym.location.range, kind: sym.kind };
                }
            } else {
                // DocumentSymbol
                if (matches) {
                    return { range: sym.selectionRange, kind: sym.kind };
                }
                if (sym.children) {
                    const found = this.findSymbolByName(sym.children, name);
                    if (found) return found;
                }
            }
        }
        return undefined;
    }

    // ===== 符号定义查询 =====

    async findDefinition(query: {
        name?: string;
        file?: string;
        line?: number;      // 1-based input
        character?: number; // 0-based
        kind?: number;
    }): Promise<DefinitionResult[]> {
        const startTime = Date.now();

        if (query.name) {
            const resolved = await this.resolveSymbol(query.name, query.kind);

            // 源码优先，生成代码靠后
            resolved.sort((a, b) => definitionPriority(a.file) - definitionPriority(b.file));

            const enriched = await Promise.all(
                resolved.map(r => this.enrichWithHover(r)),
            );

            return enriched.map(r => ({
                ...r,
                line: r.line + 1, // output 1-based
                source: r.stale ? 'cache_stale' as const : 'lsp' as const,
                latencyMs: Date.now() - startTime,
            }));
        } else if (query.file && query.line != null) {
            const client = this.lspManager.getClientForFile(query.file);
            const uri = relativeToUri(this.workspaceRoot, query.file);
            console.error(`[CSG] definition: uri=${uri} pos=${query.line - 1}:${query.character || 0}`);

            const result = await client.definition(
                uri, query.line - 1, query.character || 0,
            );

            if (!result) {
                console.error(`[CSG] definition: null result`);
                return [];
            }

            const locations = Array.isArray(result) ? result : [result];
            return locations
                .map((loc: Location) => ({
                    name: '',
                    fqn: '',
                    kind: 0,
                    language: query.file!.endsWith('.cs') ? 'csharp' : 'lua',
                    file: uriToRelative(this.workspaceRoot, loc.uri),
                    line: loc.range.start.line + 1,
                    character: loc.range.start.character,
                    source: 'lsp' as const,
                    latencyMs: Date.now() - startTime,
                }))
                .sort((a, b) => definitionPriority(a.file) - definitionPriority(b.file));
        }

        return [];
    }

    // ===== 符号引用查询 =====

    async findReferences(query: {
        name?: string;
        fqn?: string;
        file?: string;
        line?: number;      // 1-based
        character?: number;
    }): Promise<ReferenceResult> {
        const startTime = Date.now();

        let file = query.file;
        let line = query.line;
        let character = query.character || 0;
        let fqn = query.fqn || query.name || '';

        if (!file && query.name) {
            const resolved = await this.resolveSymbol(query.name);
            if (resolved.length === 0) {
                // Lua 全局变量 fallback：grep 找到一个位置 → LuaLS 做语义追踪 → grep 兜底
                const lspResult = await this.resolveViaGrepThenLsp(query.name);
                if (lspResult) {
                    return lspResult;
                }
                return { symbolFqn: fqn, references: [], count: 0, source: 'lsp' };
            }
            const first = resolved[0];
            file = first.file;
            line = first.line + 1;
            character = first.character;
            fqn = first.fqn;
        }

        if (!file || line == null) {
            return { symbolFqn: fqn, references: [], count: 0, source: 'lsp' };
        }

        // 查缓存 (TTL)
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

        // LSP references（超时视为 0 结果，让 grep fallback 兜底）
        let lspRefs: Location[] = [];
        let lspTimedOut = false;
        try {
            const client = this.lspManager.getClientForFile(file);
            const uri = relativeToUri(this.workspaceRoot, file);
            console.error(`[CSG] references: uri=${uri} pos=${line - 1}:${character} fqn=${fqn}`);

            lspRefs = await client.references(
                uri, line - 1, character, false,
            );
            console.error(`[CSG] references: ${lspRefs.length} results`);
        } catch (e) {
            if (e instanceof LspTimeoutError) {
                console.error(`[CSG] references: LSP timeout for ${file}:${line}, will try grep fallback`);
                lspTimedOut = true;
            } else {
                throw e;
            }
        }

        let results: ReferenceItem[] = lspRefs.map(ref => ({
            file: uriToRelative(this.workspaceRoot, ref.uri),
            line: ref.range.start.line + 1,
            character: ref.range.start.character,
            confidence: 'exact' as Confidence,
        }));

        // Lua grep fallback：LuaLS 对全局变量/workspace 外文件 references 常返回空或超时
        if (results.length === 0 && file.endsWith('.lua') && fqn) {
            const symbolName = fqn.includes('.') ? fqn.split('.').pop()! : fqn;
            const grepResults = await this.grepLuaReferences(symbolName);
            if (grepResults.length > 0) {
                console.error(`[CSG] references: Lua grep fallback found ${grepResults.length} results for "${symbolName}"`);
                results = grepResults.map(r => ({ ...r, confidence: 'medium' as Confidence }));
            }
        }

        // C# grep 补充：csharp-ls references 常遗漏非生成代码文件的引用
        if (file.endsWith('.cs') && fqn) {
            const symbolName = fqn.includes('.') ? fqn.split('.').pop()! : fqn;
            const nonGenResults = results.filter(r => !isGeneratedCode(r.file));
            if (nonGenResults.length < 100) {
                const grepResults = await this.grepCsharpReferences(symbolName);
                if (grepResults.length > 0) {
                    // 按 file:line 去重合并
                    const seen = new Set(results.map(r => `${r.file}:${r.line}`));
                    let added = 0;
                    for (const gr of grepResults) {
                        const key = `${gr.file}:${gr.line}`;
                        if (!seen.has(key)) {
                            results.push({ ...gr, confidence: 'medium' as Confidence });
                            seen.add(key);
                            added++;
                        }
                    }
                    if (added > 0) {
                        console.error(`[CSG] references: C# grep added ${added} results for "${symbolName}"`);
                    }
                }
            }
        }

        // 写缓存：有结果 + LSP 未超时才缓存（超时走 grep 的低质量结果不缓存，下次重试 LSP）
        if (results.length > 0 && !lspTimedOut) {
            this.cache.cacheReferences(
                fqn,
                { file, line: line - 1, char: character },
                results.map(r => ({
                    ref_file: r.file,
                    ref_line: r.line - 1,
                    ref_char: r.character,
                    cached_at: Date.now(),
                })),
            );
        }

        return {
            symbolFqn: fqn,
            references: results,
            count: results.length,
            source: lspTimedOut && results.length > 0 ? 'grep' as const : 'lsp' as const,
        };
    }

    // ===== 调用链查询（基于 references + documentSymbol / callHierarchy） =====

    async findCallChain(query: {
        name?: string;
        file?: string;
        line?: number;
        character?: number;
        direction: 'incoming' | 'outgoing' | 'both';
        maxDepth?: number;
    }): Promise<CallChainResult> {
        const maxDepth = query.maxDepth ?? 3;

        let file = query.file;
        let line = query.line;
        let character = query.character || 0;
        let rootFqn = query.name || '';

        if (!file && query.name) {
            const resolved = await this.resolveSymbol(query.name);
            if (resolved.length === 0) {
                console.error(`[CSG] findCallChain: resolveSymbol("${query.name}") returned 0 results`);
                return { root: rootFqn, incoming: [], outgoing: [] };
            }
            console.error(`[CSG] findCallChain: resolveSymbol("${query.name}") returned ${resolved.length} results: ${resolved.map(r => `${r.fqn}(kind=${r.kind})`).join(', ')}`);
            // call_chain 优先选非生成代码的 method/function（kind=6/9/12）
            const methodKinds = new Set([6, 9, 12]); // Method, Constructor, Function
            const preferred = resolved.find(r => methodKinds.has(r.kind) && !isGeneratedCode(r.file))
                || resolved.find(r => methodKinds.has(r.kind))
                || resolved[0];
            file = preferred.file;
            line = preferred.line + 1;
            character = preferred.character;
            rootFqn = preferred.fqn;
        }

        if (!file || line == null) {
            return { root: rootFqn, incoming: [], outgoing: [] };
        }

        const result: CallChainResult = {
            root: rootFqn,
            incoming: [],
            outgoing: [],
        };

        if (query.direction !== 'outgoing') {
            // 优先使用 callHierarchy（LuaLS 支持），fallback 到 references 路径
            let useCallHierarchy = false;
            try {
                useCallHierarchy = this.lspManager.supportsCallHierarchy(file);
            } catch { /* unsupported file type */ }

            console.error(`[CSG] findCallChain: root=${rootFqn} file=${file} line=${line} supportsCallHierarchy=${useCallHierarchy}`);

            if (useCallHierarchy) {
                let chResults: CallChainNode[] = [];
                try {
                    chResults = await this.findIncomingCallersViaCallHierarchy(
                        file, line, character, maxDepth, 0, new Set(),
                    );
                    console.error(`[CSG] callHierarchy returned ${chResults.length} callers`);
                } catch (e) {
                    console.error(`[CSG] callHierarchy threw: ${(e as Error).message}`);
                }

                // 始终也走 references 路径，合并两者结果（callHierarchy 常遗漏）
                let refResults: CallChainNode[] = [];
                try {
                    refResults = await this.findIncomingCallers(
                        file, line, character, maxDepth, 0, new Set(),
                    );
                    console.error(`[CSG] references path returned ${refResults.length} callers`);
                } catch (e) {
                    console.error(`[CSG] references path threw: ${(e as Error).message}`);
                }

                result.incoming = this.mergeCallChainNodes(chResults, refResults);
                console.error(`[CSG] merged: ${result.incoming.length} unique callers`);
            } else {
                result.incoming = await this.findIncomingCallers(
                    file, line, character, maxDepth, 0, new Set(),
                );
            }

            // C# grep fallback：当 LSP 结果（过滤生成代码后）不足时，用 grep 搜索调用点
            const nonGenerated = result.incoming.filter(n => !isGeneratedCode(n.file));
            if (nonGenerated.length === 0 && file.endsWith('.cs')) {
                // 优先使用原始查询名（用户输入），回退到从 fqn 提取
                const methodName = query.name || this.extractMethodName(rootFqn);
                if (methodName) {
                    console.error(`[CSG] findCallChain: LSP returned no non-generated callers, trying grep for "${methodName}"`);
                    const grepCallers = await this.grepCsharpCallers(methodName, file);
                    if (grepCallers.length > 0) {
                        console.error(`[CSG] findCallChain: grep found ${grepCallers.length} callers`);
                        result.incoming = this.mergeCallChainNodes(result.incoming, grepCallers);
                    }
                }
            }
        }

        if (query.direction !== 'incoming') {
            let useCallHierarchy = false;
            try {
                useCallHierarchy = this.lspManager.supportsCallHierarchy(file);
            } catch { /* unsupported file type */ }

            if (useCallHierarchy) {
                try {
                    result.outgoing = await this.findOutgoingCallsViaCallHierarchy(
                        file, line, character, maxDepth, 0, new Set(),
                    );
                    console.error(`[CSG] outgoing callHierarchy: ${result.outgoing.length} calls`);
                } catch (e) {
                    console.error(`[CSG] outgoing callHierarchy threw: ${(e as Error).message}`);
                }
            }
        }

        return result;
    }

    // ===== 类继承树查询 =====

    /**
     * 查找类/接口的继承关系：
     * - baseTypes：直接基类/实现的接口（从声明行解析）
     * - implementations：所有子类/实现类（grep .cs 文件）
     */
    async findHierarchy(name: string): Promise<HierarchyResult> {
        const resolved = await this.resolveSymbol(name);
        const target = resolved.length > 0 ? resolved[0] : null;

        if (!target) {
            return { target: null, baseTypes: [], implementations: [] };
        }

        const shortName = target.fqn.split('.').pop()!;

        const [baseTypes, implementations] = await Promise.all([
            this.parseBaseTypes(target.file, target.line),
            this.grepSubclasses(shortName),
        ]);

        return { target, baseTypes, implementations };
    }

    /**
     * 从类声明行解析直接基类/接口：
     * `class Foo : Bar, IBaz` → [{name:"Bar"}, {name:"IBaz"}]
     */
    private async parseBaseTypes(
        file: string, line: number,
    ): Promise<{ name: string }[]> {
        try {
            const absPath = path.join(this.workspaceRoot, file);
            const content = await fs.readFile(absPath, 'utf-8');
            const lines = content.split('\n');

            // 读声明行及后续几行（处理多行声明）
            const startIdx = Math.max(0, line); // line is 0-based
            const declText = lines.slice(startIdx, startIdx + 5).join(' ');

            // 匹配 `: Type1, Type2` 直到 `{` 或 `where`
            const match = declText.match(/:\s*([^{]+?)(?:\s+where\b|\s*\{)/);
            if (!match) return [];

            return match[1]
                .split(',')
                .map(t => t.trim().replace(/<[^>]*>/g, ''))  // 去泛型参数
                .filter(t => t.length > 0 && /^[A-Z]/.test(t))
                .map(t => ({ name: t }));
        } catch {
            return [];
        }
    }

    /**
     * Grep 所有 .cs 文件，查找继承/实现了目标类名的声明
     * 匹配 `class/struct/interface X : ...TargetName...`
     */
    private async grepSubclasses(
        className: string,
    ): Promise<{ name: string; file: string; line: number }[]> {
        const results: { name: string; file: string; line: number }[] = [];
        const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(
            `\\b(?:class|struct|interface)\\s+(\\w+)(?:<[^>]*>)?\\s*:[^{]*\\b${escaped}\\b`,
        );

        try {
            const csFiles = await glob('**/*.cs', {
                cwd: this.workspaceRoot,
                absolute: false,
                ignore: ['**/node_modules/**', '**/Library/**', '**/Temp/**'],
            });

            for (const file of csFiles) {
                if (isGeneratedCode(file)) continue;

                const absPath = path.join(this.workspaceRoot, file);
                let content: string;
                try { content = await fs.readFile(absPath, 'utf-8'); } catch { continue; }

                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const match = pattern.exec(lines[i]);
                    if (match && match[1] !== className) { // 排除自身
                        results.push({
                            name: match[1],
                            file: file.replace(/\\/g, '/'),
                            line: i + 1,
                        });
                    }
                }

                if (results.length >= 200) break;
            }
        } catch (e) {
            console.error(`[CSG] grepSubclasses error: ${(e as Error).message}`);
        }

        return results;
    }

    // ===== 按 attribute / 基类查询 =====

    /**
     * 按 C# attribute 或基类名查询类。
     * - attribute 匹配: `[Tag]` 或 `[Tag(` 模式，向下找最近的 class/struct 声明
     * - 基类匹配: `class X : ...Tag...` 模式
     * 自动判断是 attribute 还是 base_class（两种都搜）。
     */
    async findTaggedClasses(tag: string, limit = 50): Promise<TaggedClassResult[]> {
        const results: TaggedClassResult[] = [];
        const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        const attrPattern = new RegExp(`\\[\\s*${escaped}(?:\\s*[\\](])`, 'm');
        const basePattern = new RegExp(
            `\\b(?:class|struct)\\s+(\\w+)(?:<[^>]*>)?\\s*:[^{]*\\b${escaped}\\b`,
        );

        const EXCLUDE_DIRS = [
            '**/node_modules/**', '**/Library/**', '**/Temp/**',
        ];
        const EXCLUDE_DIR_PATTERNS = [
            /\bXLua[/\\]Gen\b/i,
            /\bCSObjectWrap\b/i,
            /\bEditor\b/i,
        ];

        try {
            const csFiles = await glob('**/*.cs', {
                cwd: this.workspaceRoot,
                absolute: false,
                ignore: EXCLUDE_DIRS,
            });

            for (const file of csFiles) {
                const normalized = file.replace(/\\/g, '/');
                if (EXCLUDE_DIR_PATTERNS.some(p => p.test(normalized))) continue;

                const absPath = path.join(this.workspaceRoot, file);
                let content: string;
                try { content = await fs.readFile(absPath, 'utf-8'); } catch { continue; }

                const lines = content.split('\n');

                // 1. attribute 匹配
                for (let i = 0; i < lines.length; i++) {
                    if (!attrPattern.test(lines[i])) continue;

                    // 向下找最近的 class/struct 声明（最多 10 行）
                    for (let j = i; j < Math.min(i + 10, lines.length); j++) {
                        const classMatch = lines[j].match(/\b(?:class|struct)\s+(\w+)/);
                        if (classMatch) {
                            results.push({
                                name: classMatch[1],
                                file: normalized,
                                line: j + 1,
                                tag,
                                tagType: 'attribute',
                            });
                            break;
                        }
                    }

                    if (results.length >= limit) break;
                }

                // 2. 基类匹配
                if (results.length < limit) {
                    for (let i = 0; i < lines.length; i++) {
                        const match = basePattern.exec(lines[i]);
                        if (match) {
                            // 排除已经通过 attribute 找到的同一行
                            const dup = results.some(
                                r => r.file === normalized && r.line === i + 1,
                            );
                            if (!dup) {
                                results.push({
                                    name: match[1],
                                    file: normalized,
                                    line: i + 1,
                                    tag,
                                    tagType: 'base_class',
                                });
                            }
                        }
                        if (results.length >= limit) break;
                    }
                }

                if (results.length >= limit) break;
            }
        } catch (e) {
            console.error(`[CSG] findTaggedClasses error: ${(e as Error).message}`);
        }

        return results;
    }

    // ===== 语义搜索 =====

    /**
     * 带语义过滤的搜索：在 grep 基础上判断每个匹配行是调用、定义、注释还是字符串。
     * 使用行级启发式（80/20 原则），不做完美语义分析。
     */
    async semanticSearch(params: {
        pattern: string;
        language?: 'csharp' | 'lua' | 'all';
        context?: 'call' | 'definition' | 'comment' | 'string' | 'all';
        limit?: number;
    }): Promise<SearchResult> {
        const language = params.language ?? 'all';
        const contextFilter = params.context ?? 'all';
        const limit = params.limit ?? 100;

        let regex: RegExp;
        try {
            regex = new RegExp(params.pattern);
        } catch (e) {
            throw new Error(`Invalid regex pattern: ${(e as Error).message}`);
        }

        const EXCLUDE_DIRS = [
            '**/node_modules/**', '**/Library/**', '**/Temp/**',
        ];
        const MAX_FILES = 5000;
        const MAX_FILE_SIZE = 1024 * 1024; // 1MB

        // 按语言选择 glob 模式
        let patterns: string[];
        if (language === 'csharp') {
            patterns = ['**/*.cs'];
        } else if (language === 'lua') {
            patterns = ['**/*.lua'];
        } else {
            patterns = ['**/*.cs', '**/*.lua'];
        }

        const results: SearchResult['results'] = [];

        try {
            let allFiles: string[] = [];
            for (const pattern of patterns) {
                const files = await glob(pattern, {
                    cwd: this.workspaceRoot,
                    absolute: false,
                    ignore: EXCLUDE_DIRS,
                });
                allFiles = allFiles.concat(files);
                if (allFiles.length > MAX_FILES) {
                    allFiles = allFiles.slice(0, MAX_FILES);
                    break;
                }
            }

            for (const file of allFiles) {
                if (results.length >= limit) break;

                const normalized = file.replace(/\\/g, '/');
                const absPath = path.join(this.workspaceRoot, file);

                // 跳过大文件
                let stat: import('fs').Stats;
                try { stat = fsSync.statSync(absPath); } catch { continue; }
                if (stat.size > MAX_FILE_SIZE) continue;

                let content: string;
                try { content = fsSync.readFileSync(absPath, 'utf-8'); } catch { continue; }

                const lines = content.split('\n');
                const fileLang = normalized.endsWith('.cs') ? 'csharp'
                    : normalized.endsWith('.lua') ? 'lua'
                    : 'unknown';

                for (let i = 0; i < lines.length; i++) {
                    if (results.length >= limit) break;
                    if (!regex.test(lines[i])) continue;

                    const ctx = classifyLineContext(lines[i], fileLang as 'csharp' | 'lua');
                    if (contextFilter !== 'all' && ctx !== contextFilter) continue;

                    results.push({
                        file: normalized,
                        line: i + 1,
                        content: lines[i],
                        context: ctx,
                        confidence: 'medium',
                    });
                }
            }
        } catch (e) {
            console.error(`[CSG] semanticSearch error: ${(e as Error).message}`);
        }

        return {
            totalMatches: results.length,
            results,
        };
    }

    // ===== 文件依赖查询 =====

    /**
     * 查询文件的依赖关系（依赖了谁、被谁依赖）。
     * - Lua: require 依赖 + xlua_mappings 跨语言依赖 + 反向 require 查找
     * - C#: using 命名空间提取（反向查找暂不支持）
     */
    async findFileDeps(
        file: string,
        direction: 'deps' | 'dependents' | 'both' = 'both',
    ): Promise<FileDepsResult> {
        const isLua = file.endsWith('.lua');
        const isCsharp = file.endsWith('.cs');
        const language: 'lua' | 'csharp' = isLua ? 'lua' : 'csharp';

        const result: FileDepsResult = {
            file,
            language,
            deps: {
                luaRequires: [],
                csharpUsings: [],
                crossLangDeps: [],
            },
            dependents: {
                luaRequiredBy: [],
            },
        };

        const absPath = path.join(this.workspaceRoot, file);
        let content: string;
        try {
            content = await fs.readFile(absPath, 'utf-8');
        } catch {
            return result;
        }

        if (direction === 'deps' || direction === 'both') {
            if (isLua) {
                result.deps.luaRequires = this.extractLuaRequires(content, file);
                result.deps.crossLangDeps = this.queryXluaMappingsForFile(file);
            } else if (isCsharp) {
                result.deps.csharpUsings = this.extractCsharpUsings(content);
            }
        }

        if (direction === 'dependents' || direction === 'both') {
            if (isLua) {
                result.dependents.luaRequiredBy = await this.findLuaDependents(file);
            }
            // C# 反向依赖暂不支持（using 是命名空间级别，无法简单反查文件）
        }

        return result;
    }

    // ===== 重命名预览 =====

    /**
     * 预览重命名操作：返回所有受影响的文件和行，不实际修改文件。
     * 1. 解析符号（按名字或文件位置）
     * 2. 优先尝试 LSP textDocument/rename
     * 3. Fallback: findReferences + 正则替换预览
     * 4. C# 符号额外查 xlua 跨语言 Lua 引用
     */
    async renamePreview(params: {
        name?: string;
        new_name: string;
        file?: string;
        line?: number;
    }): Promise<RenamePreview> {
        const { new_name: newName } = params;
        const warnings: string[] = [];

        // 1. 解析符号
        let file: string | undefined;
        let line: number | undefined;
        let character = 0;
        let symbolFqn = '';
        let language = '';

        if (params.file && params.line != null) {
            file = params.file;
            line = params.line;
            language = this.detectLanguage(params.file);
            // 也尝试 resolve 得到 fqn
            if (params.name) {
                const resolved = await this.resolveSymbol(params.name);
                if (resolved.length > 0) {
                    symbolFqn = resolved[0].fqn;
                    language = resolved[0].language;
                }
            }
        } else if (params.name) {
            const resolved = await this.resolveSymbol(params.name);
            if (resolved.length === 0) {
                return {
                    symbol: params.name,
                    oldName: params.name,
                    newName,
                    totalChanges: 0,
                    files: [],
                    warnings: [`Symbol "${params.name}" not found`],
                };
            }
            const first = resolved[0];
            file = first.file;
            line = first.line + 1; // resolveSymbol returns 0-based, LSP needs 0-based but findReferences expects 1-based
            character = first.character;
            symbolFqn = first.fqn;
            language = first.language;
        }

        if (!file || line == null) {
            return {
                symbol: params.name || '',
                oldName: params.name || '',
                newName,
                totalChanges: 0,
                files: [],
                warnings: ['Could not resolve symbol location'],
            };
        }

        // 提取短名用于正则替换
        const shortName = params.name
            ? (params.name.includes('.') ? params.name.split('.').pop()! : params.name)
            : symbolFqn.split('.').pop() || '';

        // 2. 尝试 LSP rename
        const lspResult = await this.tryLspRename(file, line, character, newName);
        let renameFiles: RenamePreview['files'] = [];

        if (lspResult && lspResult.length > 0) {
            renameFiles = lspResult;
            console.error(`[CSG] renamePreview: LSP rename returned ${lspResult.reduce((sum, f) => sum + f.changes.length, 0)} changes`);
        } else {
            // 3. Fallback: findReferences + 正则替换
            console.error(`[CSG] renamePreview: LSP rename unavailable/empty, using findReferences fallback`);
            renameFiles = await this.renameFallback(file, line, character, symbolFqn, shortName, newName);
            if (renameFiles.length > 0) {
                warnings.push('Used findReferences + regex fallback (LSP rename unavailable)');
            }
        }

        // 4. 跨语言扩展：C# 符号查 Lua 引用
        if (language === 'csharp' && shortName) {
            const luaChanges = await this.renamePreviewLuaCrossLang(shortName, newName);
            if (luaChanges.length > 0) {
                renameFiles.push(...luaChanges);
                warnings.push('Lua grep results may include false positives');
            }
        }

        const totalChanges = renameFiles.reduce((sum, f) => sum + f.changes.length, 0);

        return {
            symbol: symbolFqn || params.name || '',
            oldName: shortName,
            newName,
            totalChanges,
            files: renameFiles,
            warnings,
        };
    }

    /**
     * 尝试 LSP textDocument/rename，解析 WorkspaceEdit 为文件级变更预览。
     * 返回 null 表示 LSP rename 不可用或失败。
     */
    private async tryLspRename(
        file: string, line: number, character: number, newName: string,
    ): Promise<RenamePreview['files'] | null> {
        try {
            const client = this.lspManager.getClientForFile(file);
            if (client.state !== 'ready') return null;

            const uri = relativeToUri(this.workspaceRoot, file);
            // line is 1-based from findReferences convention, LSP needs 0-based
            const lspLine = line - 1;
            const wsEdit = await client.rename(uri, lspLine, character, newName);

            if (!wsEdit) return null;

            return this.parseWorkspaceEdit(wsEdit);
        } catch (e) {
            if (e instanceof LspTimeoutError) {
                console.error(`[CSG] tryLspRename: LSP timeout`);
            } else {
                console.error(`[CSG] tryLspRename: ${(e as Error).message}`);
            }
            return null;
        }
    }

    /**
     * 解析 WorkspaceEdit 为文件级变更预览。
     * 支持 changes（URI → TextEdit[]）和 documentChanges 两种格式。
     */
    private parseWorkspaceEdit(
        wsEdit: WorkspaceEdit,
    ): RenamePreview['files'] {
        const fileChangesMap = new Map<string, TextEdit[]>();

        // WorkspaceEdit.changes: { [uri: string]: TextEdit[] }
        if (wsEdit.changes) {
            for (const [editUri, edits] of Object.entries(wsEdit.changes)) {
                const filePath = uriToRelative(this.workspaceRoot, editUri);
                const existing = fileChangesMap.get(filePath) || [];
                existing.push(...edits);
                fileChangesMap.set(filePath, existing);
            }
        }

        // WorkspaceEdit.documentChanges: TextDocumentEdit[]
        if (wsEdit.documentChanges) {
            for (const docChange of wsEdit.documentChanges) {
                if ('textDocument' in docChange && 'edits' in docChange) {
                    const filePath = uriToRelative(this.workspaceRoot, docChange.textDocument.uri);
                    const existing = fileChangesMap.get(filePath) || [];
                    existing.push(...(docChange.edits as TextEdit[]));
                    fileChangesMap.set(filePath, existing);
                }
            }
        }

        if (fileChangesMap.size === 0) return [];

        const results: RenamePreview['files'] = [];
        // 文件内容缓存，避免重复读取
        const fileContentCache = new Map<string, string[]>();

        for (const [filePath, edits] of fileChangesMap) {
            const absPath = path.join(this.workspaceRoot, filePath);
            let lines: string[];

            if (fileContentCache.has(filePath)) {
                lines = fileContentCache.get(filePath)!;
            } else {
                try {
                    const content = fsSync.readFileSync(absPath, 'utf-8');
                    lines = content.split('\n');
                    fileContentCache.set(filePath, lines);
                } catch {
                    console.error(`[CSG] parseWorkspaceEdit: cannot read ${filePath}`);
                    continue;
                }
            }

            const lang = this.detectLanguage(filePath);

            // 按行号分组，同一行多个 TextEdit 需合并应用
            const editsByLine = new Map<number, TextEdit[]>();
            for (const edit of edits) {
                const editLine = edit.range.start.line;
                if (editLine < 0 || editLine >= lines.length) continue;
                if (!editsByLine.has(editLine)) editsByLine.set(editLine, []);
                editsByLine.get(editLine)!.push(edit);
            }

            const changes: { line: number; oldText: string; newText: string }[] = [];
            for (const [editLine, lineEdits] of editsByLine) {
                const oldText = lines[editLine];
                // 按 start.character 降序排列，从后往前应用避免偏移
                lineEdits.sort((a, b) => b.range.start.character - a.range.start.character);
                let newText = oldText;
                for (const edit of lineEdits) {
                    const startChar = edit.range.start.character;
                    const endChar = edit.range.end.line === editLine
                        ? edit.range.end.character
                        : newText.length;
                    newText = newText.substring(0, startChar) + edit.newText + newText.substring(endChar);
                }
                if (newText !== oldText) {
                    changes.push({ line: editLine + 1, oldText, newText });
                }
            }

            if (changes.length > 0) {
                results.push({ file: filePath, language: lang, changes: changes.sort((a, b) => a.line - b.line) });
            }
        }

        return results;
    }

    /**
     * Fallback: 用 findReferences 获取所有引用位置，对每个引用行做正则替换预览。
     */
    private async renameFallback(
        file: string, line: number, character: number,
        symbolFqn: string, shortName: string, newName: string,
    ): Promise<RenamePreview['files']> {
        const refs = await this.findReferences({
            name: undefined,
            file,
            line,
            character,
        });

        if (refs.count === 0) return [];

        const escaped = shortName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`\\b${escaped}\\b`, 'g');

        // 按文件分组
        const byFile = new Map<string, { line: number; character: number }[]>();
        for (const ref of refs.references) {
            if (!byFile.has(ref.file)) byFile.set(ref.file, []);
            byFile.get(ref.file)!.push(ref);
        }

        const results: RenamePreview['files'] = [];
        const fileContentCache = new Map<string, string[]>();

        for (const [refFile, locs] of byFile) {
            const absPath = path.join(this.workspaceRoot, refFile);
            let lines: string[];

            if (fileContentCache.has(refFile)) {
                lines = fileContentCache.get(refFile)!;
            } else {
                try {
                    const content = fsSync.readFileSync(absPath, 'utf-8');
                    lines = content.split('\n');
                    fileContentCache.set(refFile, lines);
                } catch {
                    continue;
                }
            }

            const lang = this.detectLanguage(refFile);
            const changes: { line: number; oldText: string; newText: string }[] = [];

            for (const loc of locs) {
                const lineIdx = loc.line - 1; // references are 1-based
                if (lineIdx < 0 || lineIdx >= lines.length) continue;

                const oldText = lines[lineIdx];
                const newText = oldText.replace(pattern, newName);

                if (newText !== oldText) {
                    changes.push({
                        line: loc.line, // 1-based
                        oldText,
                        newText,
                    });
                }
            }

            if (changes.length > 0) {
                const deduped = this.deduplicateLineChanges(changes);
                results.push({ file: refFile, language: lang, changes: deduped });
            }
        }

        return results;
    }

    /**
     * 查询 Lua 中的跨语言引用并生成替换预览。
     * 用 grepLuaMethodCalls 查找 Lua 中的方法调用。
     */
    private async renamePreviewLuaCrossLang(
        memberName: string, newName: string,
    ): Promise<RenamePreview['files']> {
        const luaRefs = await this.grepLuaMethodCalls(memberName, 200);
        if (luaRefs.length === 0) return [];

        const escaped = memberName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`\\b${escaped}\\b`, 'g');

        const byFile = new Map<string, { line: number; character: number }[]>();
        for (const ref of luaRefs) {
            if (!byFile.has(ref.file)) byFile.set(ref.file, []);
            byFile.get(ref.file)!.push(ref);
        }

        const results: RenamePreview['files'] = [];

        for (const [refFile, locs] of byFile) {
            const absPath = path.join(this.workspaceRoot, refFile);
            let lines: string[];
            try {
                const content = fsSync.readFileSync(absPath, 'utf-8');
                lines = content.split('\n');
            } catch {
                continue;
            }

            const changes: { line: number; oldText: string; newText: string }[] = [];

            for (const loc of locs) {
                const lineIdx = loc.line - 1;
                if (lineIdx < 0 || lineIdx >= lines.length) continue;

                const oldText = lines[lineIdx];
                const newText = oldText.replace(pattern, newName);

                if (newText !== oldText) {
                    changes.push({ line: loc.line, oldText, newText });
                }
            }

            if (changes.length > 0) {
                const deduped = this.deduplicateLineChanges(changes);
                results.push({ file: refFile, language: 'lua', changes: deduped });
            }
        }

        return results;
    }

    // ===== XLua 别名悬空检测 =====

    /**
     * 检测悬空的 XLua 别名：Lua 中定义了 C# 类型别名，但对应的 C# 类已被删除或重命名。
     * 1. 从 lua_aliases 表读取所有别名（或按 file 筛选）
     * 2. 提取唯一的 C# FQN
     * 3. 对每个 FQN 用 workspaceSymbol 查询是否存在
     * 4. 找不到的标记为 dangling
     */
    async checkDanglingAliases(params: {
        file?: string;
        limit?: number;
    }): Promise<DanglingAliasResult> {
        const limit = params.limit ?? 100;
        const aliases = this.cache.getAllAliases(params.file);

        if (aliases.length === 0) {
            return { totalChecked: 0, danglingCount: 0, danglingAliases: [] };
        }

        // 提取唯一的 C# FQN（去掉 CS. 前缀）
        const fqnSet = new Set<string>();
        for (const alias of aliases) {
            const fqn = alias.original_cs_pattern.replace(/^CS\./, '');
            fqnSet.add(fqn);
        }

        // 对每个 FQN 检查是否存在于 C# 项目中
        const fqnExists = new Map<string, boolean>();
        const csharpClient = this.lspManager.getClientForLanguage('csharp');

        if (csharpClient.state === 'ready') {
            const checkOneFqn = async (fqn: string) => {
                const shortName = fqn.includes('.') ? fqn.split('.').pop()! : fqn;
                try {
                    const symbols = await csharpClient.workspaceSymbol(shortName);
                    const found = symbols.some((s: SymbolInformation) => {
                        const container = s.containerName ?? '';
                        if (container) {
                            const symFqn = `${container}.${s.name}`;
                            return symFqn === fqn || symFqn.endsWith(`.${fqn}`) || (fqn.endsWith(`.${s.name}`) && container.endsWith(fqn.split('.').slice(0, -1).join('.')));
                        }
                        if (s.name === shortName && !fqn.includes('.')) return true;
                        return this.parseCsharpLsSymbolForFqn(s.name, fqn);
                    });
                    fqnExists.set(fqn, found);
                } catch (e) {
                    if (e instanceof LspTimeoutError) {
                        console.error(`[CSG] checkDanglingAliases: workspaceSymbol timeout for "${shortName}"`);
                        fqnExists.set(fqn, true);
                    } else {
                        throw e;
                    }
                }
            };

            // 并发控制：批量查询 workspaceSymbol
            const CONCURRENCY = 8;
            const fqnList = [...fqnSet];
            for (let i = 0; i < fqnList.length; i += CONCURRENCY) {
                const batch = fqnList.slice(i, i + CONCURRENCY);
                await Promise.allSettled(batch.map(fqn => checkOneFqn(fqn)));
            }
        } else {
            // LSP 未就绪，全部标记为存在（不误报）
            for (const fqn of fqnSet) {
                fqnExists.set(fqn, true);
            }
        }

        // 构建 dangling 列表
        const danglingAliases: DanglingAliasResult['danglingAliases'] = [];
        for (const alias of aliases) {
            if (danglingAliases.length >= limit) break;

            const fqn = alias.original_cs_pattern.replace(/^CS\./, '');
            if (!fqnExists.get(fqn)) {
                danglingAliases.push({
                    aliasName: alias.alias_name,
                    csharpFqn: fqn,
                    luaFile: alias.lua_file.replace(/\\/g, '/'),
                    luaLine: alias.lua_line,
                    reason: 'C# symbol not found via workspaceSymbol',
                });
            }
        }

        return {
            totalChecked: aliases.length,
            danglingCount: danglingAliases.length,
            danglingAliases,
        };
    }

    /**
     * 解析 csharp-ls 的 workspaceSymbol name 格式，检查是否匹配目标 FQN。
     * csharp-ls 的类符号 name 通常是短名，但方法可能是 "ReturnType Container.Member(params)"。
     * 对于类/接口/结构体等类型符号，name 通常就是类名本身。
     */
    private parseCsharpLsSymbolForFqn(symbolName: string, targetFqn: string): boolean {
        // 尝试解析 "ReturnType Container.Member(params)" 格式
        const match = symbolName.match(/\s([\w.]+)\.([\w]+)\s*(?:\(|$)/);
        if (match) {
            const fullFqn = `${match[1]}.${match[2]}`;
            return fullFqn === targetFqn || targetFqn.endsWith(fullFqn);
        }
        // 简单格式
        const simpleMatch = symbolName.match(/^([\w.]+)\.([\w]+)\s*(?:\(|$)/);
        if (simpleMatch) {
            const fullFqn = `${simpleMatch[1]}.${simpleMatch[2]}`;
            return fullFqn === targetFqn || targetFqn.endsWith(fullFqn);
        }
        // 直接类名匹配（仅单段 FQN，多段时无法仅靠短名确认命名空间）
        if (!targetFqn.includes('.')) {
            return symbolName === targetFqn;
        }
        return false;
    }

    /** 同一行的多个变更去重（保留最后一个） */
    private deduplicateLineChanges(
        changes: { line: number; oldText: string; newText: string }[],
    ): { line: number; oldText: string; newText: string }[] {
        const seen = new Map<number, { line: number; oldText: string; newText: string }>();
        for (const change of changes) {
            seen.set(change.line, change);
        }
        return Array.from(seen.values()).sort((a, b) => a.line - b.line);
    }

    /** 根据文件扩展名检测语言 */
    private detectLanguage(filePath: string): 'csharp' | 'lua' | 'other' {
        const normalized = filePath.replace(/\\/g, '/');
        if (normalized.endsWith('.cs')) return 'csharp';
        if (normalized.endsWith('.lua')) return 'lua';
        return 'other';
    }

    // ===== 循环依赖检测 =====

    /**
     * 检测 Lua require 中的循环依赖。
     * 构建依赖图后用 DFS 检测环，返回所有发现的循环链。
     */
    async checkCycles(params: {
        file?: string;
        language?: 'lua' | 'csharp' | 'all';
        max_depth?: number;
    }): Promise<CycleCheckResult> {
        const maxDepth = params.max_depth ?? 10;
        const language = params.language ?? 'lua';

        // 目前主要检测 Lua require 循环
        if (language === 'csharp') {
            return { totalFilesScanned: 0, cyclesFound: 0, cycles: [] };
        }

        // 1. 构建依赖图：扫描所有 Lua 文件
        const graph = new Map<string, string[]>();
        const luaGlob = language === 'all'
            ? '**/*.{lua,cs}'
            : '**/*.lua';

        const files = await glob(luaGlob, {
            cwd: this.workspaceRoot,
            ignore: ['**/node_modules/**', '**/Library/**', '**/Temp/**', '**/obj/**', '**/bin/**'],
        });

        const MAX_FILE_SIZE = 1024 * 1024; // 1MB

        for (const file of files) {
            if (!file.endsWith('.lua')) continue;

            const absPath = path.join(this.workspaceRoot, file);
            try {
                const stat = fsSync.statSync(absPath);
                if (stat.size > MAX_FILE_SIZE) continue;
            } catch {
                continue;
            }

            let content: string;
            try {
                content = fsSync.readFileSync(absPath, 'utf-8');
            } catch {
                continue;
            }

            const requires = this.extractLuaRequires(content, file);
            const deps: string[] = [];
            for (const req of requires) {
                if (req.resolvedFile) {
                    deps.push(req.resolvedFile);
                }
            }

            const normalizedFile = file.replace(/\\/g, '/');
            if (deps.length > 0) {
                graph.set(normalizedFile, deps);
            } else {
                // 确保所有文件都在图中（即使没有依赖）
                graph.set(normalizedFile, []);
            }
        }

        // 2. DFS 检测环
        const visited = new Set<string>();
        const inStack = new Set<string>();
        const rawCycles: string[][] = [];

        const dfs = (node: string, pathStack: string[], depth: number): void => {
            if (depth > maxDepth) return;

            if (inStack.has(node)) {
                // 找到环！从 path 中提取环
                const cycleStart = pathStack.indexOf(node);
                if (cycleStart >= 0) {
                    const cycle = pathStack.slice(cycleStart).concat(node);
                    rawCycles.push(cycle);
                }
                return;
            }

            if (visited.has(node)) return;

            visited.add(node);
            inStack.add(node);
            pathStack.push(node);

            const deps = graph.get(node) || [];
            for (const dep of deps) {
                dfs(dep, pathStack, depth + 1);
            }

            pathStack.pop();
            inStack.delete(node);
        };

        // 3. 从指定文件或所有文件出发 DFS
        if (params.file) {
            const normalizedFile = params.file.replace(/\\/g, '/');
            dfs(normalizedFile, [], 0);
        } else {
            for (const node of graph.keys()) {
                if (!visited.has(node)) {
                    dfs(node, [], 0);
                }
            }
        }

        // 4. 环去重：归一化后去重（同一个环可能从不同起点发现）
        const uniqueCycles = this.deduplicateCycles(rawCycles);

        return {
            totalFilesScanned: graph.size,
            cyclesFound: uniqueCycles.length,
            cycles: uniqueCycles.map(chain => ({
                chain,
                length: chain.length - 1, // 环长度 = 节点数（不含重复的首节点）
            })),
        };
    }

    /**
     * 对检测到的环进行归一化去重。
     * 同一个环 a→b→a 和 b→a→b 被视为同一个环。
     * 归一化方式：去掉末尾重复节点，旋转使最小字典序节点在首位，再加回末尾。
     */
    private deduplicateCycles(rawCycles: string[][]): string[][] {
        const seen = new Set<string>();
        const result: string[][] = [];

        for (const cycle of rawCycles) {
            if (cycle.length < 2) continue;

            // cycle 格式: [a, b, c, a] — 去掉末尾得到 [a, b, c]
            const nodes = cycle.slice(0, -1);

            // 旋转使字典序最小的节点在首位
            let minIdx = 0;
            for (let i = 1; i < nodes.length; i++) {
                if (nodes[i] < nodes[minIdx]) {
                    minIdx = i;
                }
            }
            const rotated = [...nodes.slice(minIdx), ...nodes.slice(0, minIdx)];
            const key = rotated.join(' -> ');

            if (!seen.has(key)) {
                seen.add(key);
                // 恢复为完整环格式（末尾加回首节点）
                result.push([...rotated, rotated[0]]);
            }
        }

        return result;
    }

    /**
     * 从 Lua 文件内容中提取 require 路径并解析为文件路径。
     * 支持 require("mod.path") 和 require('mod.path')。
     */
    extractLuaRequires(
        content: string,
        _sourceFile: string,
    ): Array<{ module: string; resolvedFile: string | null; line: number }> {
        const results: Array<{ module: string; resolvedFile: string | null; line: number }> = [];
        const lines = content.split('\n');
        const requirePattern = /require\s*\(\s*["']([^"']+)["']\s*\)/g;

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trimStart();
            if (trimmed.startsWith('--')) continue; // skip Lua single-line comments
            requirePattern.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = requirePattern.exec(lines[i])) !== null) {
                const modulePath = match[1];
                const resolvedFile = this.resolveRequirePath(modulePath);
                results.push({
                    module: modulePath,
                    resolvedFile,
                    line: i + 1,
                });
            }
        }

        return results;
    }

    /**
     * 将 Lua require 模块路径转为文件路径。
     * 如 "LuaModules.UILib.Base.PageBase" → "Lua/LuaModules/UILib/Base/PageBase.lua"
     * 在 workspaceRoot 下查找，优先在 luaRoot 下搜索。
     */
    private resolveRequirePath(modulePath: string): string | null {
        const relativePath = modulePath.replace(/\./g, '/') + '.lua';

        // 尝试直接在 workspaceRoot 下查找
        const directPath = path.join(this.workspaceRoot, relativePath);
        try {
            fsSync.accessSync(directPath);
            return relativePath.replace(/\\/g, '/');
        } catch { /* not found */ }

        // 尝试在常见 Lua 目录下查找
        const luaDirs = ['Lua', 'lua', 'LuaScripts', 'Assets/LuaScripts', 'Assets/Lua'];
        for (const dir of luaDirs) {
            const candidate = path.join(this.workspaceRoot, dir, relativePath);
            try {
                fsSync.accessSync(candidate);
                return (dir + '/' + relativePath).replace(/\\/g, '/');
            } catch { /* continue */ }
        }

        return null;
    }

    /**
     * 从 xlua_mappings 缓存表查询指定 Lua 文件的跨语言依赖。
     */
    private queryXluaMappingsForFile(
        luaFile: string,
    ): Array<{ csharpFqn: string; luaAlias?: string }> {
        try {
            const rows = this.cache.db.prepare(
                `SELECT DISTINCT csharp_fqn, lua_call_pattern FROM xlua_mappings WHERE lua_file = ? AND csharp_fqn IS NOT NULL`,
            ).all(luaFile) as Array<{ csharp_fqn: string; lua_call_pattern: string }>;

            return rows.map(r => ({
                csharpFqn: r.csharp_fqn,
                luaAlias: r.lua_call_pattern !== r.csharp_fqn ? r.lua_call_pattern : undefined,
            }));
        } catch {
            return [];
        }
    }

    /**
     * 从 C# 文件内容中提取 using 命名空间声明。
     * 排除 using static、using alias = 等形式。
     */
    extractCsharpUsings(
        content: string,
    ): Array<{ namespace: string; line: number }> {
        const results: Array<{ namespace: string; line: number }> = [];
        const lines = content.split('\n');
        const usingPattern = /^using\s+([\w.]+)\s*;/;

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            // 排除 using static、using alias =、using var（using declaration）
            if (trimmed.startsWith('using static ')) continue;
            if (/^using\s+\w+\s*=/.test(trimmed)) continue;

            const match = usingPattern.exec(trimmed);
            if (match) {
                results.push({
                    namespace: match[1],
                    line: i + 1,
                });
            }
        }

        return results;
    }

    /**
     * 查找哪些 Lua 文件 require 了指定文件（反向依赖）。
     * 将文件路径转为可能的模块路径，然后 grep 所有 Lua 文件。
     */
    private async findLuaDependents(
        luaFile: string,
    ): Promise<Array<{ file: string; line: number }>> {
        // 将文件路径转为可能的 require 模块路径
        const modulePaths = this.fileToModulePaths(luaFile);
        if (modulePaths.length === 0) return [];

        const results: Array<{ file: string; line: number }> = [];
        const seen = new Set<string>();

        try {
            const luaFiles = await glob('**/*.lua', {
                cwd: this.workspaceRoot,
                absolute: false,
                ignore: ['**/node_modules/**', '**/Library/**', '**/Temp/**'],
            });

            // 构建 require 模式匹配
            const patterns = modulePaths.map(mp => {
                const escaped = mp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(`require\\s*\\(\\s*["']${escaped}["']\\s*\\)`);
            });

            for (const file of luaFiles) {
                // 不搜索自身
                if (file.replace(/\\/g, '/') === luaFile.replace(/\\/g, '/')) continue;

                const absPath = path.join(this.workspaceRoot, file);
                let content: string;
                try {
                    content = await fs.readFile(absPath, 'utf-8');
                } catch { continue; }

                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    for (const pattern of patterns) {
                        if (pattern.test(lines[i])) {
                            const key = `${file}:${i + 1}`;
                            if (!seen.has(key)) {
                                seen.add(key);
                                results.push({
                                    file: file.replace(/\\/g, '/'),
                                    line: i + 1,
                                });
                            }
                        }
                    }
                }

                if (results.length >= 500) break;
            }
        } catch (e) {
            console.error(`[CSG] findLuaDependents error: ${(e as Error).message}`);
        }

        return results;
    }

    /**
     * 将 Lua 文件路径转为可能的 require 模块路径。
     * 如 "Lua/games/systems/GuideManager.lua" → ["games.systems.GuideManager", "Lua.games.systems.GuideManager"]
     */
    private fileToModulePaths(luaFile: string): string[] {
        const normalized = luaFile.replace(/\\/g, '/');
        // 去 .lua 后缀
        const withoutExt = normalized.replace(/\.lua$/, '');

        const results: string[] = [];

        const addModulePaths = (base: string) => {
            results.push(base.replace(/\//g, '.'));
            // init.lua convention: require("foo.bar") can resolve to foo/bar/init.lua
            if (base.endsWith('/init')) {
                results.push(base.slice(0, -'/init'.length).replace(/\//g, '.'));
            }
        };

        // 完整路径转为模块路径
        addModulePaths(withoutExt);

        // 尝试去掉常见 Lua 根目录前缀
        const luaDirs = ['Lua/', 'lua/', 'LuaScripts/', 'Assets/LuaScripts/', 'Assets/Lua/'];
        for (const dir of luaDirs) {
            if (normalized.startsWith(dir)) {
                addModulePaths(withoutExt.substring(dir.length));
            }
        }

        return [...new Set(results)]; // 去重
    }

    /**
     * 通过 callHierarchy 直接获取 incoming callers（LuaLS 支持）
     */
    private async findIncomingCallersViaCallHierarchy(
        file: string,
        line: number,      // 1-based
        character: number,
        maxDepth: number,
        currentDepth: number,
        visited: Set<string>,
    ): Promise<CallChainNode[]> {
        if (currentDepth >= maxDepth) return [];

        const visitKey = `${file}:${line}`;
        if (visited.has(visitKey)) return [];
        visited.add(visitKey);

        const client = this.lspManager.getClientForFile(file);
        const uri = relativeToUri(this.workspaceRoot, file);

        const items = await client.callHierarchyPrepare(uri, line - 1, character);
        console.error(`[CSG] callHierarchy prepare: ${items?.length || 0} items for ${file}:${line}`);
        if (!items || items.length === 0) return [];

        const incomingCalls = await client.callHierarchyIncoming(items[0]);
        console.error(`[CSG] callHierarchy incoming: ${incomingCalls?.length || 0} calls`);
        if (!incomingCalls || incomingCalls.length === 0) return [];

        const nodes: CallChainNode[] = [];
        for (const call of incomingCalls) {
            const from = call.from;
            const callerFile = uriToRelative(this.workspaceRoot, from.uri);
            const callerLine = from.range.start.line + 1;

            const node: CallChainNode = {
                name: from.name,
                fqn: from.name,
                kind: from.kind,
                file: callerFile,
                line: callerLine,
                children: [],
                confidence: 'exact',
            };

            node.children = await this.findIncomingCallersViaCallHierarchy(
                callerFile, callerLine, from.range.start.character,
                maxDepth, currentDepth + 1, visited,
            );

            nodes.push(node);
        }

        return nodes;
    }

    /**
     * 通过 callHierarchy/outgoingCalls 获取"这个方法调用了哪些方法"
     * 递归展开到 maxDepth 层
     */
    private async findOutgoingCallsViaCallHierarchy(
        file: string,
        line: number,      // 1-based
        character: number,
        maxDepth: number,
        currentDepth: number,
        visited: Set<string>,
    ): Promise<CallChainNode[]> {
        if (currentDepth >= maxDepth) return [];

        const visitKey = `${file}:${line}`;
        if (visited.has(visitKey)) return [];
        visited.add(visitKey);

        try {
            const client = this.lspManager.getClientForFile(file);
            const uri = relativeToUri(this.workspaceRoot, file);

            const items = await client.callHierarchyPrepare(uri, line - 1, character);
            if (!items || items.length === 0) return [];

            const outgoingCalls = await client.callHierarchyOutgoing(items[0]);
            if (!outgoingCalls || outgoingCalls.length === 0) return [];

            const nodes: CallChainNode[] = [];
            for (const call of outgoingCalls) {
                const to = call.to;
                const calleeFile = uriToRelative(this.workspaceRoot, to.uri);
                const calleeLine = to.range.start.line + 1;

                // 跳过生成代码（XLua Wrap 等），减少噪音
                if (isGeneratedCode(calleeFile)) continue;

                const node: CallChainNode = {
                    name: to.name,
                    fqn: to.name,
                    kind: to.kind,
                    file: calleeFile,
                    line: calleeLine,
                    children: [],
                    confidence: 'exact',
                };

                node.children = await this.findOutgoingCallsViaCallHierarchy(
                    calleeFile, calleeLine, to.range.start.character,
                    maxDepth, currentDepth + 1, visited,
                );

                nodes.push(node);
            }

            return nodes;
        } catch (e) {
            if (e instanceof LspTimeoutError) return [];
            throw e;
        }
    }

    /**
     * 通过 references + documentSymbol 找到"谁调用了这个符号"
     * 递归展开到 maxDepth 层
     */
    private async findIncomingCallers(
        file: string,
        line: number,      // 1-based
        character: number,
        maxDepth: number,
        currentDepth: number,
        visited: Set<string>,
    ): Promise<CallChainNode[]> {
        if (currentDepth >= maxDepth) return [];

        const visitKey = `${file}:${line}`;
        if (visited.has(visitKey)) return [];
        visited.add(visitKey);

        try {
            const client = this.lspManager.getClientForFile(file);
            const uri = relativeToUri(this.workspaceRoot, file);

            // 1. 获取所有引用
            const refs = await client.references(uri, line - 1, character, false);
            if (!refs || refs.length === 0) {
                console.error(`[CSG] findIncomingCallers: 0 refs for ${file}:${line}`);
                return [];
            }
            console.error(`[CSG] findIncomingCallers: ${refs.length} refs for ${file}:${line}`);

            // 2. 按文件分组
            const byFile = new Map<string, Location[]>();
            for (const ref of refs) {
                const refFile = uriToRelative(this.workspaceRoot, ref.uri);
                if (!byFile.has(refFile)) byFile.set(refFile, []);
                byFile.get(refFile)!.push(ref);
            }

            // 3. 对每个文件获取 documentSymbol，找到引用所在的外层函数
            const callerMap = new Map<string, CallChainNode>();

            for (const [refFile, fileLocs] of byFile) {
                let docSymbols: (SymbolInformation | DocumentSymbol)[] = [];
                try {
                    const refClient = this.lspManager.getClientForFile(refFile);
                    const refUri = relativeToUri(this.workspaceRoot, refFile);
                    docSymbols = await refClient.documentSymbol(refUri);
                } catch {
                    continue;
                }

                // 处理 SymbolInformation[] 格式（没有 children/range，有 location）
                const { symbols: normalized, isFlat } = this.normalizeDocSymbols(docSymbols);
                console.error(`[CSG]   file=${refFile} docSymbols=${docSymbols.length} isFlat=${isFlat}`);

                for (const loc of fileLocs) {
                    const refLine = loc.range.start.line; // 0-based
                    const enclosing = this.findEnclosingFunction(normalized, refLine, isFlat);

                    if (enclosing) {
                        const callerKey = `${refFile}:${enclosing.range.start.line}`;
                        if (!callerMap.has(callerKey)) {
                            callerMap.set(callerKey, {
                                name: enclosing.name,
                                fqn: enclosing.name,
                                kind: enclosing.kind,
                                file: refFile,
                                line: enclosing.range.start.line + 1,
                                children: [],
                                confidence: 'high',
                            });
                        }
                    } else {
                        const kindSummary = normalized.map(s => `${s.name}(k=${s.kind},L${s.range.start.line}-${s.range.end.line})`).slice(0, 10).join(', ');
                        console.error(`[CSG]   no enclosing for ref at ${refFile}:${refLine + 1} | symbols: ${kindSummary}`);
                    }
                }
            }

            console.error(`[CSG] findIncomingCallers: ${callerMap.size} callers found`);

            // 4. 递归展开每个 caller
            const nodes = Array.from(callerMap.values());
            for (const node of nodes) {
                node.children = await this.findIncomingCallers(
                    node.file, node.line, 0,
                    maxDepth, currentDepth + 1, visited,
                );
            }

            return nodes;
        } catch (e) {
            if (e instanceof LspTimeoutError) return [];
            throw e;
        }
    }

    /**
     * 在 DocumentSymbol 树中找到包含指定行的最内层函数/方法
     * @param isFlat 为 true 时使用"最近前方方法"启发式（SymbolInformation flat 模式）
     *
     * 两轮匹配策略：
     *   1. 严格 kind: Method(6), Constructor(9), Function(12)
     *   2. 放宽 kind: + Property(7), Field(8), Variable(13)
     *      Lua 中 function M:method() 可能被 LuaLS 标记为 Field/Property
     */
    private findEnclosingFunction(
        symbols: DocumentSymbol[],
        line: number, // 0-based
        isFlat: boolean = false,
    ): DocumentSymbol | undefined {
        if (!symbols || symbols.length === 0) return undefined;

        // SymbolKind: Function=12, Method=6, Constructor=9
        const strictKinds = new Set([6, 9, 12]);
        // Lua 函数可能被标记为 Field(8), Property(7), Variable(13)
        const relaxedKinds = new Set([6, 7, 8, 9, 12, 13]);

        if (isFlat) {
            const result = this.findNearestPreceding(symbols, line, strictKinds)
                        || this.findNearestPreceding(symbols, line, relaxedKinds);
            return result;
        }

        // 正常模式：range containment，先严格再放宽
        const result = this.findContaining(symbols, line, strictKinds)
                    || this.findContaining(symbols, line, relaxedKinds);
        return result;
    }

    /** flat 模式：找 startLine ≤ line 的最后一个匹配 kind 的符号 */
    private findNearestPreceding(
        symbols: DocumentSymbol[], line: number, kinds: Set<number>,
    ): DocumentSymbol | undefined {
        const filtered = symbols
            .filter(s => kinds.has(s.kind))
            .sort((a, b) => a.range.start.line - b.range.start.line);

        let best: DocumentSymbol | undefined;
        for (const m of filtered) {
            if (m.range.start.line <= line) {
                best = m;
            } else {
                break;
            }
        }
        return best;
    }

    /** hierarchical 模式：range containment 找最内层匹配 kind 的符号 */
    private findContaining(
        symbols: DocumentSymbol[], line: number, kinds: Set<number>,
    ): DocumentSymbol | undefined {
        for (const sym of symbols) {
            if (!sym.range) continue;
            if (sym.range.start.line <= line && sym.range.end.line >= line) {
                // 先检查子节点是否有更精确的匹配
                if (sym.children) {
                    const inner = this.findContaining(sym.children, line, kinds);
                    if (inner) return inner;
                }
                if (kinds.has(sym.kind)) {
                    return sym;
                }
            }
        }
        return undefined;
    }

    /** confidence 优先级排序（用于合并时取更高置信度） */
    private static readonly CONFIDENCE_RANK: Record<string, number> = {
        exact: 0, high: 1, medium: 2, low: 3,
    };

    /** 合并两组 CallChainNode，按 file:line 去重 */
    private mergeCallChainNodes(a: CallChainNode[], b: CallChainNode[]): CallChainNode[] {
        const seen = new Map<string, CallChainNode>();
        for (const node of [...a, ...b]) {
            const key = `${node.file}:${node.line}`;
            if (!seen.has(key)) {
                seen.set(key, node);
            } else {
                const existing = seen.get(key)!;
                // 保留 confidence 更高的，或 children 更多的
                const existingRank = QueryService.CONFIDENCE_RANK[existing.confidence ?? 'medium'] ?? 2;
                const nodeRank = QueryService.CONFIDENCE_RANK[node.confidence ?? 'medium'] ?? 2;
                if (nodeRank < existingRank || (nodeRank === existingRank && node.children.length > existing.children.length)) {
                    seen.set(key, node);
                }
            }
        }
        return Array.from(seen.values());
    }

    /**
     * 将 SymbolInformation[]（flat）转成 DocumentSymbol[] 格式
     * SymbolInformation 有 location 但没有 range/children
     * 返回 isFlat 标记，告知 findEnclosingFunction 使用哪种匹配模式
     */
    private normalizeDocSymbols(
        symbols: (SymbolInformation | DocumentSymbol)[],
    ): NormalizedSymbols {
        if (!symbols || symbols.length === 0) return { symbols: [], isFlat: false };

        // 检测是 DocumentSymbol 还是 SymbolInformation：DocumentSymbol 有 range，SymbolInformation 有 location
        const first = symbols[0];
        if ('range' in first && !('location' in first)) {
            // 已经是 DocumentSymbol[]
            return {
                symbols: symbols as DocumentSymbol[],
                isFlat: false,
            };
        }

        // SymbolInformation[] → 转换为 DocumentSymbol[]（flat，无 children）
        return {
            symbols: (symbols as SymbolInformation[]).map(si => ({
                name: si.name,
                kind: si.kind,
                range: si.location.range,
                selectionRange: si.location.range,
                children: [],
            })),
            isFlat: true,
        };
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

    /**
     * Lua 全局变量 fallback：grep 找到一个使用位置 → didOpen → LuaLS references。
     * 如果 LuaLS 也失败，退化为 grep 结果。
     */
    private async resolveViaGrepThenLsp(symbolName: string): Promise<ReferenceResult | null> {
        // 1. grep 找到第一个使用位置
        const grepResults = await this.grepLuaReferences(symbolName);
        if (grepResults.length === 0) return null;

        const firstHit = grepResults[0];

        // 2. 尝试通过 LuaLS references 做语义追踪
        try {
            const client = this.lspManager.getClientForLanguage('lua');
            if (client.state === 'ready') {
                const absPath = path.join(this.workspaceRoot, firstHit.file);
                const content = await fs.readFile(absPath, 'utf-8');
                const uri = relativeToUri(this.workspaceRoot, firstHit.file);

                await client.didOpen(uri, 'lua', content);
                const lspRefs = await client.references(
                    uri, firstHit.line - 1, firstHit.character, false,
                );

                if (lspRefs.length > 0) {
                    console.error(`[CSG] references: Lua global resolved via grep+LSP: ${lspRefs.length} results for "${symbolName}"`);
                    return {
                        symbolFqn: symbolName,
                        references: lspRefs.map(ref => ({
                            file: uriToRelative(this.workspaceRoot, ref.uri),
                            line: ref.range.start.line + 1,
                            character: ref.range.start.character,
                            confidence: 'high' as Confidence,
                        })),
                        count: lspRefs.length,
                        source: 'lsp',
                    };
                }
            }
        } catch (e) {
            console.error(`[CSG] references: Lua LSP fallback failed: ${(e as Error).message}`);
        }

        // 3. LuaLS 也失败，退化为 grep 结果
        console.error(`[CSG] references: grep fallback for "${symbolName}": ${grepResults.length} results`);
        return {
            symbolFqn: symbolName,
            references: grepResults.map(r => ({ ...r, confidence: 'medium' as Confidence })),
            count: grepResults.length,
            source: 'grep',
        };
    }

    /**
     * 从 csharp-ls 的 fqn 格式（如 "void GTAGameStart.UMTAwake()"）中提取短方法名
     */
    private extractMethodName(fqn: string): string | null {
        // csharp-ls 格式: "ReturnType Container.Method(params)"
        const match = fqn.match(/\.(\w+)\s*\(/);
        if (match) return match[1];
        // 简单名: "MethodName"
        const simple = fqn.match(/^(\w+)$/);
        if (simple) return simple[1];
        return null;
    }

    /**
     * grep C# 文件找到方法调用点，返回 CallChainNode（enclosing function 级）。
     * 用于 csharp-ls callHierarchy/references 返回空时的 fallback。
     */
    private async grepCsharpCallers(
        methodName: string, sourceFile: string,
    ): Promise<CallChainNode[]> {
        // 搜索 .MethodName( 或 this.MethodName( 等调用模式
        const callPattern = new RegExp(`\\b${methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`, 'g');

        try {
            const csFiles = await glob('**/*.cs', {
                cwd: this.workspaceRoot,
                absolute: false,
                ignore: ['**/node_modules/**', '**/Library/**', '**/Temp/**'],
            });

            const callSites: { file: string; line: number }[] = [];

            for (const file of csFiles) {
                // 跳过生成代码
                if (isGeneratedCode(file)) continue;

                const absPath = path.join(this.workspaceRoot, file);
                let content: string;
                try {
                    content = await fs.readFile(absPath, 'utf-8');
                } catch { continue; }

                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    // 跳过定义行（方法签名、override/virtual 声明等）
                    if (/\b(virtual|override|abstract|new)\b/.test(line) && line.includes(methodName)) continue;
                    // 跳过注释行
                    const trimmed = line.trimStart();
                    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

                    callPattern.lastIndex = 0;
                    if (callPattern.test(line)) {
                        callSites.push({
                            file: file.replace(/\\/g, '/'),
                            line: i, // 0-based
                        });
                    }
                }

                if (callSites.length >= 100) break;
            }

            if (callSites.length === 0) return [];

            // 按文件分组，用 documentSymbol 找 enclosing function
            const byFile = new Map<string, number[]>();
            for (const site of callSites) {
                if (!byFile.has(site.file)) byFile.set(site.file, []);
                byFile.get(site.file)!.push(site.line);
            }

            const callerMap = new Map<string, CallChainNode>();
            for (const [refFile, lines] of byFile) {
                let docSymbols: (SymbolInformation | DocumentSymbol)[] = [];
                try {
                    const client = this.lspManager.getClientForFile(refFile);
                    const uri = relativeToUri(this.workspaceRoot, refFile);
                    docSymbols = await client.documentSymbol(uri);
                } catch { continue; }

                const { symbols: normalized, isFlat } = this.normalizeDocSymbols(docSymbols);

                for (const refLine of lines) {
                    const enclosing = this.findEnclosingFunction(normalized, refLine, isFlat);
                    if (enclosing) {
                        const key = `${refFile}:${enclosing.range.start.line}`;
                        if (!callerMap.has(key)) {
                            callerMap.set(key, {
                                name: enclosing.name,
                                fqn: enclosing.name,
                                kind: enclosing.kind,
                                file: refFile,
                                line: enclosing.range.start.line + 1,
                                children: [],
                                confidence: 'medium',
                            });
                        }
                    }
                }
            }

            return Array.from(callerMap.values());
        } catch (e) {
            console.error(`[CSG] grepCsharpCallers error: ${(e as Error).message}`);
            return [];
        }
    }

    /**
     * grep C# 文件查找符号引用（csharp-ls references 遗漏 fallback）。
     * 只搜索非生成代码文件。
     */
    private async grepCsharpReferences(
        symbolName: string,
    ): Promise<{ file: string; line: number; character: number }[]> {
        const results: { file: string; line: number; character: number }[] = [];
        const pattern = new RegExp(`\\b${symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');

        try {
            const csFiles = await glob('**/*.cs', {
                cwd: this.workspaceRoot,
                absolute: false,
                ignore: ['**/node_modules/**', '**/Library/**', '**/Temp/**'],
            });

            for (const file of csFiles) {
                if (isGeneratedCode(file)) continue;

                const absPath = path.join(this.workspaceRoot, file);
                let content: string;
                try {
                    content = await fs.readFile(absPath, 'utf-8');
                } catch { continue; }

                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    pattern.lastIndex = 0;
                    const match = pattern.exec(lines[i]);
                    if (match) {
                        results.push({
                            file: file.replace(/\\/g, '/'),
                            line: i + 1,
                            character: match.index,
                        });
                    }
                }

                if (results.length >= 500) break;
            }
        } catch (e) {
            console.error(`[CSG] grepCsharpReferences error: ${(e as Error).message}`);
        }

        return results;
    }

    /**
     * 正则扫描所有 Lua 文件查找符号引用（LuaLS 全局变量 fallback）。
     * 仅在 LuaLS references 返回空时调用。
     */
    private async grepLuaReferences(
        symbolName: string,
    ): Promise<{ file: string; line: number; character: number }[]> {
        const results: { file: string; line: number; character: number }[] = [];
        const pattern = new RegExp(`\\b${symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');

        try {
            const luaFiles = await glob('**/*.lua', {
                cwd: this.workspaceRoot,
                absolute: false,
                ignore: ['**/node_modules/**', '**/Library/**', '**/Temp/**'],
            });

            for (const file of luaFiles) {
                const absPath = path.join(this.workspaceRoot, file);
                let content: string;
                try {
                    content = await fs.readFile(absPath, 'utf-8');
                } catch { continue; }

                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    pattern.lastIndex = 0;
                    const match = pattern.exec(lines[i]);
                    if (match) {
                        results.push({
                            file: file.replace(/\\/g, '/'),
                            line: i + 1,
                            character: match.index,
                        });
                    }
                }

                if (results.length >= 500) break; // 安全上限
            }
        } catch (e) {
            console.error(`[CSG] grepLuaReferences error: ${(e as Error).message}`);
        }

        return results;
    }

    /**
     * 正则扫描所有 Lua 文件查找方法调用（GetComponent 动态绑定 fallback）。
     * 使用 [:.]\s* 前缀精确匹配方法调用，不匹配定义或赋值。
     */
    public async grepLuaMethodCalls(
        memberName: string,
        limit = 100,
    ): Promise<{ file: string; line: number; character: number }[]> {
        const results: { file: string; line: number; character: number }[] = [];
        const escaped = memberName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`[:.][\\s]*${escaped}\\s*\\(`, 'g');

        try {
            const luaFiles = await glob('**/*.lua', {
                cwd: this.workspaceRoot,
                absolute: false,
                ignore: ['**/node_modules/**', '**/Library/**', '**/Temp/**'],
            });

            for (const file of luaFiles) {
                const absPath = path.join(this.workspaceRoot, file);
                let content: string;
                try {
                    content = await fs.readFile(absPath, 'utf-8');
                } catch { continue; }

                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    pattern.lastIndex = 0;
                    const match = pattern.exec(lines[i]);
                    if (match) {
                        results.push({
                            file: file.replace(/\\/g, '/'),
                            line: i + 1,
                            character: match.index + 1, // +1：跳过前缀 [:.] 指向方法名
                        });
                        if (results.length >= limit) break;
                    }
                }

                if (results.length >= limit) break;
            }
        } catch (e) {
            console.error(`[CSG] grepLuaMethodCalls error: ${(e as Error).message}`);
        }

        return results;
    }

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
            // hover failure doesn't affect main flow
        }
        return sym;
    }

    private extractHoverText(contents: unknown): string {
        if (typeof contents === 'string') return contents;
        if (contents && typeof contents === 'object') {
            if ('value' in contents) return (contents as { value: string }).value;
            if (Array.isArray(contents)) {
                return contents.map((c: unknown) =>
                    typeof c === 'string' ? c : (c as { value?: string })?.value || '',
                ).join('\n');
            }
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

export interface ResolvedSymbol {
    name: string;
    fqn: string;
    kind: number;
    language: string;
    file: string;
    line: number;       // 0-based
    character: number;  // 0-based
    stale?: boolean;
    signature?: string;
    doc?: string;
}

export interface DefinitionResult extends ResolvedSymbol {
    source: 'cache' | 'lsp' | 'cache_stale' | 'grep';
    latencyMs: number;
}

/** 结果置信度等级 */
export type Confidence = 'exact' | 'high' | 'medium' | 'low';

export interface ReferenceItem {
    file: string;
    line: number;
    character: number;
    confidence?: Confidence;
}

export interface ReferenceResult {
    symbolFqn: string;
    references: ReferenceItem[];
    count: number;
    source: 'cache' | 'lsp' | 'grep';
    error?: string;
}

export interface CallChainResult {
    root: string;
    incoming: CallChainNode[];
    outgoing: CallChainNode[];
}

export interface CallChainNode {
    name: string;
    fqn: string;
    kind: number;
    file: string;
    line: number;
    children: CallChainNode[];
    confidence?: Confidence;
}

export interface HierarchyResult {
    target: ResolvedSymbol | null;
    baseTypes: { name: string }[];
    implementations: { name: string; file: string; line: number }[];
}

export interface TaggedClassResult {
    name: string;
    file: string;
    line: number;
    tag: string;
    tagType: 'attribute' | 'base_class';
}

export interface FileDepsResult {
    file: string;
    language: 'lua' | 'csharp';
    deps: {
        luaRequires: Array<{ module: string; resolvedFile: string | null; line: number }>;
        csharpUsings: Array<{ namespace: string; line: number }>;
        crossLangDeps: Array<{ csharpFqn: string; luaAlias?: string }>;
    };
    dependents: {
        luaRequiredBy: Array<{ file: string; line: number }>;
    };
}

export interface DanglingAliasResult {
    totalChecked: number;
    danglingCount: number;
    danglingAliases: Array<{
        aliasName: string;
        csharpFqn: string;
        luaFile: string;
        luaLine: number;
        reason: string;
    }>;
}

export interface RenamePreview {
    symbol: string;
    oldName: string;
    newName: string;
    totalChanges: number;
    files: Array<{
        file: string;
        language: 'csharp' | 'lua' | 'other';
        changes: Array<{
            line: number;
            oldText: string;
            newText: string;
        }>;
    }>;
    warnings: string[];
}

export interface CycleCheckResult {
    totalFilesScanned: number;
    cyclesFound: number;
    cycles: Array<{
        chain: string[];     // 循环链，如 ["a.lua", "b.lua", "c.lua", "a.lua"]
        length: number;      // 环长度
    }>;
}

export type SemanticContext = 'call' | 'definition' | 'comment' | 'string' | 'unknown';

export interface SearchResult {
    totalMatches: number;
    results: Array<{
        file: string;
        line: number;
        content: string;
        context: SemanticContext;
        confidence: 'medium';
    }>;
}
