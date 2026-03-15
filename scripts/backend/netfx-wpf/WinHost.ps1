# scripts/backend/netfx-wpf/WinHost.ps1
# Entry point for the node-with-window Windows backend process.
# Spawned by the Node.js backend with -PipeName <name>.
param($PipeName)

$ScriptDir = Split-Path $MyInvocation.MyCommand.Path

Import-Module "$ScriptDir\WinBridge" -Force

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::InvariantCulture
[System.Threading.Thread]::CurrentThread.CurrentUICulture = [System.Globalization.CultureInfo]::InvariantCulture
$ErrorActionPreference = "Stop"

[PsHostEntry]::Run($PipeName)
