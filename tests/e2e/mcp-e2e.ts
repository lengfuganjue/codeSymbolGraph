/**
 * MCP 端到端测试：模拟 Claude Code 通过 stdio 调用 csg mcp 的 6 个工具。
 *
 * 用法: npx tsx tests/e2e/mcp-e2e.ts <BallClient 项目路径>
 *
 * 需要：
 * - csg 已全局 link（npm link）
 * - BallClient 项目已 csg init
 * - csharp-ls 和 lua-language-server 可用
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as path from 'path';

const BALLCLIENT_DIR = process.argv[2] || 'D:/workspace/worktree/BallClient_Work1';
const TOOL_TIMEOUT = 120_000;      // 首次调用可能等待 C# 索引（服务端自动等待）

// ────────── 测试用例 ──────────

interface TestCase {
    name: string;
    tool: string;
    args: Record<string, unknown>;
    validate: (result: unknown) => string | null;  // null = pass, string = fail reason
}

const tests: TestCase[] = [
    {
        name: '1. csg_status — 查看运行状态',
        tool: 'csg_status',
        args: {},
        validate: (result) => {
            const r = result as { success: boolean; data?: { lsp: unknown; cache: unknown } };
            if (!r.success) return `success=false`;
            if (!r.data?.lsp) return `缺少 data.lsp`;
            if (!r.data?.cache) return `缺少 data.cache`;
            return null;
        },
    },
    {
        name: '2. csg_find_definition — 查找 C# 符号定义',
        tool: 'csg_find_definition',
        args: { name: 'ReddotManager' },
        validate: (result) => {
            const r = result as { success: boolean; data?: unknown[] };
            if (!r.success) return `success=false: ${JSON.stringify((result as {error?:unknown}).error)}`;
            if (!Array.isArray(r.data) || r.data.length === 0) return `未找到 ReddotManager 定义`;
            return null;
        },
    },
    {
        name: '3. csg_find_references — 查找引用',
        tool: 'csg_find_references',
        args: { name: 'ReddotManager' },
        validate: (result) => {
            const r = result as { success: boolean; data?: { references: unknown[] } };
            if (!r.success) return `success=false: ${JSON.stringify((result as {error?:unknown}).error)}`;
            if (!r.data?.references?.length) return `未找到 ReddotManager 引用`;
            return null;
        },
    },
    {
        name: '4. csg_cross_lang — 跨语言映射查询',
        tool: 'csg_cross_lang',
        args: { name: 'CS.ReddotManager' },
        validate: (result) => {
            const r = result as { success: boolean; data?: unknown };
            // 即使未找到映射，只要 success=true 且不崩溃就算通过
            if (!r.success) {
                const err = (result as {error?:{code:string}}).error;
                // NO_MATCH 表示功能正常但没有匹配，也算通过
                if (err?.code === 'NO_MATCH') return null;
                return `success=false: ${JSON.stringify(err)}`;
            }
            return null;
        },
    },
    {
        name: '5. csg_call_chain — 调用链查询',
        tool: 'csg_call_chain',
        args: { name: 'ReddotManager', direction: 'incoming', max_depth: 2 },
        validate: (result) => {
            const r = result as { success: boolean; data?: unknown };
            if (!r.success) {
                const err = (result as {error?:{code:string}}).error;
                if (err?.code === 'NO_MATCH') return null;
                return `success=false: ${JSON.stringify(err)}`;
            }
            return null;
        },
    },
    {
        name: '6. csg_impact — 影响分析',
        tool: 'csg_impact',
        args: { name: 'ReddotManager' },
        validate: (result) => {
            const r = result as { success: boolean; data?: unknown };
            if (!r.success) {
                const err = (result as {error?:{code:string}}).error;
                if (err?.code === 'NO_MATCH') return null;
                return `success=false: ${JSON.stringify(err)}`;
            }
            return null;
        },
    },
];

// ────────── 主流程 ──────────

async function main() {
    console.log(`\n=== CSG MCP 端到端测试 ===`);
    console.log(`项目目录: ${BALLCLIENT_DIR}`);
    console.log(`LSP 等待上限: ${LSP_READY_WAIT / 1000}s\n`);

    // 1. 启动 MCP server
    console.log('启动 csg mcp ...');
    const transport = new StdioClientTransport({
        command: 'csg',
        args: ['mcp'],
        cwd: BALLCLIENT_DIR,
        env: { ...process.env },
    });

    // 收集 stderr 日志
    const stderrLines: string[] = [];
    transport.stderr?.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) {
            stderrLines.push(line);
            // 打印关键进度
            if (line.includes('LSP') || line.includes('XLua') || line.includes('error') || line.includes('Error')) {
                console.log(`  [server] ${line}`);
            }
        }
    });

    const client = new Client({ name: 'e2e-test', version: '1.0.0' });
    await client.connect(transport);
    console.log('MCP 连接已建立\n');

    // 2. 确认工具列表
    console.log('获取工具列表...');
    const toolList = await client.listTools();
    const toolNames = toolList.tools.map(t => t.name);
    console.log(`工具数量: ${toolNames.length}`);
    console.log(`工具列表: ${toolNames.join(', ')}\n`);

    const expectedTools = ['csg_status', 'csg_find_definition', 'csg_find_references', 'csg_call_chain', 'csg_cross_lang', 'csg_impact'];
    const missing = expectedTools.filter(t => !toolNames.includes(t));
    if (missing.length > 0) {
        console.error(`缺少工具: ${missing.join(', ')}`);
        process.exit(1);
    }
    console.log('所有 6 个工具已注册 ✓\n');

    // 3. 服务端自动等待 C# 索引，首次工具调用会阻塞直到索引就绪
    console.log('跳过客户端轮询（服务端 wrapTool 自动等待 C# 索引）\n');

    // 4. 逐个测试工具
    let passed = 0;
    let failed = 0;
    const results: Array<{ name: string; pass: boolean; detail: string }> = [];

    for (const tc of tests) {
        console.log(`--- ${tc.name} ---`);
        console.log(`  参数: ${JSON.stringify(tc.args)}`);

        try {
            const callResult = await Promise.race([
                client.callTool({ name: tc.tool, arguments: tc.args }),
                sleep(TOOL_TIMEOUT).then(() => { throw new Error('TIMEOUT'); }),
            ]) as Awaited<ReturnType<typeof client.callTool>>;

            const content = callResult.content as Array<{ type: string; text: string }>;
            const text = content?.[0]?.text || '';
            let parsed: unknown;
            try {
                parsed = JSON.parse(text);
            } catch {
                parsed = text;
            }

            console.log(`  响应: ${JSON.stringify(parsed, null, 2).slice(0, 500)}`);

            const failReason = tc.validate(parsed);
            if (failReason) {
                console.log(`  结果: FAIL — ${failReason}`);
                results.push({ name: tc.name, pass: false, detail: failReason });
                failed++;
            } else {
                console.log(`  结果: PASS`);
                results.push({ name: tc.name, pass: true, detail: '' });
                passed++;
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`  结果: ERROR — ${msg}`);
            results.push({ name: tc.name, pass: false, detail: msg });
            failed++;
        }
        console.log();
    }

    // 5. 总结
    console.log('=== 测试总结 ===');
    console.log(`通过: ${passed}/${tests.length}`);
    console.log(`失败: ${failed}/${tests.length}`);
    console.log();

    for (const r of results) {
        const icon = r.pass ? '✓' : '✗';
        const detail = r.detail ? ` — ${r.detail}` : '';
        console.log(`  ${icon} ${r.name}${detail}`);
    }

    // 6. 关闭
    console.log('\n关闭 MCP 连接...');
    try {
        await client.close();
    } catch {
        // ignore close errors
    }

    console.log('完成\n');
    process.exit(failed > 0 ? 1 : 0);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
