$ErrorActionPreference = 'Stop'

function Get-MonitorDebugPort {
    $settings = Join-Path $PSScriptRoot '.runtime\current-session.json'
    if (-not (Test-Path -LiteralPath $settings -PathType Leaf)) { return }
    try {
        $port = (Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json).port
        if (($port -is [int] -or $port -is [long]) -and $port -ge 1 -and $port -le 65535) { return $port }
    } catch {
        Write-Warning 'Could not read the current-session preference.'
    }
}

function Find-MonitorCode {
    $cli = Get-Command code -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cli) {
        $folder = Split-Path -Parent $cli.Source
        if ((Split-Path -Leaf $folder) -eq 'bin') { $folder = Split-Path -Parent $folder }
        $candidate = Join-Path $folder 'Code.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    $executable = Get-Command Code.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($executable) { return $executable.Source }
    foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\Code.exe',
                       'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\Code.exe')) {
        $registered = Get-Item -LiteralPath $key -ErrorAction SilentlyContinue
        if ($registered) {
            $candidate = $registered.GetValue('')
            if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
        }
    }
    foreach ($base in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $base) { continue }
        foreach ($subpath in @('Programs\Microsoft VS Code\Code.exe', 'Microsoft VS Code\Code.exe')) {
            $candidate = Join-Path $base $subpath
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        }
    }
}

$monitorNode = (Get-Command node -ErrorAction Stop).Source
$monitorService = Join-Path $PSScriptRoot 'src\service.cjs'
$monitorArguments = '"' + $monitorService + '" --open'

$debugPort = Get-MonitorDebugPort
if ($debugPort -and -not (Get-Process -Name Code -ErrorAction SilentlyContinue)) {
    try {
        if (-not (Get-NetTCPConnection -LocalPort $debugPort -State Listen -ErrorAction SilentlyContinue)) {
            $editor = Find-MonitorCode
            if ($editor) {
                $editorArguments = @('--remote-debugging-address=127.0.0.1', "--remote-debugging-port=$debugPort",
                                     '--new-window', ('"' + $PSScriptRoot + '"'))
                Start-Process -FilePath $editor -ArgumentList $editorArguments -WorkingDirectory $PSScriptRoot
            } else {
                Write-Warning 'VS Code was not found. Add the code command to PATH or start VS Code manually.'
            }
        }
    } catch {
        Write-Warning 'Automatic VS Code startup failed. The monitor can still be opened.'
    }
}

Start-Process -FilePath $monitorNode -ArgumentList $monitorArguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
