/**
 * 创建标准 SDK-style csproj：
 * - 使用 <Project Sdk="Microsoft.NET.Sdk"> 而不是显式 Import
 * - 保持所有源文件和引用
 * - 去掉 Unity 特殊元素
 *
 * 用法: tsx scripts/create-sdk-csproj.ts <BallClient根目录>
 * 示例: tsx scripts/create-sdk-csproj.ts F:\workspace\BallClient
 */
import * as fs from 'fs';
import * as path from 'path';

const ballClientRoot = process.argv[2];
if (!ballClientRoot) {
    console.error('用法: tsx scripts/create-sdk-csproj.ts <BallClient根目录>');
    console.error('示例: tsx scripts/create-sdk-csproj.ts F:\\workspace\\BallClient');
    process.exit(1);
}

const INPUT = path.join(ballClientRoot, 'Assembly-CSharp-patched.csproj');
const OUTPUT = path.join(ballClientRoot, 'Assembly-CSharp-sdk.csproj');

if (!fs.existsSync(INPUT)) {
    console.error(`输入文件不存在: ${INPUT}`);
    process.exit(1);
}

let content = fs.readFileSync(INPUT, 'utf-8');

// 1. Replace <Project> with <Project Sdk="Microsoft.NET.Sdk">
// Remove BOM and XML declaration
content = content.replace(/^\uFEFF/, '');
content = content.replace(/<\?xml[^?]*\?>/, '');
content = content.replace(/<Project>/, '<Project Sdk="Microsoft.NET.Sdk">');

// 2. Remove explicit SDK imports
content = content.replace(/\s*<Import Project="Sdk\.props"[^/]*\/>/g, '');
content = content.replace(/\s*<Import Project="Sdk\.targets"[^/]*\/>/g, '');

// 3. Remove Analyzer items (Unity source generators)
content = content.replace(/\s*<Analyzer Include="[^"]*"\s*\/>/g, '');

// 4. Remove BaseIntermediateOutputPath and IntermediateOutputPath
content = content.replace(/\s*<BaseIntermediateOutputPath>[^<]*<\/BaseIntermediateOutputPath>/g, '');
content = content.replace(/\s*<IntermediateOutputPath>[^<]*<\/IntermediateOutputPath>/g, '');

// 5. Remove GenerateDocumentationFile and DocumentationFile
content = content.replace(/<GenerateDocumentationFile>[^<]*<\/GenerateDocumentationFile>/g, '');
content = content.replace(/<DocumentationFile>[^<]*<\/DocumentationFile>/g, '');

// 6. Remove Unity-specific properties
content = content.replace(/\s*<UnityProjectGenerator>[^<]*<\/UnityProjectGenerator>/g, '');
content = content.replace(/\s*<UnityProjectGeneratorVersion>[^<]*<\/UnityProjectGeneratorVersion>/g, '');
content = content.replace(/\s*<UnityProjectGeneratorStyle>[^<]*<\/UnityProjectGeneratorStyle>/g, '');
content = content.replace(/\s*<UnityProjectType>[^<]*<\/UnityProjectType>/g, '');
content = content.replace(/\s*<UnityBuildTarget>[^<]*<\/UnityBuildTarget>/g, '');
content = content.replace(/\s*<UnityVersion>[^<]*<\/UnityVersion>/g, '');
content = content.replace(/\s*<ProjectCapability Include="Unity"\s*\/>/g, '');

// 7. Remove empty ItemGroups
content = content.replace(/\s*<ItemGroup>\s*<\/ItemGroup>/g, '');

// 8. Clean up multiple blank lines
content = content.replace(/\n{3,}/g, '\n\n');

fs.writeFileSync(OUTPUT, content.trim() + '\n', 'utf-8');
console.log(`Written: ${OUTPUT}`);

// Verify
const outContent = fs.readFileSync(OUTPUT, 'utf-8');
console.log(`Starts with: ${outContent.substring(0, 100)}`);
console.log(`Compile items: ${(outContent.match(/<Compile/g) || []).length}`);
console.log(`Reference items: ${(outContent.match(/<Reference/g) || []).length}`);
console.log(`Analyzer items: ${(outContent.match(/<Analyzer/g) || []).length}`);
console.log(`Has Sdk.props import: ${outContent.includes('Sdk.props')}`);
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
const slnPath = path.join(ballClientRoot, 'ballclient-sdk.sln');
fs.writeFileSync(slnPath, slnContent.trim() + '\n', 'utf-8');
console.log(`Written: ${slnPath}`);
