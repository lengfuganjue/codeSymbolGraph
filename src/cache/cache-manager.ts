import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';

/** 引用缓存 TTL（毫秒） */
const REFERENCE_CACHE_TTL_MS = 60 * 1000;

/** 调用链缓存 TTL（毫秒） */
const CALL_CHAIN_CACHE_TTL_MS = 120 * 1000;

export class CacheManager {
    private _db: Database.Database;
    private memCache: LRUCache<string, object>;

    constructor(dbPath: string) {
        this._db = new Database(dbPath);
        this._db.pragma('journal_mode = WAL');
        this._db.pragma('synchronous = NORMAL');
        this._db.pragma('cache_size = -64000');

        this.memCache = new LRUCache({
            max: 5000,
            ttl: 1000 * 60 * 10, // 10 minutes
        });

        this.initSchema();
    }

    get db(): Database.Database { return this._db; }

    // ===== 符号缓存 =====

    findSymbols(query: {
        name?: string;
        fqn?: string;
        filePath?: string;
        kind?: number;
        fuzzy?: boolean;
        limit?: number;
    }): CachedSymbol[] | null {
        const cacheKey = `sym:${JSON.stringify(query)}`;

        const memResult = this.memCache.get(cacheKey);
        if (memResult) return memResult as CachedSymbol[];

        let sql = 'SELECT * FROM symbol_cache WHERE 1=1';
        const params: unknown[] = [];

        if (query.fqn) {
            sql += ' AND fqn = ?';
            params.push(query.fqn);
        } else if (query.name && query.fuzzy) {
            const ftsResults = this._db.prepare(
                `SELECT rowid FROM symbol_fts WHERE symbol_fts MATCH ?`,
            ).all(this.escapeFtsQuery(query.name) + '*') as { rowid: number }[];

            if (ftsResults.length === 0) return null;

            const ids = ftsResults.map(r => r.rowid);
            sql += ` AND id IN (${ids.map(() => '?').join(',')})`;
            params.push(...ids);
        } else if (query.name) {
            sql += ' AND name = ?';
            params.push(query.name);
        }

        if (query.filePath) {
            sql += ' AND file_path = ?';
            params.push(query.filePath);
        }

        if (query.kind) {
            sql += ' AND kind = ?';
            params.push(query.kind);
        }

        sql += ' ORDER BY stale ASC, cached_at DESC';
        sql += ` LIMIT ?`;
        params.push(query.limit || 10);

        const results = this._db.prepare(sql).all(...params) as CachedSymbol[];

        if (results.length > 0) {
            this.memCache.set(cacheKey, results);
            return results;
        }

        return null;
    }

    cacheSymbols(fileHash: string, symbols: CachedSymbol[]): void {
        const insert = this._db.prepare(`
            INSERT OR REPLACE INTO symbol_cache
            (content_hash, file_path, name, fqn, kind, language,
             container_name, range_start_line, range_start_char,
             range_end_line, range_end_char, signature, doc_comment, cached_at, stale)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `);

        const transaction = this._db.transaction((syms: CachedSymbol[]) => {
            for (const s of syms) {
                insert.run(
                    fileHash, s.file_path, s.name, s.fqn, s.kind, s.language,
                    s.container_name ?? null,
                    s.range_start_line, s.range_start_char,
                    s.range_end_line, s.range_end_char,
                    s.signature ?? null, s.doc_comment ?? null,
                    Date.now(),
                );
            }
        });

        transaction(symbols);
    }

    // ===== 引用缓存 =====

    findReferences(targetFqn: string): CachedReference[] | null {
        const cacheKey = `ref:${targetFqn}`;
        const memResult = this.memCache.get(cacheKey);
        if (memResult) return memResult as CachedReference[];

        const cutoff = Date.now() - REFERENCE_CACHE_TTL_MS;
        const results = this._db.prepare(`
            SELECT * FROM reference_cache
            WHERE target_fqn = ? AND cached_at > ?
            ORDER BY ref_file, ref_line
        `).all(targetFqn, cutoff) as CachedReference[];

        if (results.length > 0) {
            this.memCache.set(cacheKey, results);
            return results;
        }

        return null;
    }

