$ErrorActionPreference = 'Stop'
$monitorNode = (Get-Command node -ErrorAction Stop).Source
& $monitorNode (Join-Path $PSScriptRoot 'src\service.cjs') --stop
exit $LASTEXITCODE
