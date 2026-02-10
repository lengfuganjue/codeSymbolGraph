/**
 * Unity 旧格式 .csproj → SDK-style 转换工具。
 *
 * 策略：从所有有效 .csproj 中提取 <Compile> 项，合并到**一个** SDK 项目中。
 * 这样 csharp-ls 只加载 1 个项目，索引速度和之前一样（40-60s），但覆盖 Packages/ 等全部目录。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/** 检测 csproj 是否是 Unity 旧格式（非 SDK-style） */
export function isUnityOldFormat(content: string): boolean {
    if (content.includes('Sdk="Microsoft.NET.Sdk"')) return false;
    return content.includes('TargetFrameworkVersion') || content.includes('UnityProjectGenerator');
}

/** 应该跳过的 csproj：Editor、Player、Tests */
function shouldSkipCsproj(fileName: string): boolean {
    const name = fileName.toLowerCase();
    if (name.endsWith('-sdk.csproj')) return true;
    if (name.includes('.player.')) return true;
    if (name.includes('.editor.') || name.endsWith('editor.csproj')) return true;
    if (name.includes('.tests.') || name.endsWith('tests.csproj') || name.endsWith('test.csproj')) return true;
    if (name.includes('testable.csproj')) return true;
    return false;
}

/** 从 csproj 内容中提取所有 <Compile Include="..."> 路径 */
function extractCompileItems(content: string): string[] {
    const items: string[] = [];
    const regex = /<Compile\s+Include="([^"]+)"\s*\/>/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
        items.push(match[1]);
    }
    return items;
}

function generateGuid(name: string): string {
    const hash = crypto.createHash('md5').update(name).digest('hex');
    return `{${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}}`;
}

export interface ConvertResult {
    slnPath: string;
    /** 扫描的 csproj 数量 */
    sourceProjectCount: number;
    /** 合并后的 Compile 项数 */
    compileItemCount: number;
    skippedCount: number;
}

/**
 * 从 Unity 项目的所有 .csproj 中提取 Compile 项，合并成单个 SDK 项目 + .sln。
 * 单项目策略保证 csharp-ls 索引速度与之前一致，同时覆盖 Packages/ 等全部目录。
 */
export function convertUnityProject(projectRoot: string): ConvertResult {
    const allCsproj = fs.readdirSync(projectRoot)
        .filter(f => f.endsWith('.csproj') && !f.endsWith('-sdk.csproj'));

    const allCompileItems = new Set<string>();
    let sourceCount = 0;
    let skipped = 0;

    for (const file of allCsproj) {
        if (shouldSkipCsproj(file)) {
            skipped++;
            continue;
        }

        const inputPath = path.join(projectRoot, file);
        const content = fs.readFileSync(inputPath, 'utf-8');

        if (!isUnityOldFormat(content)) {
            skipped++;
            continue;
        }

        sourceCount++;
        for (const item of extractCompileItems(content)) {
            allCompileItems.add(item);
        }
    }

    if (allCompileItems.size === 0) {
        throw new Error('未找到任何可转换的 Unity .csproj 或 Compile 项');
    }

    // 生成合并的 SDK csproj
    const compileItemsXml = Array.from(allCompileItems)
        .sort()
        .map(item => `    <Compile Include="${item}" />`)
        .join('\n');

    const csprojContent = `<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <TargetFramework>netstandard2.1</TargetFramework>
  </PropertyGroup>

  <ItemGroup>
${compileItemsXml}
  </ItemGroup>

</Project>
`;

    const sdkCsprojName = 'csg-merged-sdk.csproj';
    fs.writeFileSync(path.join(projectRoot, sdkCsprojName), csprojContent, 'utf-8');

    // 生成单项目 .sln
    const guid = generateGuid('csg-merged');
    const slnContent = `
Microsoft Visual Studio Solution File, Format Version 11.00
# Visual Studio 2010
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "csg-merged-sdk", "${sdkCsprojName}", "${guid}"
EndProject
Global
\tGlobalSection(SolutionConfigurationPlatforms) = preSolution
\t\tDebug|Any CPU = Debug|Any CPU
\tEndGlobalSection
\tGlobalSection(ProjectConfigurationPlatforms) = postSolution
\t\t${guid}.Debug|Any CPU.ActiveCfg = Debug|Any CPU
\t\t${guid}.Debug|Any CPU.Build.0 = Debug|Any CPU
\tEndGlobalSection
EndGlobal
`;

    const slnFileName = 'csg-sdk.sln';
    fs.writeFileSync(path.join(projectRoot, slnFileName), slnContent.trim() + '\n', 'utf-8');

    return {
        slnPath: slnFileName,
        sourceProjectCount: sourceCount,
        compileItemCount: allCompileItems.size,
        skippedCount: skipped,
    };
}
