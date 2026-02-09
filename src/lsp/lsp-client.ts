import {
    createProtocolConnection,
    StreamMessageReader,
    StreamMessageWriter,
    InitializeRequest,
    InitializeParams,
    InitializedNotification,
    ShutdownRequest,
    ExitNotification,
    DidOpenTextDocumentNotification,
    DidChangeTextDocumentNotification,
    DidCloseTextDocumentNotification,
    DidSaveTextDocumentNotification,
    DefinitionRequest,
    ReferencesRequest,
    WorkspaceSymbolRequest,
    DocumentSymbolRequest,
    HoverRequest,
    type ProtocolConnection,
    type InitializeResult,
    type Location,
    type SymbolInformation,
    type DocumentSymbol,
    type Hover,
    type CallHierarchyItem,
    type CallHierarchyIncomingCall,
    type CallHierarchyOutgoingCall,
    MarkupKind,
} from 'vscode-languageserver-protocol/node.js';
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { withTimeout, LSP_TIMEOUT_MS, LSP_INIT_TIMEOUT_MS } from '../utils/timeout.js';
import { pathToUri } from '../utils/uri.js';

export interface LspClientOptions {
    name: string;
    command: string;
    args: string[];
    workspaceRoot: string;
    initOptions?: Record<string, unknown>;
    healthCheckInterval?: number;
    /** 最大自动重启次数 (默认 5) */
    maxRestarts?: number;
    /** Override client capabilities (some LSP servers crash on certain fields) */
    clientCapabilities?: object;
}

export type LspState = 'stopped' | 'starting' | 'initializing' | 'ready' | 'error';

export class LspClient extends EventEmitter {
    private process: ChildProcess | null = null;
    private connection: ProtocolConnection | null = null;
    private _state: LspState = 'stopped';
    private restartCount = 0;
    private healthTimer: ReturnType<typeof setInterval> | null = null;
    private _capabilities: InitializeResult | null = null;

    constructor(private options: LspClientOptions) {
        super();
    }

    get state(): LspState { return this._state; }
    get capabilities(): InitializeResult | null { return this._capabilities; }
    get name(): string { return this.options.name; }

