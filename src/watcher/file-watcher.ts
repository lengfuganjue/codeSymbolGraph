import { watch, type FSWatcher } from 'chokidar';
import { EventEmitter } from 'events';
import * as path from 'path';
import { isSupportedFile } from '../utils/uri.js';

export interface FileChange {
    type: 'add' | 'change' | 'delete';
    relativePath: string;
    absolutePath: string;
}

export class FileWatcher extends EventEmitter {
    private watcher: FSWatcher | null = null;
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private pendingChanges = new Map<string, FileChange>();
    private debounceMs: number;

    constructor(
        private workspaceRoot: string,
        options?: { debounceMs?: number },
    ) {
        super();
        this.debounceMs = options?.debounceMs ?? 500;
    }

    start(): void {
        const watchPaths = [
            path.join(this.workspaceRoot, '**/*.cs'),
            path.join(this.workspaceRoot, '**/*.lua'),
        ];

        this.watcher = watch(watchPaths, {
            ignored: [
                '**/node_modules/**',
                '**/Library/**',
                '**/Temp/**',
                '**/.git/**',
                '**/obj/**',
                '**/bin/**',
            ],
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 200,
                pollInterval: 100,
            },
        });

        this.watcher.on('add', (absPath) => this.handleEvent('add', absPath));
        this.watcher.on('change', (absPath) => this.handleEvent('change', absPath));
        this.watcher.on('unlink', (absPath) => this.handleEvent('delete', absPath));

        this.watcher.on('error', (error) => {
            this.emit('error', error);
        });
    }

    async stop(): Promise<void> {
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        this.pendingChanges.clear();

        if (this.watcher) {
            await this.watcher.close();
            this.watcher = null;
        }
    }

    private handleEvent(type: FileChange['type'], absolutePath: string): void {
        const normalized = absolutePath.replace(/\\/g, '/');

        if (!isSupportedFile(normalized)) return;

        const relativePath = path.relative(this.workspaceRoot, absolutePath).replace(/\\/g, '/');

        const change: FileChange = { type, relativePath, absolutePath };
        this.pendingChanges.set(relativePath, change);

        // debounce: 同一文件多次变更合并
        const existing = this.debounceTimers.get(relativePath);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(relativePath, setTimeout(() => {
            this.debounceTimers.delete(relativePath);
            const pendingChange = this.pendingChanges.get(relativePath);
            if (pendingChange) {
                this.pendingChanges.delete(relativePath);
                this.emit('changes', [pendingChange]);
            }
        }, this.debounceMs));
    }
}
