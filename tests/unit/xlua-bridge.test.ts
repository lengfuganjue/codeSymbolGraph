import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { XLuaBridge } from '../../src/bridge/xlua-bridge.js';
import { CacheManager } from '../../src/cache/cache-manager.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SymbolInformation } from 'vscode-languageserver-protocol';

// XLuaBridge 的 extractCsCalls 和 extractAliases 是 private 方法
// 这里通过直接测试正则来验证其核心逻辑

const CS_CALL_PATTERN = /CS\.([\w.]+)[:\.](\w+)\s*\(/g;
const CS_ALIAS_PATTERN = /local\s+(\w+)\s*=\s*CS\.([\w.]+)\s*$/gm;
const CS_GLOBAL_ALIAS_PATTERN = /^(\w+)\s*=\s*CS\.([\w.]+)\s*$/gm;

/**
 * GetComponent 动态绑定正则（与 xlua-bridge.ts 保持一致）
 * group1=fieldName, group2=字符串参数, group3=CS.参数
 */
const GETCOMPONENT_PATTERN =
    /\bself\.(\w+)\s*=\s*\w+:GetComponent\s*\(\s*(?:"([\w.]+)"|CS\.([\w.]+))\s*\)/gm;

function extractGetComponentFields(content: string) {
    const fields: { fieldName: string; typeName: string; isShortName: boolean }[] = [];
    let match;
    GETCOMPONENT_PATTERN.lastIndex = 0;
    while ((match = GETCOMPONENT_PATTERN.exec(content)) !== null) {
        const fieldName = match[1];
        const stringArg = match[2];
        const csArg = match[3];
        if (csArg) {
            fields.push({ fieldName, typeName: csArg, isShortName: false });
        } else if (stringArg) {
            fields.push({ fieldName, typeName: stringArg, isShortName: true });
        }
    }
    return fields;
}

function extractCsCalls(content: string) {
    const calls: { pattern: string; className: string; memberName: string; line: number }[] = [];
    let match;
    CS_CALL_PATTERN.lastIndex = 0;
    while ((match = CS_CALL_PATTERN.exec(content)) !== null) {
        let line = 1;
        for (let i = 0; i < match.index; i++) {
            if (content[i] === '\n') line++;
        }
        const className = match[1];
        const memberName = match[2];
        const separator = match[0].includes(':') ? ':' : '.';
        calls.push({
            pattern: `CS.${className}${separator}${memberName}`,
            className,
            memberName,
            line,
        });
    }
    return calls;
}

function extractAliases(content: string) {
    const aliases: { aliasName: string; originalPattern: string; line: number }[] = [];
    let match;

    // local aliases
    CS_ALIAS_PATTERN.lastIndex = 0;
    while ((match = CS_ALIAS_PATTERN.exec(content)) !== null) {
        let line = 1;
        for (let i = 0; i < match.index; i++) {
            if (content[i] === '\n') line++;
        }
        aliases.push({
            aliasName: match[1],
            originalPattern: `CS.${match[2]}`,
            line,
        });
    }

    // global aliases
    CS_GLOBAL_ALIAS_PATTERN.lastIndex = 0;
    while ((match = CS_GLOBAL_ALIAS_PATTERN.exec(content)) !== null) {
        let line = 1;
        for (let i = 0; i < match.index; i++) {
            if (content[i] === '\n') line++;
        }
        aliases.push({
            aliasName: match[1],
            originalPattern: `CS.${match[2]}`,
            line,
        });
    }

    return aliases;
}

describe('XLua regex patterns', () => {
    describe('CS_CALL_PATTERN', () => {
        it('should match CS.Namespace.Class:Method( pattern', () => {
            const content = 'CS.Game.ItemManager:AddItem(id, count)';
            const calls = extractCsCalls(content);
            expect(calls).toHaveLength(1);
            expect(calls[0].className).toBe('Game.ItemManager');
            expect(calls[0].memberName).toBe('AddItem');
            expect(calls[0].pattern).toBe('CS.Game.ItemManager:AddItem');
        });

        it('should match CS.Namespace.Class.Method( pattern (dot separator)', () => {
            const content = 'CS.Game.UIManager.Show(param)';
            const calls = extractCsCalls(content);
            expect(calls).toHaveLength(1);
            expect(calls[0].className).toBe('Game.UIManager');
            expect(calls[0].memberName).toBe('Show');
            expect(calls[0].pattern).toBe('CS.Game.UIManager.Show');
        });

        it('should match multiple calls in one file', () => {
            const content = `
local mgr = CS.Game.ItemManager:GetInstance()
mgr:AddItem(1, 10)
CS.Game.UIManager.Show("shop")
CS.UnityEngine.Debug:Log("test")
`;
            const calls = extractCsCalls(content);
            expect(calls).toHaveLength(3);
            expect(calls[0].className).toBe('Game.ItemManager');
            expect(calls[1].className).toBe('Game.UIManager');
            expect(calls[2].className).toBe('UnityEngine.Debug');
        });

        it('should match single-level namespace', () => {
            const content = 'CS.Vector3:New(0, 0, 0)';
            const calls = extractCsCalls(content);
            expect(calls).toHaveLength(1);
            expect(calls[0].className).toBe('Vector3');
            expect(calls[0].memberName).toBe('New');
        });

        it('should not match non-CS patterns', () => {
            const content = `
local x = SomeLib.Foo:Bar()
print("CS.Not.ACall")
`;
            const calls = extractCsCalls(content);
            expect(calls).toHaveLength(0);
        });

        it('should report correct line numbers', () => {
            const content = `-- line 1
-- line 2
CS.Game.Player:Move(x, y)
-- line 4
CS.Game.Enemy:Attack(target)
`;
            const calls = extractCsCalls(content);
            expect(calls).toHaveLength(2);
            expect(calls[0].line).toBe(3);
            expect(calls[1].line).toBe(5);
        });
    });

    describe('CS_ALIAS_PATTERN (local)', () => {
        it('should match local alias assignments', () => {
            const content = 'local ItemMgr = CS.Game.ItemManager';
            const aliases = extractAliases(content);
            expect(aliases).toHaveLength(1);
            expect(aliases[0].aliasName).toBe('ItemMgr');
            expect(aliases[0].originalPattern).toBe('CS.Game.ItemManager');
        });

        it('should match multiple local aliases', () => {
            const content = `
local ItemMgr = CS.Game.ItemManager
local UIMgr = CS.Game.UIManager
local Debug = CS.UnityEngine.Debug
`;
            const aliases = extractAliases(content);
            expect(aliases).toHaveLength(3);
            expect(aliases[0].aliasName).toBe('ItemMgr');
            expect(aliases[1].aliasName).toBe('UIMgr');
            expect(aliases[2].aliasName).toBe('Debug');
        });

        it('should not match non-alias patterns', () => {
            const content = `
local x = CS.Game.Player:GetInstance()
local y = some_function()
CS.Game.Player:Move()
`;
            // 第一行有 CS. 但后面跟了 :GetInstance()，不是纯别名赋值
            const aliases = extractAliases(content);
            expect(aliases).toHaveLength(0);
        });

        it('should report correct line numbers', () => {
            const content = `-- header
-- comment
local Mgr = CS.Game.Manager
`;
            const aliases = extractAliases(content);
            expect(aliases).toHaveLength(1);
            expect(aliases[0].line).toBe(3);
        });
    });

    describe('CS_GLOBAL_ALIAS_PATTERN', () => {
        it('should match global C_xxx = CS.yyy assignments', () => {
            const content = 'C_AudioManager = CS.AudioStudio.AudioManager';
            const aliases = extractAliases(content);
            expect(aliases).toHaveLength(1);
            expect(aliases[0].aliasName).toBe('C_AudioManager');
            expect(aliases[0].originalPattern).toBe('CS.AudioStudio.AudioManager');
        });

        it('should match namespace aliases like Yoozoo = CS.Yoozoo', () => {
            const content = `Yoozoo = CS.Yoozoo
System = CS.System
UnityEngine = CS.UnityEngine`;
            const aliases = extractAliases(content);
            expect(aliases).toHaveLength(3);
            expect(aliases[0].aliasName).toBe('Yoozoo');
            expect(aliases[0].originalPattern).toBe('CS.Yoozoo');
            expect(aliases[1].aliasName).toBe('System');
            expect(aliases[2].aliasName).toBe('UnityEngine');
        });

        it('should match deeply nested CS patterns', () => {
            const content = `C_WorldPoolManager = CS.WorldMapBase.Tile.Pool.WorldPoolManager
C_HttpManager = CS.UMT.Framework.Managers.HttpManager`;
            const aliases = extractAliases(content);
            expect(aliases).toHaveLength(2);
            expect(aliases[0].originalPattern).toBe('CS.WorldMapBase.Tile.Pool.WorldPoolManager');
            expect(aliases[1].originalPattern).toBe('CS.UMT.Framework.Managers.HttpManager');
        });

        it('should capture both local and global aliases', () => {
            const content = `local ballNameSpace = CS.com.yoozoo.ball
C_Debug = CS.Yoozoo.Gameplay.GameUtils.DebugForLua
C_AudioManager = CS.AudioStudio.AudioManager`;
            const aliases = extractAliases(content);
            expect(aliases).toHaveLength(3);
            // local alias first, then globals
            expect(aliases[0].aliasName).toBe('ballNameSpace');
            expect(aliases[1].aliasName).toBe('C_Debug');
            expect(aliases[2].aliasName).toBe('C_AudioManager');
        });

        it('should not match assignments without CS. prefix', () => {
            const content = `C_GameStart = Yoozoo.Gameplay.GTAGameStart
C_ResFunc = Yoozoo.Managers.ResourceManagerV2.Runtime.UMTResource`;
            const aliases = extractAliases(content);
            expect(aliases).toHaveLength(0);
        });
    });
});

describe('GETCOMPONENT_PATTERN', () => {
    it('matches string argument form: GetComponent("TypeName")', () => {
        const content = 'self.guideMask = go:GetComponent("GotoMask")';
        const fields = extractGetComponentFields(content);
        expect(fields).toHaveLength(1);
        expect(fields[0].fieldName).toBe('guideMask');
        expect(fields[0].typeName).toBe('GotoMask');
        expect(fields[0].isShortName).toBe(true);
    });

    it('matches CS. argument form: GetComponent(CS.Game.GotoMask)', () => {
        const content = 'self.guideMask = go:GetComponent(CS.Game.GotoMask)';
        const fields = extractGetComponentFields(content);
        expect(fields).toHaveLength(1);
        expect(fields[0].fieldName).toBe('guideMask');
        expect(fields[0].typeName).toBe('Game.GotoMask');
        expect(fields[0].isShortName).toBe(false);
    });

    it('captures fieldName correctly for various names', () => {
        const content = `
self.btnClose = root:GetComponent(CS.UI.Button)
self.txtTitle = root:GetComponent("Text")
`;
        const fields = extractGetComponentFields(content);
        expect(fields).toHaveLength(2);
        expect(fields[0].fieldName).toBe('btnClose');
        expect(fields[0].typeName).toBe('UI.Button');
        expect(fields[0].isShortName).toBe(false);
        expect(fields[1].fieldName).toBe('txtTitle');
        expect(fields[1].typeName).toBe('Text');
        expect(fields[1].isShortName).toBe(true);
    });

    it('does NOT match when receiver is not self', () => {
        // other.field = xxx:GetComponent(...) 不匹配
        const content = 'other.mask = go:GetComponent("GotoMask")';
        const fields = extractGetComponentFields(content);
        expect(fields).toHaveLength(0);
    });

    it('matches with spaces around arguments', () => {
        const content = 'self.panel = go:GetComponent( CS.Game.Panel )';
        const fields = extractGetComponentFields(content);
        expect(fields).toHaveLength(1);
        expect(fields[0].typeName).toBe('Game.Panel');
    });

    it('handles multiple GetComponent in one file', () => {
        const content = `
self.hp = root:GetComponent(CS.Game.HpBar)
self.name = root:GetComponent("TextMeshPro")
self.icon = root:GetComponent(CS.UI.Image)
`;
        const fields = extractGetComponentFields(content);
        expect(fields).toHaveLength(3);
        expect(fields.map(f => f.fieldName)).toEqual(['hp', 'name', 'icon']);
    });
});

// ===== resolveGetComponentShortNames 测试 =====

function makeTempDb(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-xlua-'));
    return path.join(dir, 'test.db');
}

function makeSymbolInfo(name: string, kind: number, containerName?: string): SymbolInformation {
    return {
        name,
        kind,
        containerName: containerName ?? undefined,
        location: {
            uri: 'file:///workspace/Assets/Scripts/Test.cs',
            range: {
                start: { line: 10, character: 0 },
                end: { line: 10, character: 20 },
            },
        },
    } as SymbolInformation;
}

function createMockLspManager(csharpState: string = 'ready', workspaceSymbolFn?: (...args: any[]) => any) {
    const mockCsharpClient = {
        state: csharpState,
        workspaceSymbol: workspaceSymbolFn ?? vi.fn().mockResolvedValue([]),
        definition: vi.fn().mockResolvedValue(null),
        references: vi.fn().mockResolvedValue([]),
        hover: vi.fn().mockResolvedValue(null),
        documentSymbol: vi.fn().mockResolvedValue([]),
    };
    const mockLuaClient = {
        state: 'ready',
        workspaceSymbol: vi.fn().mockResolvedValue([]),
        definition: vi.fn().mockResolvedValue(null),
        references: vi.fn().mockResolvedValue([]),
        hover: vi.fn().mockResolvedValue(null),
        documentSymbol: vi.fn().mockResolvedValue([]),
    };

    return {
        getClientForLanguage: vi.fn((lang: string) =>
            lang === 'csharp' ? mockCsharpClient : mockLuaClient,
        ),
        getClientForFile: vi.fn().mockReturnValue(mockCsharpClient),
        getStatus: vi.fn().mockReturnValue({
            csharp: { state: csharpState, name: 'csharp-ls' },
            lua: { state: 'ready', name: 'LuaLS' },
            allReady: csharpState === 'ready',
        }),
        _mockCsharpClient: mockCsharpClient,
        _mockLuaClient: mockLuaClient,
    } as any;
}

interface GetComponentField {
    fieldName: string;
    typeName: string;
    isShortName: boolean;
    file: string;
    line: number;
}

describe('resolveGetComponentShortNames', () => {
    let dbPath: string;
    let cache: CacheManager;

    beforeEach(() => {
        dbPath = makeTempDb();
        cache = new CacheManager(dbPath);
    });

    afterEach(() => {
        cache.close();
        try { fs.unlinkSync(dbPath); } catch {}
        try { fs.rmdirSync(path.dirname(dbPath)); } catch {}
    });

    it('唯一匹配 (containerName 有值): workspaceSymbol 返回含 containerName 的结果', async () => {
        const workspaceSymbolFn = vi.fn().mockResolvedValue([
            makeSymbolInfo('GotoMask', 5, 'Game'),  // Class kind=5, container=Game
        ]);
        const lspManager = createMockLspManager('ready', workspaceSymbolFn);
        const bridge = new XLuaBridge(lspManager, cache, '/workspace', '/workspace/lua');

        const fieldTypeLookup = new Map<string, GetComponentField>();
        fieldTypeLookup.set('guideMask', {
            fieldName: 'guideMask',
            typeName: 'GotoMask',
            isShortName: true,
            file: 'ui/panel.lua',
            line: 10,
        });

        await bridge.resolveGetComponentShortNames(fieldTypeLookup);

        const field = fieldTypeLookup.get('guideMask')!;
        expect(field.typeName).toBe('Game.GotoMask');
        expect(field.isShortName).toBe(false);
    });

    it('唯一匹配 (csharp-ls containerName=null): name 自带命名空间', async () => {
        // csharp-ls 的 containerName 始终为 null，但 name 可能包含命名空间
        const workspaceSymbolFn = vi.fn().mockResolvedValue([
            makeSymbolInfo('Game.GotoMask', 5),  // containerName=undefined, name 自带命名空间
        ]);
        const lspManager = createMockLspManager('ready', workspaceSymbolFn);
        const bridge = new XLuaBridge(lspManager, cache, '/workspace', '/workspace/lua');

        const fieldTypeLookup = new Map<string, GetComponentField>();
        fieldTypeLookup.set('guideMask', {
            fieldName: 'guideMask',
            typeName: 'GotoMask',
            isShortName: true,
            file: 'ui/panel.lua',
            line: 10,
        });

        await bridge.resolveGetComponentShortNames(fieldTypeLookup);

        const field = fieldTypeLookup.get('guideMask')!;
        expect(field.typeName).toBe('Game.GotoMask');
        expect(field.isShortName).toBe(false);
    });

    it('短名仅返回裸名 (无命名空间) → 跳过不解析', async () => {
        // csharp-ls containerName=null，name 也只是裸类名，无法确定 FQN
        const workspaceSymbolFn = vi.fn().mockResolvedValue([
            makeSymbolInfo('GotoMask', 5),  // 无 containerName, name 无命名空间
        ]);
        const lspManager = createMockLspManager('ready', workspaceSymbolFn);
        const bridge = new XLuaBridge(lspManager, cache, '/workspace', '/workspace/lua');

        const fieldTypeLookup = new Map<string, GetComponentField>();
        fieldTypeLookup.set('guideMask', {
            fieldName: 'guideMask',
            typeName: 'GotoMask',
            isShortName: true,
            file: 'ui/panel.lua',
            line: 10,
        });

        await bridge.resolveGetComponentShortNames(fieldTypeLookup);

        const field = fieldTypeLookup.get('guideMask')!;
        expect(field.typeName).toBe('GotoMask');
        expect(field.isShortName).toBe(true);
    });

    it('多个匹配: workspaceSymbol 返回多个类型结果 → 跳过不解析', async () => {
        const workspaceSymbolFn = vi.fn().mockResolvedValue([
            makeSymbolInfo('Mask', 5, 'Game'),    // Game.Mask
            makeSymbolInfo('Mask', 5, 'UI'),       // UI.Mask
        ]);
        const lspManager = createMockLspManager('ready', workspaceSymbolFn);
        const bridge = new XLuaBridge(lspManager, cache, '/workspace', '/workspace/lua');

        const fieldTypeLookup = new Map<string, GetComponentField>();
        fieldTypeLookup.set('mask', {
            fieldName: 'mask',
            typeName: 'Mask',
            isShortName: true,
            file: 'ui/panel.lua',
            line: 5,
        });

        await bridge.resolveGetComponentShortNames(fieldTypeLookup);

        const field = fieldTypeLookup.get('mask')!;
        expect(field.typeName).toBe('Mask');
        expect(field.isShortName).toBe(true);
    });

    it('无匹配: workspaceSymbol 返回 0 → 保持原样', async () => {
        const workspaceSymbolFn = vi.fn().mockResolvedValue([]);
        const lspManager = createMockLspManager('ready', workspaceSymbolFn);
        const bridge = new XLuaBridge(lspManager, cache, '/workspace', '/workspace/lua');

        const fieldTypeLookup = new Map<string, GetComponentField>();
        fieldTypeLookup.set('unknown', {
            fieldName: 'unknown',
            typeName: 'NonExistentType',
            isShortName: true,
            file: 'ui/panel.lua',
            line: 15,
        });

        await bridge.resolveGetComponentShortNames(fieldTypeLookup);

        const field = fieldTypeLookup.get('unknown')!;
        expect(field.typeName).toBe('NonExistentType');
        expect(field.isShortName).toBe(true);
    });

    it('LSP 未就绪: csharp client state != ready → 跳过不报错', async () => {
        const workspaceSymbolFn = vi.fn().mockResolvedValue([]);
        const lspManager = createMockLspManager('initializing', workspaceSymbolFn);
        const bridge = new XLuaBridge(lspManager, cache, '/workspace', '/workspace/lua');

        const fieldTypeLookup = new Map<string, GetComponentField>();
        fieldTypeLookup.set('guideMask', {
            fieldName: 'guideMask',
            typeName: 'GotoMask',
            isShortName: true,
            file: 'ui/panel.lua',
            line: 10,
        });

        // 不应抛异常
        await bridge.resolveGetComponentShortNames(fieldTypeLookup);

        // 保持原样
        const field = fieldTypeLookup.get('guideMask')!;
        expect(field.typeName).toBe('GotoMask');
        expect(field.isShortName).toBe(true);

        // workspaceSymbol 不应被调用
        expect(workspaceSymbolFn).not.toHaveBeenCalled();
    });

    it('混合场景: CS.Xxx 格式正常处理，短名尝试解析', async () => {
        const workspaceSymbolFn = vi.fn().mockImplementation(async (query: string) => {
            if (query === 'GotoMask') {
                return [makeSymbolInfo('GotoMask', 5, 'Game')];
            }
            if (query === 'Text') {
                // Text 有多个匹配
                return [
                    makeSymbolInfo('Text', 5, 'UnityEngine.UI'),
                    makeSymbolInfo('Text', 5, 'TMPro'),
                ];
            }
            return [];
        });
        const lspManager = createMockLspManager('ready', workspaceSymbolFn);
        const bridge = new XLuaBridge(lspManager, cache, '/workspace', '/workspace/lua');

        const fieldTypeLookup = new Map<string, GetComponentField>();
        // CS. 参数（非短名） — 不需要解析
        fieldTypeLookup.set('hpBar', {
            fieldName: 'hpBar',
            typeName: 'Game.HpBar',
            isShortName: false,
            file: 'ui/panel.lua',
            line: 5,
        });
        // 短名，唯一匹配 → 解析
        fieldTypeLookup.set('guideMask', {
            fieldName: 'guideMask',
            typeName: 'GotoMask',
            isShortName: true,
            file: 'ui/panel.lua',
            line: 10,
        });
        // 短名，多匹配 → 跳过
        fieldTypeLookup.set('txtTitle', {
            fieldName: 'txtTitle',
            typeName: 'Text',
            isShortName: true,
            file: 'ui/panel.lua',
            line: 15,
        });

        await bridge.resolveGetComponentShortNames(fieldTypeLookup);

        // CS. 参数保持不变
        const hpField = fieldTypeLookup.get('hpBar')!;
        expect(hpField.typeName).toBe('Game.HpBar');
        expect(hpField.isShortName).toBe(false);

        // 短名唯一匹配 → 已解析
        const maskField = fieldTypeLookup.get('guideMask')!;
        expect(maskField.typeName).toBe('Game.GotoMask');
        expect(maskField.isShortName).toBe(false);

        // 短名多匹配 → 保持原样
        const txtField = fieldTypeLookup.get('txtTitle')!;
        expect(txtField.typeName).toBe('Text');
        expect(txtField.isShortName).toBe(true);
    });

    it('过滤非类型符号: workspaceSymbol 返回方法不算匹配', async () => {
        const workspaceSymbolFn = vi.fn().mockResolvedValue([
            makeSymbolInfo('GotoMask', 6, 'SomeClass'),  // Method kind=6, not a type
        ]);
        const lspManager = createMockLspManager('ready', workspaceSymbolFn);
        const bridge = new XLuaBridge(lspManager, cache, '/workspace', '/workspace/lua');

        const fieldTypeLookup = new Map<string, GetComponentField>();
        fieldTypeLookup.set('guideMask', {
            fieldName: 'guideMask',
            typeName: 'GotoMask',
            isShortName: true,
            file: 'ui/panel.lua',
            line: 10,
        });

        await bridge.resolveGetComponentShortNames(fieldTypeLookup);

        // 方法不算类型匹配，保持原样
        const field = fieldTypeLookup.get('guideMask')!;
        expect(field.typeName).toBe('GotoMask');
        expect(field.isShortName).toBe(true);
    });

    it('无短名字段时不调用 workspaceSymbol', async () => {
        const workspaceSymbolFn = vi.fn().mockResolvedValue([]);
        const lspManager = createMockLspManager('ready', workspaceSymbolFn);
        const bridge = new XLuaBridge(lspManager, cache, '/workspace', '/workspace/lua');

        const fieldTypeLookup = new Map<string, GetComponentField>();
        // 只有非短名
        fieldTypeLookup.set('hpBar', {
            fieldName: 'hpBar',
            typeName: 'Game.HpBar',
            isShortName: false,
            file: 'ui/panel.lua',
            line: 5,
        });

        await bridge.resolveGetComponentShortNames(fieldTypeLookup);

        expect(workspaceSymbolFn).not.toHaveBeenCalled();
    });

    it('workspaceSymbol 抛异常时优雅处理', async () => {
        const workspaceSymbolFn = vi.fn().mockRejectedValue(new Error('LSP timeout'));
        const lspManager = createMockLspManager('ready', workspaceSymbolFn);
        const bridge = new XLuaBridge(lspManager, cache, '/workspace', '/workspace/lua');

        const fieldTypeLookup = new Map<string, GetComponentField>();
        fieldTypeLookup.set('guideMask', {
            fieldName: 'guideMask',
            typeName: 'GotoMask',
            isShortName: true,
            file: 'ui/panel.lua',
            line: 10,
        });

        // 不应抛异常（Promise.allSettled 处理了 rejection）
        await bridge.resolveGetComponentShortNames(fieldTypeLookup);

        // 保持原样
        const field = fieldTypeLookup.get('guideMask')!;
        expect(field.typeName).toBe('GotoMask');
        expect(field.isShortName).toBe(true);
    });
});
