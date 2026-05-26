# Ordner `electron/db` (nur Quell-/Build-Artefakte)

## Im Installer erlaubt

- `schema.sql` — leeres SQLite-Schema für die Erstinstallation

## Nicht ins Setup packen (lokal, gitignored)

- `monteur.db` — Entwickler-Datenbank; würde sonst an alle Monteure mitgeliefert
- `dienstreise_config.json` mit persönlichem `basePath`
- `app_config.json` mit `acceptSelfSignedDispoTls: true` (Standard, fest — kein UI-Schalter)
- `.dispo-tls-insecure` (Legacy-Flag, wird automatisch gesetzt)

`.\build.ps1` bricht ab, wenn `monteur.db` oder ein befüllter `dienstreise_config.json` vorhanden ist.

Pro Monteur/Windows-Benutzer: Daten unter `%APPDATA%\monteur-webapp\db\` (wird beim ersten Start angelegt).
