import { describe, it, expect } from 'vitest';
import { withTimeout, LspTimeoutError, LSP_TIMEOUT_MS, LSP_INIT_TIMEOUT_MS } from '../../src/utils/timeout.js';

describe('timeout utils', () => {
    describe('withTimeout', () => {
        it('should resolve if promise resolves before timeout', async () => {
            const result = await withTimeout(
                Promise.resolve('ok'),
                1000,
                'test',
            );
            expect(result).toBe('ok');
        });

        it('should reject with LspTimeoutError if promise takes too long', async () => {
            const slowPromise = new Promise(resolve => setTimeout(resolve, 5000));

            await expect(
                withTimeout(slowPromise, 50, 'slowMethod'),
            ).rejects.toThrow(LspTimeoutError);

            await expect(
                withTimeout(slowPromise, 50, 'slowMethod'),
            ).rejects.toThrow("LSP request 'slowMethod' timed out after 50ms");
        });

        it('should forward rejection if promise rejects before timeout', async () => {
            const failPromise = Promise.reject(new Error('original error'));

            await expect(
                withTimeout(failPromise, 1000, 'test'),
            ).rejects.toThrow('original error');
        });

        it('should preserve resolved value type', async () => {
            const result = await withTimeout(
                Promise.resolve({ foo: 42 }),
                1000,
                'test',
            );
            expect(result).toEqual({ foo: 42 });
        });

        it('should handle null resolve', async () => {
            const result = await withTimeout(
                Promise.resolve(null),
                1000,
                'test',
            );
            expect(result).toBeNull();
        });
    });

    describe('LspTimeoutError', () => {
        it('should have correct name and message', () => {
            const err = new LspTimeoutError('textDocument/definition', 5000);
            expect(err.name).toBe('LspTimeoutError');
            expect(err.message).toBe("LSP request 'textDocument/definition' timed out after 5000ms");
            expect(err).toBeInstanceOf(Error);
            expect(err).toBeInstanceOf(LspTimeoutError);
        });
    });

    describe('constants', () => {
        it('should have expected default values', () => {
            expect(LSP_TIMEOUT_MS).toBe(5000);
            expect(LSP_INIT_TIMEOUT_MS).toBe(60000);
        });
    });
});
