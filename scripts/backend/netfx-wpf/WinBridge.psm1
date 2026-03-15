# scripts/windows/WinBridge.psm1
# PowerShell module for the node-with-window Windows backend.
# Compiles all C# sources via Add-Type and starts the named-pipe server.
$scriptDir = Split-Path $MyInvocation.MyCommand.Path

$csFiles = @(
    "$scriptDir\BridgeState.cs",
    "$scriptDir\Protocol.cs",
    "$scriptDir\WindowHelper.cs",
    "$scriptDir\WinChromeActions.cs",
    "$scriptDir\WebView2Actions.cs",
    "$scriptDir\Reflection.cs",
    "$scriptDir\PsHost.cs",
    "$scriptDir\PsHostEntry.cs"
)

$referencedAssemblies = @(
    'System.dll',
    'System.Core.dll',
    'System.Windows.Forms.dll',
    'System.Drawing.dll',
    'System.Runtime.InteropServices.dll',
    'PresentationFramework',
    'PresentationCore',
    'WindowsBase'
)

Add-Type -Path $csFiles -ReferencedAssemblies $referencedAssemblies

Export-ModuleMember -Function ConvertTo-Protocol, Resolve-Args, Invoke-ReflectionLogic, Remove-BridgeObject -Variable BridgeState
