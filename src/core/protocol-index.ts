/**
 * 协议/配置表索引。
 * 解析 EmmyLuaAnnotations 目录中的注解文件，提取 @class 和 @field 定义。
 */
import * as fs from 'fs/promises';
import * as path from 'path';

export interface ProtocolField {
    name: string;
    type: string;
    comment: string;
}

export interface ProtocolClass {
    name: string;
    comment: string;
    source: 'proto' | 'config' | 'flatbuffers';
    file: string;
    line: number;
    fields: ProtocolField[];
}

const CLASS_RE = /^---@class\s+(\S+)(?:\s+(.*))?$/;
const FIELD_RE = /^---@field\s+public\s+(\S+)\s+(\S+)(?:\s+(.*))?$/;

function detectSource(fileName: string): ProtocolClass['source'] {
    const lower = fileName.toLowerCase();
    if (lower.includes('protocol')) return 'proto';
    if (lower.includes('generated')) return 'flatbuffers';
    return 'config';
}

export class ProtocolIndex {
    private classes = new Map<string, ProtocolClass>();
    /** 小写类名 → 原始类名 */
    private lowerClassMap = new Map<string, string[]>();
    /** 小写字段名 → 所属类名列表 */
    private fieldToClass = new Map<string, string[]>();
    private loaded = false;
    private annotationsDir = '';

    async load(annotationsDir: string): Promise<void> {
        this.annotationsDir = annotationsDir;
        this.classes.clear();
        this.lowerClassMap.clear();
        this.fieldToClass.clear();

        let entries: string[];
        try {
            entries = await fs.readdir(annotationsDir);
        } catch {
            this.loaded = false;
            return;
        }

        const luaFiles = entries.filter(e => e.endsWith('.lua'));
        for (const file of luaFiles) {
            const filePath = path.join(annotationsDir, file);
            await this.parseFile(filePath, file);
        }

        // 也扫描 LuaAPI 子目录
        const luaApiDir = path.join(annotationsDir, 'LuaAPI');
        try {
            const apiEntries = await fs.readdir(luaApiDir);
            for (const file of apiEntries.filter(e => e.endsWith('.lua'))) {
                const filePath = path.join(luaApiDir, file);
                await this.parseFile(filePath, `LuaAPI/${file}`);
            }
        } catch { /* LuaAPI dir may not exist */ }

        this.loaded = true;
    }

    private async parseFile(filePath: string, relativeFile: string): Promise<void> {
        let content: string;
        try {
            content = await fs.readFile(filePath, 'utf-8');
        } catch {
            return;
        }

        const source = detectSource(relativeFile);
        const lines = content.split(/\r?\n/);

        let currentClass: ProtocolClass | null = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            const classMatch = CLASS_RE.exec(line);
            if (classMatch) {
                // 保存上一个 class
                if (currentClass) {
                    this.registerClass(currentClass);
                }
                currentClass = {
                    name: classMatch[1],
                    comment: classMatch[2]?.trim() || '',
                    source,
                    file: relativeFile,
                    line: i + 1,
                    fields: [],
                };
                continue;
            }

            const fieldMatch = FIELD_RE.exec(line);
            if (fieldMatch && currentClass) {
                currentClass.fields.push({
                    name: fieldMatch[1],
                    type: fieldMatch[2],
                    comment: fieldMatch[3]?.trim() || '',
                });

                // 建立字段 → 类的索引
                const lowerField = fieldMatch[1].toLowerCase();
                const existing = this.fieldToClass.get(lowerField);
                if (existing) {
                    if (!existing.includes(currentClass.name)) existing.push(currentClass.name);
                } else {
                    this.fieldToClass.set(lowerField, [currentClass.name]);
                }
                continue;
            }

            // 遇到非注解行，结束当前 class 解析
            if (currentClass && !line.startsWith('---')) {
                this.registerClass(currentClass);
                currentClass = null;
            }
        }

        // 文件末尾的 class
        if (currentClass) {
            this.registerClass(currentClass);
        }
    }

    private registerClass(cls: ProtocolClass): void {
        this.classes.set(cls.name, cls);
        const lower = cls.name.toLowerCase();
        const existing = this.lowerClassMap.get(lower);
        if (existing) {
            if (!existing.includes(cls.name)) existing.push(cls.name);
        } else {
            this.lowerClassMap.set(lower, [cls.name]);
        }
    }

    async reload(): Promise<void> {
        if (this.annotationsDir) {
            await this.load(this.annotationsDir);
        }
    }

    get isLoaded(): boolean {
        return this.loaded;
    }

    get size(): number {
        return this.classes.size;
    }

    find(query: string, field?: string): ProtocolClass[] {
        if (!this.loaded) return [];

        // 按字段名搜索
        if (field) {
            const lowerField = field.toLowerCase();
            const classNames = this.fieldToClass.get(lowerField);
            if (!classNames) return [];
            return classNames
                .map(n => this.classes.get(n))
                .filter((c): c is ProtocolClass => !!c)
                .slice(0, 20);
        }

        // 按类名搜索
        if (!query) return [];
        const lowerQuery = query.toLowerCase();

        // 精确匹配
        const exactNames = this.lowerClassMap.get(lowerQuery);
        if (exactNames) {
            return exactNames
                .map(n => this.classes.get(n))
                .filter((c): c is ProtocolClass => !!c);
        }

        // 子串匹配
        const results: ProtocolClass[] = [];
        for (const [lower, names] of this.lowerClassMap) {
            if (lower.includes(lowerQuery)) {
                for (const name of names) {
                    const cls = this.classes.get(name);
                    if (cls) results.push(cls);
                }
            }
            if (results.length >= 20) break;
        }

        return results.slice(0, 20);
    }
}
