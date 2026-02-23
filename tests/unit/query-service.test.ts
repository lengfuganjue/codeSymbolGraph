import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QueryService } from '../../src/core/query-service.js';
import { CacheManager, type CachedSymbol } from '../../src/cache/cache-manager.js';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

function makeTempDb(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-qs-'));
    return path.join(dir, 'test.db');
}

function makeSymbol(overrides: Partial<CachedSymbol> = {}): CachedSymbol {
    return {
        content_hash: 'abc123',
        file_path: 'Assets/Scripts/Player.cs',
        name: 'Player',
        fqn: 'Game.Player',
        kind: 5,
        language: 'csharp',
        container_name: 'Game',
        range_start_line: 10,
        range_start_char: 4,
        range_end_line: 50,
        range_end_char: 1,
        cached_at: Date.now(),
        stale: 0,
        ...overrides,
    };
}

function createMockLspManager() {
    const mockClient = {
        state: 'ready',
        workspaceSymbol: vi.fn().mockResolvedValue([]),
        definition: vi.fn().mockResolvedValue(null),
        references: vi.fn().mockResolvedValue([]),
        hover: vi.fn().mockResolvedValue(null),
        documentSymbol: vi.fn().mockResolvedValue([]),
        rename: vi.fn().mockResolvedValue(null),
    };

    return {
        getClientForFile: vi.fn().mockReturnValue(mockClient),
        getClientForLanguage: vi.fn().mockReturnValue(mockClient),
        getStatus: vi.fn().mockReturnValue({
            csharp: { state: 'ready', name: 'csharp-ls' },
            lua: { state: 'ready', name: 'LuaLS' },
            allReady: true,
        }),
        getLspStatusForMcp: vi.fn().mockReturnValue({ csharp: 'ready', lua: 'ready' }),
        _mockClient: mockClient,
    } as any;
}

