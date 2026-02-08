import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CacheManager, type CachedSymbol } from '../../src/cache/cache-manager.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function makeTempDb(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-test-'));
    return path.join(dir, 'test.db');
}

function makeSymbol(overrides: Partial<CachedSymbol> = {}): CachedSymbol {
    return {
        content_hash: 'abc123',
        file_path: 'Assets/Scripts/Player.cs',
        name: 'Player',
        fqn: 'Game.Player',
        kind: 5, // Class
        language: 'csharp',
        container_name: 'Game',
        range_start_line: 10,
        range_start_char: 0,
        range_end_line: 50,
        range_end_char: 1,
        cached_at: Date.now(),
        stale: 0,
        ...overrides,
    };
}

describe('CacheManager', () => {
    let dbPath: string;
    let cache: CacheManager;

    beforeEach(() => {
        dbPath = makeTempDb();
        cache = new CacheManager(dbPath);
    });

    afterEach(() => {
        cache.close();
        try { fs.unlinkSync(dbPath); } catch {}
        try { fs.rmdirSync(path.dirname(dbPath)); } catch {}
    });

    describe('schema initialization', () => {
        it('should create tables without error', () => {
            const stats = cache.getStats();
            expect(stats.symbols).toBe(0);
            expect(stats.references).toBe(0);
            expect(stats.xluaMappings).toBe(0);
        });

        it('should be idempotent', () => {
            // Creating another CacheManager on the same db should not fail
            const cache2 = new CacheManager(dbPath);
            expect(cache2.getStats().symbols).toBe(0);
            cache2.close();
        });
    });

    describe('cacheSymbols / findSymbols', () => {
        it('should store and retrieve symbols by name', () => {
            cache.cacheSymbols('hash1', [makeSymbol()]);

            const results = cache.findSymbols({ name: 'Player' });
            expect(results).not.toBeNull();
            expect(results!.length).toBe(1);
            expect(results![0].name).toBe('Player');
            expect(results![0].fqn).toBe('Game.Player');
        });

        it('should retrieve symbols by fqn', () => {
            cache.cacheSymbols('hash1', [makeSymbol()]);

            const results = cache.findSymbols({ fqn: 'Game.Player' });
            expect(results).not.toBeNull();
            expect(results![0].fqn).toBe('Game.Player');
        });

        it('should retrieve symbols by filePath', () => {
            cache.cacheSymbols('hash1', [makeSymbol()]);

            const results = cache.findSymbols({ filePath: 'Assets/Scripts/Player.cs' });
            expect(results).not.toBeNull();
            expect(results!.length).toBe(1);
        });

        it('should retrieve symbols by kind', () => {
            cache.cacheSymbols('hash1', [
                makeSymbol({ kind: 5, name: 'PlayerClass' }),
                makeSymbol({ kind: 6, name: 'Move', fqn: 'Game.Player.Move' }),
            ]);

            const results = cache.findSymbols({ kind: 6 });
            expect(results).not.toBeNull();
            expect(results!.length).toBe(1);
            expect(results![0].name).toBe('Move');
        });

        it('should return null when no match', () => {
            const results = cache.findSymbols({ name: 'NonExistent' });
            expect(results).toBeNull();
        });

        it('should order stale results after fresh', () => {
            cache.cacheSymbols('hash1', [makeSymbol({ name: 'A', fqn: 'A' })]);
            cache.cacheSymbols('hash2', [makeSymbol({ name: 'A', fqn: 'A', stale: 1 } as any)]);

            // Manually mark one stale
            cache.db.prepare('UPDATE symbol_cache SET stale = 1 WHERE content_hash = ?').run('hash1');

            // Insert a fresh one
            cache.cacheSymbols('hash3', [makeSymbol({ name: 'A', fqn: 'A' })]);

            const results = cache.findSymbols({ name: 'A' });
            expect(results).not.toBeNull();
            // Fresh (stale=0) should come first
            expect(results![0].stale).toBe(0);
        });

        it('should respect limit parameter', () => {
            const symbols = Array.from({ length: 20 }, (_, i) =>
                makeSymbol({ name: `Sym${i}`, fqn: `NS.Sym${i}`, content_hash: `h${i}` }),
            );
            cache.cacheSymbols('multi', symbols);

            const results = cache.findSymbols({ limit: 3 });
            // Without specific query, all 20 match - but limit 3
            expect(results).not.toBeNull();
            expect(results!.length).toBe(3);
        });

        it('should support fuzzy search via FTS (prefix matching)', () => {
            cache.cacheSymbols('hash1', [
                makeSymbol({ name: 'PlayerManager', fqn: 'Game.PlayerManager' }),
                makeSymbol({ name: 'PlayerController', fqn: 'Game.PlayerController' }),
                makeSymbol({ name: 'Enemy', fqn: 'Game.Enemy' }),
            ]);

            // FTS5 prefix search: "Player*" matches PlayerManager and PlayerController
            const results = cache.findSymbols({ name: 'Player', fuzzy: true });
            expect(results).not.toBeNull();
            expect(results!.length).toBe(2);
            expect(results!.every(r => r.name.startsWith('Player'))).toBe(true);
        });
    });

    describe('cacheReferences / findReferences', () => {
        it('should store and retrieve references within TTL', () => {
            cache.cacheReferences(
                'Game.Player',
                { file: 'Player.cs', line: 10, char: 0 },
                [
                    { ref_file: 'GameManager.cs', ref_line: 20, ref_char: 5, cached_at: Date.now() },
                    { ref_file: 'UI.cs', ref_line: 30, ref_char: 10, cached_at: Date.now() },
                ],
            );

            const results = cache.findReferences('Game.Player');
            expect(results).not.toBeNull();
            expect(results!.length).toBe(2);
            expect(results![0].ref_file).toBe('GameManager.cs');
        });

        it('should return null for expired references', () => {
            // Insert with old timestamp directly
            cache.db.prepare(`
                INSERT INTO reference_cache
                (target_fqn, target_file, target_line, target_char, ref_file, ref_line, ref_char, cached_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run('Old.Symbol', 'old.cs', 1, 0, 'ref.cs', 5, 0, Date.now() - 120_000);

            const results = cache.findReferences('Old.Symbol');
            expect(results).toBeNull();
        });

        it('should replace old references on re-cache', () => {
            cache.cacheReferences('Game.Player', { file: 'Player.cs', line: 10, char: 0 }, [
                { ref_file: 'A.cs', ref_line: 1, ref_char: 0, cached_at: Date.now() },
            ]);
            cache.cacheReferences('Game.Player', { file: 'Player.cs', line: 10, char: 0 }, [
                { ref_file: 'B.cs', ref_line: 2, ref_char: 0, cached_at: Date.now() },
                { ref_file: 'C.cs', ref_line: 3, ref_char: 0, cached_at: Date.now() },
            ]);

            const results = cache.findReferences('Game.Player');
            expect(results).not.toBeNull();
            expect(results!.length).toBe(2);
            expect(results![0].ref_file).toBe('B.cs');
        });
    });

    describe('invalidateFile', () => {
        it('should mark symbols in file as stale', () => {
            cache.cacheSymbols('hash1', [makeSymbol()]);

            cache.invalidateFile('Assets/Scripts/Player.cs');

            const results = cache.findSymbols({ name: 'Player' });
            expect(results).not.toBeNull();
            expect(results![0].stale).toBe(1);
        });

        it('should mark xlua mappings as pending for lua files', () => {
            cache.db.prepare(`
                INSERT INTO xlua_mappings
                (lua_call_pattern, lua_file, lua_line, lua_file_hash, status, verified_at)
                VALUES (?, ?, ?, ?, 'verified', ?)
            `).run('CS.Game.Player:Move', 'scripts/player.lua', 10, 'hash', Date.now());

            cache.invalidateFile('scripts/player.lua');

            const mapping = cache.db.prepare(
                `SELECT status FROM xlua_mappings WHERE lua_file = ?`,
            ).get('scripts/player.lua') as { status: string };
            expect(mapping.status).toBe('pending');
        });

        it('should not affect other files', () => {
            cache.cacheSymbols('hash1', [makeSymbol()]);
            cache.cacheSymbols('hash2', [makeSymbol({
                name: 'Enemy',
                fqn: 'Game.Enemy',
                file_path: 'Assets/Scripts/Enemy.cs',
            })]);

            cache.invalidateFile('Assets/Scripts/Player.cs');

            const playerResults = cache.findSymbols({ name: 'Player' });
            expect(playerResults![0].stale).toBe(1);

            const enemyResults = cache.findSymbols({ name: 'Enemy' });
            expect(enemyResults![0].stale).toBe(0);
        });
    });

    describe('computeFileHash', () => {
        it('should return 16 char hex string', () => {
            const hash = CacheManager.computeFileHash('hello world');
            expect(hash).toHaveLength(16);
            expect(hash).toMatch(/^[0-9a-f]+$/);
        });

        it('should be deterministic', () => {
            const h1 = CacheManager.computeFileHash('test content');
            const h2 = CacheManager.computeFileHash('test content');
            expect(h1).toBe(h2);
        });

        it('should differ for different content', () => {
            const h1 = CacheManager.computeFileHash('content A');
            const h2 = CacheManager.computeFileHash('content B');
            expect(h1).not.toBe(h2);
        });
    });

    describe('getStats', () => {
        it('should count correctly', () => {
            cache.cacheSymbols('hash1', [
                makeSymbol({ name: 'A', fqn: 'A' }),
                makeSymbol({ name: 'B', fqn: 'B' }),
            ]);
            cache.cacheReferences('A', { file: 'a.cs', line: 1, char: 0 }, [
                { ref_file: 'b.cs', ref_line: 5, ref_char: 0, cached_at: Date.now() },
            ]);

            const stats = cache.getStats();
            expect(stats.symbols).toBe(2);
            expect(stats.references).toBe(1);
            expect(stats.xluaMappings).toBe(0);
        });
    });

    describe('cleanup', () => {
        it('should remove old stale symbols', () => {
            cache.cacheSymbols('hash1', [makeSymbol()]);
            // Mark stale with old timestamp
            cache.db.prepare(
                'UPDATE symbol_cache SET stale = 1, cached_at = ?',
            ).run(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago

            cache.cleanup();

            const stats = cache.getStats();
            expect(stats.symbols).toBe(0);
        });

        it('should keep fresh symbols', () => {
            cache.cacheSymbols('hash1', [makeSymbol()]);

            cache.cleanup();

            const stats = cache.getStats();
            expect(stats.symbols).toBe(1);
        });
    });
});
