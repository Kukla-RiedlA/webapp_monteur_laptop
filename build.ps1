# Build-Skript: Electron-Installer erstellen (Windows NSIS)
# Liest Version aus electron/version.json, synchronisiert package.json, baut Installer.
# Aufruf: .\build.ps1
# Optional: .\build.ps1 -DeployPath "C:\deploy\laptop"  (Kopiert Installer nach Build)

param(
    [string]$DeployPath = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = $PSScriptRoot
$electronDir = Join-Path $repoRoot "electron"

function Stop-MonteurElectronForBuild {
    foreach ($name in @("electron", "Monteur WebApp")) {
        Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
            Write-Host "Beende Prozess: $($_.ProcessName) (PID $($_.Id))"
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Milliseconds 800
}

$script:BuildOutputDirName = "dist-build"

function Clear-ElectronBuildOutput {
    param([string]$ElectronDir)
    $outRoot = Join-Path $ElectronDir $script:BuildOutputDirName
    if (-not (Test-Path -LiteralPath $outRoot)) { return }
    Write-Host "Bereinige electron\$script:BuildOutputDirName ..."
    try {
        Remove-Item -LiteralPath $outRoot -Recurse -Force -ErrorAction Stop
    } catch {
        $stamp = Get-Date -Format "yyyyMMddHHmmss"
        $script:BuildOutputDirName = "dist-build-$stamp"
        Write-Warning "Ausgabeordner gesperrt - nutze $script:BuildOutputDirName"
    }
}
$versionJsonPath = Join-Path $electronDir "version.json"
$packageJsonPath = Join-Path $electronDir "package.json"

$versionJson = Get-Content $versionJsonPath -Raw | ConvertFrom-Json
$appVersion = $versionJson.version.Trim()

# SemVer: V 1.100.000 -> 1.100.0 (Integer-Segmente)
if ($appVersion -match '^\s*V\s*([1-9]\d*)\.(\d{3})\.(\d{3})\s*$') {
    $maj = [int]$Matches[1]
    $rel = [int]$Matches[2]
    $pat = [int]$Matches[3]
    $semver = "$maj.$rel.$pat"
} else {
    $semver = "1.0.0"
}

Write-Host "Version: $appVersion (package.json: $semver)"

$packageContent = Get-Content $packageJsonPath -Raw
$packageContent = $packageContent -replace '"version"\s*:\s*"[^"]*"', "`"version`": `"$semver`""
Set-Content $packageJsonPath -Value $packageContent -NoNewline

Stop-MonteurElectronForBuild
Clear-ElectronBuildOutput -ElectronDir $electronDir

Push-Location $electronDir
try {
    $outputDir = $script:BuildOutputDirName
    & npm.cmd run dist -- "--config.directories.output=$outputDir"
    if ($LASTEXITCODE -ne 0) {
        throw "npm run dist fehlgeschlagen"
    }

    $distDir = Join-Path $electronDir $script:BuildOutputDirName
    $installer = Get-ChildItem -Path $distDir -Filter "*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1

    if ($installer) {
        Write-Host "Installer: $($installer.FullName)"
        if ($DeployPath -and (Test-Path $DeployPath)) {
            Copy-Item $installer.FullName -Destination (Join-Path $DeployPath $installer.Name) -Force
            Write-Host "Kopiert nach: $DeployPath"
        }
    }
} finally {
    Pop-Location
}

Write-Host "Build abgeschlossen."
