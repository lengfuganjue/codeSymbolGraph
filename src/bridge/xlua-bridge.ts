import { LspManager } from '../lsp/lsp-manager.js';
import { CacheManager } from '../cache/cache-manager.js';
import { relativeToUri, uriToRelative } from '../utils/uri.js';
import { LspTimeoutError } from '../utils/timeout.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import type { SymbolInformation } from 'vscode-languageserver-protocol';

/** 直接 CS. 调用: CS.Namespace.Class:method() 或 CS.Namespace.Class.method() */
const CS_CALL_PATTERN = /CS\.([\w.]+)[:\.](\w+)\s*\(/g;

/**
 * GetComponent 动态绑定: self.fieldName = xxx:GetComponent("TypeName") 或 :GetComponent(CS.Type)
 * group1=fieldName, group2=字符串参数TypeName, group3=CS.参数Type
 */
const GETCOMPONENT_PATTERN =
    /\bself\.(\w+)\s*=\s*\w+:GetComponent\s*\(\s*(?:"([\w.]+)"|CS\.([\w.]+))\s*\)/gm;

/** 通过别名的调用: identifier:method() 或 identifier.method() */
const ALIAS_CALL_PATTERN = /\b(\w+)\s*[:.]\s*(\w+)\s*\(/g;

/**
 * 原始赋值提取：捕获 global 和 local 别名定义
 * 匹配: varName = value.with.dots 或 local varName = value.with.dots
 * 值部分用 [\w.]+ 只匹配标识符和点，不会吃到注释/空格
 */
const RAW_GLOBAL_ALIAS = /^\s*(\w+)\s*=\s*((?:CS\.)?[\w.]+)/gm;
const RAW_LOCAL_ALIAS = /\blocal\s+(\w+)\s*=\s*((?:CS\.)?[\w.]+)/gm;

interface GetComponentField {
    fieldName: string;    // e.g. "guideMask"
    typeName: string;     // e.g. "GotoMask"（短名）或 "Game.GotoMask"（FQN）
    isShortName: boolean; // true=字符串参数，false=CS.参数
    file: string;
    line: number;
}

interface RawAlias {
    name: string;
    value: string;  // 原始右值，未解析
    file: string;
    line: number;
}

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
    aliasCallsFound: number;
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
    /** fullScan 后保存的已解析别名表，供 updateFile 复用 */
    private aliasLookup = new Map<string, string>();

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
            totalCalls: 0, verified: 0, unresolved: 0, aliases: 0,
            aliasCallsFound: 0, duration: 0,
        };
        const startTime = Date.now();

        // ===== 读取所有文件 =====
        const luaFiles = await glob('**/*.lua', {
            cwd: this.luaRoot,
            absolute: false,
        });

        const fileContents = new Map<string, string>();
        for (const file of luaFiles) {
            const absPath = path.join(this.luaRoot, file);
            const content = await fs.readFile(absPath, 'utf-8');
            fileContents.set(file, content);
        }
        // ===== Phase 1: 提取所有原始别名 =====
        const rawAliases: RawAlias[] = [];
        for (const [file, content] of fileContents) {
            rawAliases.push(...this.extractRawAliases(file, content));
        }

        // ===== Phase 1.5: 提取 GetComponent 字段映射 =====
        const allGetComponentFields: GetComponentField[] = [];
        for (const [file, content] of fileContents) {
            allGetComponentFields.push(...this.extractGetComponentFields(file, content));
        }
        const fieldTypeLookup = new Map<string, GetComponentField>();
        for (const f of allGetComponentFields) {
            // 同名字段以 CS. 参数（非短名）优先，更准确
            if (!fieldTypeLookup.has(f.fieldName) || !f.isShortName) {
                fieldTypeLookup.set(f.fieldName, f);
            }
        }
        // 全量写入 getcomponent_fields 表
        const insertGcf = this.cache.db.prepare(`
            INSERT OR REPLACE INTO getcomponent_fields
            (field_name, type_name, lua_file, lua_line, file_hash)
            VALUES (?, ?, ?, ?, '')
        `);
        this.cache.db.transaction(() => {
            this.cache.db.prepare('DELETE FROM getcomponent_fields').run();
            for (const f of allGetComponentFields) {
                insertGcf.run(f.fieldName, f.typeName, f.file, f.line);
            }
        })();
        console.error(`[CSG] getcomponent: ${allGetComponentFields.length} fields, ${fieldTypeLookup.size} unique`);

        // ===== Phase 1.5b: 短名解析（通过 workspaceSymbol 查找唯一匹配的 FQN）=====
        await this.resolveGetComponentShortNames(fieldTypeLookup);

        // 将解析后的 FQN 同步到 DB
        const updateGcf = this.cache.db.prepare(
            'UPDATE getcomponent_fields SET type_name = ? WHERE field_name = ? AND lua_file = ? AND lua_line = ?',
        );
        for (const [, field] of fieldTypeLookup) {
            if (!field.isShortName) {
                updateGcf.run(field.typeName, field.fieldName, field.file, field.line);
            }
        }

        // ===== Phase 2: 解析别名链 =====
        this.aliasLookup = this.resolveAliasChains(rawAliases);
        console.error(`[CSG] alias chain: ${rawAliases.length} raw → ${this.aliasLookup.size} resolved`);

        // ===== Phase 3: 提取调用，分离直接调用和别名调用 =====
        const directCalls: XLuaCall[] = [];
        const aliasCalls: XLuaCall[] = [];
        for (const [file, content] of fileContents) {
            directCalls.push(...this.extractCsCalls(file, content));
            aliasCalls.push(...this.extractAliasCalls(file, content, this.aliasLookup, fieldTypeLookup));
        }
        const dedupDirect = this.deduplicateCalls(directCalls);
        const dedupAlias = this.deduplicateCalls(aliasCalls);

        result.totalCalls = dedupDirect.length + dedupAlias.length;
        result.aliasCallsFound = dedupAlias.length;

        // ===== Phase 4: 构建别名 DB 记录（只存已解析的） =====
        const allAliases: XLuaAlias[] = [];
        for (const raw of rawAliases) {
            const resolved = this.aliasLookup.get(raw.name);
            if (resolved) {
                allAliases.push({
                    aliasName: raw.name,
                    originalPattern: resolved,
                    file: raw.file,
                    line: raw.line,
                });
            }
        }
        result.aliases = allAliases.length;

        // ===== Phase 5: 验证直接 CS. 调用（workspaceSymbol 慢，别名调用按命名空间分类即可） =====
        const verifyResults = await this.batchVerifyWithCSharp(dedupDirect);

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
            // 直接 CS. 调用：用 workspaceSymbol 验证结果
            for (const call of dedupDirect) {
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

            // 别名调用：别名链已解析为完整 FQN，按命名空间分类（不做 workspaceSymbol 验证）
            const insertAliasResolved = this.cache.db.prepare(`
                INSERT OR REPLACE INTO xlua_mappings
                (lua_call_pattern, lua_file, lua_line, lua_caller_fqn,
                 lua_file_hash, csharp_fqn, status)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            for (const call of dedupAlias) {
                const fqn = `${call.className}.${call.memberName}`;
                const nsStatus = classifyUnresolved(call.className, this.thirdPartyNs);
                const status = nsStatus === 'unresolved' ? 'alias_resolved' : nsStatus;
                insertAliasResolved.run(
                    call.pattern, call.file, call.line, call.callerFqn ?? null,
                    '', fqn, status,
                );
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

        // 提取新的别名并合并到现有 aliasLookup
        const rawAliases = this.extractRawAliases(filePath, content);
        for (const raw of rawAliases) {
            if (raw.value.startsWith('CS.')) {
                this.aliasLookup.set(raw.name, raw.value);
            } else {
                const firstDot = raw.value.indexOf('.');
                const firstPart = firstDot > 0 ? raw.value.substring(0, firstDot) : raw.value;
                const rest = firstDot > 0 ? raw.value.substring(firstDot) : '';
                const resolved = this.aliasLookup.get(firstPart);
                if (resolved) {
                    this.aliasLookup.set(raw.name, resolved + rest);
                }
            }
        }

        // 增量更新 getcomponent_fields
        this.cache.db.prepare('DELETE FROM getcomponent_fields WHERE lua_file = ?').run(filePath);
        const gcFields = this.extractGetComponentFields(filePath, content);
        const insertGcf = this.cache.db.prepare(`
            INSERT OR REPLACE INTO getcomponent_fields
            (field_name, type_name, lua_file, lua_line, file_hash)
            VALUES (?, ?, ?, ?, '')
        `);
        for (const f of gcFields) {
            insertGcf.run(f.fieldName, f.typeName, f.file, f.line);
        }
        const fieldTypeLookup = new Map<string, GetComponentField>();
        for (const f of gcFields) {
            if (!fieldTypeLookup.has(f.fieldName) || !f.isShortName) {
                fieldTypeLookup.set(f.fieldName, f);
            }
        }

        // 短名解析（增量更新也支持）
        await this.resolveGetComponentShortNames(fieldTypeLookup);

        const calls = [
            ...this.extractCsCalls(filePath, content),
            ...this.extractAliasCalls(filePath, content, this.aliasLookup, fieldTypeLookup),
        ];
        const deduped = this.deduplicateCalls(calls);
        const aliases = rawAliases
            .filter(r => this.aliasLookup.has(r.name))
            .map(r => ({
                aliasName: r.name,
                originalPattern: this.aliasLookup.get(r.name)!,
                file: r.file,
                line: r.line,
            }));

        await this.enrichCallerInfo(deduped);

        const verifyResults = await this.batchVerifyWithCSharp(deduped);

        const transaction = this.cache.db.transaction(() => {
            for (const call of deduped) {
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

        let mappings = this.cache.db.prepare(`
            SELECT * FROM xlua_mappings
            WHERE csharp_fqn LIKE ? OR lua_call_pattern LIKE ?
            ORDER BY status ASC
        `).all(`${csharpFqn}%`, `%${csharpFqn}%`) as Record<string, unknown>[];

        // alias 表 fallback：类赋值不会进 xlua_mappings，但会存 lua_aliases
        if (mappings.length === 0) {
            const aliases = this.cache.db.prepare(`
                SELECT * FROM lua_aliases
                WHERE original_cs_pattern LIKE ? OR alias_name LIKE ?
            `).all(`%${csharpFqn}%`, `%${csharpFqn}%`) as Record<string, unknown>[];

            if (aliases.length > 0) {
                return {
                    csharp: { fqn: csharpFqn },
                    lua: {
                        globalName: `CS.${csharpFqn}`,
                        callSites: aliases.map(a => ({
                            file: a.alias_file as string,
                            line: a.alias_line as number,
                            callerFqn: undefined,
                            pattern: `${a.alias_name} = ${a.original_cs_pattern}`,
                            status: 'alias',
                        })),
                    },
                };
            }
            return null;
        }

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

    // ===== 别名链解析 =====

    /**
     * 提取文件中的所有原始赋值（global + local），不做链解析
     */
    private extractRawAliases(filePath: string, content: string): RawAlias[] {
        const aliases: RawAlias[] = [];
        const seen = new Set<string>(); // 同文件同名去重（取最后一个赋值）
        let match;

        // global: varName = value.with.dots
        RAW_GLOBAL_ALIAS.lastIndex = 0;
        while ((match = RAW_GLOBAL_ALIAS.exec(content)) !== null) {
            const name = match[1];
            const value = match[2];
            // 过滤明显不是别名的赋值
            if (this.isLikelyAlias(name, value)) {
                seen.add(name);
                aliases.push({
                    name, value,
                    file: filePath,
                    line: this.getLineNumber(content, match.index),
                });
            }
        }

        // local: local varName = value.with.dots
        RAW_LOCAL_ALIAS.lastIndex = 0;
        while ((match = RAW_LOCAL_ALIAS.exec(content)) !== null) {
            const name = match[1];
            const value = match[2];
            if (this.isLikelyAlias(name, value) && !seen.has(name)) {
                aliases.push({
                    name, value,
                    file: filePath,
                    line: this.getLineNumber(content, match.index),
                });
            }
        }

        return aliases;
    }

    /**
     * 启发式判断赋值是否可能是 C# 别名：
     * - 值以 CS. 开头：肯定是
     * - 值首段首字母大写且包含至少一个点：很可能是
     * - 变量名以 C_/D_/E_/G_ 开头：XLua 项目约定
     */
    private isLikelyAlias(name: string, value: string): boolean {
        if (value.startsWith('CS.')) return true;
        // 必须包含至少一个点（排除 x = nil/true/someVar）
        if (!value.includes('.')) return false;
        const firstPart = value.split('.')[0];
        // 首段首字母大写（C# 命名空间约定）
        if (/^[A-Z]/.test(firstPart)) return true;
        // 变量名以常见 XLua 前缀开头
        if (/^[CDE]_/.test(name)) return true;
        return false;
    }

    /**
     * 迭代解析别名链：
     * 1. 直接 CS. 前缀的别名立即解析
     * 2. 非 CS. 前缀的别名，检查值首段是否已解析，若是则替换并解析
     * 3. 重复直到不再有新解析
     */
    private resolveAliasChains(rawAliases: RawAlias[]): Map<string, string> {
        const resolved = new Map<string, string>();
        let pending = rawAliases.slice();

        // Pass 0: 直接 CS. 前缀
        const stillPending: RawAlias[] = [];
        for (const alias of pending) {
            if (alias.value.startsWith('CS.')) {
                resolved.set(alias.name, alias.value);
            } else {
                stillPending.push(alias);
            }
        }
        pending = stillPending;

        // 迭代解析链（最多 10 轮防止循环引用）
        for (let round = 0; round < 10 && pending.length > 0; round++) {
            let changed = false;
            const nextPending: RawAlias[] = [];

            for (const alias of pending) {
                const firstDot = alias.value.indexOf('.');
                const firstPart = firstDot > 0 ? alias.value.substring(0, firstDot) : alias.value;
                const rest = firstDot > 0 ? alias.value.substring(firstDot) : '';

                if (resolved.has(firstPart)) {
                    const resolvedPrefix = resolved.get(firstPart)!;
                    resolved.set(alias.name, resolvedPrefix + rest);
                    changed = true;
                } else {
                    nextPending.push(alias);
                }
            }

            pending = nextPending;
            if (!changed) break;
        }

        return resolved;
    }

    // ===== 调用提取 =====

    /** 提取直接 CS. 调用 */
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

    /**
     * 通过别名表提取间接调用：
     * 对每个 identifier:method() 或 identifier.method()，
     * 如果 identifier 在 aliasLookup 中，记录为 C# 跨语言调用。
     * 跳过 UnityEngine/System 等引擎 API 别名（数千个 Vector3.new() 没有跟踪价值）
     *
     * fieldTypeLookup：GetComponent 动态绑定映射，当 aliasLookup 无匹配时作为 fallback。
     * 仅处理 isShortName=false（CS. 参数）的条目，短名无法确定完整命名空间。
     */
    private extractAliasCalls(
        filePath: string, content: string,
        aliasLookup: Map<string, string>,
        fieldTypeLookup?: Map<string, GetComponentField>,
    ): XLuaCall[] {
        const calls: XLuaCall[] = [];
        let match;
        ALIAS_CALL_PATTERN.lastIndex = 0;

        while ((match = ALIAS_CALL_PATTERN.exec(content)) !== null) {
            const varName = match[1];
            const methodName = match[2];

            // 跳过直接 CS. 调用（已被 extractCsCalls 处理）
            const prefixStart = Math.max(0, match.index - 3);
            const prefix = content.substring(prefixStart, match.index);
            if (prefix.endsWith('CS.')) continue;

            let className: string;
            const resolvedFqn = aliasLookup.get(varName);
            if (resolvedFqn) {
                className = resolvedFqn.replace(/^CS\./, '');
            } else if (fieldTypeLookup) {
                // GetComponent 动态绑定 fallback（仅 CS. 参数，短名跳过）
                const gcf = fieldTypeLookup.get(varName);
                if (!gcf || gcf.isShortName) continue;
                className = gcf.typeName;
            } else {
                continue;
            }

            // 跳过引擎/框架 API 别名（只跟踪项目自有类）
            if (this.isBuiltinNamespace(className)) continue;

            const line = this.getLineNumber(content, match.index);
            const separator = match[0].includes(':') ? ':' : '.';

            calls.push({
                pattern: `${varName}${separator}${methodName}`,
                className,
                memberName: methodName,
                file: filePath,
                line,
            });
        }

        return calls;
    }

    /**
     * 提取文件中的 GetComponent 动态绑定：
     * self.fieldName = xxx:GetComponent("TypeName")  → isShortName=true
     * self.fieldName = xxx:GetComponent(CS.Type)     → isShortName=false
     */
    private extractGetComponentFields(filePath: string, content: string): GetComponentField[] {
        const fields: GetComponentField[] = [];
        let match;
        GETCOMPONENT_PATTERN.lastIndex = 0;

        while ((match = GETCOMPONENT_PATTERN.exec(content)) !== null) {
            const fieldName = match[1];
            const stringArg = match[2]; // "TypeName" 形式
            const csArg = match[3];     // CS.Type 形式

            if (csArg) {
                fields.push({
                    fieldName,
                    typeName: csArg,  // 已去掉 CS. 前缀
                    isShortName: false,
                    file: filePath,
                    line: this.getLineNumber(content, match.index),
                });
            } else if (stringArg) {
                fields.push({
                    fieldName,
                    typeName: stringArg,
                    isShortName: true,
                    file: filePath,
                    line: this.getLineNumber(content, match.index),
                });
            }
        }

        return fields;
    }

    /**
     * 对 GetComponent 短名字段，尝试通过 workspaceSymbol 查找唯一匹配的 C# 类型，
     * 解析出完整 FQN。只有唯一匹配时才确定，多匹配/无匹配/LSP 不可用时跳过。
     *
     * 会就地修改 fieldTypeLookup 中对应条目的 typeName 和 isShortName。
     */
    async resolveGetComponentShortNames(
        fieldTypeLookup: Map<string, GetComponentField>,
    ): Promise<void> {
        const csharpClient = this.lspManager.getClientForLanguage('csharp');
        if (csharpClient.state !== 'ready') {
            console.error('[CSG] resolveGetComponentShortNames: csharp LSP not ready, skipping');
            return;
        }

        // 收集所有 isShortName=true 的唯一短名
        const shortNameFields = new Map<string, GetComponentField[]>();
        for (const [, field] of fieldTypeLookup) {
            if (field.isShortName) {
                if (!shortNameFields.has(field.typeName)) {
                    shortNameFields.set(field.typeName, []);
                }
                shortNameFields.get(field.typeName)!.push(field);
            }
        }

        if (shortNameFields.size === 0) return;

        const shortNames = [...shortNameFields.keys()];
        let resolvedCount = 0;

        // SymbolKind: Class=5, Enum=10, Interface=11, Struct=23
        const TYPE_KINDS = new Set([5, 10, 11, 23]);

        const CONCURRENCY = 8;
        for (let i = 0; i < shortNames.length; i += CONCURRENCY) {
            const batch = shortNames.slice(i, i + CONCURRENCY);
            const results = await Promise.allSettled(
                batch.map(name => csharpClient.workspaceSymbol(name)),
            );

            for (let j = 0; j < batch.length; j++) {
                const shortName = batch[j];
                const r = results[j];
                if (r.status !== 'fulfilled') continue;

                const symbols = r.value;

                // 筛选：只保留类型符号（Class/Struct/Enum/Interface），且名字精确匹配短名
                const typeMatches = symbols.filter(s => {
                    if (!TYPE_KINDS.has(s.kind)) return false;

                    // csharp-ls containerName 常为 null，name 可能是 "ClassName" 或
                    // 带命名空间的格式。我们需要精确匹配短名。
                    const symName = s.name;
                    // 精确匹配：name 就是短名
                    if (symName === shortName) return true;
                    // csharp-ls 可能返回 "Namespace.ClassName" 格式
                    if (symName.endsWith(`.${shortName}`)) return true;
                    return false;
                });

                if (typeMatches.length === 1) {
                    // 唯一匹配 → 解析 FQN
                    const sym = typeMatches[0];
                    // csharp-ls containerName 通常为 null，name 可能是 "ClassName" 或 "Namespace.ClassName"
                    const containerNorm = sym.containerName?.replace(/:/g, '.') || '';
                    let fqn: string;
                    if (containerNorm) {
                        fqn = `${containerNorm}.${sym.name}`;
                    } else if (sym.name.includes('.')) {
                        // name 自带命名空间（如 "Game.GotoMask"）
                        fqn = sym.name;
                    } else {
                        // 只有短名，无法确定完整 FQN，跳过
                        continue;
                    }

                    // 更新 fieldTypeLookup 中所有使用该短名的条目
                    const fields = shortNameFields.get(shortName)!;
                    for (const field of fields) {
                        field.typeName = fqn;
                        field.isShortName = false;
                    }
                    resolvedCount++;
                }
                // 多匹配或无匹配 → 跳过
            }
        }

        console.error(`[CSG] resolveGetComponentShortNames: resolved ${resolvedCount}/${shortNameFields.size} short names`);
    }

    /** 判断是否引擎/框架命名空间（不需要跟踪跨语言调用） */
    private isBuiltinNamespace(className: string): boolean {
        const topNs = className.split('.')[0];
        return UNITY_NS.includes(topNs) || DOTNET_NS.includes(topNs) ||
            this.thirdPartyNs.includes(topNs);
    }

    /** 按 file:line:className.memberName 去重 */
    private deduplicateCalls(calls: XLuaCall[]): XLuaCall[] {
        const seen = new Set<string>();
        const result: XLuaCall[] = [];
        for (const call of calls) {
            const key = `${call.file}:${call.line}:${call.className}.${call.memberName}`;
            if (!seen.has(key)) {
                seen.add(key);
                result.push(call);
            }
        }
        return result;
    }

    // ===== 批量验证 =====

    /**
     * Verify XLua calls by querying workspace/symbol for each unique member name,
     * then matching the symbol's containerName against the expected className.
     */
    private async batchVerifyWithCSharp(
        calls: XLuaCall[],
    ): Promise<Map<string, VerifiedSymbol>> {
        const result = new Map<string, VerifiedSymbol>();

        const csharpClient = this.lspManager.getClientForLanguage('csharp');
        if (csharpClient.state !== 'ready') return result;

        // Deduplicate by className.memberName
        const uniquePairs = new Map<string, XLuaCall>();
        for (const call of calls) {
            const key = `${call.className}.${call.memberName}`;
            if (!uniquePairs.has(key)) uniquePairs.set(key, call);
        }

        // Query workspaceSymbol for each unique member name (parallel, deduplicated)
        const uniqueMembers = new Set<string>();
        for (const [, call] of uniquePairs) uniqueMembers.add(call.memberName);

        const queriedMembers = new Map<string, SymbolInformation[]>();
        const memberList = [...uniqueMembers];
        const CONCURRENCY = 8;
        for (let i = 0; i < memberList.length; i += CONCURRENCY) {
            const batch = memberList.slice(i, i + CONCURRENCY);
            const results = await Promise.allSettled(
                batch.map(m => csharpClient.workspaceSymbol(m)),
            );
            for (let j = 0; j < batch.length; j++) {
                const r = results[j];
                queriedMembers.set(batch[j], r.status === 'fulfilled' ? r.value : []);
            }
        }

        for (const [key, call] of uniquePairs) {
            const symbols = queriedMembers.get(call.memberName) || [];
            const shortClassName = call.className.split('.').pop()!;

            const matched = symbols.find(s => {
                // csharp-ls returns name in format: "ReturnType Container.Member(params)"
                // containerName is often null, so we parse the name field.
                const container = s.containerName ?? '';
                let memberName = s.name;

                if (!container) {
                    // Parse "ReturnType Container.Member(params)" or "Type Container.field"
                    const parsed = this.parseCsharpLsSymbolName(s.name);
                    if (parsed) {
                        memberName = parsed.member;
                        // Check member name AND container
                        if (memberName !== call.memberName) return false;
                        return parsed.container === shortClassName ||
                            parsed.container.endsWith(shortClassName) ||
                            call.className.endsWith(parsed.container);
                    }
                    return false;
                }

                // Standard LSP: containerName is set
                if (memberName !== call.memberName) return false;
                if (container === call.className) return true;
                if (container.endsWith(shortClassName)) return true;
                if (call.className.endsWith(container) && container.length > 0) return true;
                return false;
            });

            if (matched) {
                result.set(key, {
                    fqn: key,
                    file: uriToRelative(this.workspaceRoot, matched.location.uri),
                    line: matched.location.range.start.line + 1,
                });
            }
        }

        if (result.size > 0 || uniquePairs.size > 0) {
            console.error(`[CSG] xlua verify: ${uniquePairs.size} unique pairs, ${queriedMembers.size} member queries, ${result.size} verified`);
        }

        return result;
    }

    /**
     * Parse csharp-ls workspace/symbol name format: "ReturnType Container.Member(params)"
     * Examples:
     *   "bool SafeAreaDebugOverlay.IsShowing()" → { container: "SafeAreaDebugOverlay", member: "IsShowing" }
     *   "void GpuHudFacade.SetGpuHudAsset(List<GpuHudAsset> assets)" → { container: "GpuHudFacade", member: "SetGpuHudAsset" }
     *   "GPUInstancingManager GPUInstancingManager.GetInstance()" → { container: "GPUInstancingManager", member: "GetInstance" }
     */
    private parseCsharpLsSymbolName(name: string): { container: string; member: string } | null {
        // Match: "anything Container.Member" or "anything Container.Member(..."
        const match = name.match(/\s([\w.]+)\.([\w]+)\s*(?:\(|$)/);
        if (match) {
            return { container: match[1], member: match[2] };
        }
        // Simple format without return type: "Container.Member(..." or "Container.Member"
        const simpleMatch = name.match(/^([\w.]+)\.([\w]+)\s*(?:\(|$)/);
        if (simpleMatch) {
            return { container: simpleMatch[1], member: simpleMatch[2] };
        }
        return null;
    }

    // ===== 辅助方法 =====

    private async enrichCallerInfo(calls: XLuaCall[]): Promise<void> {
        const luaLs = this.lspManager.getClientForLanguage('lua');
        if (luaLs.state !== 'ready') return;

        const byFile = new Map<string, XLuaCall[]>();
        for (const call of calls) {
            if (!byFile.has(call.file)) byFile.set(call.file, []);
            byFile.get(call.file)!.push(call);
        }

        const files = [...byFile.entries()];
        const CONCURRENCY = 8;
        for (let i = 0; i < files.length; i += CONCURRENCY) {
            const batch = files.slice(i, i + CONCURRENCY);
            await Promise.allSettled(
                batch.map(async ([file, fileCalls]) => {
                    const uri = relativeToUri(this.luaRoot, file);
                    const symbols = await luaLs.documentSymbol(uri);
                    for (const call of fileCalls) {
                        call.callerFqn = this.findEnclosingSymbol(
                            symbols as import('vscode-languageserver-protocol').DocumentSymbol[], call.line,
                        );
                    }
                }),
            );
        }
    }

    private findEnclosingSymbol(
        symbols: import('vscode-languageserver-protocol').DocumentSymbol[],
        line: number,
    ): string | undefined {
        for (const sym of symbols) {
            if (sym.range &&
                sym.range.start.line <= line - 1 &&
                sym.range.end.line >= line - 1) {
                if (sym.children) {
                    const inner = this.findEnclosingSymbol(sym.children, line);
                    if (inner) return inner;
                }
                return sym.name;
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
