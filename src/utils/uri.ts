import { URI } from 'vscode-uri';
import * as path from 'path';

/** 绝对路径 → file URI（跨平台安全） */
export function pathToUri(absolutePath: string): string {
    return URI.file(absolutePath).toString();
}

/** file URI → 绝对路径 */
export function uriToPath(uri: string): string {
    return URI.parse(uri).fsPath;
}

/** 相对路径 → file URI */
export function relativeToUri(workspaceRoot: string, relativePath: string): string {
    const abs = path.resolve(workspaceRoot, relativePath);
    return pathToUri(abs);
}

/** file URI → 相对路径 */
export function uriToRelative(workspaceRoot: string, uri: string): string {
    const abs = uriToPath(uri);
    return path.relative(workspaceRoot, abs).replace(/\\/g, '/');
}

/** 根据文件扩展名推断 LSP languageId */
export function getLanguageId(filePath: string): 'csharp' | 'lua' {
    if (filePath.endsWith('.cs')) return 'csharp';
    if (filePath.endsWith('.lua')) return 'lua';
    throw new Error(`Unsupported file type: ${filePath}`);
}

/** 根据文件扩展名判断是否为支持的语言 */
export function isSupportedFile(filePath: string): boolean {
    return filePath.endsWith('.cs') || filePath.endsWith('.lua');
}
