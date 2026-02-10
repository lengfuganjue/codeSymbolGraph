/**
 * 将 Unity 生成的旧格式 csproj 转为 SDK-style csproj，供 csharp-ls 使用。
 *
 * 用法: tsx scripts/create-sdk-csproj.ts <项目根目录>
 * 示例:
 *   tsx scripts/create-sdk-csproj.ts D:\workspace\BallClient
 *
 * 自动发现所有 Unity .csproj（含 Packages/ 中的 Assembly Definition 项目），
 * 转换为 SDK-style 并生成包含所有项目的 .sln。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const projectRoot = process.argv[2];
if (!projectRoot) {
    console.error('用法: tsx scripts/create-sdk-csproj.ts <项目根目录>');
    console.error('示例: tsx scripts/create-sdk-csproj.ts D:\\workspace\\BallClient');
    process.exit(1);
}

/** 检测 csproj 是否是 Unity 旧格式（非 SDK-style） */
function isUnityOldFormat(content: string): boolean {
    // Unity 旧格式特征：有 ToolsVersion 或 TargetFrameworkVersion，无 Sdk 属性
    if (content.includes('Sdk="Microsoft.NET.Sdk"')) return false;
    return content.includes('TargetFrameworkVersion') || content.includes('UnityProjectGenerator');
}

/** 将单个 Unity 旧格式 csproj 转换为 SDK-style */
function convertCsproj(content: string): string {
    // 1. Remove BOM and XML declaration
    content = content.replace(/^\uFEFF/, '');
    content = content.replace(/<\?xml[^?]*\?>\s*/, '');

    // 2. Replace <Project ...> with SDK-style
    content = content.replace(
        /<Project\b[^>]*>/,
        '<Project Sdk="Microsoft.NET.Sdk">',
    );

    // 3. Replace TargetFrameworkVersion with netstandard2.1
    content = content.replace(
        /<TargetFrameworkVersion>[^<]*<\/TargetFrameworkVersion>/,
        '<TargetFramework>netstandard2.1</TargetFramework>',
    );

    // 4. Add EnableDefaultCompileItems=false (keep explicit Compile items)
    if (!content.includes('EnableDefaultCompileItems')) {
        content = content.replace(
            /(<TargetFramework>)/,
            '<EnableDefaultCompileItems>false</EnableDefaultCompileItems>\n    $1',
        );
    }

    // 5. Remove explicit SDK imports
    content = content.replace(/\s*<Import Project="Sdk\.props"[^/]*\/>/g, '');
    content = content.replace(/\s*<Import Project="Sdk\.targets"[^/]*\/>/g, '');
    content = content.replace(/\s*<Import Project="[^"]*Microsoft\.CSharp\.targets"[^/]*\/>/g, '');

    // 6. Remove Analyzer items (Unity source generators)
    content = content.replace(/\s*<Analyzer Include="[^"]*"\s*\/>/g, '');

    // 7. Remove BaseIntermediateOutputPath and IntermediateOutputPath
    content = content.replace(/\s*<BaseIntermediateOutputPath>[^<]*<\/BaseIntermediateOutputPath>/g, '');
    content = content.replace(/\s*<IntermediateOutputPath>[^<]*<\/IntermediateOutputPath>/g, '');

    // 8. Remove GenerateDocumentationFile and DocumentationFile
    content = content.replace(/<GenerateDocumentationFile>[^<]*<\/GenerateDocumentationFile>/g, '');
    content = content.replace(/<DocumentationFile>[^<]*<\/DocumentationFile>/g, '');

    // 9. Remove Unity-specific properties
    const unityProps = [
        'UnityProjectGenerator', 'UnityProjectGeneratorVersion', 'UnityProjectGeneratorStyle',
        'UnityProjectType', 'UnityBuildTarget', 'UnityVersion',
        'ProductVersion', 'SchemaVersion', 'ProjectTypeGuids',
        '_TargetFrameworkDirectories', '_FullFrameworkReferenceAssemblyPaths',
        'DisableHandlePackageFileConflicts', 'AppDesignerFolder',
    ];
    for (const prop of unityProps) {
        content = content.replace(new RegExp(`\\s*<${prop}>[^<]*</${prop}>`, 'g'), '');
    }
    content = content.replace(/\s*<ProjectCapability Include="Unity"\s*\/>/g, '');

    // 10. Remove empty PropertyGroups and ItemGroups
    content = content.replace(/\s*<PropertyGroup>\s*<\/PropertyGroup>/g, '');
    content = content.replace(/\s*<ItemGroup>\s*<\/ItemGroup>/g, '');

    // 11. Clean up multiple blank lines
    content = content.replace(/\n{3,}/g, '\n\n');

    return content.trim() + '\n';
}

/** 生成确定性 GUID（基于项目名） */
function generateGuid(name: string): string {
    const hash = crypto.createHash('md5').update(name).digest('hex');
    return `{${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}}`;
}

// === 主流程 ===

// 1. 发现所有 Unity .csproj（项目根目录，不递归到子目录）
const allCsproj = fs.readdirSync(projectRoot)
    .filter(f => f.endsWith('.csproj') && !f.endsWith('-sdk.csproj'));

const convertedProjects: { name: string; sdkFile: string; guid: string }[] = [];

for (const csprojFile of allCsproj) {
    const inputPath = path.join(projectRoot, csprojFile);
    const content = fs.readFileSync(inputPath, 'utf-8');

    if (!isUnityOldFormat(content)) {
        console.log(`Skip (already SDK-style): ${csprojFile}`);
        continue;
    }

    const baseName = csprojFile.replace('.csproj', '');
    const sdkFileName = `${baseName}-sdk.csproj`;
    const outputPath = path.join(projectRoot, sdkFileName);

    const converted = convertCsproj(content);
    fs.writeFileSync(outputPath, converted, 'utf-8');

    const compileCount = (converted.match(/<Compile/g) || []).length;
    console.log(`Converted: ${csprojFile} → ${sdkFileName} (${compileCount} compile items)`);

    convertedProjects.push({
        name: baseName + '-sdk',
        sdkFile: sdkFileName,
        guid: generateGuid(baseName),
    });
}

if (convertedProjects.length === 0) {
    console.error('未找到任何 Unity 旧格式 .csproj 文件');
    process.exit(1);
}

// 2. 生成包含所有转换项目的 .sln
const projectEntries = convertedProjects.map(p =>
    `Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "${p.name}", "${p.sdkFile}", "${p.guid}"\nEndProject`,
).join('\n');

const configEntries = convertedProjects.map(p =>
    `\t\t${p.guid}.Debug|Any CPU.ActiveCfg = Debug|Any CPU\n\t\t${p.guid}.Debug|Any CPU.Build.0 = Debug|Any CPU`,
).join('\n');

const slnContent = `
Microsoft Visual Studio Solution File, Format Version 11.00
# Visual Studio 2010
${projectEntries}
Global
\tGlobalSection(SolutionConfigurationPlatforms) = preSolution
\t\tDebug|Any CPU = Debug|Any CPU
\tEndGlobalSection
\tGlobalSection(ProjectConfigurationPlatforms) = postSolution
${configEntries}
\tEndGlobalSection
EndGlobal
`;

const dirName = path.basename(projectRoot).toLowerCase();
const slnPath = path.join(projectRoot, `${dirName}-sdk.sln`);
fs.writeFileSync(slnPath, slnContent.trim() + '\n', 'utf-8');
console.log(`\nSolution: ${slnPath} (${convertedProjects.length} projects)`);
convertedProjects.forEach(p => console.log(`  - ${p.sdkFile}`));
