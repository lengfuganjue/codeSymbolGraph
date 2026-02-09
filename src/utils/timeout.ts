export class LspTimeoutError extends Error {
    constructor(method: string, timeoutMs: number) {
        super(`LSP request '${method}' timed out after ${timeoutMs}ms`);
        this.name = 'LspTimeoutError';
    }
}

/** 给 Promise 加超时，超时后 reject */
export function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    method: string,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new LspTimeoutError(method, timeoutMs)),
            timeoutMs,
        );

        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); },
        );
    });
}

/** 默认 LSP 请求超时（毫秒），可通过 setTimeouts 覆盖 */
export let LSP_TIMEOUT_MS = 5000;

/** 初始化超时（毫秒），比普通请求更长，可通过 setTimeouts 覆盖 */
export let LSP_INIT_TIMEOUT_MS = 60000;

/** 用配置值覆盖默认超时 */
export function setTimeouts(opts: { lspTimeoutMs?: number; lspInitTimeoutMs?: number }): void {
    if (opts.lspTimeoutMs != null) LSP_TIMEOUT_MS = opts.lspTimeoutMs;
    if (opts.lspInitTimeoutMs != null) LSP_INIT_TIMEOUT_MS = opts.lspInitTimeoutMs;
}