    cacheReferences(
        targetFqn: string,
        targetLoc: { file: string; line: number; char: number },
        refs: CachedReference[],
    ): void {
        const insert = this._db.prepare(`
            INSERT INTO reference_cache
            (target_fqn, target_file, target_line, target_char,
             ref_file, ref_line, ref_char, cached_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const transaction = this._db.transaction((references: CachedReference[]) => {
            this._db.prepare('DELETE FROM reference_cache WHERE target_fqn = ?')
                .run(targetFqn);

            for (const r of references) {
                insert.run(
                    targetFqn, targetLoc.file, targetLoc.line, targetLoc.char,
                    r.ref_file, r.ref_line, r.ref_char, Date.now(),
                );
            }
        });

        transaction(refs);
    }

    // ===== 缓存失效 =====

    invalidateFile(filePath: string): void {
        this._db.prepare(
            'UPDATE symbol_cache SET stale = 1 WHERE file_path = ?',
        ).run(filePath);

        if (filePath.endsWith('.lua')) {
            this._db.prepare(
                `UPDATE xlua_mappings SET status = 'pending' WHERE lua_file = ?`,
            ).run(filePath);
        }

        this.invalidateMemCacheForFile(filePath);
    }

    private invalidateMemCacheForFile(filePath: string): void {
        for (const key of this.memCache.keys()) {
            if (key.includes(filePath)) {
                this.memCache.delete(key);
            }
        }
        for (const key of this.memCache.keys()) {
            if (key.startsWith('ref:')) {
                this.memCache.delete(key);
            }
        }
    }

    cleanup(): void {
        const symCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        this._db.prepare('DELETE FROM symbol_cache WHERE stale = 1 AND cached_at < ?')
            .run(symCutoff);

        const refCutoff = Date.now() - 60 * 60 * 1000;
        this._db.prepare('DELETE FROM reference_cache WHERE cached_at < ?')
            .run(refCutoff);

        this._db.prepare('DELETE FROM call_chain_cache WHERE cached_at < ?')
            .run(refCutoff);
    }

    static computeFileHash(content: string): string {
        return createHash('sha256').update(content).digest('hex').substring(0, 16);
    }

    getStats(): CacheStats {
        const symbolCount = (this._db.prepare(
            'SELECT COUNT(*) as c FROM symbol_cache WHERE stale = 0',
        ).get() as { c: number }).c;
        const refCount = (this._db.prepare(
            'SELECT COUNT(*) as c FROM reference_cache',
        ).get() as { c: number }).c;
        const xluaCount = (this._db.prepare(
            'SELECT COUNT(*) as c FROM xlua_mappings',
        ).get() as { c: number }).c;
        const xluaVerified = (this._db.prepare(
            `SELECT COUNT(*) as c FROM xlua_mappings WHERE status = 'verified'`,
        ).get() as { c: number }).c;

        return {
            symbols: symbolCount,
            references: refCount,
            xluaMappings: xluaCount,
            xluaVerified,
            memCacheSize: this.memCache.size,
        };
    }

    close(): void {
        this._db.close();
    }

    private escapeFtsQuery(query: string): string {
        // FTS5 中 . " ' \ * 等需要转义，将 . 替换为空格（FTS5 隐式 AND）
        return query.replace(/['"\\*.]/g, ' ').trim();
    }

    private initSchema(): void {
        this._db.exec(`
            CREATE TABLE IF NOT EXISTS files (
                relative_path TEXT NOT NULL,
                worktree_id TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                mtime INTEGER NOT NULL,
                size INTEGER NOT NULL,
                language TEXT NOT NULL,
                last_indexed_at INTEGER,
                PRIMARY KEY (relative_path, worktree_id)
            );

            CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);

            CREATE TABLE IF NOT EXISTS symbol_cache (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content_hash TEXT NOT NULL,
                file_path TEXT NOT NULL,
                name TEXT NOT NULL,
                fqn TEXT NOT NULL,
                kind INTEGER NOT NULL,
                language TEXT NOT NULL,
                container_name TEXT,
                range_start_line INTEGER NOT NULL,
                range_start_char INTEGER NOT NULL,
                range_end_line INTEGER NOT NULL,
                range_end_char INTEGER NOT NULL,
                signature TEXT,
                doc_comment TEXT,
                cached_at INTEGER NOT NULL,
                stale INTEGER DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_sym_hash ON symbol_cache(content_hash);
            CREATE INDEX IF NOT EXISTS idx_sym_name ON symbol_cache(name);
            CREATE INDEX IF NOT EXISTS idx_sym_fqn ON symbol_cache(fqn);
            CREATE INDEX IF NOT EXISTS idx_sym_file ON symbol_cache(file_path);

            CREATE VIRTUAL TABLE IF NOT EXISTS symbol_fts USING fts5(
                name,
                fqn,
                signature,
                content='symbol_cache',
                content_rowid='id'
            );

            CREATE TABLE IF NOT EXISTS reference_cache (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                target_fqn TEXT NOT NULL,
                target_file TEXT NOT NULL,
                target_line INTEGER NOT NULL,
                target_char INTEGER NOT NULL,
                ref_file TEXT NOT NULL,
                ref_line INTEGER NOT NULL,
                ref_char INTEGER NOT NULL,
                cached_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_ref_target ON reference_cache(target_fqn);
            CREATE INDEX IF NOT EXISTS idx_ref_cached ON reference_cache(cached_at);

            CREATE TABLE IF NOT EXISTS call_chain_cache (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                root_fqn TEXT NOT NULL,
                root_file TEXT NOT NULL,
                root_line INTEGER NOT NULL,
                direction TEXT NOT NULL,
                depth INTEGER NOT NULL,
                result_json TEXT NOT NULL,
                cached_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_cc_root ON call_chain_cache(root_fqn);
            CREATE INDEX IF NOT EXISTS idx_cc_cached ON call_chain_cache(cached_at);

            CREATE TABLE IF NOT EXISTS xlua_mappings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                lua_call_pattern TEXT NOT NULL,
                lua_file TEXT NOT NULL,
                lua_line INTEGER NOT NULL,
                lua_caller_fqn TEXT,
                lua_file_hash TEXT NOT NULL,
                csharp_fqn TEXT,
                csharp_file TEXT,
                csharp_line INTEGER,
                csharp_signature TEXT,
                status TEXT DEFAULT 'pending',
                verified_at INTEGER,
                UNIQUE(lua_call_pattern, lua_file, lua_line)
            );

            CREATE INDEX IF NOT EXISTS idx_xlua_lua ON xlua_mappings(lua_call_pattern);
            CREATE INDEX IF NOT EXISTS idx_xlua_csharp ON xlua_mappings(csharp_fqn);
            CREATE INDEX IF NOT EXISTS idx_xlua_lua_file ON xlua_mappings(lua_file);

            CREATE TABLE IF NOT EXISTS lua_aliases (
                alias_name TEXT NOT NULL,
                alias_file TEXT NOT NULL,
                alias_line INTEGER NOT NULL,
                original_cs_pattern TEXT NOT NULL,
                file_hash TEXT NOT NULL,
                PRIMARY KEY (alias_name, alias_file, alias_line)
            );

            CREATE INDEX IF NOT EXISTS idx_alias_file ON lua_aliases(alias_file);

            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            INSERT OR IGNORE INTO meta (key, value) VALUES
                ('schema_version', '3'),
                ('created_at', datetime('now'));
        `);

        // FTS triggers - use separate exec since IF NOT EXISTS not supported for triggers
        // Check if triggers exist first
        const triggerExists = this._db.prepare(
            `SELECT name FROM sqlite_master WHERE type='trigger' AND name='symbol_fts_insert'`,
        ).get();

        if (!triggerExists) {
            this._db.exec(`
                CREATE TRIGGER symbol_fts_insert AFTER INSERT ON symbol_cache BEGIN
                    INSERT INTO symbol_fts(rowid, name, fqn, signature)
                    VALUES (new.id, new.name, new.fqn, new.signature);
                END;

                CREATE TRIGGER symbol_fts_delete AFTER DELETE ON symbol_cache BEGIN
                    INSERT INTO symbol_fts(symbol_fts, rowid, name, fqn, signature)
                    VALUES('delete', old.id, old.name, old.fqn, old.signature);
                END;

                CREATE TRIGGER symbol_fts_update AFTER UPDATE ON symbol_cache BEGIN
                    INSERT INTO symbol_fts(symbol_fts, rowid, name, fqn, signature)
                    VALUES('delete', old.id, old.name, old.fqn, old.signature);
                    INSERT INTO symbol_fts(rowid, name, fqn, signature)
                    VALUES (new.id, new.name, new.fqn, new.signature);
                END;
            `);
        }
    }
}

// ===== 类型定义 =====

export interface CachedSymbol {
    id?: number;
    content_hash: string;
    file_path: string;
    name: string;
    fqn: string;
    kind: number;
    language: string;
    container_name?: string;
    range_start_line: number;
    range_start_char: number;
    range_end_line: number;
    range_end_char: number;
    signature?: string;
    doc_comment?: string;
    cached_at: number;
    stale: number;
}

export interface CachedReference {
    ref_file: string;
    ref_line: number;
    ref_char: number;
    cached_at: number;
}

export interface CacheStats {
    symbols: number;
    references: number;
    xluaMappings: number;
    xluaVerified: number;
    memCacheSize: number;
}
