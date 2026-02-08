import { LspManager } from '../lsp/lsp-manager.js';
import { CacheManager, type CachedSymbol } from '../cache/cache-manager.js';
import { relativeToUri, uriToRelative } from '../utils/uri.js';
import { LspTimeoutError } from '../utils/timeout.js';
import type { Location, DocumentSymbol, SymbolInformation } from 'vscode-languageserver-protocol';
import { glob } from 'glob';

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

        // 精确匹配有结果就用精确的
        let results = exactResults.length > 0 ? exactResults : [];

        // dotted name 没有精确匹配时，优先用 container+documentSymbol（比 fuzzy 精确）
        if (results.length === 0 && name.includes('.')) {
            results = await this.resolveMethodViaContainer(name);
        }

        // 最后才用 fuzzy
        if (results.length === 0) {
            results = fuzzyResults;
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
            return locations.map((loc: Location) => ({
                name: '',
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

        // LSP
        try {
            const client = this.lspManager.getClientForFile(file);
            const uri = relativeToUri(this.workspaceRoot, file);
            console.error(`[CSG] references: uri=${uri} pos=${line - 1}:${character} fqn=${fqn}`);

            const lspRefs = await client.references(
                uri, line - 1, character, false,
            );
            console.error(`[CSG] references: ${lspRefs.length} results`);

            const results = lspRefs.map(ref => ({
                file: uriToRelative(this.workspaceRoot, ref.uri),
                line: ref.range.start.line + 1,
                character: ref.range.start.character,
            }));

            // 写缓存
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
            // call_chain 优先选 method/function 级别符号（kind=6/9/12），class 级做 references 通常找不到外层函数
            const methodKinds = new Set([6, 9, 12]); // Method, Constructor, Function
            const preferred = resolved.find(r => methodKinds.has(r.kind)) || resolved[0];
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
                try {
                    result.incoming = await this.findIncomingCallersViaCallHierarchy(
                        file, line, character, maxDepth, 0, new Set(),
                    );
                    console.error(`[CSG] callHierarchy returned ${result.incoming.length} callers`);
                } catch (e) {
                    console.error(`[CSG] callHierarchy threw: ${(e as Error).message}`);
                }
                // callHierarchy 失败或返回空时，fallback 到 references 路径
                if (result.incoming.length === 0) {
                    console.error(`[CSG] callHierarchy empty, falling back to references`);
                    result.incoming = await this.findIncomingCallers(
                        file, line, character, maxDepth, 0, new Set(),
                    );
                }
            } else {
                result.incoming = await this.findIncomingCallers(
                    file, line, character, maxDepth, 0, new Set(),
                );
            }
        }

        // outgoing 需要 AST 分析，当前仅通过 references 实现 incoming
        // outgoing 留空，后续可通过 Roslyn API 增强

        return result;
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
    source: 'cache' | 'lsp' | 'cache_stale';
    latencyMs: number;
}

export interface ReferenceResult {
    symbolFqn: string;
    references: { file: string; line: number; character: number }[];
    count: number;
    source: 'cache' | 'lsp';
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
}