describe('QueryService', () => {
    let dbPath: string;
    let cache: CacheManager;
    let lspManager: ReturnType<typeof createMockLspManager>;
    let service: QueryService;

    beforeEach(() => {
        dbPath = makeTempDb();
        cache = new CacheManager(dbPath);
        lspManager = createMockLspManager();
        service = new QueryService(lspManager, cache, 'C:\\workspace\\project');
    });

    afterEach(() => {
        cache.close();
        try { fs.unlinkSync(dbPath); } catch {}
        try { fs.rmdirSync(path.dirname(dbPath)); } catch {}
    });

    describe('resolveSymbol', () => {
        it('should resolve from cache by fqn', async () => {
            cache.cacheSymbols('hash1', [makeSymbol()]);

            const results = await service.resolveSymbol('Game.Player');
            expect(results).toHaveLength(1);
            expect(results[0].fqn).toBe('Game.Player');
            expect(results[0].file).toBe('Assets/Scripts/Player.cs');
            expect(results[0].line).toBe(10);
            expect(results[0].stale).toBe(false);
        });

        it('should resolve from cache by name', async () => {
            cache.cacheSymbols('hash1', [makeSymbol()]);

            const results = await service.resolveSymbol('Player');
            expect(results).toHaveLength(1);
            expect(results[0].name).toBe('Player');
        });

        it('should fall back to LSP when cache misses', async () => {
            lspManager._mockClient.workspaceSymbol.mockResolvedValue([
                {
                    name: 'ItemManager',
                    containerName: 'Game',
                    kind: 5,
                    location: {
                        uri: 'file:///C:/workspace/project/Assets/Scripts/ItemManager.cs',
                        range: { start: { line: 5, character: 0 }, end: { line: 100, character: 1 } },
                    },
                },
            ]);

            const results = await service.resolveSymbol('ItemManager');
            expect(results.length).toBeGreaterThan(0);
            expect(results[0].name).toBe('ItemManager');
            expect(results[0].fqn).toBe('Game.ItemManager');
        });

        it('should return empty array when nothing found', async () => {
            const results = await service.resolveSymbol('NonExistent');
            expect(results).toHaveLength(0);
        });

        it('should search by last segment for dotted names', async () => {
            lspManager._mockClient.workspaceSymbol.mockResolvedValue([]);

            const results = await service.resolveSymbol('Game.Player.Move');

            // Should search for "Move" (last segment) against both LSPs
            expect(lspManager._mockClient.workspaceSymbol).toHaveBeenCalledWith('Move');
            expect(results).toHaveLength(0);
        });
    });

    describe('findDefinition', () => {
        it('should find definition by name from cache', async () => {
            cache.cacheSymbols('hash1', [makeSymbol()]);

            const results = await service.findDefinition({ name: 'Player' });
            expect(results).toHaveLength(1);
            expect(results[0].name).toBe('Player');
            // line should be 1-based in output
            expect(results[0].line).toBe(11); // 10 (0-based) + 1
            expect(results[0].source).toBe('lsp');
        });

        it('should find definition by file position', async () => {
            lspManager._mockClient.definition.mockResolvedValue({
                uri: 'file:///C:/workspace/project/Assets/Scripts/Enemy.cs',
                range: { start: { line: 20, character: 8 }, end: { line: 20, character: 13 } },
            });

            const results = await service.findDefinition({
                file: 'Assets/Scripts/Player.cs',
                line: 15,
                character: 10,
            });

            expect(results).toHaveLength(1);
            expect(results[0].file).toContain('Enemy.cs');
            expect(results[0].line).toBe(21); // 20 + 1
        });

        it('should return empty for no match', async () => {
            const results = await service.findDefinition({ name: 'NonExistent' });
            expect(results).toHaveLength(0);
        });

        it('should handle definition returning array', async () => {
            lspManager._mockClient.definition.mockResolvedValue([
                {
                    uri: 'file:///C:/workspace/project/A.cs',
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                },
                {
                    uri: 'file:///C:/workspace/project/B.cs',
                    range: { start: { line: 10, character: 0 }, end: { line: 10, character: 5 } },
                },
            ]);

            const results = await service.findDefinition({
                file: 'test.cs',
                line: 1,
            });
            expect(results).toHaveLength(2);
        });
    });

    describe('findReferences', () => {
        it('should find references from cache (TTL)', async () => {
            // seed symbol
            cache.cacheSymbols('hash1', [makeSymbol()]);
            // seed references
            cache.cacheReferences(
                'Game.Player',
                { file: 'Player.cs', line: 10, char: 0 },
                [
                    { ref_file: 'GameManager.cs', ref_line: 20, ref_char: 5, cached_at: Date.now() },
                ],
            );

            const result = await service.findReferences({ name: 'Player' });
            expect(result.source).toBe('cache');
            expect(result.count).toBe(1);
            expect(result.references[0].file).toBe('GameManager.cs');
            expect(result.references[0].line).toBe(21); // 20 + 1
        });

        it('should fall back to LSP when cache misses', async () => {
            cache.cacheSymbols('hash1', [makeSymbol()]);

            lspManager._mockClient.references.mockResolvedValue([
                {
                    uri: 'file:///C:/workspace/project/Assets/Scripts/GameManager.cs',
                    range: { start: { line: 30, character: 10 }, end: { line: 30, character: 16 } },
                },
            ]);

            const result = await service.findReferences({ name: 'Player' });
            expect(result.source).toBe('lsp');
            expect(result.count).toBe(1);
            expect(result.references[0].line).toBe(31);
        });

        it('should return empty result when symbol not found', async () => {
            const result = await service.findReferences({ name: 'NonExistent' });
            expect(result.count).toBe(0);
            expect(result.references).toHaveLength(0);
        });
    });

    describe('findCallChain', () => {
        it('should find incoming callers via references + documentSymbol', async () => {
            cache.cacheSymbols('hash1', [makeSymbol({
                name: 'Move',
                fqn: 'Game.Player.Move',
                kind: 6, // Method
                file_path: 'Assets/Scripts/Player.cs',
                range_start_line: 20,
                range_start_char: 8,
            })]);

            // references returns 2 call sites
            lspManager._mockClient.references.mockResolvedValue([
                {
                    uri: 'file:///C:/workspace/project/Assets/Scripts/GameManager.cs',
                    range: { start: { line: 50, character: 12 }, end: { line: 50, character: 16 } },
                },
                {
                    uri: 'file:///C:/workspace/project/Assets/Scripts/AI.cs',
                    range: { start: { line: 30, character: 8 }, end: { line: 30, character: 12 } },
                },
            ]);

            // documentSymbol returns enclosing functions
            lspManager._mockClient.documentSymbol.mockImplementation(async (uri: string) => {
                if (uri.includes('GameManager')) {
                    return [{
                        name: 'Update',
                        kind: 6, // Method
                        range: { start: { line: 45, character: 0 }, end: { line: 60, character: 1 } },
                        selectionRange: { start: { line: 45, character: 4 }, end: { line: 45, character: 10 } },
                    }];
                }
                if (uri.includes('AI')) {
                    return [{
                        name: 'Think',
                        kind: 6,
                        range: { start: { line: 25, character: 0 }, end: { line: 40, character: 1 } },
                        selectionRange: { start: { line: 25, character: 4 }, end: { line: 25, character: 9 } },
                    }];
                }
                return [];
            });

            const result = await service.findCallChain({
                name: 'Move',
                direction: 'incoming',
                maxDepth: 1,
            });

            expect(result.root).toBe('Game.Player.Move');
            expect(result.incoming).toHaveLength(2);

            const names = result.incoming.map(n => n.name).sort();
            expect(names).toEqual(['Think', 'Update']);

            // Each caller should have file and line info
            for (const node of result.incoming) {
                expect(node.file).toBeTruthy();
                expect(node.line).toBeGreaterThan(0);
                expect(node.kind).toBe(6);
            }
        });

        it('should return empty incoming when no references found', async () => {
            cache.cacheSymbols('hash1', [makeSymbol()]);
            lspManager._mockClient.references.mockResolvedValue([]);

            const result = await service.findCallChain({
                name: 'Player',
                direction: 'incoming',
            });

            expect(result.incoming).toHaveLength(0);
        });

        it('should return empty outgoing (not supported via references)', async () => {
            cache.cacheSymbols('hash1', [makeSymbol()]);

            const result = await service.findCallChain({
                name: 'Player',
                direction: 'outgoing',
            });

            expect(result.outgoing).toHaveLength(0);
        });

        it('should detect cycles and not infinite loop', async () => {
            cache.cacheSymbols('hash1', [makeSymbol({
                name: 'Recursive',
                fqn: 'Game.Recursive',
                kind: 6,
                range_start_line: 10,
            })]);

            // references returns self-referencing location
            lspManager._mockClient.references.mockResolvedValue([
                {
                    uri: 'file:///C:/workspace/project/Assets/Scripts/Player.cs',
                    range: { start: { line: 15, character: 0 }, end: { line: 15, character: 5 } },
                },
            ]);

            lspManager._mockClient.documentSymbol.mockResolvedValue([{
                name: 'Recursive',
                kind: 6,
                range: { start: { line: 10, character: 0 }, end: { line: 20, character: 1 } },
                selectionRange: { start: { line: 10, character: 4 }, end: { line: 10, character: 13 } },
            }]);

            const result = await service.findCallChain({
                name: 'Recursive',
                direction: 'incoming',
                maxDepth: 5,
            });

            // Should not infinite loop; visited set prevents re-entry
            expect(result.incoming.length).toBeLessThanOrEqual(1);
        });

        it('should return empty when symbol not resolved', async () => {
            const result = await service.findCallChain({
                name: 'NonExistent',
                direction: 'both',
            });

            expect(result.root).toBe('NonExistent');
            expect(result.incoming).toHaveLength(0);
            expect(result.outgoing).toHaveLength(0);
        });

        it('should find incoming callers with SymbolInformation flat format (isFlat=true)', async () => {
            // This tests the fix for csharp-ls which returns SymbolInformation[]
            // (flat, identifier-only range) instead of DocumentSymbol[] (hierarchical, full range)
            cache.cacheSymbols('hash1', [makeSymbol({
                name: 'LoadMap',
                fqn: 'Game.MapSystem.LoadMap',
                kind: 6, // Method
                file_path: 'Assets/Scripts/MapSystem.cs',
                range_start_line: 100,
                range_start_char: 8,
            })]);

            // references returns a call site at line 194 in BattleScene.cs
            lspManager._mockClient.references.mockResolvedValue([
                {
                    uri: 'file:///C:/workspace/project/Assets/Scripts/BattleScene.cs',
                    range: { start: { line: 194, character: 20 }, end: { line: 194, character: 27 } },
                },
            ]);

            // documentSymbol returns SymbolInformation[] (flat format with location, no children)
            // This simulates csharp-ls which only returns identifier-line ranges
            lspManager._mockClient.documentSymbol.mockResolvedValue([
                {
                    // Class symbol
                    name: 'BattleScene',
                    kind: 5,
                    location: {
                        uri: 'file:///C:/workspace/project/Assets/Scripts/BattleScene.cs',
                        range: { start: { line: 10, character: 0 }, end: { line: 10, character: 11 } },
                    },
                },
                {
                    // Method above the reference line (should be picked as enclosing)
                    name: 'OnMapLoaded',
                    kind: 6,
                    location: {
                        uri: 'file:///C:/workspace/project/Assets/Scripts/BattleScene.cs',
                        range: { start: { line: 180, character: 4 }, end: { line: 180, character: 15 } },
                    },
                },
                {
                    // Method below the reference line (should NOT be picked)
                    name: 'OnBattleEnd',
                    kind: 6,
                    location: {
                        uri: 'file:///C:/workspace/project/Assets/Scripts/BattleScene.cs',
                        range: { start: { line: 220, character: 4 }, end: { line: 220, character: 15 } },
                    },
                },
            ]);

            const result = await service.findCallChain({
                name: 'LoadMap',
                direction: 'incoming',
                maxDepth: 1,
            });

            expect(result.root).toBe('Game.MapSystem.LoadMap');
            expect(result.incoming).toHaveLength(1);
            expect(result.incoming[0].name).toBe('OnMapLoaded');
            expect(result.incoming[0].line).toBe(181); // 180 (0-based) + 1
        });

        it('should pick nearest method in flat mode when multiple methods precede reference', async () => {
            cache.cacheSymbols('hash1', [makeSymbol({
                name: 'DoWork',
                fqn: 'Game.Worker.DoWork',
                kind: 6,
                file_path: 'Assets/Scripts/Worker.cs',
                range_start_line: 50,
                range_start_char: 0,
            })]);

            // Reference at line 150
            lspManager._mockClient.references.mockResolvedValue([
                {
                    uri: 'file:///C:/workspace/project/Assets/Scripts/Caller.cs',
                    range: { start: { line: 150, character: 10 }, end: { line: 150, character: 16 } },
                },
            ]);

            // Three methods before line 150 — should pick the nearest one (line 140)
            lspManager._mockClient.documentSymbol.mockResolvedValue([
                {
                    name: 'Init',
                    kind: 6,
                    location: {
                        uri: 'file:///C:/workspace/project/Assets/Scripts/Caller.cs',
                        range: { start: { line: 20, character: 0 }, end: { line: 20, character: 4 } },
                    },
                },
                {
                    name: 'Start',
                    kind: 6,
                    location: {
                        uri: 'file:///C:/workspace/project/Assets/Scripts/Caller.cs',
                        range: { start: { line: 80, character: 0 }, end: { line: 80, character: 5 } },
                    },
                },
                {
                    name: 'Execute',
                    kind: 6,
                    location: {
                        uri: 'file:///C:/workspace/project/Assets/Scripts/Caller.cs',
                        range: { start: { line: 140, character: 0 }, end: { line: 140, character: 7 } },
                    },
                },
            ]);

            const result = await service.findCallChain({
                name: 'DoWork',
                direction: 'incoming',
                maxDepth: 1,
            });

            expect(result.incoming).toHaveLength(1);
            expect(result.incoming[0].name).toBe('Execute');
        });
    });
});

