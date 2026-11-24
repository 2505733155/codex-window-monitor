param(
    [string]$ExtensionsDirectory,
    [string]$CodexExecutable,
    [string]$RuntimeDirectory = (Join-Path $PSScriptRoot '.runtime'),
    [switch]$Disable
)

$ErrorActionPreference = 'Stop'
$runtime = [IO.Path]::GetFullPath($RuntimeDirectory)
$marker = Join-Path $runtime 'relay-enabled'
if ($Disable) {
    if (Test-Path -LiteralPath $marker -PathType Leaf) { Remove-Item -LiteralPath $marker }
    return
}

$node = (Get-Command node -CommandType Application).Source
if ([int](& $node -p 'process.versions.node.split(".")[0]') -lt 22) { throw 'Node.js 22 or later is required.' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'The Windows .NET Framework C# compiler was not found.' }
$settings = @{}
if ($ExtensionsDirectory) { $settings.extensionsDirectory = (Resolve-Path -LiteralPath $ExtensionsDirectory).Path }
if ($CodexExecutable) { $settings.codexExecutable = (Resolve-Path -LiteralPath $CodexExecutable).Path }
$relayDirectory = Join-Path $runtime 'codex-relay'
New-Item -ItemType Directory -Path $relayDirectory -Force | Out-Null
$launcher = Join-Path $relayDirectory 'codex-monitor-relay.exe'
& $compiler /nologo /target:exe "/out:$launcher" (Join-Path $PSScriptRoot 'src\native\CodexRelayLauncher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Could not build the Codex relay launcher. Close configured VS Code windows before reinstalling.' }
foreach ($file in @('codex-relay.cjs','app-server.cjs','stream-json.cjs','input-state.cjs')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "src\$file") -Destination $relayDirectory
}
Set-Content -LiteralPath (Join-Path $relayDirectory 'node.path') -Encoding UTF8 -Value $node
Set-Content -LiteralPath (Join-Path $relayDirectory 'settings.json') -Encoding UTF8 -Value (ConvertTo-Json -InputObject $settings -Compress)
Set-Content -LiteralPath $marker -Encoding Ascii -Value '1'
Write-Output $launcher
