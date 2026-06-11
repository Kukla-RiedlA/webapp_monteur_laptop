# Windows-Installer bauen und Upload-Artefakte fuer Dispo Laptop-Releases auflisten.
# Aufruf im Ordner electron: .\build.ps1
# Optional: .\build.ps1 -SkipNpmInstall

param(
    [switch]$SkipNpmInstall
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot

function Stop-MonteurElectronForBuild {
    $names = @("electron", "Monteur WebApp")
    foreach ($name in $names) {
        Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
            Write-Host "Beende Prozess: $($_.ProcessName) (PID $($_.Id))"
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Milliseconds 800
}

# dist-build statt dist: altes dist/ bleibt oft durch laufende App/Cursor/AV gesperrt (app.asar).
$script:BuildOutputDirName = "dist-build"

function Clear-BuildOutputDirBeforeBuild {
    $outRoot = Join-Path $here $script:BuildOutputDirName
    if (-not (Test-Path -LiteralPath $outRoot)) {
        return
    }
    Write-Host "Bereinige $script:BuildOutputDirName (vorherige Build-Artefakte) ..."
    try {
        Remove-Item -LiteralPath $outRoot -Recurse -Force -ErrorAction Stop
    } catch {
        $stamp = Get-Date -Format "yyyyMMddHHmmss"
        $script:BuildOutputDirName = "dist-build-$stamp"
        Write-Warning "Konnte $outRoot nicht loeschen ($($_.Exception.Message)) - nutze $script:BuildOutputDirName"
    }
}

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
    $devDb = Join-Path $here "db\monteur.db"
    if (Test-Path $devDb) {
        throw @"
Build abgebrochen: electron\db\monteur.db ist vorhanden (Entwickler-Daten).
Diese Datei wuerde mit dem Installer an andere Monteure verteilt.
Loeschen oder verschieben, dann erneut .\build.ps1 ausfuehren.
"@
    }
    $devDr = Join-Path $here "db\dienstreise_config.json"
    if (Test-Path $devDr) {
        $cfg = Get-Content $devDr -Raw | ConvertFrom-Json
        if ($cfg.basePath -and ($cfg.basePath.ToString().Trim().Length -gt 0)) {
            throw @"
Build abgebrochen: electron\db\dienstreise_config.json enthaelt basePath ($($cfg.basePath)).
Fuer Installer nur leere Vorlage oder Datei entfernen.
"@
        }
    }
    Stop-MonteurElectronForBuild
    Clear-BuildOutputDirBeforeBuild
    $outputDir = $script:BuildOutputDirName
    Write-Host "electron-builder (win) -> $outputDir ..."
    & npm.cmd run dist -- "--config.directories.output=$outputDir"
    if ($LASTEXITCODE -ne 0) { throw "npm run dist fehlgeschlagen (exit $LASTEXITCODE)." }

    $dist = Join-Path $here $script:BuildOutputDirName
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
