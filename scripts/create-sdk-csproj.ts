/**
 * 将 Unity 生成的旧格式 csproj 转为 SDK-style csproj，供 csharp-ls 使用。
 *
 * 用法: tsx scripts/create-sdk-csproj.ts <项目根目录> [输入csproj文件名]
 * 示例:
 *   tsx scripts/create-sdk-csproj.ts D:\workspace\BallClient
 *   tsx scripts/create-sdk-csproj.ts D:\workspace\BallClient Assembly-CSharp.csproj
 *
 * 默认输入: Assembly-CSharp.csproj
 * 输出:     Assembly-CSharp-sdk.csproj + ballclient-sdk.sln
 */
import * as fs from 'fs';
import * as path from 'path';

const projectRoot = process.argv[2];
if (!projectRoot) {
    console.error('用法: tsx scripts/create-sdk-csproj.ts <项目根目录> [输入csproj]');
    console.error('示例: tsx scripts/create-sdk-csproj.ts D:\\workspace\\BallClient');
    process.exit(1);
}

const inputName = process.argv[3] || 'Assembly-CSharp.csproj';
const INPUT = path.join(projectRoot, inputName);
const OUTPUT = path.join(projectRoot, 'Assembly-CSharp-sdk.csproj');

if (!fs.existsSync(INPUT)) {
    console.error(`输入文件不存在: ${INPUT}`);
    process.exit(1);
}

let content = fs.readFileSync(INPUT, 'utf-8');

// 1. Remove BOM and XML declaration
content = content.replace(/^\uFEFF/, '');
content = content.replace(/<\?xml[^?]*\?>\s*/, '');

// 2. Replace <Project ...> with SDK-style（兼容旧格式和 patched 格式）
content = content.replace(
    /<Project\b[^>]*>/,
    '<Project Sdk="Microsoft.NET.Sdk">',
);

// 3. Replace TargetFrameworkVersion with netstandard2.1
//    Unity 用的是 .NET Framework 4.x，但 .NET SDK 9.0 没有对应 targeting pack。
//    用 netstandard2.1 让 Roslyn 能加载项目做符号分析（不需要编译通过）。
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
// Remove other MSBuild imports (Unity targets etc.)
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

fs.writeFileSync(OUTPUT, content.trim() + '\n', 'utf-8');
console.log(`Written: ${OUTPUT}`);

// Verify
const outContent = fs.readFileSync(OUTPUT, 'utf-8');
console.log(`Starts with: ${outContent.substring(0, 120)}`);
console.log(`Compile items: ${(outContent.match(/<Compile/g) || []).length}`);
console.log(`Reference items: ${(outContent.match(/<Reference/g) || []).length}`);
console.log(`Analyzer items: ${(outContent.match(/<Analyzer/g) || []).length}`);
console.log(`Has Sdk attribute: ${outContent.includes('Sdk="Microsoft.NET.Sdk"')}`);

// Create sln
const slnContent = `
Microsoft Visual Studio Solution File, Format Version 11.00
# Visual Studio 2010
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Assembly-CSharp-sdk", "Assembly-CSharp-sdk.csproj", "{61c66513-02bf-7569-3d59-be122bd9ab9d}"
EndProject
Global
\tGlobalSection(SolutionConfigurationPlatforms) = preSolution
\t\tDebug|Any CPU = Debug|Any CPU
\tEndGlobalSection
\tGlobalSection(ProjectConfigurationPlatforms) = postSolution
\t\t{61c66513-02bf-7569-3d59-be122bd9ab9d}.Debug|Any CPU.ActiveCfg = Debug|Any CPU
\t\t{61c66513-02bf-7569-3d59-be122bd9ab9d}.Debug|Any CPU.Build.0 = Debug|Any CPU
\tEndGlobalSection
EndGlobal
`;
const slnPath = path.join(projectRoot, 'ballclient-sdk.sln');
fs.writeFileSync(slnPath, slnContent.trim() + '\n', 'utf-8');
console.log(`Written: ${slnPath}`);
