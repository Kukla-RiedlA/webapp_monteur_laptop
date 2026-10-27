# Git Hooks (Versions-Patch)

Der `pre-commit`-Hook erhoeht die App-Version in `electron/version.json`, `config/version.php` und `electron/package.json` (SemVer) um **Patch +1** gegenueber `HEAD`, sobald `HEAD` bereits das Format `V major.release.patch` nutzt.

## Automatisch

Im Repo-Root **`npm install`** / **`npm ci`**: `prepare` setzt `core.hooksPath` auf `githooks` (siehe `package.json`, `scripts/install-githooks.cjs`).

## Manuell

```bash
git config core.hooksPath githooks
```

Voraussetzung beim Commit: **`node`** im PATH.

## Schnelle Lib-Tests (pre-commit)

Wenn der Commit Dateien unter `electron/lib/` enthaelt, laeuft vor dem Versions-Bump `node scripts/run-lib-unit-tests.js` (alle `lib/**/*.test.js`). PDF-Skripte unter `electron/scripts/` bleiben manuell.

Manuell aus `electron/`: `npm test`.

Ueberspringen, Versions-Bump bleibt: `KUKLA_SKIP_UNIT_TESTS=1`. `KUKLA_SKIP_VERSION_HOOK=1` ueberspringt den ganzen Hook, also auch die Tests.

## Notfall / Amend

```bash
export KUKLA_SKIP_VERSION_HOOK=1
```

PowerShell: `$env:KUKLA_SKIP_VERSION_HOOK = "1"`

## OneDrive-Sicherung (pre-push)

`githooks/pre-push` spiegelt den gesamten Plattform-Ordner nach `P:\OneDrive - KUKLA Waagenfabrik GmbH & Co KG\Software Tools AI\Kukla_Monteur_Plattform`, inklusive Dateien ausserhalb von Git. Abschalten: `KUKLA_SKIP_ONEDRIVE_BACKUP=1`. Ein Sicherungsfehler stoppt den Push nicht. Skript: `scripts/backup-push-to-onedrive.ps1` im Plattform-Root.
