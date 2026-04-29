# Git Hooks (Versions-Patch)

Der `pre-commit`-Hook erhoeht die App-Version in `electron/version.json`, `config/version.php` und `electron/package.json` (SemVer) um **Patch +1** gegenueber `HEAD`, sobald `HEAD` bereits das Format `V major.release.patch` nutzt.

## Einmalige Aktivierung (im Repo-Root `webapp_monteur_laptop/`)

```bash
git config core.hooksPath githooks
```

Voraussetzung: `node` im PATH.

## Notfall / Amend

```bash
export KUKLA_SKIP_VERSION_HOOK=1
```

PowerShell: `$env:KUKLA_SKIP_VERSION_HOOK = "1"`
