import { describe, it, expect } from 'vitest';
import { pathToUri, uriToPath, relativeToUri, uriToRelative, getLanguageId, isSupportedFile } from '../../src/utils/uri.js';
import * as path from 'path';

describe('uri utils', () => {
    describe('pathToUri / uriToPath roundtrip', () => {
        // vscode-uri normalizes drive letters to lowercase per URI spec
        // So roundtrip comparison must be case-insensitive on Windows
        it('should handle Windows absolute path', () => {
            const absPath = 'C:\\Users\\test\\project\\file.cs';
            const uri = pathToUri(absPath);
            expect(uri).toMatch(/^file:\/\/\//);
            expect(uri).toContain('file.cs');

            const back = uriToPath(uri);
            expect(path.normalize(back).toLowerCase()).toBe(path.normalize(absPath).toLowerCase());
        });

        it('should handle path with spaces', () => {
            const absPath = 'C:\\Users\\test user\\my project\\file.lua';
            const uri = pathToUri(absPath);
            expect(uri).toContain('test%20user');
            const back = uriToPath(uri);
            expect(path.normalize(back).toLowerCase()).toBe(path.normalize(absPath).toLowerCase());
        });

        it('should handle path with Chinese characters', () => {
            const absPath = 'C:\\项目\\代码\\file.cs';
            const uri = pathToUri(absPath);
            const back = uriToPath(uri);
            expect(path.normalize(back).toLowerCase()).toBe(path.normalize(absPath).toLowerCase());
        });
    });

    describe('relativeToUri / uriToRelative', () => {
        it('should convert relative path to uri and back', () => {
            const root = 'C:\\workspace\\project';
            const rel = 'Assets/Scripts/Player.cs';
            const uri = relativeToUri(root, rel);

            expect(uri).toMatch(/^file:\/\/\//);
            expect(uri).toContain('Player.cs');

            const backRel = uriToRelative(root, uri);
            expect(backRel).toBe('Assets/Scripts/Player.cs');
        });

        it('should normalize backslashes in result', () => {
            const root = 'C:\\workspace\\project';
            const uri = pathToUri('C:\\workspace\\project\\src\\main.lua');
            const rel = uriToRelative(root, uri);
            expect(rel).not.toContain('\\');
            expect(rel).toBe('src/main.lua');
        });
    });

    describe('getLanguageId', () => {
        it('should return csharp for .cs files', () => {
            expect(getLanguageId('foo.cs')).toBe('csharp');
            expect(getLanguageId('path/to/Player.cs')).toBe('csharp');
        });

        it('should return lua for .lua files', () => {
            expect(getLanguageId('foo.lua')).toBe('lua');
            expect(getLanguageId('scripts/main.lua')).toBe('lua');
        });

        it('should throw for unsupported file types', () => {
            expect(() => getLanguageId('foo.py')).toThrow('Unsupported file type');
            expect(() => getLanguageId('foo.txt')).toThrow('Unsupported file type');
        });
    });

    describe('isSupportedFile', () => {
        it('should return true for .cs and .lua', () => {
            expect(isSupportedFile('foo.cs')).toBe(true);
            expect(isSupportedFile('foo.lua')).toBe(true);
        });

        it('should return false for other extensions', () => {
            expect(isSupportedFile('foo.py')).toBe(false);
            expect(isSupportedFile('foo.ts')).toBe(false);
            expect(isSupportedFile('foo.txt')).toBe(false);
            expect(isSupportedFile('foo')).toBe(false);
        });
    });
});
