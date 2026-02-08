import { LspManager } from '../lsp/lsp-manager.js';
import { CacheManager } from '../cache/cache-manager.js';
import { XLuaBridge } from '../bridge/xlua-bridge.js';
import { type FileChange } from '../watcher/file-watcher.js';
import { relativeToUri } from '../utils/uri.js';
import * as fs from 'fs/promises';

export interface UpdateResult {
    filesProcessed: number;
    cacheInvalidated: number;
    xluaUpdated: number;
    duration: number;
}

export class UpdateCoordinator {
    constructor(
        private lspManager: LspManager,
        private cache: CacheManager,
        private xluaBridge: XLuaBridge,
        private workspaceRoot: string,
    ) {}

    async processChanges(changes: FileChange[]): Promise<UpdateResult> {
        const startTime = Date.now();
        const result: UpdateResult = {
            filesProcessed: 0,
            cacheInvalidated: 0,
            xluaUpdated: 0,
            duration: 0,
        };

        for (const change of changes) {
            try {
                if (change.type === 'delete') {
                    await this.handleDelete(change);
                } else {
                    await this.handleAddOrChange(change);
                }
                result.filesProcessed++;
            } catch (error) {
                console.error(`Failed to process ${change.relativePath}:`, error);
            }
        }

        result.duration = Date.now() - startTime;
        return result;
    }

    private async handleDelete(change: FileChange): Promise<void> {
        const { relativePath } = change;

        this.cache.invalidateFile(relativePath);

        try {
            const client = this.lspManager.getClientForFile(relativePath);
            const tracker = this.lspManager.getTrackerForFile(relativePath);
            const uri = relativeToUri(this.workspaceRoot, relativePath);
            await tracker.notifyDelete(client, uri);
        } catch { /* notification failure doesn't block */ }
    }

    private async handleAddOrChange(change: FileChange): Promise<void> {
        const { relativePath, absolutePath } = change;

        const content = await fs.readFile(absolutePath, 'utf-8');
        const contentHash = CacheManager.computeFileHash(content);

        this.cache.invalidateFile(relativePath);

        try {
            const client = this.lspManager.getClientForFile(relativePath);
            const tracker = this.lspManager.getTrackerForFile(relativePath);
            const uri = relativeToUri(this.workspaceRoot, relativePath);
            const languageId = relativePath.endsWith('.cs') ? 'csharp' : 'lua';

            await tracker.notifyChange(client, uri, languageId, content);
            await tracker.notifySave(client, uri);
        } catch { /* notification failure doesn't block */ }

        if (relativePath.endsWith('.lua')) {
            try {
                await this.xluaBridge.updateFile(relativePath, content);
            } catch { /* xlua update failure doesn't block */ }
        }

        this.cache.db.prepare(`
            INSERT OR REPLACE INTO files
            (relative_path, worktree_id, content_hash, mtime, size, language, last_indexed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            relativePath, this.getWorktreeId(), contentHash,
            Date.now(), Buffer.byteLength(content),
            relativePath.endsWith('.cs') ? 'csharp' : 'lua',
            Date.now(),
        );
    }

    private getWorktreeId(): string {
        return CacheManager.computeFileHash(this.workspaceRoot);
    }
}
