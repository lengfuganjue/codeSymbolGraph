/**
 * 资源名反查索引。
 * 解析 AssetsNameToolCacheFile.txt，格式：奇数行=短名称，偶数行=\t完整路径。
 */
import * as fs from 'fs/promises';

export interface AssetEntry {
    shortName: string;
    fullPaths: string[];
}

export class AssetIndex {
    private nameToPath = new Map<string, string[]>();
    /** 小写名 → 原始名 的映射，用于忽略大小写匹配 */
    private lowerNameMap = new Map<string, string[]>();
    private loaded = false;
    private filePath = '';

    async load(filePath: string): Promise<void> {
        this.filePath = filePath;
        this.nameToPath.clear();
        this.lowerNameMap.clear();

        let content: string;
        try {
            content = await fs.readFile(filePath, 'utf-8');
        } catch {
            this.loaded = false;
            return;
        }

        const lines = content.split(/\r?\n/);
        for (let i = 0; i + 1 < lines.length; i += 2) {
            const name = lines[i].trim();
            const fullPath = lines[i + 1].replace(/^\t/, '').trim();
            if (!name || !fullPath) continue;

            const existing = this.nameToPath.get(name);
            if (existing) {
                existing.push(fullPath);
            } else {
                this.nameToPath.set(name, [fullPath]);
            }

            const lower = name.toLowerCase();
            const lowerExisting = this.lowerNameMap.get(lower);
            if (lowerExisting) {
                if (!lowerExisting.includes(name)) lowerExisting.push(name);
            } else {
                this.lowerNameMap.set(lower, [name]);
            }
        }

        this.loaded = true;
    }

    async reload(): Promise<void> {
        if (this.filePath) {
            await this.load(this.filePath);
        }
    }

    get isLoaded(): boolean {
        return this.loaded;
    }

    get size(): number {
        return this.nameToPath.size;
    }

    find(query: string): AssetEntry[] {
        if (!this.loaded || !query) return [];

        // 1. 精确匹配（忽略大小写）
        const lowerQuery = query.toLowerCase();
        const exactNames = this.lowerNameMap.get(lowerQuery);
        if (exactNames) {
            return exactNames.map(name => ({
                shortName: name,
                fullPaths: this.nameToPath.get(name) || [],
            }));
        }

        // 2. 子串匹配
        const results: AssetEntry[] = [];
        for (const [lower, names] of this.lowerNameMap) {
            if (lower.includes(lowerQuery)) {
                for (const name of names) {
                    results.push({
                        shortName: name,
                        fullPaths: this.nameToPath.get(name) || [],
                    });
                }
            }
            if (results.length >= 20) break;
        }

        return results.slice(0, 20);
    }
}
