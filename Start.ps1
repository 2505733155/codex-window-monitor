$ErrorActionPreference = 'Stop'
$monitorNode = (Get-Command node -ErrorAction Stop).Source
$monitorService = Join-Path $PSScriptRoot 'src\service.cjs'
$monitorArguments = '"' + $monitorService + '" --open'
Start-Process -FilePath $monitorNode -ArgumentList $monitorArguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
