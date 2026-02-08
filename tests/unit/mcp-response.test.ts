import { describe, it, expect } from 'vitest';
import { successResponse, errorResponse } from '../../src/utils/mcp-response.js';

const lspStatus = { csharp: 'ready', lua: 'ready' };

describe('mcp-response', () => {
    describe('successResponse', () => {
        it('should create success response with data', () => {
            const data = { results: [{ name: 'Foo' }], count: 1 };
            const resp = successResponse(data);

            expect(resp.success).toBe(true);
            expect(resp.data).toEqual(data);
            expect(resp.error).toBeUndefined();
            expect(resp.meta).toBeUndefined();
        });

        it('should handle empty array data', () => {
            const resp = successResponse([]);
            expect(resp.success).toBe(true);
            expect(resp.data).toEqual([]);
        });

        it('should handle null data', () => {
            const resp = successResponse(null);
            expect(resp.success).toBe(true);
            expect(resp.data).toBeNull();
        });
    });

    describe('errorResponse', () => {
        it('should create error response with LSP_TIMEOUT code', () => {
            const resp = errorResponse('LSP_TIMEOUT', 'timed out', lspStatus);

            expect(resp.success).toBe(false);
            expect(resp.error!.code).toBe('LSP_TIMEOUT');
            expect(resp.error!.message).toBe('timed out');
            expect(resp.meta!.lspStatus).toEqual(lspStatus);
        });

        it('should create error response with NO_MATCH code', () => {
            const resp = errorResponse('NO_MATCH', 'not found', lspStatus);
            expect(resp.error!.code).toBe('NO_MATCH');
        });

        it('should create error response with LSP_NOT_READY code', () => {
            const partial = { csharp: 'starting', lua: 'stopped' };
            const resp = errorResponse('LSP_NOT_READY', 'not ready', partial);
            expect(resp.error!.code).toBe('LSP_NOT_READY');
            expect(resp.meta!.lspStatus).toEqual(partial);
        });
    });
});
