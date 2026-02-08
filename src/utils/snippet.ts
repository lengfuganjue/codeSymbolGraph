import * as fs from 'fs';
import * as path from 'path';

/** 模块级文件内容缓存，避免同一工具调用中重复读取同一文件 */
const fileCache = new Map<string, string[]>();

/** 每次工具调用结束后清空缓存 */
export function clearSnippetCache(): void {
    fileCache.clear();
}

/**
 * 读取文件指定行附近的代码片段
 * @param workspaceRoot 工作区根目录
 * @param relativePath 相对路径
 * @param line 目标行号 (1-based)
 * @param contextLines 上下文行数，默认2
 * @returns 带行号前缀的代码片段，文件不存在或行号越界返回空字符串
 */
export function readSnippet(
    workspaceRoot: string,
    relativePath: string,
    line: number,
    contextLines: number = 2,
): string {
    try {
        const absPath = path.resolve(workspaceRoot, relativePath);

        let lines = fileCache.get(absPath);
        if (!lines) {
            const content = fs.readFileSync(absPath, 'utf-8');
            lines = content.split('\n');
            fileCache.set(absPath, lines);
        }

        const startLine = Math.max(0, line - 1 - contextLines);
        const endLine = Math.min(lines.length - 1, line - 1 + contextLines);

        if (startLine >= lines.length || line < 1) return '';

        const snippetLines: string[] = [];
        for (let i = startLine; i <= endLine; i++) {
            const lineNum = i + 1;
            snippetLines.push(`${lineNum}| ${lines[i]}`);
        }

        return snippetLines.join('\n');
    } catch {
        return '';
    }
}
