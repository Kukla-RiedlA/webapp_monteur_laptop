# Windows-Installer bauen und Upload-Artefakte fuer Dispo Laptop-Releases auflisten.
# Aufruf im Ordner electron: .\build.ps1
# Optional: .\build.ps1 -SkipNpmInstall

param(
    [switch]$SkipNpmInstall
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
Push-Location $here
try {
    if (-not $SkipNpmInstall) {
        Write-Host "npm install ..."
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install fehlgeschlagen (exit $LASTEXITCODE)." }
    }
    Write-Host "App-Icons (Kukla-Logo) ..."
    npm run generate-icons
    if ($LASTEXITCODE -ne 0) { throw "generate-icons fehlgeschlagen (exit $LASTEXITCODE)." }
    Write-Host "electron-builder (win) ..."
    npm run dist
    if ($LASTEXITCODE -ne 0) { throw "npm run dist fehlgeschlagen (exit $LASTEXITCODE)." }

    $dist = Join-Path $here "dist"
    if (-not (Test-Path $dist)) {
        throw "dist/ fehlt nach Build."
    }

    Write-Host ""
    Write-Host "=== Artefakte fuer Dispo (System -> Deploy, Laptop-Releases, Als current setzen) ==="
    $uploadFiles = Get-ChildItem $dist -File | Where-Object {
        $_.Extension -in @(".exe", ".yml", ".yaml", ".blockmap")
    } | Sort-Object Name

    if (-not $uploadFiles -or $uploadFiles.Count -eq 0) {
        Write-Warning "Keine .exe/.yml/.blockmap in dist/ gefunden."
    } else {
        foreach ($f in $uploadFiles) {
            $mb = [math]::Round($f.Length / 1MB, 2)
            Write-Host ("  {0,-55} {1,8} MB" -f $f.Name, $mb)
        }
    }

    $latestYml = Join-Path $dist "latest.yml"
    if (-not (Test-Path $latestYml)) {
        Write-Warning "latest.yml fehlt - electron-updater braucht diese Datei im Feed (current/)."
        exit 1
    }
    Write-Host ""
    Write-Host "Feed-Test (nach Upload + Activate auf dem Server):"
    Write-Host '  {dispoBase}/api/laptop_release_feed.php/latest.yml'
} finally {
    Pop-Location
}
