# csharp-ls 兼容性说明

## 版本要求

- **推荐版本**: 0.20.0（0.21.0 和 0.22.0 有 NuGet 打包缺陷无法安装）
- **安装**: `dotnet tool install --global csharp-ls --version 0.20.0`

## 关键问题与解决方案

### 1. csharp-ls 不加载解决方案（workspace/symbol 返回空）

**根因**: csharp-ls 0.20.0 在初始化后会发送以下 LSP 请求到客户端，如果客户端不响应，csharp-ls 会阻塞，永远不加载项目：

| 请求 | 说明 |
|------|------|
| `client/registerCapability` | 动态注册能力 |
| `workspace/configuration` | 请求工作区配置 |
| `window/workDoneProgress/create` | **关键！** 创建进度条，不响应则阻塞解决方案加载 |

**解决方案**: 在 `lsp-client.ts` 中注册所有请求的处理器：
```typescript
this.connection.onRequest('client/registerCapability', () => ({}));
this.connection.onRequest('client/unregisterCapability', () => ({}));
this.connection.onRequest('workspace/configuration', () => [{}]);
this.connection.onRequest('window/workDoneProgress/create', () => ({}));
```

### 2. Unity 旧格式 .csproj 不被 csharp-ls 支持

**现象**: csharp-ls 基于 Roslyn MSBuild Workspace，无法加载 Unity 生成的旧格式 .csproj（`<Project ToolsVersion="4.0" ...>`）。初始化成功但符号查询永远返回空。

**解决方案**: 使用 `scripts/create-sdk-csproj.ts` 将 Unity .csproj 转换为 SDK-style 格式：
```bash
npx tsx scripts/create-sdk-csproj.ts <项目根目录>
```

然后在 `csg init` 时使用 `--sln ballclient-sdk.sln` 指向转换后的解决方案。

### 3. TargetFramework 兼容性

Unity 项目使用 `TargetFrameworkVersion v4.7.1`（.NET Framework），但 .NET SDK 9.0 没有对应 targeting pack。转换脚本会自动替换为 `netstandard2.1`，这样 Roslyn 可以加载项目做符号分析（不需要编译通过）。

### 4. csharp-ls 0.5.6 的 textDocument capabilities 崩溃

早期版本 csharp-ls 0.5.6 在 initialize 请求中收到 textDocument capabilities 时会崩溃（exit code 3）。`lsp-manager.ts` 中对 csharp-ls 只发送 workspace capabilities 作为 workaround。

## 调试技巧

- csharp-ls 的 stderr 输出会包含 `Roslyn.Solution` 相关日志
- 如果看到 `Will use MSBuild props: map [...]`，说明解决方案正在加载
- 如果看不到这行日志，说明某个 LSP 请求阻塞了加载流程
- 大型项目（>2000 C# 文件）首次加载可能需要 20-60 秒

## 环境依赖

- .NET SDK 9.0+（用于运行 csharp-ls）
- csharp-ls 全局安装（`dotnet tool install --global csharp-ls --version 0.20.0`）
- 对于 Unity 项目：需要先运行 SDK csproj 转换脚本
