#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { execSync } from 'child_process';
import * as http from 'http';
import { startMcpServer } from '../mcp/server.js';
import { LspManager } from '../lsp/lsp-manager.js';
import { CacheManager } from '../cache/cache-manager.js';
import { QueryService } from '../core/query-service.js';
import { XLuaBridge } from '../bridge/xlua-bridge.js';
import { FileWatcher } from '../watcher/file-watcher.js';
import { UpdateCoordinator } from '../core/update-coordinator.js';
import { DaemonHttpServer, DEFAULT_PORT } from '../daemon/http-server.js';
import { type CsgConfig, type AdvancedConfig, resolveAdvanced } from '../config.js';
import { setTimeouts } from '../utils/timeout.js';
import { isUnityOldFormat, convertUnityProject } from '../utils/unity-csproj.js';
import { AssetIndex } from '../core/asset-index.js';
import { ProtocolIndex } from '../core/protocol-index.js';

const CONFIG_DIR = '.codesymbolgraph';
const CONFIG_FILE = 'config.json';
const DB_FILE = 'cache.db';
const DAEMON_FILE = 'daemon.json';

interface DaemonInfo {
    pid: number;
    port: number;
    startedAt: string;
}

async function readDaemonInfo(): Promise<DaemonInfo | null> {
    const daemonPath = path.join(process.cwd(), CONFIG_DIR, DAEMON_FILE);
    try {
        const raw = await fs.readFile(daemonPath, 'utf-8');
        return JSON.parse(raw) as DaemonInfo;
    } catch {
        return null;
    }
}

async function writeDaemonInfo(info: DaemonInfo): Promise<void> {
    const daemonPath = path.join(process.cwd(), CONFIG_DIR, DAEMON_FILE);
    await fs.writeFile(daemonPath, JSON.stringify(info, null, 2));
}

async function removeDaemonInfo(): Promise<void> {
    const daemonPath = path.join(process.cwd(), CONFIG_DIR, DAEMON_FILE);
    try { await fs.unlink(daemonPath); } catch { /* ignore */ }
}

