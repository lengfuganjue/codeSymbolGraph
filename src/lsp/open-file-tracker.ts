import { LspClient } from './lsp-client.js';

/**
 * 维护 LSP 的文件打开状态。
 *
 * LSP 协议规则：
 * - didOpen: 只在文件首次打开时调用
 * - didChange: 已打开的文件内容变化时调用
 * - didClose: 文件关闭后才能再次 didOpen
 * - 对未打开的文件调 didChange 是协议违规
 */
export class OpenFileTracker {
    /** uri → 当前版本号 */
    private openFiles = new Map<string, number>();

    /** 通知 LSP 文件变更（自动处理 open/change 状态） */
    async notifyChange(
        client: LspClient,
        uri: string,
        languageId: string,
        content: string,
    ): Promise<void> {
        if (this.openFiles.has(uri)) {
            const version = this.openFiles.get(uri)! + 1;
            this.openFiles.set(uri, version);
            await client.didChange(uri, content, version);
        } else {
            this.openFiles.set(uri, 1);
            await client.didOpen(uri, languageId, content);
        }
    }

    /** 通知 LSP 文件保存 */
    async notifySave(client: LspClient, uri: string): Promise<void> {
        if (this.openFiles.has(uri)) {
            await client.didSave(uri);
        }
    }

    /** 通知 LSP 文件删除/关闭 */
    async notifyDelete(client: LspClient, uri: string): Promise<void> {
        if (this.openFiles.has(uri)) {
            await client.didClose(uri);
            this.openFiles.delete(uri);
        }
    }

    isOpen(uri: string): boolean {
        return this.openFiles.has(uri);
    }

    /** LSP 重启后清空状态 */
    reset(): void {
        this.openFiles.clear();
    }

    get openCount(): number {
        return this.openFiles.size;
    }
}
