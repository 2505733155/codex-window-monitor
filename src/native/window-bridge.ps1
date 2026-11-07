$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    Add-Type -Path (Join-Path $PSScriptRoot 'WindowBridge.cs')
    if ($request.action -eq 'list') {
        $result = @{ ok = $true; windows = @([MonitorWindowBridge]::List()) }
    } elseif ($request.action -eq 'activate') {
        $result = @{ ok = $true; result = [MonitorWindowBridge]::Activate([long]$request.handle, [uint32]$request.processId, [string]$request.processStarted, [string]$request.title) }
    } else { throw 'Unsupported native action' }
    $result | ConvertTo-Json -Depth 6 -Compress
} catch {
    @{ ok = $false; error = 'Native window operation failed' } | ConvertTo-Json -Compress
    exit 1
}
