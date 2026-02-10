# MCP 接入 Claude Code 指南

## 配置方法

### 1. 添加 MCP server

在目标项目目录下执行：

```bash
claude mcp add -s project csg -- cmd /c csg mcp
```

**注意**：MSYS bash 环境下 `/c` 会被转义为 `C:/`，必须手动编辑生成的 `.mcp.json` 修正：

```json
{
  "mcpServers": {
    "csg": {
      "type": "stdio",
      "command": "cmd",
      "args": ["/c", "csg", "mcp"]
    }
  }
}
```

### 2. 配置文件位置

- 正确：项目根目录 **`.mcp.json`**
- 错误：`.claude/mcp.json`（Claude Code 不读这个位置）

### 3. CLAUDE.md 工具说明

Claude 不会自动使用 MCP 工具，必须在目标项目的 `CLAUDE.md` 中添加工具说明，告知 Claude 何时使用 csg 工具。参考 BallClient 项目中的 CLAUDE.md 写法。

## Windows 踩坑记录

### npm link 的 .cmd 文件

`csg` 通过 `npm link` 安装后，实际是 `.cmd` 文件。Node.js 的 `child_process.spawn` 默认找不到 `.cmd`，必须用 `cmd /c csg mcp` 绕过。

### 进程泄漏

两个已修复的 bug（保留记录防回归）：

1. **cleanup handler 注册过晚**：原来 SIGINT/SIGTERM handler 在 `startAll().then()` 回调里注册。LSP 启动的 30-60s 内终止进程，cleanup 不执行，子进程成孤儿。修复：提前注册到 `startAll()` 之前。

2. **MCP client 断开后无清理**：MCP SDK 的 `StdioServerTransport` 不监听 stdin `end` 事件。Claude Code 退出后 stdin 关闭，但 node 进程不退出。修复：添加 `process.stdin.on('end', cleanup)`。

### C# 索引等待

csharp-ls 初始化握手完成（state="ready"）后，解决方案加载还需 30-60s。期间 `workspace/symbol` 查询返回空结果。

修复：`wrapTool` 在执行工具函数前 `await indexingReady`，服务端自动等待索引完成，客户端无需轮询。首次工具调用可能阻塞 30-60s，之后秒回。

## 验证方法

```bash
# 单元测试
npm test

# E2E 测试（需要目标项目已 csg init）
npx tsx tests/e2e/mcp-e2e.ts <目标项目路径>
```

E2E 测试验证 6 个工具：csg_status、csg_find_definition、csg_find_references、csg_cross_lang、csg_call_chain、csg_impact。
