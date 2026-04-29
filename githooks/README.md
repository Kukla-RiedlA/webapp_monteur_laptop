# Git Hooks (Versions-Patch)

Der `pre-commit`-Hook erhoeht die App-Version in `electron/version.json`, `config/version.php` und `electron/package.json` (SemVer) um **Patch +1** gegenueber `HEAD`, sobald `HEAD` bereits das Format `V major.release.patch` nutzt.

## Automatisch

Im Repo-Root **`npm install`** / **`npm ci`**: `prepare` setzt `core.hooksPath` auf `githooks` (siehe `package.json`, `scripts/install-githooks.cjs`).

## Manuell

```bash
git config core.hooksPath githooks
```

Voraussetzung beim Commit: **`node`** im PATH.

## Notfall / Amend

```bash
export KUKLA_SKIP_VERSION_HOOK=1
```

PowerShell: `$env:KUKLA_SKIP_VERSION_HOOK = "1"`
