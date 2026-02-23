/**
 * Daemon HTTP 服务器，使用 Node 内置 http 模块。
 * 所有端点返回 JSON，复用 query-handler 逻辑。
 */
import * as http from 'http';
import {
    type QueryContext,
    handleFindDefinition,
    handleFindReferences,
    handleCallChain,
    handleCrossLang,
    handleImpact,
    handleHierarchy,
    handleStatus,
    handleFindAsset,
    handleFindProtocol,
    handleCheckLua,
    handleCheckCsharp,
} from './query-handler.js';
import { LspTimeoutError } from '../utils/timeout.js';

export const DEFAULT_PORT = 3870;

export interface DaemonHttpServerOptions {
    port?: number;
    ctx: QueryContext;
    /** daemon 就绪 Promise（C# + Lua 索引 + XLua scan 完成后 resolve） */
    indexingReady: Promise<void>;
    onLog?: (level: string, message: string) => void;
}

export class DaemonHttpServer {
    private server: http.Server | null = null;
    private port: number;
    private ctx: QueryContext;
    private indexingReady: Promise<void>;
    private log: (level: string, message: string) => void;

    constructor(options: DaemonHttpServerOptions) {
        this.port = options.port ?? DEFAULT_PORT;
        this.ctx = options.ctx;
        this.indexingReady = options.indexingReady;
        this.log = options.onLog ?? ((level, msg) => console.log(`[HTTP] [${level}] ${msg}`));
    }

    async start(): Promise<number> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => this.handleRequest(req, res));

            this.server.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    reject(new Error(`Port ${this.port} is already in use`));
                } else {
                    reject(err);
                }
            });

            this.server.listen(this.port, '127.0.0.1', () => {
                this.log('info', `HTTP server listening on http://127.0.0.1:${this.port}`);
                resolve(this.port);
            });
        });
    }

    async stop(): Promise<void> {
        if (!this.server) return;
        return new Promise((resolve) => {
            this.server!.close(() => {
                this.log('info', 'HTTP server stopped');
                resolve();
            });
        });
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        // CORS headers for localhost dev
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (req.method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.writeHead(204);
            res.end();
            return;
        }

        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const pathname = url.pathname;

        try {
            if (pathname === '/api/status' && req.method === 'GET') {
                const result = await handleStatus(this.ctx);
                this.sendJson(res, 200, result);
                return;
            }

            // POST 端点
            if (req.method === 'POST') {
                const body = await this.readBody(req);
                let args: Record<string, unknown>;
                try {
                    args = JSON.parse(body);
                } catch {
                    this.sendJson(res, 400, { success: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } });
                    return;
                }

                // find-asset 和 find-protocol 不依赖 LSP 索引，可立即响应
                const noWaitEndpoints = ['/api/find-asset', '/api/find-protocol'];
                if (!noWaitEndpoints.includes(pathname)) {
                    // 等索引就绪（最多 90s）
                    try {
                        await Promise.race([
                            this.indexingReady,
                            new Promise<never>((_, reject) =>
                                setTimeout(() => reject(new Error('Indexing timeout')), 90_000),
                            ),
                        ]);
                    } catch {
                        this.sendJson(res, 503, {
                            success: false,
                            error: { code: 'LSP_NOT_READY', message: 'Indexing still in progress, please retry later' },
                        });
                        return;
                    }
                }

                const result = await this.routePost(pathname, args);
                if (result) {
                    this.sendJson(res, 200, result);
                    return;
                }
            }

            this.sendJson(res, 404, {
                success: false,
                error: { code: 'NOT_FOUND', message: `Unknown endpoint: ${req.method} ${pathname}` },
            });
        } catch (e) {
            const err = e as Error;
            this.log('error', `Request error: ${pathname} - ${err.message}`);

            if (e instanceof LspTimeoutError) {
                this.sendJson(res, 504, {
                    success: false,
                    error: { code: 'LSP_TIMEOUT', message: err.message },
                });
            } else {
                this.sendJson(res, 500, {
                    success: false,
                    error: { code: 'INTERNAL_ERROR', message: err.message },
                });
            }
        }
    }

    private async routePost(pathname: string, args: Record<string, unknown>): Promise<unknown | null> {
        switch (pathname) {
            case '/api/find-definition':
                return handleFindDefinition(this.ctx, args as any);
            case '/api/find-references':
                return handleFindReferences(this.ctx, args as any);
            case '/api/call-chain':
                return handleCallChain(this.ctx, args as any);
            case '/api/cross-lang':
                return handleCrossLang(this.ctx, args as any);
            case '/api/impact':
                return handleImpact(this.ctx, args as any);
            case '/api/hierarchy':
                return handleHierarchy(this.ctx, args as any);
            case '/api/find-asset':
                return handleFindAsset(this.ctx, args as any);
            case '/api/find-protocol':
                return handleFindProtocol(this.ctx, args as any);
            case '/api/check-lua':
                return handleCheckLua(this.ctx, args as any);
            case '/api/check-csharp':
                return handleCheckCsharp(this.ctx, args as any);
            default:
                return null;
        }
    }

    private sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
        res.writeHead(statusCode);
        res.end(JSON.stringify(data));
    }

    private readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
            req.on('error', reject);
        });
    }
}
