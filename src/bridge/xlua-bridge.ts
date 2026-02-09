import { LspManager } from '../lsp/lsp-manager.js';
import { CacheManager } from '../cache/cache-manager.js';
import { relativeToUri, uriToRelative } from '../utils/uri.js';
import { LspTimeoutError } from '../utils/timeout.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import type { DocumentSymbol, SymbolInformation } from 'vscode-languageserver-protocol';

const CS_CALL_PATTERN = /CS\.([\w.]+)[:\.](\w+)\s*\(/g;
const CS_ALIAS_PATTERN = /local\s+(\w+)\s*=\s*CS\.([\w.]+)\s*$/gm;
const CS_GLOBAL_ALIAS_PATTERN = /^(\w+)\s*=\s*CS\.([\w.]+)\s*$/gm;

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

interface VerifiedSymbol {
    fqn: string;
    file: string;
    line: number;
    signature?: string;
}

export interface ScanResult {
    totalCalls: number;
    verified: number;
    unresolved: number;
    aliases: number;
    duration: number;
}

export interface CrossLangResult {
    csharp: { fqn: string; file?: string; line?: number; signature?: string };
    lua: {
        globalName: string;
        callSites: {
            file: string; line: number; callerFqn?: string;
            pattern: string; status: string;
        }[];
    };
}

/**
 * 对 LSP 查不到的 C# 类名进行分类，让 AI 更容易理解调用来源。
 * - verified:        项目源码中找到定义
 * - unity_builtin:   UnityEngine / UnityEditor 引擎 API
 * - dotnet_builtin:  System / Microsoft .NET 框架类型
 * - third_party:     已知第三方插件（Spine, DOTween, TextMeshPro 等）
 * - project_dll:     项目命名空间但编译为 DLL，源码不在 LSP 索引范围
 * - unresolved:      无法判断来源
 */
const UNITY_NS = ['UnityEngine', 'UnityEditor'];
const DOTNET_NS = ['System', 'Microsoft'];
const BUILTIN_THIRD_PARTY_NS = [
    'Spine', 'TMPro', 'DG', 'Cinemachine', 'BehaviorDesigner',
    'BitBenderGames', 'FluffyUnderware', 'HedgehogTeam', 'Neonagee',
    'Mopsicus', 'OWL', 'UMT', 'NPinyin', 'ImageEffects', 'MobileMedia',
    'DeviceInfo', 'GpuHudFacade', 'AudioStudio',
];

function classifyUnresolved(className: string, thirdPartyNs: string[]): string {
    const topNs = className.split('.')[0];
    if (UNITY_NS.includes(topNs)) return 'unity_builtin';
    if (DOTNET_NS.includes(topNs)) return 'dotnet_builtin';
    if (thirdPartyNs.includes(topNs)) return 'third_party';
    return 'unresolved';
}

export class XLuaBridge {
    private luaRoot: string;
    private thirdPartyNs: string[];

    constructor(
        private lspManager: LspManager,
        private cache: CacheManager,
        private workspaceRoot: string,
        luaRoot: string,
        extraThirdPartyNamespaces?: string[],
    ) {
        // Resolve relative luaRoot against workspaceRoot
        this.luaRoot = path.isAbsolute(luaRoot) ? luaRoot : path.resolve(workspaceRoot, luaRoot);
        this.thirdPartyNs = [...BUILTIN_THIRD_PARTY_NS, ...(extraThirdPartyNamespaces ?? [])];
    }

    async fullScan(): Promise<ScanResult> {
        const result: ScanResult = {
            totalCalls: 0, verified: 0, unresolved: 0, aliases: 0, duration: 0,
        };
        const startTime = Date.now();

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

        await this.enrichCallerInfo(allCalls);

        const verifyResults = await this.batchVerifyWithCSharp(allCalls);

        const insertVerified = this.cache.db.prepare(`
            INSERT OR REPLACE INTO xlua_mappings
            (lua_call_pattern, lua_file, lua_line, lua_caller_fqn,
             lua_file_hash, csharp_fqn, csharp_file, csharp_line,
             csharp_signature, status, verified_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?)
        `);

        const insertClassified = this.cache.db.prepare(`
            INSERT OR REPLACE INTO xlua_mappings
            (lua_call_pattern, lua_file, lua_line, lua_caller_fqn,
             lua_file_hash, status)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        const transaction = this.cache.db.transaction(() => {
            for (const call of allCalls) {
                const verified = verifyResults.get(
                    `${call.className}.${call.memberName}`,
                );

                if (verified) {
                    result.verified++;
                    insertVerified.run(
                        call.pattern, call.file, call.line, call.callerFqn ?? null,
                        '', verified.fqn, verified.file, verified.line,
                        verified.signature ?? null, Date.now(),
                    );
                } else {
                    result.unresolved++;
                    const status = classifyUnresolved(call.className, this.thirdPartyNs);
                    insertClassified.run(
                        call.pattern, call.file, call.line, call.callerFqn ?? null, '', status,
                    );
                }
            }

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

    async updateFile(filePath: string, content: string): Promise<void> {
        if (!filePath.endsWith('.lua')) return;

        this.cache.db.prepare('DELETE FROM xlua_mappings WHERE lua_file = ?')
            .run(filePath);
        this.cache.db.prepare('DELETE FROM lua_aliases WHERE alias_file = ?')
            .run(filePath);

        const calls = this.extractCsCalls(filePath, content);
        const aliases = this.extractAliases(filePath, content);

        await this.enrichCallerInfo(calls);

        const verifyResults = await this.batchVerifyWithCSharp(calls);

        const transaction = this.cache.db.transaction(() => {
            for (const call of calls) {
                const verified = verifyResults.get(
                    `${call.className}.${call.memberName}`,
                );
                if (verified) {
                    this.cache.db.prepare(`
                        INSERT OR REPLACE INTO xlua_mappings
                        (lua_call_pattern, lua_file, lua_line, lua_caller_fqn,
                         lua_file_hash, csharp_fqn, csharp_file, csharp_line,
                         csharp_signature, status, verified_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?)
                    `).run(
                        call.pattern, call.file, call.line, call.callerFqn ?? null,
                        '', verified.fqn, verified.file, verified.line,
                        verified.signature ?? null, Date.now(),
                    );
                } else {
                    const status = classifyUnresolved(call.className, this.thirdPartyNs);
                    this.cache.db.prepare(`
                        INSERT OR REPLACE INTO xlua_mappings
                        (lua_call_pattern, lua_file, lua_line, lua_caller_fqn,
                         lua_file_hash, status)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `).run(call.pattern, call.file, call.line, call.callerFqn ?? null, '', status);
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
        `).all(`${csharpFqn}%`, `%${csharpFqn}%`) as Record<string, unknown>[];

        if (mappings.length === 0) return null;

        return {
            csharp: {
                fqn: csharpFqn,
                file: mappings[0]?.csharp_file as string | undefined,
                line: mappings[0]?.csharp_line as number | undefined,
                signature: mappings[0]?.csharp_signature as string | undefined,
            },
            lua: {
                globalName: `CS.${csharpFqn}`,
                callSites: mappings.map(m => ({
                    file: m.lua_file as string,
                    line: m.lua_line as number,
                    callerFqn: m.lua_caller_fqn as string | undefined,
                    pattern: m.lua_call_pattern as string,
                    status: m.status as string,
                })),
            },
        };
    }

    // ===== 批量验证 =====

    private async batchVerifyWithCSharp(
        calls: XLuaCall[],
    ): Promise<Map<string, VerifiedSymbol>> {
        const result = new Map<string, VerifiedSymbol>();

        const csharpClient = this.lspManager.getClientForLanguage('csharp');
        if (csharpClient.state !== 'ready') return result;

        const uniqueClasses = new Set(calls.map(c => c.className));
        const classSymbols = new Map<string, SymbolInformation[]>();

        for (const className of uniqueClasses) {
            const shortName = className.split('.').pop()!;
            try {
                const symbols = await csharpClient.workspaceSymbol(shortName);
                classSymbols.set(className, symbols);
            } catch (e) {
                if (e instanceof LspTimeoutError) continue;
                classSymbols.set(className, []);
            }
        }

        for (const call of calls) {
            const key = `${call.className}.${call.memberName}`;
            if (result.has(key)) continue;

            const symbols = classSymbols.get(call.className) || [];
            const matched = symbols.find(s => {
                const symFqn = s.containerName
                    ? `${s.containerName}.${s.name}`
                    : s.name;
                return (symFqn === key || symFqn.endsWith(key)) && s.name === call.memberName;
            });

            if (matched) {
                result.set(key, {
                    fqn: key,
                    file: uriToRelative(this.workspaceRoot, matched.location.uri),
                    line: matched.location.range.start.line + 1,
                });
            }
        }

        return result;
    }

    // ===== 内部方法 =====

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

        // local aliases: local xxx = CS.yyy
        CS_ALIAS_PATTERN.lastIndex = 0;
        while ((match = CS_ALIAS_PATTERN.exec(content)) !== null) {
            aliases.push({
                aliasName: match[1],
                originalPattern: `CS.${match[2]}`,
                file: filePath,
                line: this.getLineNumber(content, match.index),
            });
        }

        // global aliases: C_xxx = CS.yyy (common XLua pattern in alias.lua)
        CS_GLOBAL_ALIAS_PATTERN.lastIndex = 0;
        while ((match = CS_GLOBAL_ALIAS_PATTERN.exec(content)) !== null) {
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
                    call.callerFqn = this.findEnclosingSymbol(
                        symbols as (SymbolInformation | DocumentSymbol)[], call.line,
                    );
                }
            } catch { /* don't block */ }
        }
    }

    private findEnclosingSymbol(
        symbols: (SymbolInformation | DocumentSymbol)[],
        line: number,
    ): string | undefined {
        for (const sym of symbols) {
            const docSym = sym as DocumentSymbol;
            if (docSym.range &&
                docSym.range.start.line <= line - 1 &&
                docSym.range.end.line >= line - 1) {
                if (docSym.children) {
                    const inner = this.findEnclosingSymbol(docSym.children, line);
                    if (inner) return inner;
                }
                return docSym.name;
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
