#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { execSync } from 'child_process';
import { startMcpServer } from '../mcp/server.js';
import { LspManager } from '../lsp/lsp-manager.js';
import { CacheManager } from '../cache/cache-manager.js';
import { QueryService } from '../core/query-service.js';
import { XLuaBridge } from '../bridge/xlua-bridge.js';
import { FileWatcher } from '../watcher/file-watcher.js';
import { UpdateCoordinator } from '../core/update-coordinator.js';
import { type CsgConfig, type AdvancedConfig, resolveAdvanced } from '../config.js';
import { setTimeouts } from '../utils/timeout.js';

const CONFIG_DIR = '.codesymbolgraph';
const CONFIG_FILE = 'config.json';
const DB_FILE = 'cache.db';

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

        // 1. Detect .sln
        let slnPath = options.sln;
        if (!slnPath) {
            const slnFiles = await glob('*.sln', { cwd: process.cwd() });
            if (slnFiles.length === 0) {
                console.error('No .sln file found.');
                console.error('Run in project root or use --sln <path>');
                process.exit(1);
            }
            slnPath = slnFiles[0];
            if (slnFiles.length > 1) {
                console.warn(`Multiple .sln files found, using: ${slnPath}`);
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
    .description('Start background service (LSP + File Watcher + MCP Server)')
    .action(async () => {
        const { config, adv } = await loadConfig();
        const workspaceRoot = process.cwd();
        const dbPath = path.join(workspaceRoot, CONFIG_DIR, DB_FILE);

        console.log('Starting CodeSymbolGraph...\n');

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
        const updateCoordinator = new UpdateCoordinator(
            lspManager, cache, xluaBridge, workspaceRoot,
        );
        const fileWatcher = new FileWatcher(workspaceRoot, {
            debounceMs: adv.fileWatcherDebounceMs,
        });

        lspManager.on('log', (e: { level: string; message: string }) => {
            console.log(`[${e.level}] ${e.message}`);
        });

        fileWatcher.on('changes', async (changes: import('../watcher/file-watcher.js').FileChange[]) => {
            const result = await updateCoordinator.processChanges(changes);
            console.log(`[update] ${result.filesProcessed} files processed (${result.duration}ms)`);
        });

        // Start LSP
        console.log('Starting LSP servers...');
        await lspManager.startAll();

        const status = lspManager.getStatus();
        console.log(`C# LSP: ${status.csharp.state} (${status.csharp.name})`);
        console.log(`Lua LSP: ${status.lua.state} (${status.lua.name})`);

        // Start watcher
        fileWatcher.start();
        console.log('File watcher started');

        console.log('\nCodeSymbolGraph is running. Press Ctrl+C to stop.');

        // Cleanup on exit
        const cleanup = async () => {
            console.log('\nShutting down...');
            await fileWatcher.stop();
            await lspManager.stopAll();
            cache.close();
            process.exit(0);
        };

        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
    });

// ===== csg mcp =====
program
    .command('mcp')
    .description('Run as MCP Server (for Claude Code integration)')
    .action(async () => {
        const { config, adv } = await loadConfig();
        const workspaceRoot = process.cwd();
        const dbPath = path.join(workspaceRoot, CONFIG_DIR, DB_FILE);

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
        });
    });

// ===== csg status =====
program
    .command('status')
    .description('Show service status')
    .action(async () => {
        const configDir = path.join(process.cwd(), CONFIG_DIR);
        const dbPath = path.join(configDir, DB_FILE);

        try {
            await fs.access(dbPath);
        } catch {
            console.log('No cache database found. Run "csg start" first.');
            return;
        }

        const cache = new CacheManager(dbPath);
        const stats = cache.getStats();
        cache.close();

        console.log('Cache Statistics:');
        console.log(`  Symbols:        ${stats.symbols}`);
        console.log(`  References:     ${stats.references}`);
        console.log(`  XLua mappings:  ${stats.xluaMappings} (${stats.xluaVerified} verified)`);
        console.log(`  Memory cache:   ${stats.memCacheSize} entries`);
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

program.parse();
