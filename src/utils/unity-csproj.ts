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

/** 检测 csproj 是否是 Unity 项目（旧格式或新版 SDK-style 都算） */
export function isUnityProject(content: string): boolean {
    return content.includes('UnityProjectGenerator') || content.includes('TargetFrameworkVersion');
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

export interface DllReference {
    name: string;
    hintPath: string;
}

/** 从 csproj 内容中提取所有 <Reference Include="..."><HintPath>...</HintPath></Reference> */
function extractReferences(content: string): DllReference[] {
    const refs: DllReference[] = [];
    const regex = /<Reference\s+Include="([^"]+)"[\s\S]*?<HintPath>([^<]+)<\/HintPath>[\s\S]*?<\/Reference>/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
        refs.push({ name: match[1], hintPath: match[2] });
    }
    return refs;
}

/**
 * 从已收集的 DLL 引用中推断 Unity 引擎 DLL 目录，补充隐式引用的核心模块。
 * Unity asmdef 系统会隐式引用所有 UnityEngine/UnityEditor 核心模块，
 * 但生成的 .csproj 不会显式列出这些引用。Roslyn 需要它们才能正确解析继承链。
 */
function supplementUnityImplicitReferences(
    references: Map<string, string>,
    projectRoot: string,
): void {
    const unityDllDirs = new Set<string>();
    for (const [name, hintPath] of references) {
        if (name.startsWith('UnityEngine.') || name === 'UnityEngine' ||
            name.startsWith('UnityEditor.') || name === 'UnityEditor') {
            const absPath = path.isAbsolute(hintPath) ? hintPath : path.join(projectRoot, hintPath);
            const dir = path.dirname(absPath);
            if (fs.existsSync(dir)) {
                unityDllDirs.add(dir);
            }
        }
    }

    if (unityDllDirs.size === 0) return;

    for (const dir of unityDllDirs) {
        let files: string[];
        try {
            files = fs.readdirSync(dir);
        } catch {
            continue;
        }
        for (const file of files) {
            if (!file.endsWith('.dll')) continue;
            if (!file.startsWith('UnityEngine.') && !file.startsWith('UnityEditor.')) continue;
            const dllName = file.replace('.dll', '');
            if (!references.has(dllName)) {
                const fullPath = path.join(dir, file);
                references.set(dllName, fullPath);
            }
        }
    }
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
    /** 合并后的 DLL 引用数 */
    referenceCount: number;
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
    // key=name, value=hintPath — 按 name 去重
    const allReferences = new Map<string, string>();
    let sourceCount = 0;
    let skipped = 0;

    for (const file of allCsproj) {
        if (shouldSkipCsproj(file)) {
            skipped++;
            continue;
        }

        const inputPath = path.join(projectRoot, file);
        const content = fs.readFileSync(inputPath, 'utf-8');

        if (!isUnityOldFormat(content) && !isUnityProject(content)) {
            skipped++;
            continue;
        }

        sourceCount++;
        for (const item of extractCompileItems(content)) {
            allCompileItems.add(item);
        }
        for (const ref of extractReferences(content)) {
            if (!allReferences.has(ref.name)) {
                allReferences.set(ref.name, ref.hintPath);
            }
        }
    }

    if (allCompileItems.size === 0) {
        throw new Error('未找到任何可转换的 Unity .csproj 或 Compile 项');
    }

    // 补充 Unity 隐式引用的核心模块（asmdef 不显式列出 CoreModule 等）
    supplementUnityImplicitReferences(allReferences, projectRoot);

    // 过滤掉文件不存在的 DLL 引用
    const validReferences: Array<[string, string]> = [];
    for (const [name, hintPath] of allReferences) {
        const absPath = path.isAbsolute(hintPath) ? hintPath : path.join(projectRoot, hintPath);
        if (fs.existsSync(absPath)) {
            validReferences.push([name, hintPath]);
        }
    }

    // 生成合并的 SDK csproj
    const compileItemsXml = Array.from(allCompileItems)
        .sort()
        .map(item => `    <Compile Include="${item}" />`)
        .join('\n');

    const referencesXml = validReferences.length > 0
        ? '\n  <ItemGroup>\n' + validReferences
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([name, hp]) => `    <Reference Include="${name}">\n      <HintPath>${hp}</HintPath>\n    </Reference>`)
            .join('\n') + '\n  </ItemGroup>\n'
        : '';

    const csprojContent = `<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <TargetFramework>netstandard2.1</TargetFramework>
    <NoWarn>CS0246;CS0234;CS1061;CS0103;CS0117;CS0029;CS0019</NoWarn>
  </PropertyGroup>

  <ItemGroup>
${compileItemsXml}
  </ItemGroup>
${referencesXml}
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
        referenceCount: validReferences.length,
        skippedCount: skipped,
    };
}
