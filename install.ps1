# hrok installer (Windows x64). No admin; installs to %LOCALAPPDATA%\hrok.
#   irm https://raw.githubusercontent.com/hmdlohar/hrok/main/install.ps1 | iex
# Re-run to upgrade.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is ~10x slower with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072  # TLS 1.2 on old PS 5.1

$dir = Join-Path $env:LOCALAPPDATA 'hrok'
$exe = Join-Path $dir 'hrok.exe'
$url = 'https://github.com/hmdlohar/hrok/releases/latest/download/hrok.exe'

New-Item -ItemType Directory -Force -Path $dir | Out-Null
Write-Host "Downloading $url"
Invoke-WebRequest $url -OutFile "$exe.new" -UseBasicParsing

# A running service locks hrok.exe against overwrite, but Windows allows
# renaming it away. The service picks up the new exe on its next restart.
Remove-Item "$exe.old" -Force -ErrorAction SilentlyContinue
if (Test-Path $exe) { Move-Item -Force $exe "$exe.old" }
Move-Item -Force "$exe.new" $exe
Write-Host "Installed $exe"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $dir)) {
    [Environment]::SetEnvironmentVariable('Path', (($userPath, $dir) -ne '' -join ';'), 'User')
    $env:Path += ";$dir"
    Write-Host "Added $dir to your PATH (new terminals pick it up)."
}
Write-Host 'Run:      hrok --server=ws://<VPS_IP>:8081 --local=3000 --subdomain=myapp'
Write-Host 'Service:  hrok --startup --server=... --local=3000 --subdomain=myapp   (one UAC prompt)'
