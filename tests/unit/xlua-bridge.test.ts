import { describe, it, expect } from 'vitest';

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
