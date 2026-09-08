# Build an x64 Windows installer from a Windows checkout.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
foreach ($tool in @('node.exe','npm.cmd','cargo.exe')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is missing. Install Node.js LTS and Rust (MSVC), then reopen PowerShell." }
}
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
& npm.cmd test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }
& npm.cmd run build:windows -- --target x86_64-pc-windows-msvc
if ($LASTEXITCODE -ne 0) { throw 'Windows build failed' }
$installers = @(Get-ChildItem 'src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe')
if (-not $installers.Count) { throw 'Installer was not produced' }
$installers | Get-FileHash -Algorithm SHA256 | Format-Table -AutoSize
