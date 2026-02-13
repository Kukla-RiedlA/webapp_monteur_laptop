# Release-Skript: Version setzen, commit, Git-Tag (Label) setzen und push
# Aufruf: .\release.ps1 "V 1.002"
# Oder Build hochzählen: .\release.ps1 --bump

param(
    [Parameter(Position = 0)]
    [string]$Version
)

$ErrorActionPreference = "Stop"
$repoRoot = $PSScriptRoot

# Aktuelle Version aus version.json lesen
$versionJsonPath = Join-Path $repoRoot "electron\version.json"
$versionPhpPath = Join-Path $repoRoot "config\version.php"

function Get-CurrentVersion {
    $json = Get-Content $versionJsonPath -Raw | ConvertFrom-Json
    return $json.version.Trim()
}

function Set-VersionFiles($newVersion) {
    # Format für Tag: V 1.002 -> v1.002 (ohne Leerzeichen)
    $tagName = "v" + ($newVersion -replace "\s+", "")
    $versionPhpContent = Get-Content $versionPhpPath -Raw
    $versionPhpContent = $versionPhpContent -replace "(?<=\$APP_VERSION = ')V \d+\.\d+(?=';)", $newVersion
    Set-Content $versionPhpPath -Value $versionPhpContent -NoNewline

    $versionJson = @{ version = $newVersion } | ConvertTo-Json
    Set-Content $versionJsonPath -Value $versionJson -NoNewline

    return $tagName
}

if ($Version -eq "--bump") {
    $current = Get-CurrentVersion
    if ($current -match 'V\s*(\d+)\.(\d+)') {
        $build = [int]$Matches[2] + 1
        $Version = "V $($Matches[1]).$build"
    } else {
        Write-Error "Aktuelle Version konnte nicht gelesen werden: $current"
    }
}

if ([string]::IsNullOrWhiteSpace($Version)) {
    Write-Host "Aufruf: .\release.ps1 `"V 1.002`"   (neue Version setzen)"
    Write-Host "        .\release.ps1 --bump        (Build-Nummer um 1 erhoehen)"
    exit 1
}

# Version im Format "V 1.002" normalisieren
if ($Version -notmatch '^V\s*\d+\.\d+') {
    $Version = "V " + ($Version -replace '^v\s*', '' -replace '^V\s*', '')
}

Write-Host "Neue Version: $Version"
$tagName = Set-VersionFiles $Version
Write-Host "Tag-Name:     $tagName"

Push-Location $repoRoot
try {
    git add config/version.php electron/version.json
    git status --short
    $commitMsg = "Release $Version"
    git commit -m $commitMsg
    git tag -a $tagName -m $commitMsg
    git push --follow-tags
    Write-Host "Release $Version (Tag: $tagName) gepusht."
} catch {
    Write-Error $_
    exit 1
} finally {
    Pop-Location
}