/** 检查 daemon 进程是否存活 */
function isDaemonAlive(info: DaemonInfo): boolean {
    try {
        process.kill(info.pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** 通过 HTTP 请求 daemon API */
async function daemonRequest(port: number, method: string, endpoint: string, body?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : undefined;
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: endpoint,
            method,
            headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
                } catch {
                    reject(new Error('Invalid JSON response from daemon'));
                }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function loadConfig(): Promise<{ config: CsgConfig; adv: AdvancedConfig }> {
    const configPath = path.join(process.cwd(), CONFIG_DIR, CONFIG_FILE);
    try {
        const raw = await fs.readFile(configPath, 'utf-8');
        const config: CsgConfig = JSON.parse(raw);
        const adv = resolveAdvanced(config.advanced);
        setTimeouts({ lspTimeoutMs: adv.lspTimeoutMs, lspInitTimeoutMs: adv.lspInitTimeoutMs });
        return { config, adv };
    } catch {
        console.error('Config not found. Run "csg init" first.');
        process.exit(1);
    }
}

/** 自动检测资源名映射文件路径 */
async function detectAssetsFile(workspaceRoot: string, config: CsgConfig): Promise<string | null> {
    if (config.assetsNameFile) {
        const p = path.resolve(workspaceRoot, config.assetsNameFile);
        try { await fs.access(p); return p; } catch { return null; }
    }
    const candidate = path.join(workspaceRoot, 'AssetsNameToolCacheFile.txt');
    try { await fs.access(candidate); return candidate; } catch { return null; }
}

/** 自动检测协议注解目录 */
async function detectAnnotationsDir(workspaceRoot: string, config: CsgConfig): Promise<string | null> {
    if (config.protocolAnnotationsDir) {
        const p = path.resolve(workspaceRoot, config.protocolAnnotationsDir);
        try { await fs.access(p); return p; } catch { return null; }
    }
    const candidates = ['EmmyLuaAnnotations', 'Lua/EmmyLuaAnnotations'];
    for (const dir of candidates) {
        const p = path.join(workspaceRoot, dir);
        try { await fs.access(p); return p; } catch { /* continue */ }
    }
    return null;
}

/**
 * Poll workspace/symbol until the C# LSP returns results, indicating indexing is complete.
 * Falls back to a fixed wait if Lua-only (no C# sln configured).
 */
async function waitForLspIndexing(lspManager: LspManager, maxWaitMs: number): Promise<void> {
    const POLL_INTERVAL = 3000;
    const startTime = Date.now();
    const csharpClient = lspManager.getClientForLanguage('csharp');

    while (Date.now() - startTime < maxWaitMs) {
        try {
            const results = await csharpClient.workspaceSymbol('Object');
            if (results.length > 0) {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`C# LSP indexing ready (${results.length} symbols found, ${elapsed}s)`);
                return;
            }
        } catch {
            // LSP not ready yet, keep polling
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }

    console.warn(`Warning: C# LSP indexing did not complete within ${maxWaitMs / 1000}s, proceeding anyway...`);
}

const program = new Command();

program
    .name('csg')
    .description('CodeSymbolGraph - LSP-based semantic query layer for AI code assistants')
    .version('0.1.0');

// ===== csg init =====
program
    .command('init')
    .description('Initialize project (detect .sln, check LSP installation)')
    .option('--sln <path>', 'Path to .sln file')
    .option('--lua-root <path>', 'Lua files root directory')
    .option('--csharp-lsp <kind>', 'C# LSP: csharp-ls (default) or omnisharp')
    .option('--csharp-lsp-path <path>', 'Path to C# LSP executable')
    .option('--luals-path <path>', 'Path to lua-language-server executable')
    .action(async (options) => {
        console.log('Detecting project...\n');

        // 1. Detect .sln（Unity 项目自动转换旧格式 csproj）
        let slnPath = options.sln;
        if (!slnPath) {
            // 检测是否是 Unity 项目（有旧格式 Assembly-CSharp.csproj）
            const mainCsproj = path.join(process.cwd(), 'Assembly-CSharp.csproj');
            let needsConvert = false;
            try {
                const content = await fs.readFile(mainCsproj, 'utf-8');
                needsConvert = isUnityOldFormat(content);
            } catch { /* file doesn't exist */ }

            if (needsConvert) {
                console.log('[Unity] Detected Unity project, converting .csproj to SDK-style...');
                try {
                    const result = convertUnityProject(process.cwd());
                    slnPath = result.slnPath;
                    console.log(`[OK] Merged ${result.compileItemCount} .cs files from ${result.sourceProjectCount} projects (skipped ${result.skippedCount} editor/player/test)`);
                } catch (e) {
                    console.error(`[!!] Conversion failed: ${(e as Error).message}`);
                    process.exit(1);
                }
            } else {
                // 非 Unity 项目或已转换：直接找 .sln
                const slnFiles = await glob('*.sln', { cwd: process.cwd() });
                if (slnFiles.length === 0) {
                    console.error('No .sln file found.');
                    console.error('Run in project root or use --sln <path>');
                    process.exit(1);
                }
                // 优先使用 -sdk.sln
                slnPath = slnFiles.find(f => f.endsWith('-sdk.sln')) || slnFiles[0];
                if (slnFiles.length > 1) {
                    console.log(`Multiple .sln files found, using: ${slnPath}`);
                }
            }
        }
        console.log(`[OK] .sln: ${slnPath}`);

        // 2. Count files
        const csFiles = await glob('**/*.cs', { cwd: process.cwd(), ignore: ['**/obj/**', '**/bin/**'] });
        console.log(`[OK] C# files: ${csFiles.length}`);

        let luaRoot = options.luaRoot;
        const luaDirs = ['Assets/LuaScripts', 'Assets/Lua', 'LuaScripts', 'Lua', 'lua'];
        if (!luaRoot) {
            for (const dir of luaDirs) {
                try {
                    await fs.access(path.join(process.cwd(), dir));
                    luaRoot = dir;
                    break;
                } catch { /* not exist, continue */ }
            }
        }

        let luaCount = 0;
        if (luaRoot) {
            const luaFiles = await glob(`${luaRoot}/**/*.lua`, { cwd: process.cwd() });
            luaCount = luaFiles.length;
            console.log(`[OK] Lua files: ${luaCount} (${luaRoot}/)`);
        } else {
            console.log('[--] No Lua directory found (LuaLS will be skipped)');
        }

        // 3. Check LSP installation
        console.log('\nChecking LSP servers...\n');

        const csharpLsp = options.csharpLsp || 'csharp-ls';
        let csharpOk = false;
        let luaOk = false;

        let csharpLspPath = options.csharpLspPath || null;
        if (csharpLsp === 'csharp-ls') {
            if (!csharpLspPath) {
                // Try PATH first, then common locations
                try {
                    execSync('csharp-ls --version', { stdio: 'pipe' });
                    csharpLspPath = 'csharp-ls';
                } catch {
                    const home = process.env.USERPROFILE || process.env.HOME || '';
                    const commonPaths = [
                        path.join(home, '.dotnet', 'tools', 'csharp-ls.exe'),
                        path.join(home, '.dotnet', 'tools', 'csharp-ls'),
                    ];
                    for (const p of commonPaths) {
                        try {
                            execSync(`"${p}" --version`, { stdio: 'pipe' });
                            csharpLspPath = p;
                            break;
                        } catch { /* continue */ }
                    }
                }
            }
            if (csharpLspPath) {
                console.log(`[OK] csharp-ls: ${csharpLspPath}`);
                csharpOk = true;
            } else {
                console.error('[!!] csharp-ls not found');
                console.error('     Install: dotnet tool install --global csharp-ls');
                console.error('     Or use --csharp-lsp-path <path>');
            }
        } else {
            try {
                execSync('OmniSharp --version', { stdio: 'pipe' });
                console.log('[OK] OmniSharp: installed');
                csharpOk = true;
            } catch {
                console.error('[!!] OmniSharp not installed');
            }
        }

        // Try to find LuaLS: custom path > PATH > common locations
        let lualsPath = options.lualsPath || null;
        if (!lualsPath) {
            try {
                execSync('lua-language-server --version', { stdio: 'pipe' });
                lualsPath = 'lua-language-server';
            } catch {
                // Check common install locations
                const home = process.env.USERPROFILE || process.env.HOME || '';
                const commonPaths = [
                    path.join(home, 'tools', 'lua-language-server', 'bin', 'lua-language-server.exe'),
                    path.join(home, 'tools', 'lua-language-server', 'bin', 'lua-language-server'),
                    path.join(home, '.local', 'bin', 'lua-language-server'),
                ];
                for (const p of commonPaths) {
                    try {
                        execSync(`"${p}" --version`, { stdio: 'pipe' });
                        lualsPath = p;
                        break;
                    } catch { /* continue */ }
                }
            }
        }

        if (lualsPath) {
            console.log(`[OK] lua-language-server: ${lualsPath}`);
            luaOk = true;
        } else if (luaCount > 0) {
            console.error('[!!] lua-language-server not found');
            console.error('     Download: https://github.com/LuaLS/lua-language-server/releases');
            console.error('     Or use --luals-path <path>');
        } else {
            console.log('[--] lua-language-server: not needed (no Lua files)');
            luaOk = true;
        }

        if (!csharpOk || !luaOk) {
            console.log('\nPlease install missing LSP servers and re-run "csg init"');
            process.exit(1);
        }

        // 4. Write config
        const configDir = path.join(process.cwd(), CONFIG_DIR);
        await fs.mkdir(configDir, { recursive: true });

        const config: CsgConfig = {
            slnPath,
            luaRoot: luaRoot || null,
            csharpLsp,
            csharpLspPath: csharpLspPath,
            lualsPath: lualsPath,
        };

        await fs.writeFile(
            path.join(configDir, CONFIG_FILE),
            JSON.stringify(config, null, 2),
        );

        console.log(`\nConfig written: ${CONFIG_DIR}/${CONFIG_FILE}`);
        console.log('Tip: Add .codesymbolgraph/ to .gitignore');
        console.log('\nNext: run "csg start" or "csg mcp"');
    });

// ===== csg start =====
program
    .command('start')
    .description('Start daemon service (HTTP API + LSP + File Watcher)')
    .option('--port <port>', 'HTTP API port', String(DEFAULT_PORT))
    .action(async (options) => {
        const { config, adv } = await loadConfig();
        const workspaceRoot = process.cwd();
        const dbPath = path.join(workspaceRoot, CONFIG_DIR, DB_FILE);
        const port = parseInt(options.port, 10) || DEFAULT_PORT;

        // 检查是否已有 daemon 在运行
        const existing = await readDaemonInfo();
        if (existing && isDaemonAlive(existing)) {
            console.error(`Daemon already running (pid=${existing.pid}, port=${existing.port})`);
            console.error('Stop it first or use a different --port');
            process.exit(1);
        }

        console.log('Starting CodeSymbolGraph daemon...\n');

        // 防止未捕获异常导致 daemon 崩溃
        process.on('uncaughtException', (err) => {
            console.error(`[DAEMON] Uncaught exception: ${err.message}`);
            console.error(err.stack);
        });
        process.on('unhandledRejection', (reason) => {
            console.error(`[DAEMON] Unhandled rejection: ${reason}`);
        });

        const lspManager = new LspManager({
            workspaceRoot,
            slnPath: config.slnPath,
            luaRoot: config.luaRoot || undefined,
            csharpLsp: config.csharpLsp,
            csharpLspPath: config.csharpLspPath || undefined,
            lualsPath: config.lualsPath || undefined,
            luaVersion: adv.luaVersion,
            lualsMaxPreload: adv.lualsMaxPreload,
            lualsPreloadFileSize: adv.lualsPreloadFileSize,
            healthCheckIntervalMs: adv.healthCheckIntervalMs,
        });

        const cache = new CacheManager(dbPath, {
            cacheMaxEntries: adv.cacheMaxEntries,
            cacheTtlMinutes: adv.cacheTtlMinutes,
            referenceCacheTtlSeconds: adv.referenceCacheTtlSeconds,
            callChainCacheTtlSeconds: adv.callChainCacheTtlSeconds,
        });
        const queryService = new QueryService(lspManager, cache, workspaceRoot);
        const xluaBridge = new XLuaBridge(
            lspManager, cache, workspaceRoot,
            config.luaRoot || workspaceRoot,
            adv.extraThirdPartyNamespaces,
        );

        lspManager.on('log', (e: { level: string; message: string }) => {
            console.log(`[${e.level}] ${e.message}`);
        });

        // 初始化资源索引和协议索引
        const assetIndex = new AssetIndex();
        const protocolIndex = new ProtocolIndex();

        const assetsFile = await detectAssetsFile(workspaceRoot, config);
        if (assetsFile) {
            await assetIndex.load(assetsFile);
            console.log(`Asset index: ${assetIndex.size} entries loaded`);
        }

        const annotationsDir = await detectAnnotationsDir(workspaceRoot, config);
        if (annotationsDir) {
            await protocolIndex.load(annotationsDir);
            console.log(`Protocol index: ${protocolIndex.size} classes loaded`);
        }

        // 索引就绪 Promise
        let resolveIndexing: () => void;
        const indexingReady = new Promise<void>(r => { resolveIndexing = r; });

        // 启动 HTTP 服务器
        const httpServer = new DaemonHttpServer({
            port,
            ctx: { queryService, xluaBridge, lspManager, cache, workspaceRoot, assetIndex, protocolIndex },
            indexingReady,
            onLog: (level, msg) => console.log(`[HTTP] [${level}] ${msg}`),
        });

        let fileWatcher: FileWatcher | null = null;
        let cleaningUp = false;
        const cleanup = async () => {
            if (cleaningUp) return;
            cleaningUp = true;
            console.log('\nShutting down...');
            await removeDaemonInfo();
            if (fileWatcher) await fileWatcher.stop();
            await httpServer.stop();
            await lspManager.stopAll();
            cache.close();
            process.exit(0);
        };
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);

        try {
            await httpServer.start();
        } catch (e) {
            console.error(`Failed to start HTTP server: ${(e as Error).message}`);
            process.exit(1);
        }

        // 写入 daemon.json
        await writeDaemonInfo({ pid: process.pid, port, startedAt: new Date().toISOString() });

        // 启动 LSP
        console.log('Starting LSP servers...');
        await lspManager.startAll();

        const status = lspManager.getStatus();
        console.log(`C# LSP: ${status.csharp.state} (${status.csharp.name})`);
        console.log(`Lua LSP: ${status.lua.state} (${status.lua.name})`);

        // 并行等待 C# + Lua 索引
        console.log('Waiting for indexing...');
        await Promise.all([
            lspManager.waitForCsharpIndexing(180_000),
            config.luaRoot ? lspManager.waitForLuaIndexing(120_000) : Promise.resolve(),
        ]);

        // XLua 扫描
        if (config.luaRoot) {
            try {
                console.log('Running XLua scan...');
                const scanResult = await xluaBridge.fullScan();
                console.log(`XLua scan: ${scanResult.totalCalls} calls, ${scanResult.verified} verified, ${scanResult.unresolved} unresolved (${scanResult.duration}ms)`);
            } catch (err) {
                console.error(`XLua scan failed: ${err}`);
            }
        }

        // 索引完成，解除 HTTP API 阻塞
        resolveIndexing!();
        console.log('All indexes ready, API unblocked');

        // 启动文件监控
        const updateCoordinator = new UpdateCoordinator(
            lspManager, cache, xluaBridge, workspaceRoot,
        );
        fileWatcher = new FileWatcher(workspaceRoot, {
            debounceMs: adv.fileWatcherDebounceMs,
        });

        // 监控资源映射文件变更
        if (assetsFile) {
            fileWatcher.addExtraWatch(assetsFile, () => {
                assetIndex.reload().then(() => {
                    console.log(`[update] Asset index reloaded: ${assetIndex.size} entries`);
                }).catch(err => console.error(`Asset reload failed: ${err}`));
            });
        }

        // 监控注解目录变更
        if (annotationsDir) {
            fileWatcher.addExtraWatch(path.join(annotationsDir, '**/*.lua'), () => {
                protocolIndex.reload().then(() => {
                    console.log(`[update] Protocol index reloaded: ${protocolIndex.size} classes`);
                }).catch(err => console.error(`Protocol reload failed: ${err}`));
            });
        }

        fileWatcher.on('changes', async (changes: import('../watcher/file-watcher.js').FileChange[]) => {
            const result = await updateCoordinator.processChanges(changes);
            console.log(`[update] ${result.filesProcessed} files processed (${result.duration}ms)`);
        });

        fileWatcher.start();
        console.log('File watcher started');

        console.log(`\nDaemon running on http://127.0.0.1:${port}`);
        console.log('Press Ctrl+C to stop.');
    });

// ===== csg mcp =====
program
    .command('mcp')
    .description('Run as MCP Server (for Claude Code integration)')
    .action(async () => {
        const { config, adv } = await loadConfig();
        const workspaceRoot = process.cwd();
        const dbPath = path.join(workspaceRoot, CONFIG_DIR, DB_FILE);

        // 检查是否有 daemon 在运行
        const daemon = await readDaemonInfo();
        if (daemon && isDaemonAlive(daemon)) {
            console.error(`[CSG] Daemon detected (pid=${daemon.pid}, port=${daemon.port}), using proxy mode`);
            const { startMcpProxyServer } = await import('../mcp/server.js');
            await startMcpProxyServer(daemon.port);
            return;
        }

        console.error('[CSG] No daemon detected, starting in standalone mode');

        // 初始化资源索引和协议索引
        const assetIndex = new AssetIndex();
        const protocolIndex = new ProtocolIndex();

        const assetsFile = await detectAssetsFile(workspaceRoot, config);
        if (assetsFile) {
            await assetIndex.load(assetsFile);
            console.error(`[CSG] Asset index: ${assetIndex.size} entries`);
        }
        const annotationsDir = await detectAnnotationsDir(workspaceRoot, config);
        if (annotationsDir) {
            await protocolIndex.load(annotationsDir);
            console.error(`[CSG] Protocol index: ${protocolIndex.size} classes`);
        }

        await startMcpServer({
            workspaceRoot,
            dbPath,
            slnPath: config.slnPath,
            luaRoot: config.luaRoot || undefined,
            csharpLsp: config.csharpLsp,
            csharpLspPath: config.csharpLspPath || undefined,
            lualsPath: config.lualsPath || undefined,
            luaVersion: adv.luaVersion,
            lualsMaxPreload: adv.lualsMaxPreload,
            lualsPreloadFileSize: adv.lualsPreloadFileSize,
            healthCheckIntervalMs: adv.healthCheckIntervalMs,
            extraThirdPartyNamespaces: adv.extraThirdPartyNamespaces,
            cacheOptions: {
                cacheMaxEntries: adv.cacheMaxEntries,
                cacheTtlMinutes: adv.cacheTtlMinutes,
                referenceCacheTtlSeconds: adv.referenceCacheTtlSeconds,
                callChainCacheTtlSeconds: adv.callChainCacheTtlSeconds,
            },
            fileWatcherDebounceMs: adv.fileWatcherDebounceMs,
            assetIndex,
            protocolIndex,
        });
    });

// ===== csg status =====
program
    .command('status')
    .description('Show service status (daemon + cache)')
    .action(async () => {
        // 检查 daemon
        const daemon = await readDaemonInfo();
        if (daemon && isDaemonAlive(daemon)) {
            console.log(`Daemon: running (pid=${daemon.pid}, port=${daemon.port})`);
            console.log(`  Started: ${daemon.startedAt}`);
            try {
                const result = await daemonRequest(daemon.port, 'GET', '/api/status') as any;
                if (result?.success && result.data) {
                    const lsp = result.data.lsp;
                    const cache = result.data.cache;
                    console.log(`  C# LSP:  ${lsp?.csharp?.state} (${lsp?.csharp?.name})`);
                    console.log(`  Lua LSP: ${lsp?.lua?.state} (${lsp?.lua?.name})`);
                    console.log(`  Indexed: C#=${lsp?.indexing?.csharp ? 'yes' : 'no'}`);
                    if (cache) {
                        console.log(`  Cache:   ${cache.symbols} symbols, ${cache.xluaMappings} xlua mappings`);
                    }
                }
            } catch (e) {
                console.log(`  (failed to query daemon: ${(e as Error).message})`);
            }
        } else {
            console.log('Daemon: not running');
            if (daemon) {
                console.log('  (stale daemon.json found, cleaning up)');
                await removeDaemonInfo();
            }
        }

        // 也显示本地缓存统计
        const configDir = path.join(process.cwd(), CONFIG_DIR);
        const dbPath = path.join(configDir, DB_FILE);
        try {
            await fs.access(dbPath);
            const cache = new CacheManager(dbPath);
            const stats = cache.getStats();
            cache.close();
            console.log('\nLocal Cache:');
            console.log(`  Symbols:        ${stats.symbols}`);
            console.log(`  References:     ${stats.references}`);
            console.log(`  XLua mappings:  ${stats.xluaMappings} (${stats.xluaVerified} verified)`);
            console.log(`  Memory cache:   ${stats.memCacheSize} entries`);
        } catch {
            console.log('\nLocal Cache: no database found');
        }
    });

// ===== csg warmup =====
program
    .command('warmup')
    .description('Warm up cache (index all files)')
    .action(async () => {
        const { config, adv } = await loadConfig();
        const workspaceRoot = process.cwd();
        const dbPath = path.join(workspaceRoot, CONFIG_DIR, DB_FILE);

        console.log('Warming up cache...\n');

        const lspManager = new LspManager({
            workspaceRoot,
            slnPath: config.slnPath,
            luaRoot: config.luaRoot || undefined,
            csharpLsp: config.csharpLsp,
            csharpLspPath: config.csharpLspPath || undefined,
            lualsPath: config.lualsPath || undefined,
            luaVersion: adv.luaVersion,
            lualsMaxPreload: adv.lualsMaxPreload,
            lualsPreloadFileSize: adv.lualsPreloadFileSize,
            healthCheckIntervalMs: adv.healthCheckIntervalMs,
        });

        const cache = new CacheManager(dbPath, {
            cacheMaxEntries: adv.cacheMaxEntries,
            cacheTtlMinutes: adv.cacheTtlMinutes,
            referenceCacheTtlSeconds: adv.referenceCacheTtlSeconds,
            callChainCacheTtlSeconds: adv.callChainCacheTtlSeconds,
        });

        lspManager.on('log', (e: { level: string; message: string }) => {
            console.log(`[${e.level}] ${e.message}`);
        });

        console.log('Starting LSP servers...');
        await lspManager.startAll();

        const status = lspManager.getStatus();
        console.log(`C# LSP: ${status.csharp.state}`);
        console.log(`Lua LSP: ${status.lua.state}`);

        // Wait for LSP servers to finish indexing by polling workspace/symbol
        console.log('Waiting for LSP indexing...');
        await waitForLspIndexing(lspManager, adv.lspInitTimeoutMs);

        // XLua scan
        if (config.luaRoot) {
            console.log('\nRunning XLua scan...');
            const xluaBridge = new XLuaBridge(
                lspManager, cache, workspaceRoot,
                config.luaRoot,
                adv.extraThirdPartyNamespaces,
            );
            const scanResult = await xluaBridge.fullScan();
            console.log(`XLua scan: ${scanResult.totalCalls} calls, ${scanResult.verified} verified, ${scanResult.unresolved} unresolved (${scanResult.duration}ms)`);
        }

        const stats = cache.getStats();
        console.log(`\nCache: ${stats.symbols} symbols, ${stats.xluaMappings} xlua mappings`);

        await lspManager.stopAll();
        cache.close();
        console.log('\nWarmup complete.');
    });

// ===== csg query =====
program
    .command('query <tool> [args...]')
    .description('Query daemon API directly (e.g., query find-definition ItemManager)')
    .option('--port <port>', 'Daemon port override')
    .option('--json', 'Raw JSON output')
    .action(async (tool: string, queryArgs: string[], options) => {
        // 找到 daemon
        let port: number;
        if (options.port) {
            port = parseInt(options.port, 10);
        } else {
            const daemon = await readDaemonInfo();
            if (!daemon || !isDaemonAlive(daemon)) {
                console.error('No daemon running. Start one with "csg start"');
                process.exit(1);
            }
            port = daemon.port;
        }

        // 映射工具名到 API 端点
        const toolMap: Record<string, { endpoint: string; method: string }> = {
            'status': { endpoint: '/api/status', method: 'GET' },
            'find-definition': { endpoint: '/api/find-definition', method: 'POST' },
            'find-references': { endpoint: '/api/find-references', method: 'POST' },
            'call-chain': { endpoint: '/api/call-chain', method: 'POST' },
            'cross-lang': { endpoint: '/api/cross-lang', method: 'POST' },
            'impact': { endpoint: '/api/impact', method: 'POST' },
            'find-asset': { endpoint: '/api/find-asset', method: 'POST' },
            'find-protocol': { endpoint: '/api/find-protocol', method: 'POST' },
            'check-lua': { endpoint: '/api/check-lua', method: 'POST' },
            'check-csharp': { endpoint: '/api/check-csharp', method: 'POST' },
        };

        const mapping = toolMap[tool];
        if (!mapping) {
            console.error(`Unknown tool: ${tool}`);
            console.error(`Available: ${Object.keys(toolMap).join(', ')}`);
            process.exit(1);
        }

        // 构建请求体：第一个 arg 作为 name，支持 key=value 格式
        let body: Record<string, unknown> = {};
        if (mapping.method === 'POST') {
            if (queryArgs.length > 0) {
                // 检查是否是 key=value 格式
                const hasKeyValue = queryArgs.some(a => a.includes('='));
                if (hasKeyValue) {
                    for (const arg of queryArgs) {
                        const eqIdx = arg.indexOf('=');
                        if (eqIdx > 0) {
                            const key = arg.substring(0, eqIdx);
                            const val = arg.substring(eqIdx + 1);
                            // 尝试解析数字和布尔值
                            if (val === 'true') body[key] = true;
                            else if (val === 'false') body[key] = false;
                            else if (/^\d+$/.test(val)) body[key] = parseInt(val, 10);
                            else body[key] = val;
                        }
                    }
                } else {
                    // check-lua/check-csharp 的第一个参数是 file，其他工具是 name
                    const firstArgKey = (tool === 'check-lua' || tool === 'check-csharp') ? 'file' : 'name';
                    body[firstArgKey] = queryArgs[0];
                }
            }
        }

        try {
            const result = await daemonRequest(port, mapping.method, mapping.endpoint, mapping.method === 'POST' ? body : undefined);

            if (options.json) {
                console.log(JSON.stringify(result, null, 2));
                return;
            }

            // 格式化输出
            formatQueryResult(tool, result);
        } catch (e) {
            console.error(`Failed to query daemon: ${(e as Error).message}`);
            process.exit(1);
        }
    });

function formatQueryResult(tool: string, result: unknown): void {
    const r = result as any;
    if (!r?.success) {
        console.error(`Error: ${r?.error?.code || 'UNKNOWN'} - ${r?.error?.message || 'Unknown error'}`);
        return;
    }

    const data = r.data;
    switch (tool) {
        case 'status': {
            const lsp = data?.lsp;
            const cache = data?.cache;
            console.log('LSP Status:');
            console.log(`  C#:  ${lsp?.csharp?.state} (${lsp?.csharp?.name})`);
            console.log(`  Lua: ${lsp?.lua?.state} (${lsp?.lua?.name})`);
            console.log(`  C# indexed: ${lsp?.indexing?.csharp ? 'yes' : 'no'}`);
            if (cache) {
                console.log(`\nCache: ${cache.symbols} symbols, ${cache.xluaMappings} xlua`);
            }
            break;
        }

        case 'find-definition': {
            if (Array.isArray(data)) {
                for (const d of data) {
                    console.log(`${d.file}:${d.line} [${d.language}] ${d.fqn || d.name}`);
                    if (d.snippet) console.log(`  ${d.snippet.replace(/\n/g, '\n  ')}`);
                }
                console.log(`\n${data.length} definition(s) found`);
            }
            break;
        }

        case 'find-references': {
            console.log(`Symbol: ${data?.symbol}`);
            const refs = data?.references || [];
            for (const ref of refs.slice(0, 30)) {
                console.log(`  ${ref.file}:${ref.line}`);
                if (ref.snippet) console.log(`    ${ref.snippet.replace(/\n/g, '\n    ')}`);
            }
            console.log(`\n${data?.count || 0} reference(s) (${data?.totalBeforeFilter || 0} before filter)`);
            const cross = data?.crossLanguage || [];
            if (cross.length > 0) {
                console.log(`\nCross-language (Lua): ${cross.length} call site(s)`);
                for (const c of cross.slice(0, 10)) {
                    console.log(`  ${c.file}:${c.line}`);
                }
            }
            break;
        }

        case 'call-chain': {
            console.log(`Root: ${data?.root}`);
            const printChain = (nodes: any[], indent: string) => {
                for (const n of nodes) {
                    console.log(`${indent}← ${n.name} (${n.file}:${n.line})`);
                    if (n.children?.length > 0) printChain(n.children, indent + '  ');
                }
            };
            if (data?.incoming?.length > 0) {
                console.log('Incoming:');
                printChain(data.incoming, '  ');
            }
            if (data?.outgoing?.length > 0) {
                console.log('Outgoing:');
                printChain(data.outgoing, '  ');
            }
            break;
        }

        case 'cross-lang': {
            console.log(`C#: ${data?.csharp?.fqn}`);
            if (data?.csharp?.file) console.log(`  ${data.csharp.file}:${data.csharp.line}`);
            const sites = data?.lua?.callSites || [];
            console.log(`Lua: ${data?.lua?.globalName} (${sites.length} call sites)`);
            for (const s of sites.slice(0, 20)) {
                console.log(`  ${s.file}:${s.line}`);
            }
            break;
        }

        case 'impact': {
            console.log(`Symbol: ${data?.symbol}`);
            console.log(`References: ${data?.totalReferences} (${data?.totalBeforeFilter} before filter)`);
            const files = data?.affectedFiles || [];
            for (const f of files.slice(0, 20)) {
                console.log(`  ${f.file} (${f.count} refs)`);
            }
            const crossImpact = data?.crossLanguageImpact || [];
            if (crossImpact.length > 0) {
                console.log(`\nCross-language impact: ${crossImpact.length} Lua call site(s)`);
            }
            break;
        }

        case 'find-asset': {
            const assets = data?.results || [];
            for (const a of assets) {
                console.log(`${a.shortName}:`);
                for (const p of a.fullPaths) {
                    console.log(`  ${p}`);
                }
            }
            console.log(`\n${data?.count || 0} asset(s) found`);
            break;
        }

        case 'find-protocol': {
            const classes = data?.classes || [];
            for (const c of classes) {
                console.log(`${c.name} [${c.source}] ${c.comment ? '— ' + c.comment : ''}`);
                console.log(`  file: ${c.file}:${c.line}`);
                for (const f of c.fields.slice(0, 20)) {
                    console.log(`  ${f.name}: ${f.type}${f.comment ? '  // ' + f.comment : ''}`);
                }
                if (c.fields.length > 20) console.log(`  ... ${c.fields.length - 20} more fields`);
            }
            console.log(`\n${data?.count || 0} class(es) found`);
            break;
        }

        case 'check-lua':
        case 'check-csharp': {
            console.log(`File: ${data?.file}`);
            const errors = data?.errors || [];
            const warnings = data?.warnings || [];
            if (errors.length > 0) {
                console.log(`\nErrors (${errors.length}):`);
                for (const e of errors.slice(0, 30)) {
                    console.log(`  L${e.line}: ${e.message}`);
                }
            }
            if (warnings.length > 0) {
                console.log(`\nWarnings (${warnings.length}):`);
                for (const w of warnings.slice(0, 30)) {
                    console.log(`  L${w.line}: ${w.message}`);
                }
            }
            console.log(`\nTotal: ${data?.total || 0} diagnostic(s)`);
            break;
        }

        default:
            console.log(JSON.stringify(data, null, 2));
    }
}

// ===== csg stop =====
program
    .command('stop')
    .description('Stop the running daemon')
    .action(async () => {
        const daemon = await readDaemonInfo();
        if (!daemon) {
            console.log('No daemon info found.');
            return;
        }

        if (!isDaemonAlive(daemon)) {
            console.log('Daemon is not running (stale daemon.json, cleaning up)');
            await removeDaemonInfo();
            return;
        }

        console.log(`Stopping daemon (pid=${daemon.pid})...`);
        try {
            process.kill(daemon.pid, 'SIGTERM');
            // 等待进程退出
            for (let i = 0; i < 30; i++) {
                await new Promise(r => setTimeout(r, 200));
                if (!isDaemonAlive(daemon)) break;
            }
            if (isDaemonAlive(daemon)) {
                console.log('Daemon did not stop gracefully, force killing...');
                process.kill(daemon.pid, 'SIGKILL');
            }
        } catch (e) {
            console.error(`Failed to stop: ${(e as Error).message}`);
        }

        await removeDaemonInfo();
        console.log('Daemon stopped.');
    });

program.parse();
