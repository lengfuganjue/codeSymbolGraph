import { describe, it, expect } from 'vitest';
import { isSupportedFile } from '../../src/utils/uri.js';

// FileWatcher 依赖 chokidar 和实际文件系统，不适合纯单元测试
// 这里测试其核心过滤逻辑（通过 isSupportedFile）

describe('FileWatcher filter logic', () => {
    it('should accept .cs files', () => {
        expect(isSupportedFile('Assets/Scripts/Player.cs')).toBe(true);
        expect(isSupportedFile('C:/project/test.cs')).toBe(true);
    });

    it('should accept .lua files', () => {
        expect(isSupportedFile('LuaScripts/main.lua')).toBe(true);
        expect(isSupportedFile('/home/user/game.lua')).toBe(true);
    });

    it('should reject other file types', () => {
        expect(isSupportedFile('package.json')).toBe(false);
        expect(isSupportedFile('readme.md')).toBe(false);
        expect(isSupportedFile('image.png')).toBe(false);
        expect(isSupportedFile('project.csproj')).toBe(false);
        expect(isSupportedFile('script.js')).toBe(false);
    });
});
