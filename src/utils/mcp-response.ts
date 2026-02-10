import type { LspState } from '../lsp/lsp-client.js';

export type McpErrorCode = 'LSP_TIMEOUT' | 'LSP_NOT_READY' | 'NO_MATCH' | 'NOT_AVAILABLE' | 'INTERNAL_ERROR';

export interface McpToolResponse<T = unknown> {
    success: boolean;
    data?: T;
    error?: {
        code: McpErrorCode;
        message: string;
    };
    meta?: {
        lspStatus: {
            csharp: string;
            lua: string;
        };
    };
}

export function successResponse<T>(
    data: T,
): McpToolResponse<T> {
    return { success: true, data };
}

export function errorResponse(
    code: McpErrorCode,
    message: string,
    lspStatus: { csharp: string; lua: string },
): McpToolResponse {
    return {
        success: false,
        error: { code, message },
        meta: { lspStatus },
    };
}