    async start(): Promise<void> {
        this.setState('starting');

        try {
            this.process = spawn(this.options.command, this.options.args, {
                cwd: this.options.workspaceRoot,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env },
            });

            this.process.on('error', (err) => {
                this.emit('log', { level: 'error', message: `Process error: ${err.message}` });
                this.setState('error');
            });

            this.process.on('exit', (code, signal) => {
                this.handleProcessExit(code, signal);
            });

            this.process.stderr?.on('data', (data: Buffer) => {
                this.emit('log', { level: 'stderr', message: data.toString().trim() });
            });

            this.connection = createProtocolConnection(
                new StreamMessageReader(this.process.stdout!),
                new StreamMessageWriter(this.process.stdin!),
            );

            // Handle server-to-client requests that block if unhandled
            this.connection.onRequest('client/registerCapability', () => ({}));
            this.connection.onRequest('client/unregisterCapability', () => ({}));
            // csharp-ls 0.20+ requests workspace configuration on init
            this.connection.onRequest('workspace/configuration', () => [{}]);

            this.connection.listen();

            this.setState('initializing');

            const initParams: InitializeParams = {
                processId: null,
                rootUri: pathToUri(this.options.workspaceRoot),
                capabilities: this.options.clientCapabilities ?? this.getClientCapabilities(),
                initializationOptions: this.options.initOptions,
                workspaceFolders: [{
                    uri: pathToUri(this.options.workspaceRoot),
                    name: this.options.name,
                }],
            };

            this._capabilities = await withTimeout(
                this.connection.sendRequest(InitializeRequest.type, initParams),
                LSP_INIT_TIMEOUT_MS,
                'initialize',
            );

            await this.connection.sendNotification(InitializedNotification.type, {});

            this.setState('ready');
            this.restartCount = 0;
            this.startHealthCheck();
            this.emit('ready', this._capabilities);

        } catch (error) {
            this.setState('error');
            this.emit('error', error);
            throw error;
        }
    }

    async stop(): Promise<void> {
        this.stopHealthCheck();

        if (this.connection) {
            try {
                await withTimeout(
                    this.connection.sendRequest(ShutdownRequest.type),
                    5000,
                    'shutdown',
                );
                await this.connection.sendNotification(ExitNotification.type);
            } catch {
                // ignore shutdown errors
            }
            this.connection.dispose();
            this.connection = null;
        }

        if (this.process && !this.process.killed) {
            this.process.kill('SIGTERM');
            setTimeout(() => {
                if (this.process && !this.process.killed) {
                    this.process.kill('SIGKILL');
                }
            }, 5000);
        }

        this.setState('stopped');
    }

    // ===== LSP 请求封装 =====

    async definition(uri: string, line: number, character: number): Promise<Location | Location[] | null> {
        this.ensureReady();
        return withTimeout(
            this.connection!.sendRequest(DefinitionRequest.type, {
                textDocument: { uri },
                position: { line, character },
            }),
            LSP_TIMEOUT_MS,
            'textDocument/definition',
        ) as Promise<Location | Location[] | null>;
    }

    async references(
        uri: string, line: number, character: number,
        includeDeclaration = false,
    ): Promise<Location[]> {
        this.ensureReady();
        const result = await withTimeout(
            this.connection!.sendRequest(ReferencesRequest.type, {
                textDocument: { uri },
                position: { line, character },
                context: { includeDeclaration },
            }),
            LSP_TIMEOUT_MS,
            'textDocument/references',
        );
        return result || [];
    }

    async workspaceSymbol(query: string): Promise<SymbolInformation[]> {
        this.ensureReady();
        const result = await withTimeout(
            this.connection!.sendRequest(WorkspaceSymbolRequest.type, { query }),
            LSP_TIMEOUT_MS,
            'workspace/symbol',
        );
        return (result || []) as SymbolInformation[];
    }

    async documentSymbol(uri: string): Promise<(SymbolInformation | DocumentSymbol)[]> {
        this.ensureReady();
        const result = await withTimeout(
            this.connection!.sendRequest(DocumentSymbolRequest.type, {
                textDocument: { uri },
            }),
            LSP_TIMEOUT_MS,
            'textDocument/documentSymbol',
        );
        return result || [];
    }

    async callHierarchyPrepare(uri: string, line: number, character: number): Promise<CallHierarchyItem[]> {
        this.ensureReady();
        const result = await withTimeout(
            this.connection!.sendRequest('textDocument/prepareCallHierarchy', {
                textDocument: { uri },
                position: { line, character },
            }),
            LSP_TIMEOUT_MS,
            'textDocument/prepareCallHierarchy',
        );
        return (result as CallHierarchyItem[]) || [];
    }

    async callHierarchyIncoming(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[]> {
        this.ensureReady();
        const result = await withTimeout(
            this.connection!.sendRequest('callHierarchy/incomingCalls', { item }),
            LSP_TIMEOUT_MS,
            'callHierarchy/incomingCalls',
        );
        return (result as CallHierarchyIncomingCall[]) || [];
    }

    async callHierarchyOutgoing(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[]> {
        this.ensureReady();
        const result = await withTimeout(
            this.connection!.sendRequest('callHierarchy/outgoingCalls', { item }),
            LSP_TIMEOUT_MS,
            'callHierarchy/outgoingCalls',
        );
        return (result as CallHierarchyOutgoingCall[]) || [];
    }

    async hover(uri: string, line: number, character: number): Promise<Hover | null> {
        this.ensureReady();
        return withTimeout(
            this.connection!.sendRequest(HoverRequest.type, {
                textDocument: { uri },
                position: { line, character },
            }),
            LSP_TIMEOUT_MS,
            'textDocument/hover',
        );
    }

    // ===== LSP 文件通知 =====

    async didOpen(uri: string, languageId: string, content: string): Promise<void> {
        this.ensureReady();
        await this.connection!.sendNotification(DidOpenTextDocumentNotification.type, {
            textDocument: { uri, languageId, version: 1, text: content },
        });
    }

    async didChange(uri: string, content: string, version: number): Promise<void> {
        this.ensureReady();
        await this.connection!.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: { uri, version },
            contentChanges: [{ text: content }],
        });
    }

    async didClose(uri: string): Promise<void> {
        this.ensureReady();
        await this.connection!.sendNotification(DidCloseTextDocumentNotification.type, {
            textDocument: { uri },
        });
    }

    async didSave(uri: string): Promise<void> {
        this.ensureReady();
        await this.connection!.sendNotification(DidSaveTextDocumentNotification.type, {
            textDocument: { uri },
        });
    }

    // ===== 内部方法 =====

    private ensureReady(): void {
        if (this._state !== 'ready') {
            throw new Error(`LSP ${this.options.name} is not ready (state: ${this._state})`);
        }
        if (!this.connection) {
            throw new Error(`LSP ${this.options.name} has no connection`);
        }
    }

    private setState(state: LspState): void {
        const prev = this._state;
        this._state = state;
        this.emit('stateChange', { from: prev, to: state });
    }

    private getClientCapabilities() {
        return {
            textDocument: {
                definition: { dynamicRegistration: false },
                references: { dynamicRegistration: false },
                documentSymbol: {
                    dynamicRegistration: false,
                    hierarchicalDocumentSymbolSupport: true,
                },
                callHierarchy: { dynamicRegistration: false },
                hover: {
                    dynamicRegistration: false,
                    contentFormat: [MarkupKind.Markdown, MarkupKind.PlainText],
                },
                synchronization: {
                    didSave: true,
                    willSave: false,
                    willSaveWaitUntil: false,
                },
            },
            workspace: {
                symbol: { dynamicRegistration: false },
                workspaceFolders: true,
            },
        };
    }

    private handleProcessExit(code: number | null, signal: string | null): void {
        this.emit('log', {
            level: 'warn',
            message: `LSP ${this.options.name} exited (code: ${code}, signal: ${signal})`,
        });

        if (this._state !== 'stopped') {
            this.setState('error');
            this.tryRestart();
        }
    }

    private async tryRestart(): Promise<void> {
        const maxRestarts = this.options.maxRestarts ?? 5;
        const backoffMs = Math.min(1000 * Math.pow(2, this.restartCount), 30000);

        if (this.restartCount >= maxRestarts) {
            this.emit('error', new Error(
                `LSP ${this.options.name} crashed ${maxRestarts} times, giving up`,
            ));
            return;
        }

        this.restartCount++;
        this.emit('log', {
            level: 'info',
            message: `Restarting ${this.options.name} in ${backoffMs}ms (attempt ${this.restartCount})`,
        });

        await new Promise(r => setTimeout(r, backoffMs));

        try {
            await this.start();
        } catch (error) {
            this.emit('error', error);
        }
    }

    private startHealthCheck(): void {
        const interval = this.options.healthCheckInterval || 30000;

        this.healthTimer = setInterval(async () => {
            try {
                await withTimeout(
                    this.connection!.sendRequest(WorkspaceSymbolRequest.type, { query: '' }),
                    5000,
                    'healthCheck',
                );
                this.emit('healthCheck', { status: 'ok' });
            } catch (error) {
                this.emit('healthCheck', { status: 'unhealthy', error });
            }
        }, interval);
    }

    private stopHealthCheck(): void {
        if (this.healthTimer) {
            clearInterval(this.healthTimer);
            this.healthTimer = null;
        }
    }
}
