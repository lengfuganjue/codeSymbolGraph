import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UpdateCoordinator } from '../../src/core/update-coordinator.js';
import { CacheManager } from '../../src/cache/cache-manager.js';
import type { FileChange } from '../../src/watcher/file-watcher.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function makeTempDb(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-uc-'));
    return path.join(dir, 'test.db');
}

function createMockLspManager() {
    const mockClient = {
        state: 'ready',
        didOpen: vi.fn().mockResolvedValue(undefined),
        didChange: vi.fn().mockResolvedValue(undefined),
        didClose: vi.fn().mockResolvedValue(undefined),
        didSave: vi.fn().mockResolvedValue(undefined),
    };

    const mockTracker = {
        notifyChange: vi.fn().mockResolvedValue(undefined),
        notifySave: vi.fn().mockResolvedValue(undefined),
        notifyDelete: vi.fn().mockResolvedValue(undefined),
    };

    return {
        getClientForFile: vi.fn().mockReturnValue(mockClient),
        getTrackerForFile: vi.fn().mockReturnValue(mockTracker),
        _mockClient: mockClient,
        _mockTracker: mockTracker,
    } as any;
}

function createMockXLuaBridge() {
    return {
        updateFile: vi.fn().mockResolvedValue(undefined),
    } as any;
}

describe('UpdateCoordinator', () => {
    let dbPath: string;
    let cache: CacheManager;
    let lspManager: ReturnType<typeof createMockLspManager>;
    let xluaBridge: ReturnType<typeof createMockXLuaBridge>;
    let coordinator: UpdateCoordinator;
    let tmpDir: string;

    beforeEach(() => {
        dbPath = makeTempDb();
        cache = new CacheManager(dbPath);
        lspManager = createMockLspManager();
        xluaBridge = createMockXLuaBridge();

        // Create temp workspace with test files
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-ws-'));
        fs.writeFileSync(path.join(tmpDir, 'test.cs'), 'class Foo {}');
        fs.writeFileSync(path.join(tmpDir, 'test.lua'), 'local x = 1');

        coordinator = new UpdateCoordinator(
            lspManager, cache, xluaBridge, tmpDir,
        );
    });

    afterEach(() => {
        cache.close();
        try { fs.unlinkSync(dbPath); } catch {}
        try { fs.rmdirSync(path.dirname(dbPath)); } catch {}
        try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    });

    it('should process add/change for C# files', async () => {
        const changes: FileChange[] = [{
            type: 'change',
            relativePath: 'test.cs',
            absolutePath: path.join(tmpDir, 'test.cs'),
        }];

        const result = await coordinator.processChanges(changes);

        expect(result.filesProcessed).toBe(1);
        expect(result.duration).toBeGreaterThanOrEqual(0);

        // Should notify LSP
        expect(lspManager._mockTracker.notifyChange).toHaveBeenCalledTimes(1);
        expect(lspManager._mockTracker.notifySave).toHaveBeenCalledTimes(1);

        // Should NOT call XLua bridge for .cs files
        expect(xluaBridge.updateFile).not.toHaveBeenCalled();
    });

    it('should process add/change for Lua files and update XLua bridge', async () => {
        const changes: FileChange[] = [{
            type: 'change',
            relativePath: 'test.lua',
            absolutePath: path.join(tmpDir, 'test.lua'),
        }];

        const result = await coordinator.processChanges(changes);

        expect(result.filesProcessed).toBe(1);

        // Should notify LSP
        expect(lspManager._mockTracker.notifyChange).toHaveBeenCalledTimes(1);

        // Should call XLua bridge for .lua files
        expect(xluaBridge.updateFile).toHaveBeenCalledTimes(1);
        expect(xluaBridge.updateFile).toHaveBeenCalledWith('test.lua', 'local x = 1');
    });

    it('should process delete events', async () => {
        const changes: FileChange[] = [{
            type: 'delete',
            relativePath: 'deleted.cs',
            absolutePath: path.join(tmpDir, 'deleted.cs'),
        }];

        const result = await coordinator.processChanges(changes);

        expect(result.filesProcessed).toBe(1);

        // Should notify LSP tracker of deletion
        expect(lspManager._mockTracker.notifyDelete).toHaveBeenCalledTimes(1);
    });

    it('should process multiple changes', async () => {
        const changes: FileChange[] = [
            {
                type: 'change',
                relativePath: 'test.cs',
                absolutePath: path.join(tmpDir, 'test.cs'),
            },
            {
                type: 'change',
                relativePath: 'test.lua',
                absolutePath: path.join(tmpDir, 'test.lua'),
            },
        ];

        const result = await coordinator.processChanges(changes);
        expect(result.filesProcessed).toBe(2);
    });

    it('should record file info in database', async () => {
        const changes: FileChange[] = [{
            type: 'add',
            relativePath: 'test.cs',
            absolutePath: path.join(tmpDir, 'test.cs'),
        }];

        await coordinator.processChanges(changes);

        // Check file was recorded in DB
        const row = cache.db.prepare(
            'SELECT * FROM files WHERE relative_path = ?',
        ).get('test.cs') as Record<string, unknown> | undefined;

        expect(row).toBeDefined();
        expect(row!.language).toBe('csharp');
        expect(row!.content_hash).toBeTruthy();
    });

    it('should continue processing when one file fails', async () => {
        // Make the first file's LSP notification throw
        let callCount = 0;
        lspManager._mockTracker.notifyChange.mockImplementation(async () => {
            callCount++;
            if (callCount === 1) throw new Error('LSP failed');
        });

        const changes: FileChange[] = [
            {
                type: 'change',
                relativePath: 'test.cs',
                absolutePath: path.join(tmpDir, 'test.cs'),
            },
            {
                type: 'change',
                relativePath: 'test.lua',
                absolutePath: path.join(tmpDir, 'test.lua'),
            },
        ];

        const result = await coordinator.processChanges(changes);

        // Both files are "processed" — LSP notification failures are caught internally
        // and don't prevent the file from being recorded
        expect(result.filesProcessed).toBe(2);
    });
});