describe('findHierarchy — grep patterns', () => {
    it('grepSubclasses pattern matches class inheritance', () => {
        const pattern = /\b(?:class|struct|interface)\s+(\w+)(?:<[^>]*>)?\s*:[^{]*\bBase\b/;
        expect(pattern.exec('  public class ChildA : Base {')?.[1]).toBe('ChildA');
        expect(pattern.exec('  public class ChildB : Base, IFoo {')?.[1]).toBe('ChildB');
    });

    it('does NOT match class itself in inheritance list', () => {
        const pattern = /\b(?:class|struct|interface)\s+(\w+)(?:<[^>]*>)?\s*:[^{]*\bBase\b/;
        // "Base" appears as the class name, not in the inheritance part
        expect(pattern.exec('public class Base : System.Object {')).toBeNull();
    });

    it('matches interface implementations', () => {
        const pattern = /\b(?:class|struct|interface)\s+(\w+)(?:<[^>]*>)?\s*:[^{]*\bIDisposable\b/;
        expect(pattern.exec('public class MyService : IDisposable, ICloneable {')?.[1]).toBe('MyService');
    });

    it('matches generic class inheritance', () => {
        const pattern = /\b(?:class|struct|interface)\s+(\w+)(?:<[^>]*>)?\s*:[^{]*\bList\b/;
        expect(pattern.exec('public class SpecialList<T> : List<T>, IEnumerable {')?.[1]).toBe('SpecialList');
    });

    it('matches struct inheritance', () => {
        const pattern = /\b(?:class|struct|interface)\s+(\w+)(?:<[^>]*>)?\s*:[^{]*\bIEquatable\b/;
        expect(pattern.exec('public struct MyVal : IEquatable<MyVal> {')?.[1]).toBe('MyVal');
    });

    it('parseBaseTypes extracts base types from declaration', () => {
        const declLine = '  public class Foo : Bar, IBaz {';
        const match = declLine.match(/:\s*([^{]+?)(?:\s+where\b|\s*\{)/);
        expect(match).not.toBeNull();
        const types = match![1].split(',').map(t => t.trim().replace(/<[^>]*>/g, ''));
        expect(types).toEqual(['Bar', 'IBaz']);
    });

    it('parseBaseTypes handles generic constraints', () => {
        const declLine = 'class Foo<T> : Bar<T> where T : class {';
        const match = declLine.match(/:\s*([^{]+?)(?:\s+where\b|\s*\{)/);
        expect(match).not.toBeNull();
        const types = match![1].split(',').map(t => t.trim().replace(/<[^>]*>/g, ''));
        expect(types).toEqual(['Bar']);
    });
});

describe('grepLuaMethodCalls', () => {
    let tmpDir: string;
    let dbPath: string;
    let cache: CacheManager;
    let service: QueryService;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-grep-'));
        dbPath = path.join(tmpDir, 'test.db');
        cache = new CacheManager(dbPath);
        const mockLsp = {
            getClientForFile: vi.fn().mockReturnValue({ state: 'ready' }),
            getClientForLanguage: vi.fn().mockReturnValue({ state: 'ready' }),
            getStatus: vi.fn().mockReturnValue({ csharp: { state: 'ready' }, lua: { state: 'ready' }, allReady: true }),
            getLspStatusForMcp: vi.fn().mockReturnValue({}),
        } as any;
        service = new QueryService(mockLsp, cache, tmpDir);
    });

    afterEach(async () => {
        cache.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('matches colon method calls: obj:Method()', async () => {
        await fsp.writeFile(path.join(tmpDir, 'a.lua'),
            'self.guideMask:ClickOption()\nlocal x = 1\n');
        const results = await service.grepLuaMethodCalls('ClickOption');
        expect(results).toHaveLength(1);
        expect(results[0].line).toBe(1);
        expect(results[0].file).toBe('a.lua');
    });

    it('matches dot method calls: obj.Method()', async () => {
        await fsp.writeFile(path.join(tmpDir, 'b.lua'),
            'mgr.Update(dt)\n');
        const results = await service.grepLuaMethodCalls('Update');
        expect(results).toHaveLength(1);
        expect(results[0].line).toBe(1);
    });

    it('does NOT match bare variable assignment: local ClickOption = ...', async () => {
        await fsp.writeFile(path.join(tmpDir, 'c.lua'),
            'local ClickOption = function() end\nClickOption = nil\n');
        const results = await service.grepLuaMethodCalls('ClickOption');
        expect(results).toHaveLength(0);
    });

    it('respects limit parameter', async () => {
        const lines = Array.from({ length: 20 }, (_, i) => `obj:ClickOption() -- ${i}`).join('\n');
        await fsp.writeFile(path.join(tmpDir, 'd.lua'), lines);
        const results = await service.grepLuaMethodCalls('ClickOption', 5);
        expect(results.length).toBeLessThanOrEqual(5);
    });

    it('returns results from multiple files', async () => {
        await fsp.writeFile(path.join(tmpDir, 'e1.lua'), 'a:Foo()\n');
        await fsp.writeFile(path.join(tmpDir, 'e2.lua'), 'b:Foo()\n');
        const results = await service.grepLuaMethodCalls('Foo');
        expect(results.length).toBe(2);
    });
});

describe('findTaggedClasses', () => {
    let tmpDir: string;
    let dbPath: string;
    let cache: CacheManager;
    let service: QueryService;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-tagged-'));
        dbPath = path.join(tmpDir, 'test.db');
        cache = new CacheManager(dbPath);
        const mockLsp = {
            getClientForFile: vi.fn().mockReturnValue({ state: 'ready' }),
            getClientForLanguage: vi.fn().mockReturnValue({ state: 'ready' }),
            getStatus: vi.fn().mockReturnValue({ csharp: { state: 'ready' }, lua: { state: 'ready' }, allReady: true }),
            getLspStatusForMcp: vi.fn().mockReturnValue({}),
        } as any;
        service = new QueryService(mockLsp, cache, tmpDir);
    });

    afterEach(async () => {
        cache.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('matches attribute [LuaCallCSharp]', async () => {
        await fsp.writeFile(path.join(tmpDir, 'A.cs'),
            '[LuaCallCSharp]\npublic class MyClass { }\n');
        const results = await service.findTaggedClasses('LuaCallCSharp');
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe('MyClass');
        expect(results[0].tagType).toBe('attribute');
        expect(results[0].line).toBe(2);
    });

    it('matches attribute with parameters [Hotfix(HotfixFlag.Stateless)]', async () => {
        await fsp.writeFile(path.join(tmpDir, 'B.cs'),
            '[Hotfix(HotfixFlag.Stateless)]\npublic class HotfixTarget { }\n');
        const results = await service.findTaggedClasses('Hotfix');
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe('HotfixTarget');
        expect(results[0].tagType).toBe('attribute');
    });

    it('matches base class: class Foo : MonoBehaviour', async () => {
        await fsp.writeFile(path.join(tmpDir, 'C.cs'),
            'public class PlayerController : MonoBehaviour {\n}\n');
        const results = await service.findTaggedClasses('MonoBehaviour');
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe('PlayerController');
        expect(results[0].tagType).toBe('base_class');
        expect(results[0].line).toBe(1);
    });

    it('matches base class with multiple interfaces: class Foo : MonoBehaviour, IDisposable', async () => {
        await fsp.writeFile(path.join(tmpDir, 'D.cs'),
            'public class GameManager : MonoBehaviour, IDisposable {\n}\n');
        const results = await service.findTaggedClasses('MonoBehaviour');
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe('GameManager');
        expect(results[0].tagType).toBe('base_class');
    });

    it('excludes generated code directories (XLua/Gen)', async () => {
        const genDir = path.join(tmpDir, 'XLua', 'Gen');
        fs.mkdirSync(genDir, { recursive: true });
        await fsp.writeFile(path.join(genDir, 'E.cs'),
            '[LuaCallCSharp]\npublic class GenClass { }\n');
        const results = await service.findTaggedClasses('LuaCallCSharp');
        expect(results).toHaveLength(0);
    });

    it('excludes Editor directory', async () => {
        const editorDir = path.join(tmpDir, 'Editor');
        fs.mkdirSync(editorDir, { recursive: true });
        await fsp.writeFile(path.join(editorDir, 'F.cs'),
            '[LuaCallCSharp]\npublic class EditorClass { }\n');
        const results = await service.findTaggedClasses('LuaCallCSharp');
        expect(results).toHaveLength(0);
    });

    it('returns empty for no matches', async () => {
        await fsp.writeFile(path.join(tmpDir, 'G.cs'),
            'public class NormalClass { }\n');
        const results = await service.findTaggedClasses('LuaCallCSharp');
        expect(results).toHaveLength(0);
    });

    it('finds both attribute and base class matches', async () => {
        await fsp.writeFile(path.join(tmpDir, 'H.cs'),
            '[Serializable]\npublic class DataA { }\n');
        await fsp.writeFile(path.join(tmpDir, 'I.cs'),
            'public class DataB : Serializable {\n}\n');
        const results = await service.findTaggedClasses('Serializable');
        expect(results).toHaveLength(2);
        const types = results.map(r => r.tagType).sort();
        expect(types).toEqual(['attribute', 'base_class']);
    });

    it('respects limit parameter', async () => {
        for (let i = 0; i < 10; i++) {
            await fsp.writeFile(path.join(tmpDir, `L${i}.cs`),
                `[Hotfix]\npublic class Cls${i} { }\n`);
        }
        const results = await service.findTaggedClasses('Hotfix', 3);
        expect(results.length).toBeLessThanOrEqual(3);
    });
});

describe('findFileDeps', () => {
    let tmpDir: string;
    let dbPath: string;
    let cache: CacheManager;
    let service: QueryService;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-deps-'));
        dbPath = path.join(tmpDir, 'test.db');
        cache = new CacheManager(dbPath);
        const mockLsp = {
            getClientForFile: vi.fn().mockReturnValue({ state: 'ready' }),
            getClientForLanguage: vi.fn().mockReturnValue({ state: 'ready' }),
            getStatus: vi.fn().mockReturnValue({ csharp: { state: 'ready' }, lua: { state: 'ready' }, allReady: true }),
            getLspStatusForMcp: vi.fn().mockReturnValue({}),
        } as any;
        service = new QueryService(mockLsp, cache, tmpDir);
    });

    afterEach(async () => {
        cache.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('Lua require extraction', () => {
        it('extracts require with double quotes', () => {
            const content = 'local M = require("games.systems.GuideManager")\n';
            const results = service.extractLuaRequires(content, 'test.lua');
            expect(results).toHaveLength(1);
            expect(results[0].module).toBe('games.systems.GuideManager');
            expect(results[0].line).toBe(1);
        });

        it('extracts require with single quotes', () => {
            const content = "local M = require('ui.base.PageBase')\n";
            const results = service.extractLuaRequires(content, 'test.lua');
            expect(results).toHaveLength(1);
            expect(results[0].module).toBe('ui.base.PageBase');
        });

        it('extracts require with spaces around parentheses', () => {
            const content = 'local M = require( "utils.Helper" )\n';
            const results = service.extractLuaRequires(content, 'test.lua');
            expect(results).toHaveLength(1);
            expect(results[0].module).toBe('utils.Helper');
        });

        it('extracts multiple requires', () => {
            const content = [
                'local A = require("mod.A")',
                'local B = require("mod.B")',
                '-- local C = require("mod.C")',
                'local D = require("mod.D")',
            ].join('\n');
            const results = service.extractLuaRequires(content, 'test.lua');
            // Note: the commented-out require is still matched by regex (not a real parser)
            expect(results.length).toBeGreaterThanOrEqual(3);
            expect(results[0].module).toBe('mod.A');
            expect(results[0].line).toBe(1);
            expect(results[1].module).toBe('mod.B');
            expect(results[1].line).toBe(2);
        });

        it('returns empty for file without requires', () => {
            const content = 'local x = 1\nprint("hello")\n';
            const results = service.extractLuaRequires(content, 'test.lua');
            expect(results).toHaveLength(0);
        });
    });

    describe('Lua require path resolution', () => {
        it('resolves require path when file exists', async () => {
            // Create the target file
            const modDir = path.join(tmpDir, 'games', 'systems');
            fs.mkdirSync(modDir, { recursive: true });
            fs.writeFileSync(path.join(modDir, 'GuideManager.lua'), 'return {}');

            const content = 'local M = require("games.systems.GuideManager")\n';
            const results = service.extractLuaRequires(content, 'test.lua');
            expect(results).toHaveLength(1);
            expect(results[0].resolvedFile).toBe('games/systems/GuideManager.lua');
        });

        it('resolves require path under Lua/ directory', async () => {
            const luaDir = path.join(tmpDir, 'Lua', 'utils');
            fs.mkdirSync(luaDir, { recursive: true });
            fs.writeFileSync(path.join(luaDir, 'Helper.lua'), 'return {}');

            const content = 'local H = require("utils.Helper")\n';
            const results = service.extractLuaRequires(content, 'test.lua');
            expect(results).toHaveLength(1);
            expect(results[0].resolvedFile).toBe('Lua/utils/Helper.lua');
        });

        it('returns null for unresolved require path', () => {
            const content = 'local M = require("nonexistent.Module")\n';
            const results = service.extractLuaRequires(content, 'test.lua');
            expect(results).toHaveLength(1);
            expect(results[0].resolvedFile).toBeNull();
        });
    });

    describe('C# using extraction', () => {
        it('extracts simple using statements', () => {
            const content = [
                'using System;',
                'using System.Collections.Generic;',
                'using UnityEngine;',
                '',
                'namespace Game {',
            ].join('\n');
            const results = service.extractCsharpUsings(content);
            expect(results).toHaveLength(3);
            expect(results[0]).toEqual({ namespace: 'System', line: 1 });
            expect(results[1]).toEqual({ namespace: 'System.Collections.Generic', line: 2 });
            expect(results[2]).toEqual({ namespace: 'UnityEngine', line: 3 });
        });

        it('excludes using static', () => {
            const content = [
                'using System;',
                'using static System.Math;',
                'using UnityEngine;',
            ].join('\n');
            const results = service.extractCsharpUsings(content);
            expect(results).toHaveLength(2);
            expect(results.map(r => r.namespace)).toEqual(['System', 'UnityEngine']);
        });

        it('excludes using alias', () => {
            const content = [
                'using System;',
                'using Vec3 = UnityEngine.Vector3;',
                'using UnityEngine;',
            ].join('\n');
            const results = service.extractCsharpUsings(content);
            expect(results).toHaveLength(2);
            expect(results.map(r => r.namespace)).toEqual(['System', 'UnityEngine']);
        });

        it('returns empty for file without usings', () => {
            const content = 'namespace Game {\n    class Foo { }\n}\n';
            const results = service.extractCsharpUsings(content);
            expect(results).toHaveLength(0);
        });
    });

    describe('Lua reverse dependency (dependents)', () => {
        it('finds files that require the target file', async () => {
            // Create target module
            const modDir = path.join(tmpDir, 'games');
            fs.mkdirSync(modDir, { recursive: true });
            fs.writeFileSync(path.join(modDir, 'Target.lua'), 'return {}');

            // Create files that require it
            fs.writeFileSync(path.join(tmpDir, 'a.lua'),
                'local T = require("games.Target")\nprint(T)\n');
            fs.writeFileSync(path.join(tmpDir, 'b.lua'),
                'local other = require("games.Target")\n');
            fs.writeFileSync(path.join(tmpDir, 'c.lua'),
                'local x = 1\n');

            const result = await service.findFileDeps('games/Target.lua', 'dependents');
            expect(result.dependents.luaRequiredBy.length).toBe(2);
            const files = result.dependents.luaRequiredBy.map(r => r.file).sort();
            expect(files).toEqual(['a.lua', 'b.lua']);
        });

        it('does not include the target file itself', async () => {
            // Create a file that requires itself (unusual but possible)
            fs.writeFileSync(path.join(tmpDir, 'self.lua'),
                'local M = require("self")\nreturn M\n');

            const result = await service.findFileDeps('self.lua', 'dependents');
            expect(result.dependents.luaRequiredBy).toHaveLength(0);
        });
    });

    describe('cross-language dependencies', () => {
        it('queries xlua_mappings for Lua file', async () => {
            // Create the Lua file on disk (required for findFileDeps to proceed)
            const luaDir = path.join(tmpDir, 'Lua', 'game');
            fs.mkdirSync(luaDir, { recursive: true });
            fs.writeFileSync(path.join(luaDir, 'init.lua'), 'local M = {}\nreturn M\n');

            // Insert test xlua mappings
            cache.db.prepare(`
                INSERT INTO xlua_mappings (lua_call_pattern, lua_file, lua_line, csharp_fqn, lua_file_hash, status)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run('CS.Game.ItemManager', 'Lua/game/init.lua', 10, 'Game.ItemManager', 'abc', 'verified');

            cache.db.prepare(`
                INSERT INTO xlua_mappings (lua_call_pattern, lua_file, lua_line, csharp_fqn, lua_file_hash, status)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run('GameHelper', 'Lua/game/init.lua', 20, 'Game.Helpers.GameHelper', 'abc', 'verified');

            const result = await service.findFileDeps('Lua/game/init.lua', 'deps');
            expect(result.deps.crossLangDeps).toHaveLength(2);
            const fqns = result.deps.crossLangDeps.map(c => c.csharpFqn).sort();
            expect(fqns).toEqual(['Game.Helpers.GameHelper', 'Game.ItemManager']);
        });

        it('returns empty cross-lang deps for C# files', async () => {
            fs.writeFileSync(path.join(tmpDir, 'Test.cs'),
                'using System;\nnamespace Game { class Test { } }\n');

            const result = await service.findFileDeps('Test.cs', 'deps');
            expect(result.deps.crossLangDeps).toHaveLength(0);
            expect(result.language).toBe('csharp');
        });
    });

    describe('findFileDeps — full integration', () => {
        it('returns both deps and dependents for Lua file', async () => {
            // Create target Lua file with requires
            const gamesDir = path.join(tmpDir, 'games');
            fs.mkdirSync(gamesDir, { recursive: true });
            fs.writeFileSync(path.join(gamesDir, 'Manager.lua'), [
                'local Base = require("games.Base")',
                'local Utils = require("utils.Helper")',
                'local M = {}',
                'return M',
            ].join('\n'));

            // Create the required Base module
            fs.writeFileSync(path.join(gamesDir, 'Base.lua'), 'return {}');

            // Create a file that depends on Manager
            fs.writeFileSync(path.join(tmpDir, 'main.lua'),
                'local Mgr = require("games.Manager")\nMgr:init()\n');

            const result = await service.findFileDeps('games/Manager.lua', 'both');
            expect(result.file).toBe('games/Manager.lua');
            expect(result.language).toBe('lua');

            // Should have 2 requires
            expect(result.deps.luaRequires).toHaveLength(2);
            expect(result.deps.luaRequires[0].module).toBe('games.Base');
            expect(result.deps.luaRequires[0].resolvedFile).toBe('games/Base.lua');
            expect(result.deps.luaRequires[1].module).toBe('utils.Helper');
            expect(result.deps.luaRequires[1].resolvedFile).toBeNull(); // doesn't exist

            // Should be required by main.lua
            expect(result.dependents.luaRequiredBy).toHaveLength(1);
            expect(result.dependents.luaRequiredBy[0].file).toBe('main.lua');
        });

        it('returns usings for C# file', async () => {
            fs.writeFileSync(path.join(tmpDir, 'Player.cs'), [
                'using System;',
                'using System.Collections.Generic;',
                'using UnityEngine;',
                '',
                'namespace Game {',
                '    public class Player : MonoBehaviour {',
                '    }',
                '}',
            ].join('\n'));

            const result = await service.findFileDeps('Player.cs', 'deps');
            expect(result.language).toBe('csharp');
            expect(result.deps.csharpUsings).toHaveLength(3);
            expect(result.deps.csharpUsings.map(u => u.namespace)).toEqual([
                'System', 'System.Collections.Generic', 'UnityEngine',
            ]);
        });

        it('returns empty result for nonexistent file', async () => {
            const result = await service.findFileDeps('nonexistent.lua', 'both');
            expect(result.deps.luaRequires).toHaveLength(0);
            expect(result.dependents.luaRequiredBy).toHaveLength(0);
        });

        it('respects direction=deps (no dependents query)', async () => {
            fs.writeFileSync(path.join(tmpDir, 'mod.lua'),
                'local A = require("other")\nreturn {}\n');
            fs.writeFileSync(path.join(tmpDir, 'user.lua'),
                'local M = require("mod")\n');

            const result = await service.findFileDeps('mod.lua', 'deps');
            expect(result.deps.luaRequires).toHaveLength(1);
            // dependents should be empty since direction=deps
            expect(result.dependents.luaRequiredBy).toHaveLength(0);
        });

        it('respects direction=dependents (no deps query)', async () => {
            fs.writeFileSync(path.join(tmpDir, 'mod.lua'),
                'local A = require("other")\nreturn {}\n');
            fs.writeFileSync(path.join(tmpDir, 'user.lua'),
                'local M = require("mod")\n');

            const result = await service.findFileDeps('mod.lua', 'dependents');
            // deps should be empty since direction=dependents
            expect(result.deps.luaRequires).toHaveLength(0);
            expect(result.dependents.luaRequiredBy).toHaveLength(1);
        });
    });
});

describe('renamePreview', () => {
    let tmpDir: string;
    let dbPath: string;
    let cache: CacheManager;
    let lspManager: ReturnType<typeof createMockLspManager>;
    let service: QueryService;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-rename-'));
        dbPath = path.join(tmpDir, 'test.db');
        cache = new CacheManager(dbPath);
        lspManager = createMockLspManager();
        service = new QueryService(lspManager, cache, tmpDir);
    });

    afterEach(async () => {
        cache.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should require new_name and name or file', async () => {
        // name is provided, new_name is provided => should not error on params
        // When symbol not found, should return empty
        const result = await service.renamePreview({ name: 'NonExistent', new_name: 'NewName' });
        expect(result.totalChanges).toBe(0);
        expect(result.files).toHaveLength(0);
        expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should generate correct oldText/newText via fallback (findReferences + regex)', async () => {
        // Create a CS file that contains the symbol
        const csContent = [
            'using System;',
            'public class Player {',
            '    public void Move() { }',
            '}',
            'public class Game {',
            '    Player player = new Player();',
            '    void Update() { player.Move(); }',
            '}',
        ].join('\n');
        await fsp.writeFile(path.join(tmpDir, 'Player.cs'), csContent);

        // Cache the symbol
        cache.cacheSymbols('hash1', [makeSymbol({
            file_path: 'Player.cs',
            name: 'Player',
            fqn: 'Player',
            kind: 5,
            language: 'csharp',
            range_start_line: 1,
            range_start_char: 13,
        })]);

        // Mock references returning lines where "Player" appears
        lspManager._mockClient.references.mockResolvedValue([
            {
                uri: `file://${tmpDir}/Player.cs`,
                range: { start: { line: 1, character: 13 }, end: { line: 1, character: 19 } },
            },
            {
                uri: `file://${tmpDir}/Player.cs`,
                range: { start: { line: 5, character: 4 }, end: { line: 5, character: 10 } },
            },
        ]);

        // Mock LSP rename to return null (trigger fallback)
        lspManager._mockClient.rename = vi.fn().mockResolvedValue(null);

        const result = await service.renamePreview({ name: 'Player', new_name: 'Character' });

        expect(result.oldName).toBe('Player');
        expect(result.newName).toBe('Character');
        expect(result.totalChanges).toBeGreaterThan(0);

        // Find the file entry
        const fileEntry = result.files.find(f => f.file === 'Player.cs');
        expect(fileEntry).toBeDefined();
        expect(fileEntry!.language).toBe('csharp');

        // Verify that replacement is correct
        for (const change of fileEntry!.changes) {
            expect(change.oldText).toContain('Player');
            expect(change.newText).toContain('Character');
            expect(change.newText).not.toContain('Player');
        }
    });

    it('should use word boundary regex to avoid replacing substrings', async () => {
        const csContent = [
            'public class Get {',
            '    void GetComponent() { }',
            '    void DoGet() { }',
            '    Get instance;',
            '}',
        ].join('\n');
        await fsp.writeFile(path.join(tmpDir, 'Get.cs'), csContent);

        cache.cacheSymbols('hash1', [makeSymbol({
            file_path: 'Get.cs',
            name: 'Get',
            fqn: 'Get',
            kind: 5,
            language: 'csharp',
            range_start_line: 0,
            range_start_char: 13,
        })]);

        // Reference on line 3 (0-based) where "Get" appears as standalone word
        lspManager._mockClient.references.mockResolvedValue([
            {
                uri: `file://${tmpDir}/Get.cs`,
                range: { start: { line: 3, character: 4 }, end: { line: 3, character: 7 } },
            },
        ]);
        lspManager._mockClient.rename = vi.fn().mockResolvedValue(null);

        const result = await service.renamePreview({ name: 'Get', new_name: 'Fetch' });

        const fileEntry = result.files.find(f => f.file === 'Get.cs');
        expect(fileEntry).toBeDefined();

        // The change on line 4 (1-based) should replace "Get" but not "GetComponent"
        const change = fileEntry!.changes.find(c => c.line === 4);
        expect(change).toBeDefined();
        expect(change!.oldText).toBe('    Get instance;');
        expect(change!.newText).toBe('    Fetch instance;');
    });

    it('should include Lua cross-language references for C# symbol', async () => {
        // Create a Lua file with method call
        await fsp.writeFile(path.join(tmpDir, 'game.lua'),
            'local obj = CS.Game.Player()\nobj:Move()\nobj:Attack()\n');

        cache.cacheSymbols('hash1', [makeSymbol({
            file_path: 'Player.cs',
            name: 'Move',
            fqn: 'Game.Player.Move',
            kind: 6,
            language: 'csharp',
            range_start_line: 10,
            range_start_char: 8,
        })]);

        // Create the C# file on disk too
        await fsp.writeFile(path.join(tmpDir, 'Player.cs'),
            'namespace Game {\n    public class Player {\n        public void Move() { }\n    }\n}\n');

        // Mock: no LSP references, no LSP rename
        lspManager._mockClient.references.mockResolvedValue([]);
        lspManager._mockClient.rename = vi.fn().mockResolvedValue(null);

        const result = await service.renamePreview({ name: 'Move', new_name: 'Walk' });

        // Should find the Lua cross-language reference
        const luaFile = result.files.find(f => f.file === 'game.lua');
        expect(luaFile).toBeDefined();
        expect(luaFile!.language).toBe('lua');
        expect(luaFile!.changes.length).toBeGreaterThan(0);

        const moveChange = luaFile!.changes.find(c => c.oldText.includes('Move'));
        expect(moveChange).toBeDefined();
        expect(moveChange!.newText).toContain('Walk');

        // Should have a warning about Lua grep
        expect(result.warnings.some(w => w.includes('Lua grep'))).toBe(true);
    });

    it('should return empty files when symbol not found', async () => {
        const result = await service.renamePreview({ name: 'NoSuchSymbol', new_name: 'NewName' });
        expect(result.totalChanges).toBe(0);
        expect(result.files).toHaveLength(0);
        expect(result.warnings).toContain('Symbol "NoSuchSymbol" not found');
    });

    it('should parse LSP WorkspaceEdit correctly', async () => {
        const csContent = [
            'public class Foo {',
            '    Foo instance;',
            '    void UseFoo() { new Foo(); }',
            '}',
        ].join('\n');
        await fsp.writeFile(path.join(tmpDir, 'Foo.cs'), csContent);

        cache.cacheSymbols('hash1', [makeSymbol({
            file_path: 'Foo.cs',
            name: 'Foo',
            fqn: 'Foo',
            kind: 5,
            language: 'csharp',
            range_start_line: 0,
            range_start_char: 13,
        })]);

        // Mock LSP rename returning WorkspaceEdit
        lspManager._mockClient.rename = vi.fn().mockResolvedValue({
            changes: {
                [`file://${tmpDir}/Foo.cs`]: [
                    { range: { start: { line: 0, character: 13 }, end: { line: 0, character: 16 } }, newText: 'Bar' },
                    { range: { start: { line: 1, character: 4 }, end: { line: 1, character: 7 } }, newText: 'Bar' },
                    { range: { start: { line: 2, character: 22 }, end: { line: 2, character: 25 } }, newText: 'Bar' },
                ],
            },
        });

        const result = await service.renamePreview({ name: 'Foo', new_name: 'Bar' });

        expect(result.totalChanges).toBe(3);
        const fileEntry = result.files.find(f => f.file === 'Foo.cs');
        expect(fileEntry).toBeDefined();
        expect(fileEntry!.changes).toHaveLength(3);

        // Line 1: "public class Foo {" → "public class Bar {"
        const line1 = fileEntry!.changes.find(c => c.line === 1);
        expect(line1).toBeDefined();
        expect(line1!.oldText).toBe('public class Foo {');
        expect(line1!.newText).toBe('public class Bar {');

        // Line 2: "    Foo instance;" → "    Bar instance;"
        const line2 = fileEntry!.changes.find(c => c.line === 2);
        expect(line2).toBeDefined();
        expect(line2!.oldText).toBe('    Foo instance;');
        expect(line2!.newText).toBe('    Bar instance;');
    });

    it('should handle multi-file references', async () => {
        // Create two C# files
        await fsp.writeFile(path.join(tmpDir, 'A.cs'),
            'public class Helper {\n    public void DoWork() { }\n}\n');
        await fsp.writeFile(path.join(tmpDir, 'B.cs'),
            'public class User {\n    Helper h = new Helper();\n}\n');

        cache.cacheSymbols('hash1', [makeSymbol({
            file_path: 'A.cs',
            name: 'Helper',
            fqn: 'Helper',
            kind: 5,
            language: 'csharp',
            range_start_line: 0,
            range_start_char: 13,
        })]);

        // References in both files
        lspManager._mockClient.references.mockResolvedValue([
            {
                uri: `file://${tmpDir}/A.cs`,
                range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
            },
            {
                uri: `file://${tmpDir}/B.cs`,
                range: { start: { line: 1, character: 4 }, end: { line: 1, character: 10 } },
            },
        ]);
        lspManager._mockClient.rename = vi.fn().mockResolvedValue(null);

        const result = await service.renamePreview({ name: 'Helper', new_name: 'Utility' });

        expect(result.totalChanges).toBe(2);
        expect(result.files).toHaveLength(2);

        const fileNames = result.files.map(f => f.file).sort();
        expect(fileNames).toEqual(['A.cs', 'B.cs']);

        const aFile = result.files.find(f => f.file === 'A.cs');
        expect(aFile!.changes[0].newText).toContain('Utility');

        const bFile = result.files.find(f => f.file === 'B.cs');
        expect(bFile!.changes[0].newText).toContain('Utility');
    });
});

describe('checkDanglingAliases', () => {
    let dbPath: string;
    let cache: CacheManager;
    let lspManager: ReturnType<typeof createMockLspManager>;
    let service: QueryService;

    beforeEach(() => {
        dbPath = makeTempDb();
        cache = new CacheManager(dbPath);
        lspManager = createMockLspManager();
        service = new QueryService(lspManager, cache, '/workspace/project');
    });

    afterEach(() => {
        cache.close();
        try { fs.unlinkSync(dbPath); } catch {}
        try { fs.rmdirSync(path.dirname(dbPath)); } catch {}
    });

    it('should return empty when lua_aliases table is empty', async () => {
        const result = await service.checkDanglingAliases({});
        expect(result.totalChecked).toBe(0);
        expect(result.danglingCount).toBe(0);
        expect(result.danglingAliases).toHaveLength(0);
    });

    it('should return danglingCount=0 when all aliases exist', async () => {
        // Insert aliases
        cache.db.prepare(
            `INSERT INTO lua_aliases (alias_name, alias_file, alias_line, original_cs_pattern, file_hash)
             VALUES (?, ?, ?, ?, ?)`,
        ).run('C_Player', 'Lua/game/init.lua', 5, 'CS.Game.Player', '');
        cache.db.prepare(
            `INSERT INTO lua_aliases (alias_name, alias_file, alias_line, original_cs_pattern, file_hash)
             VALUES (?, ?, ?, ?, ?)`,
        ).run('C_Enemy', 'Lua/game/init.lua', 6, 'CS.Game.Enemy', '');

        // Mock workspaceSymbol to return matching symbols for both
        lspManager._mockClient.workspaceSymbol.mockImplementation(async (query: string) => {
            if (query === 'Player') {
                return [{
                    name: 'Player',
                    containerName: 'Game',
                    kind: 5,
                    location: {
                        uri: 'file:///workspace/project/Player.cs',
                        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
                    },
                }];
            }
            if (query === 'Enemy') {
                return [{
                    name: 'Enemy',
                    containerName: 'Game',
                    kind: 5,
                    location: {
                        uri: 'file:///workspace/project/Enemy.cs',
                        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                    },
                }];
            }
            return [];
        });

        const result = await service.checkDanglingAliases({});
        expect(result.totalChecked).toBe(2);
        expect(result.danglingCount).toBe(0);
        expect(result.danglingAliases).toHaveLength(0);
    });

    it('should detect dangling aliases when C# FQN not found', async () => {
        // Insert aliases: one exists, one does not
        cache.db.prepare(
            `INSERT INTO lua_aliases (alias_name, alias_file, alias_line, original_cs_pattern, file_hash)
             VALUES (?, ?, ?, ?, ?)`,
        ).run('C_Player', 'Lua/game/init.lua', 5, 'CS.Game.Player', '');
        cache.db.prepare(
            `INSERT INTO lua_aliases (alias_name, alias_file, alias_line, original_cs_pattern, file_hash)
             VALUES (?, ?, ?, ?, ?)`,
        ).run('C_Deleted', 'Lua/game/init.lua', 10, 'CS.Game.DeletedClass', '');

        lspManager._mockClient.workspaceSymbol.mockImplementation(async (query: string) => {
            if (query === 'Player') {
                return [{
                    name: 'Player',
                    containerName: 'Game',
                    kind: 5,
                    location: {
                        uri: 'file:///workspace/project/Player.cs',
                        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
                    },
                }];
            }
            // DeletedClass returns empty
            return [];
        });

        const result = await service.checkDanglingAliases({});
        expect(result.totalChecked).toBe(2);
        expect(result.danglingCount).toBe(1);
        expect(result.danglingAliases).toHaveLength(1);
        expect(result.danglingAliases[0].aliasName).toBe('C_Deleted');
        expect(result.danglingAliases[0].csharpFqn).toBe('Game.DeletedClass');
        expect(result.danglingAliases[0].luaFile).toBe('Lua/game/init.lua');
        expect(result.danglingAliases[0].luaLine).toBe(10);
        expect(result.danglingAliases[0].reason).toBe('C# symbol not found via workspaceSymbol');
    });

    it('should filter by file when file parameter is provided', async () => {
        // Insert aliases in two different files
        cache.db.prepare(
            `INSERT INTO lua_aliases (alias_name, alias_file, alias_line, original_cs_pattern, file_hash)
             VALUES (?, ?, ?, ?, ?)`,
        ).run('C_Player', 'Lua/game/init.lua', 5, 'CS.Game.Player', '');
        cache.db.prepare(
            `INSERT INTO lua_aliases (alias_name, alias_file, alias_line, original_cs_pattern, file_hash)
             VALUES (?, ?, ?, ?, ?)`,
        ).run('C_Other', 'Lua/other/init.lua', 3, 'CS.Game.Other', '');

        // Both not found
        lspManager._mockClient.workspaceSymbol.mockResolvedValue([]);

        const result = await service.checkDanglingAliases({ file: 'Lua/game/init.lua' });
        expect(result.totalChecked).toBe(1);
        expect(result.danglingCount).toBe(1);
        expect(result.danglingAliases).toHaveLength(1);
        expect(result.danglingAliases[0].aliasName).toBe('C_Player');
    });

    it('should deduplicate FQN queries (same FQN from multiple aliases)', async () => {
        // Three aliases pointing to the same FQN
        cache.db.prepare(
            `INSERT INTO lua_aliases (alias_name, alias_file, alias_line, original_cs_pattern, file_hash)
             VALUES (?, ?, ?, ?, ?)`,
        ).run('C_Foo', 'Lua/a.lua', 1, 'CS.Game.Foo', '');
        cache.db.prepare(
            `INSERT INTO lua_aliases (alias_name, alias_file, alias_line, original_cs_pattern, file_hash)
             VALUES (?, ?, ?, ?, ?)`,
        ).run('C_Foo2', 'Lua/b.lua', 2, 'CS.Game.Foo', '');
        cache.db.prepare(
            `INSERT INTO lua_aliases (alias_name, alias_file, alias_line, original_cs_pattern, file_hash)
             VALUES (?, ?, ?, ?, ?)`,
        ).run('C_Foo3', 'Lua/c.lua', 3, 'CS.Game.Foo', '');

        // FQN not found
        lspManager._mockClient.workspaceSymbol.mockResolvedValue([]);

        const result = await service.checkDanglingAliases({});
        expect(result.totalChecked).toBe(3);
        expect(result.danglingCount).toBe(3);

        // workspaceSymbol should only be called once for "Foo" (deduplicated by FQN)
        expect(lspManager._mockClient.workspaceSymbol).toHaveBeenCalledTimes(1);
        expect(lspManager._mockClient.workspaceSymbol).toHaveBeenCalledWith('Foo');
    });

    it('should respect limit parameter', async () => {
        // Insert 5 dangling aliases
        for (let i = 0; i < 5; i++) {
            cache.db.prepare(
                `INSERT INTO lua_aliases (alias_name, alias_file, alias_line, original_cs_pattern, file_hash)
                 VALUES (?, ?, ?, ?, ?)`,
            ).run(`C_Missing${i}`, 'Lua/game/init.lua', i + 1, `CS.Game.Missing${i}`, '');
        }

        lspManager._mockClient.workspaceSymbol.mockResolvedValue([]);

        const result = await service.checkDanglingAliases({ limit: 3 });
        expect(result.totalChecked).toBe(5);
        expect(result.danglingAliases.length).toBeLessThanOrEqual(3);
        expect(result.danglingCount).toBeLessThanOrEqual(3);
    });
});

describe('confidence scoring', () => {
    let dbPath: string;
    let cache: CacheManager;
    let lspManager: ReturnType<typeof createMockLspManager>;
    let service: QueryService;

    beforeEach(() => {
        dbPath = makeTempDb();
        cache = new CacheManager(dbPath);
        lspManager = createMockLspManager();
        service = new QueryService(lspManager, cache, 'C:\\workspace\\project');
    });

    afterEach(() => {
        cache.close();
        try { fs.unlinkSync(dbPath); } catch {}
        try { fs.rmdirSync(path.dirname(dbPath)); } catch {}
    });

    describe('findReferences confidence', () => {
        it('should mark LSP references as exact confidence', async () => {
            cache.cacheSymbols('hash1', [makeSymbol()]);

            lspManager._mockClient.references.mockResolvedValue([
                {
                    uri: 'file:///C:/workspace/project/Assets/Scripts/GameManager.cs',
                    range: { start: { line: 30, character: 10 }, end: { line: 30, character: 16 } },
                },
                {
                    uri: 'file:///C:/workspace/project/Assets/Scripts/UI.cs',
                    range: { start: { line: 5, character: 2 }, end: { line: 5, character: 8 } },
                },
            ]);

            const result = await service.findReferences({ name: 'Player' });
            expect(result.count).toBe(2);
            for (const ref of result.references) {
                expect(ref.confidence).toBe('exact');
            }
        });

        it('should not have confidence on cached references', async () => {
            cache.cacheSymbols('hash1', [makeSymbol()]);
            cache.cacheReferences(
                'Game.Player',
                { file: 'Player.cs', line: 10, char: 0 },
                [
                    { ref_file: 'GameManager.cs', ref_line: 20, ref_char: 5, cached_at: Date.now() },
                ],
            );

            const result = await service.findReferences({ name: 'Player' });
            expect(result.source).toBe('cache');
            // Cached results don't have confidence (they're from a previous query)
            expect(result.references[0].confidence).toBeUndefined();
        });
    });

    describe('findCallChain confidence', () => {
        it('should mark references-based callers as high confidence', async () => {
            cache.cacheSymbols('hash1', [makeSymbol({
                name: 'Attack',
                fqn: 'Game.Player.Attack',
                kind: 6,
                file_path: 'Assets/Scripts/Player.cs',
                range_start_line: 30,
                range_start_char: 8,
            })]);

            lspManager._mockClient.references.mockResolvedValue([
                {
                    uri: 'file:///C:/workspace/project/Assets/Scripts/Combat.cs',
                    range: { start: { line: 50, character: 12 }, end: { line: 50, character: 18 } },
                },
            ]);

            lspManager._mockClient.documentSymbol.mockResolvedValue([{
                name: 'ProcessCombat',
                kind: 6,
                range: { start: { line: 40, character: 0 }, end: { line: 60, character: 1 } },
                selectionRange: { start: { line: 40, character: 4 }, end: { line: 40, character: 17 } },
            }]);

            const result = await service.findCallChain({
                name: 'Attack',
                direction: 'incoming',
                maxDepth: 1,
            });

            expect(result.incoming).toHaveLength(1);
            expect(result.incoming[0].name).toBe('ProcessCombat');
            expect(result.incoming[0].confidence).toBe('high');
        });
    });
});

describe('semanticSearch', () => {
    let tmpDir: string;
    let dbPath: string;
    let cache: CacheManager;
    let service: QueryService;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-search-'));
        dbPath = path.join(tmpDir, 'test.db');
        cache = new CacheManager(dbPath);
        const mockLsp = {
            getClientForFile: vi.fn().mockReturnValue({ state: 'ready' }),
            getClientForLanguage: vi.fn().mockReturnValue({ state: 'ready' }),
            getStatus: vi.fn().mockReturnValue({ csharp: { state: 'ready' }, lua: { state: 'ready' }, allReady: true }),
            getLspStatusForMcp: vi.fn().mockReturnValue({}),
        } as any;
        service = new QueryService(mockLsp, cache, tmpDir);

        // Create test files
        await fsp.writeFile(path.join(tmpDir, 'Player.cs'), [
            '// FooBar is a helper',
            'public void FooBar() {',
            '    obj.FooBar(x);',
            '    string s = "FooBar";',
            '}',
        ].join('\n'));

        await fsp.writeFile(path.join(tmpDir, 'game.lua'), [
            '-- FooBar is used here',
            'function FooBar()',
            '    obj:FooBar(x)',
            'end',
        ].join('\n'));
    });

    afterEach(async () => {
        cache.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('C# comment filtering: // FooBar should be marked as comment', async () => {
        const result = await service.semanticSearch({ pattern: 'FooBar', language: 'csharp' });
        const commentResults = result.results.filter(r => r.context === 'comment');
        expect(commentResults.length).toBeGreaterThanOrEqual(1);
        expect(commentResults.some(r => r.content.includes('// FooBar'))).toBe(true);
    });

    it('C# definition identification: public void FooBar() should be marked as definition', async () => {
        const result = await service.semanticSearch({ pattern: 'FooBar', language: 'csharp' });
        const defResults = result.results.filter(r => r.context === 'definition');
        expect(defResults.length).toBeGreaterThanOrEqual(1);
        expect(defResults.some(r => r.content.includes('public void FooBar()'))).toBe(true);
    });

    it('Lua comment filtering: -- FooBar should be marked as comment', async () => {
        const result = await service.semanticSearch({ pattern: 'FooBar', language: 'lua' });
        const commentResults = result.results.filter(r => r.context === 'comment');
        expect(commentResults.length).toBeGreaterThanOrEqual(1);
        expect(commentResults.some(r => r.content.includes('-- FooBar'))).toBe(true);
    });

    it('Lua function definition: function FooBar() should be marked as definition', async () => {
        const result = await service.semanticSearch({ pattern: 'FooBar', language: 'lua' });
        const defResults = result.results.filter(r => r.context === 'definition');
        expect(defResults.length).toBeGreaterThanOrEqual(1);
        expect(defResults.some(r => r.content.includes('function FooBar()'))).toBe(true);
    });

    it('call identification: obj.FooBar(x) should be marked as call', async () => {
        const result = await service.semanticSearch({ pattern: 'FooBar' });
        const callResults = result.results.filter(r => r.context === 'call');
        expect(callResults.length).toBeGreaterThanOrEqual(1);
        // At least the C# obj.FooBar(x) or Lua obj:FooBar(x) should be call
        expect(callResults.some(r => r.content.includes('FooBar(x)'))).toBe(true);
    });

    it('context filter: context=call should only return call type', async () => {
        const result = await service.semanticSearch({ pattern: 'FooBar', context: 'call' });
        for (const r of result.results) {
            expect(r.context).toBe('call');
        }
        expect(result.results.length).toBeGreaterThan(0);
    });

    it('language filter: language=lua should only search .lua files', async () => {
        const result = await service.semanticSearch({ pattern: 'FooBar', language: 'lua' });
        for (const r of result.results) {
            expect(r.file).toMatch(/\.lua$/);
        }
        expect(result.results.length).toBeGreaterThan(0);
    });

    it('invalid regex pattern should throw error', async () => {
        await expect(service.semanticSearch({ pattern: '[invalid' }))
            .rejects.toThrow('Invalid regex pattern');
    });

    it('respects limit parameter', async () => {
        const result = await service.semanticSearch({ pattern: 'FooBar', limit: 2 });
        expect(result.results.length).toBeLessThanOrEqual(2);
        expect(result.totalMatches).toBeLessThanOrEqual(2);
    });

    it('returns empty results when pattern has no matches', async () => {
        const result = await service.semanticSearch({ pattern: 'NonExistentSymbol12345' });
        expect(result.totalMatches).toBe(0);
        expect(result.results).toHaveLength(0);
    });
});

describe('checkCycles', () => {
    let tmpDir: string;
    let luaDir: string;
    let dbPath: string;
    let cache: CacheManager;
    let service: QueryService;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-cycles-'));
        luaDir = path.join(tmpDir, 'Lua');
        fs.mkdirSync(luaDir, { recursive: true });
        dbPath = path.join(tmpDir, 'test.db');
        cache = new CacheManager(dbPath);
        const mockLsp = {
            getClientForFile: vi.fn().mockReturnValue({ state: 'ready' }),
            getClientForLanguage: vi.fn().mockReturnValue({ state: 'ready' }),
            getStatus: vi.fn().mockReturnValue({
                csharp: { state: 'ready', name: 'csharp-ls' },
                lua: { state: 'ready', name: 'LuaLS' },
            }),
            getLspStatusForMcp: vi.fn().mockReturnValue({ csharp: 'ready', lua: 'ready' }),
        } as any;
        service = new QueryService(mockLsp, cache, tmpDir);
    });

    afterEach(() => {
        cache.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('no cycles: linear dependency a -> b -> c', async () => {
        // Create Lua files with linear dependencies
        fs.writeFileSync(path.join(luaDir, 'a.lua'), 'local b = require("Lua.b")\nreturn {}');
        fs.writeFileSync(path.join(luaDir, 'b.lua'), 'local c = require("Lua.c")\nreturn {}');
        fs.writeFileSync(path.join(luaDir, 'c.lua'), 'return {}');

        const result = await service.checkCycles({});

        expect(result.cyclesFound).toBe(0);
        expect(result.cycles).toHaveLength(0);
        expect(result.totalFilesScanned).toBe(3);
    });

    it('simple cycle: a -> b -> a', async () => {
        fs.writeFileSync(path.join(luaDir, 'a.lua'), 'local b = require("Lua.b")\nreturn {}');
        fs.writeFileSync(path.join(luaDir, 'b.lua'), 'local a = require("Lua.a")\nreturn {}');

        const result = await service.checkCycles({});

        expect(result.cyclesFound).toBe(1);
        expect(result.cycles[0].length).toBe(2);
        // Cycle chain should contain both files and loop back
        const chain = result.cycles[0].chain;
        expect(chain).toHaveLength(3); // [x, y, x]
        expect(chain[0]).toBe(chain[chain.length - 1]); // first = last
        expect(chain).toContain('Lua/a.lua');
        expect(chain).toContain('Lua/b.lua');
    });

    it('three-node cycle: a -> b -> c -> a', async () => {
        fs.writeFileSync(path.join(luaDir, 'a.lua'), 'local b = require("Lua.b")\nreturn {}');
        fs.writeFileSync(path.join(luaDir, 'b.lua'), 'local c = require("Lua.c")\nreturn {}');
        fs.writeFileSync(path.join(luaDir, 'c.lua'), 'local a = require("Lua.a")\nreturn {}');

        const result = await service.checkCycles({});

        expect(result.cyclesFound).toBe(1);
        expect(result.cycles[0].length).toBe(3);
        const chain = result.cycles[0].chain;
        expect(chain).toHaveLength(4); // [x, y, z, x]
        expect(chain[0]).toBe(chain[chain.length - 1]);
    });

    it('multiple independent cycles: a<->b, c<->d', async () => {
        fs.writeFileSync(path.join(luaDir, 'a.lua'), 'local b = require("Lua.b")\nreturn {}');
        fs.writeFileSync(path.join(luaDir, 'b.lua'), 'local a = require("Lua.a")\nreturn {}');
        fs.writeFileSync(path.join(luaDir, 'c.lua'), 'local d = require("Lua.d")\nreturn {}');
        fs.writeFileSync(path.join(luaDir, 'd.lua'), 'local c = require("Lua.c")\nreturn {}');

        const result = await service.checkCycles({});

        expect(result.cyclesFound).toBe(2);
        expect(result.cycles).toHaveLength(2);
    });

    it('from specified file: only detects cycles reachable from that file', async () => {
        // a -> b -> a (cycle), c -> d -> c (independent cycle)
        fs.writeFileSync(path.join(luaDir, 'a.lua'), 'local b = require("Lua.b")\nreturn {}');
        fs.writeFileSync(path.join(luaDir, 'b.lua'), 'local a = require("Lua.a")\nreturn {}');
        fs.writeFileSync(path.join(luaDir, 'c.lua'), 'local d = require("Lua.d")\nreturn {}');
        fs.writeFileSync(path.join(luaDir, 'd.lua'), 'local c = require("Lua.c")\nreturn {}');

        const result = await service.checkCycles({ file: 'Lua/a.lua' });

        // Should only find the a<->b cycle
        expect(result.cyclesFound).toBe(1);
        const chain = result.cycles[0].chain;
        expect(chain).toContain('Lua/a.lua');
        expect(chain).toContain('Lua/b.lua');
        // Should NOT contain c or d
        expect(chain).not.toContain('Lua/c.lua');
        expect(chain).not.toContain('Lua/d.lua');
    });

    it('depth limit: max_depth=2 does not detect 3-level cycles', async () => {
        // a -> b -> c -> a (3-node cycle needs depth > 2 to detect)
        fs.writeFileSync(path.join(luaDir, 'a.lua'), 'local b = require("Lua.b")\nreturn {}');
        fs.writeFileSync(path.join(luaDir, 'b.lua'), 'local c = require("Lua.c")\nreturn {}');
        fs.writeFileSync(path.join(luaDir, 'c.lua'), 'local a = require("Lua.a")\nreturn {}');

        const result = await service.checkCycles({ max_depth: 2 });

        // With max_depth=2, DFS goes a(0)->b(1)->c(2) and then tries to visit a at depth 3 which exceeds limit
        expect(result.cyclesFound).toBe(0);
    });

    it('csharp language returns empty result', async () => {
        const result = await service.checkCycles({ language: 'csharp' });

        expect(result.totalFilesScanned).toBe(0);
        expect(result.cyclesFound).toBe(0);
        expect(result.cycles).toHaveLength(0);
    });

    it('cycle deduplication: same cycle from different starting points', async () => {
        // a -> b -> a forms one cycle, detected from both a and b
        fs.writeFileSync(path.join(luaDir, 'a.lua'), 'local b = require("Lua.b")\nreturn {}');
        fs.writeFileSync(path.join(luaDir, 'b.lua'), 'local a = require("Lua.a")\nreturn {}');

        const result = await service.checkCycles({});

        // Should deduplicate to just 1 cycle
        expect(result.cyclesFound).toBe(1);
    });

    it('skips commented-out requires', async () => {
        fs.writeFileSync(path.join(luaDir, 'a.lua'), '-- local b = require("Lua.b")\nreturn {}');
        fs.writeFileSync(path.join(luaDir, 'b.lua'), 'local a = require("Lua.a")\nreturn {}');

        const result = await service.checkCycles({});

        // a does not actually require b (commented out), so no cycle
        expect(result.cyclesFound).toBe(0);
    });
});
