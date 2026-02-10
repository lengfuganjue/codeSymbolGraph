/**
 * 集中配置定义。
 * 所有可调参数都在此定义默认值，用户可在 .codesymbolgraph/config.json 中覆盖。
 */

/** 用户在 config.json 中写入的配置（所有字段都有默认值，advanced 完全可选） */
export interface CsgConfig {
    slnPath: string;
    luaRoot: string | null;
    csharpLsp: 'csharp-ls' | 'omnisharp';
    csharpLspPath: string | null;
    lualsPath: string | null;
    /** 资源名映射文件路径（可选，默认自动检测 AssetsNameToolCacheFile.txt） */
    assetsNameFile?: string;
    /** 协议注解目录路径（可选，默认自动检测 EmmyLuaAnnotations/） */
    protocolAnnotationsDir?: string;
    /** 可选的高级调优参数 */
    advanced?: Partial<AdvancedConfig>;
}

/** 高级调优参数（全部有默认值） */
export interface AdvancedConfig {
    /** Lua 运行时版本，用于 LuaLS 配置 (默认 "Lua 5.3") */
    luaVersion: string;
    /** LuaLS 最大预加载文件数 (默认 10000) */
    lualsMaxPreload: number;
    /** LuaLS 预加载文件大小上限 KB (默认 500) */
    lualsPreloadFileSize: number;
    /** LSP 普通请求超时 ms (默认 5000) */
    lspTimeoutMs: number;
    /** LSP 初始化超时 ms (默认 60000) */
    lspInitTimeoutMs: number;
    /** LSP 健康检查间隔 ms (默认 30000) */
    healthCheckIntervalMs: number;
    /** LSP 最大自动重启次数 (默认 5) */
    maxRestarts: number;
    /** 内存缓存最大条目数 (默认 5000) */
    cacheMaxEntries: number;
    /** 内存缓存 TTL 分钟 (默认 10) */
    cacheTtlMinutes: number;
    /** 引用缓存 TTL 秒 (默认 60) */
    referenceCacheTtlSeconds: number;
    /** 调用链缓存 TTL 秒 (默认 120) */
    callChainCacheTtlSeconds: number;
    /** 文件监控防抖 ms (默认 500) */
    fileWatcherDebounceMs: number;
    /** 额外的第三方命名空间前缀（会追加到内置列表） */
    extraThirdPartyNamespaces: string[];
}

export const DEFAULT_ADVANCED: AdvancedConfig = {
    luaVersion: 'Lua 5.3',
    lualsMaxPreload: 10000,
    lualsPreloadFileSize: 500,
    lspTimeoutMs: 5000,
    lspInitTimeoutMs: 60000,
    healthCheckIntervalMs: 30000,
    maxRestarts: 5,
    cacheMaxEntries: 5000,
    cacheTtlMinutes: 10,
    referenceCacheTtlSeconds: 60,
    callChainCacheTtlSeconds: 120,
    fileWatcherDebounceMs: 500,
    extraThirdPartyNamespaces: [],
};

/** 将用户 partial config 与默认值合并，返回完整的 AdvancedConfig */
export function resolveAdvanced(partial?: Partial<AdvancedConfig>): AdvancedConfig {
    if (!partial) return { ...DEFAULT_ADVANCED };
    return { ...DEFAULT_ADVANCED, ...partial };
}
