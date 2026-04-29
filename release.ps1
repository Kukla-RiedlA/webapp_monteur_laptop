# Release-Skript: Version setzen, commit, Git-Tag (Label) setzen und push
# Format: V <major>.<release>.<patch> z. B. V 1.100.000 (major ohne fuehrende Null; release/patch je 3 Ziffern)
# Aufruf: .\release.ps1 "V 1.100.001"   oder   .\release.ps1 --bump

param(
    [Parameter(Position = 0)]
    [string]$Version
)

$ErrorActionPreference = "Stop"
$repoRoot = $PSScriptRoot

$versionJsonPath = Join-Path $repoRoot "electron\version.json"
$versionPhpPath = Join-Path $repoRoot "config\version.php"

function Test-KuklaAppVersion([string]$v) {
    return $v -match '^\s*V\s*([1-9]\d*)\.(\d{3})\.(\d{3})\s*$'
}

function Normalize-KuklaAppVersion([string]$v) {
    if (-not (Test-KuklaAppVersion $v)) { return $null }
    if ($v -match '^\s*V\s*([1-9]\d*)\.(\d{3})\.(\d{3})\s*$') {
        return "V $($Matches[1]).$($Matches[2]).$($Matches[3])"
    }
    return $null
}

function AppVersion-ToSemVer([string]$appVer) {
    if ($appVer -match '^\s*V\s*([1-9]\d*)\.(\d{3})\.(\d{3})\s*$') {
        $maj = [int]$Matches[1]
        $rel = [int]$Matches[2]
        $pat = [int]$Matches[3]
        return "$maj.$rel.$pat"
    }
    return "1.0.0"
}

function TagName-FromAppVersion([string]$appVer) {
    if ($appVer -match '^\s*V\s*([1-9]\d*)\.(\d{3})\.(\d{3})\s*$') {
        return "v$($Matches[1]).$($Matches[2]).$($Matches[3])"
    }
    throw "Kein gueltiges Tag aus Version: $appVer"
}

function Get-CurrentVersion {
    $json = Get-Content $versionJsonPath -Raw | ConvertFrom-Json
    return $json.version.Trim()
}

function Set-VersionFiles($newVersion) {
    $norm = Normalize-KuklaAppVersion $newVersion
    if (-not $norm) { throw "Ungueltige Version (erwartet z. B. V 1.100.000): $newVersion" }
    $tagName = TagName-FromAppVersion $norm
    $versionPhpContent = Get-Content $versionPhpPath -Raw
    $versionPhpContent = $versionPhpContent -replace "(?<=\`$APP_VERSION = ')[^']+(?=';)", $norm
    Set-Content $versionPhpPath -Value $versionPhpContent -NoNewline

    $versionJson = (@{ version = $norm } | ConvertTo-Json -Compress)
    Set-Content $versionJsonPath -Value $versionJson -NoNewline -Encoding UTF8

    $packageJsonPath = Join-Path $repoRoot "electron\package.json"
    $semver = AppVersion-ToSemVer $norm
    $pkg = Get-Content $packageJsonPath -Raw
    $pkg = $pkg -replace '"version"\s*:\s*"[^"]*"', "`"version`": `"$semver`""
    Set-Content $packageJsonPath -Value $pkg -NoNewline

    return $tagName
}

if ($Version -eq "--bump") {
    $current = Get-CurrentVersion
    if ($current -match '^\s*V\s*([1-9]\d*)\.(\d{3})\.(\d{3})\s*$') {
        $maj = [int]$Matches[1]
        $rel = [int]$Matches[2]
        $pat = [int]$Matches[3] + 1
        if ($pat -gt 999) { throw "Patch > 999, bitte Release-Stelle erhoehen." }
        $Version = "V $maj.$($rel.ToString('000')).$($pat.ToString('000'))"
    } else {
        Write-Error "Aktuelle Version konnte nicht gelesen werden: $current"
    }
}

if ([string]::IsNullOrWhiteSpace($Version)) {
    Write-Host "Aufruf: .\release.ps1 `"V 1.100.001`"   (neue Version setzen)"
    Write-Host "        .\release.ps1 --bump        (Patch um 1 erhoehen)"
    exit 1
}

$Version = Normalize-KuklaAppVersion $Version
if (-not $Version) {
    Write-Error "Ungueltige Version. Erwartet: V <major>.<release>.<patch> (z. B. V 1.100.000)."
}

Write-Host "Neue Version: $Version"
$tagName = Set-VersionFiles $Version
Write-Host "Tag-Name:     $tagName"

Push-Location $repoRoot
try {
    git add -A
    git status --short
    $commitMsg = "Release $Version"
    git commit -m $commitMsg
    $tagExists = git tag -l $tagName 2>$null
    if ($tagExists) {
        git tag -d $tagName 2>$null
        Write-Host "Alten Tag $tagName entfernt, setze neu auf aktuellen Commit."
    }
    git tag -a $tagName -m $commitMsg
    git push
    git push origin $tagName --force
    Write-Host "Release $Version (Tag: $tagName) gepusht."
    git reset --hard HEAD
    Write-Host "Arbeitsverzeichnis mit Release-Commit abgeglichen."
} catch {
    Write-Error $_
    exit 1
} finally {
    Pop-Location
}
