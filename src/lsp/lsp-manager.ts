import { LspClient, type LspClientOptions, type LspState } from './lsp-client.js';
import { OpenFileTracker } from './open-file-tracker.js';
import { EventEmitter } from 'events';
import * as path from 'path';

export type CSharpLspKind = 'csharp-ls' | 'omnisharp';

export interface LspManagerOptions {
    workspaceRoot: string;
    slnPath?: string;
    luaRoot?: string;
    csharpLsp?: CSharpLspKind;
    csharpLspPath?: string;
    lualsPath?: string;
}

export interface LspManagerStatus {
    csharp: { state: LspState; name: string };
    lua: { state: LspState; name: string };
    allReady: boolean;
}

export class LspManager extends EventEmitter {
    private csharpClient: LspClient;
    private luaClient: LspClient;

    readonly csharpTracker = new OpenFileTracker();
    readonly luaTracker = new OpenFileTracker();

    constructor(private options: LspManagerOptions) {
        super();
        this.csharpClient = new LspClient(this.getCSharpOptions());
        this.luaClient = new LspClient(this.getLuaLSOptions());

        for (const client of [this.csharpClient, this.luaClient]) {
            client.on('stateChange', (e) => {
                this.emit('log', {
                    level: 'info',
                    message: `[${client.name}] ${e.from} → ${e.to}`,
                });
            });
            client.on('error', (e: Error) => {
                this.emit('log', {
                    level: 'error',
                    message: `[${client.name}] ${e.message}`,
                });
            });
            client.on('log', (e: { level: string; message: string }) => {
                this.emit('log', e);
            });
        }

        // LSP 重启后重置 tracker
        this.csharpClient.on('ready', () => this.csharpTracker.reset());
        this.luaClient.on('ready', () => this.luaTracker.reset());
    }

    async startAll(): Promise<void> {
        const results = await Promise.allSettled([
            this.csharpClient.start(),
            this.luaClient.start(),
        ]);

        for (const r of results) {
            if (r.status === 'rejected') {
                this.emit('log', {
                    level: 'error',
                    message: `LSP start failed: ${r.reason}`,
                });
            }
        }
    }

    async stopAll(): Promise<void> {
        await Promise.allSettled([
            this.csharpClient.stop(),
            this.luaClient.stop(),
        ]);
    }

    getClientForFile(filePath: string): LspClient {
        if (filePath.endsWith('.cs')) return this.csharpClient;
        if (filePath.endsWith('.lua')) return this.luaClient;
        throw new Error(`Unsupported file type: ${filePath}`);
    }

    getTrackerForFile(filePath: string): OpenFileTracker {
        if (filePath.endsWith('.cs')) return this.csharpTracker;
        if (filePath.endsWith('.lua')) return this.luaTracker;
        throw new Error(`Unsupported file type: ${filePath}`);
    }

    getClientForLanguage(language: 'csharp' | 'lua'): LspClient {
        return language === 'csharp' ? this.csharpClient : this.luaClient;
    }

    getStatus(): LspManagerStatus {
        return {
            csharp: {
                state: this.csharpClient.state,
                name: this.options.csharpLsp || 'csharp-ls',
            },
            lua: {
                state: this.luaClient.state,
                name: 'LuaLS',
            },
            allReady: this.csharpClient.state === 'ready' && this.luaClient.state === 'ready',
        };
    }

    supportsCallHierarchy(filePath: string): boolean {
        const client = this.getClientForFile(filePath);
        const caps = client.capabilities;
        return !!caps?.capabilities?.callHierarchyProvider;
    }

    getLspStatusForMcp(): { csharp: string; lua: string } {
        return {
            csharp: this.csharpClient.state,
            lua: this.luaClient.state,
        };
    }

    private getCSharpOptions(): LspClientOptions {
        const kind = this.options.csharpLsp || 'csharp-ls';

        if (kind === 'csharp-ls') {
            const command = this.options.csharpLspPath || 'csharp-ls';
            const args: string[] = [];
            if (this.options.slnPath) {
                args.push('--solution', this.options.slnPath);
            }
            return {
                name: 'csharp-ls',
                command,
                args,
                workspaceRoot: this.options.workspaceRoot,
                healthCheckInterval: 30000,
                // csharp-ls 0.5.6 crashes (exit code 3) when textDocument capabilities
                // are present in the initialize request. Only send workspace capabilities.
                clientCapabilities: {
                    workspace: {
                        symbol: { dynamicRegistration: false },
                        workspaceFolders: true,
                    },
                },
            };
        } else {
            const command = this.options.csharpLspPath || 'OmniSharp';
            const args: string[] = [
                '--languageserver',
                '--encoding', 'utf-8',
                '--hostPID', String(process.pid),
            ];
            if (this.options.slnPath) {
                args.push('-s', this.options.slnPath);
            }
            return {
                name: 'omnisharp',
                command,
                args,
                workspaceRoot: this.options.workspaceRoot,
                healthCheckInterval: 30000,
            };
        }
    }

    private getLuaLSOptions(): LspClientOptions {
        const lualsPath = this.options.lualsPath || 'lua-language-server';

        return {
            name: 'luals',
            command: lualsPath,
            args: ['--stdio'],
            workspaceRoot: this.options.luaRoot
                ? path.resolve(this.options.workspaceRoot, this.options.luaRoot)
                : this.options.workspaceRoot,
            initOptions: {
                settings: {
                    Lua: {
                        workspace: {
                            library: [],
                            maxPreload: 10000,
                            preloadFileSize: 500,
                        },
                        runtime: { version: 'Lua 5.3' },
                        diagnostics: { enable: false },
                    },
                },
            },
            healthCheckInterval: 30000,
        };
    }
}
