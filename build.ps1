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
$versionJsonPath = Join-Path $electronDir "version.json"
$packageJsonPath = Join-Path $electronDir "package.json"

# Version aus version.json lesen (Format: V 1.025)
$versionJson = Get-Content $versionJsonPath -Raw | ConvertFrom-Json
$appVersion = $versionJson.version.Trim()

# In SemVer für package.json umwandeln: V 1.025 -> 1.0.25
if ($appVersion -match 'V\s*(\d+)\.(\d+)') {
    $buildNum = $Matches[2].TrimStart('0')
    if ($buildNum -eq '') { $buildNum = '0' }
    $semver = "$($Matches[1]).0.$buildNum"
} else {
    $semver = "1.0.0"
}

Write-Host "Version: $appVersion (package.json: $semver)"

# package.json Version aktualisieren
$packageContent = Get-Content $packageJsonPath -Raw
$packageContent = $packageContent -replace '"version"\s*:\s*"[^"]*"', "`"version`": `"$semver`""
Set-Content $packageJsonPath -Value $packageContent -NoNewline

# Build ausführen
Push-Location $electronDir
try {
    npm run dist
    if ($LASTEXITCODE -ne 0) {
        throw "npm run dist fehlgeschlagen"
    }

    # Installer-Pfad (electron-builder Standard)
    $distDir = Join-Path $electronDir "dist"
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
