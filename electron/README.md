# Monteur WebApp – Electron (Windows, Offline)

Desktop-App mit **eigener lokaler SQLite-DB** für Offline-Nutzung. Bei Bedarf Sync mit der PHP-WebApp (Dispo-Server).

## Voraussetzungen

- Node.js 18+ (z. B. von [nodejs.org](https://nodejs.org))
- Windows (für `npm run dist` → Windows-Installer)
- **Native SQLite:** **better-sqlite3** (WAL) — `npm install` baut das Modul per `electron-builder install-app-deps` für Electron. Auf dem Dev-PC: Visual Studio Build Tools (MSVC) für node-gyp, falls der Rebuild fehlschlägt.

## Schnellstart

```bash
cd electron
npm install
npm start
```

Es öffnet sich ein Fenster mit der Monteur-Oberfläche. Die App läuft **offline** gegen die lokale SQLite-DB (`monteur.db` unter `%APPDATA%\monteur-webapp\db\` in der installierten App, Dev: `electron/db/`).

## Ablauf

1. **Offline:** Monteur-ID eingeben (muss vorher einmal per Sync vom Server gekommen sein oder Sie legen einen lokalen Benutzer an). Ohne Sync sind „Meine Aufträge“ leer, bis Sie einmal „Vom Server holen“ ausführen.
2. **Vom Dispo-Server holen:** Dispo-Server-URL eintragen (z. B. `http://localhost/`). Die Monteur-API liegt **im Dispo-Projekt** unter `htdocs/api/` (my_jobs.php, my_absences.php, job.php, absence.php). Dann „Vom Dispo-Server holen“ – die App speichert Aufträge und Abwesenheiten in SQLite.
3. **Offline arbeiten:** Aufträge laden, Status auf „Start“ / „Erledigt“ setzen. Änderungen werden lokal gespeichert und in `pending_changes` vermerkt.
4. **Änderungen hochladen:** Bei Verbindung zum Server „Änderungen hochladen“ – die App sendet alle ausstehenden Status- und Abwesenheits-Änderungen an die PHP-API.

## Lokale DB (SQLite)

- Datei: `electron/db/monteur.db`
- Schema: `electron/db/schema.sql` (wird beim ersten Start angelegt)
- Kein separater DB-Server nötig – alles in einer Datei, ideal für Offline.

## Windows-Build (Installer)

```bash
npm run dist
```

Ergebnis unter `electron/dist/` (z. B. NSIS-Installer für Windows).

## API (lokal)

Der integrierte Express-Server läuft auf **Port 39678** und bietet die gleichen Pfade wie die PHP-API (ohne `.php`):

- `GET /api/my_jobs?technician_id=3`
- `GET /api/job?id=5&technician_id=3`
- `PATCH /api/job` (Body: `job_id`, `status` oder `description`)
- `GET /api/my_absences?technician_id=3`
- `POST /api/absence`, `PATCH /api/absence`, `DELETE /api/absence`
- `POST /api/sync_pull` (Body: `baseUrl`, `technicianId`)
- `POST /api/sync_push` (Body: `baseUrl`, `technicianId`)
- `GET /api/jobs_open_local` – offene Aufträge aus SQLite (Filter wie Dispo `jobs_open.php`)

Die UI spricht immer mit diesem lokalen Server; Sync verbindet sich mit dem **Dispo-Server**.

### Verbindungs-Badge und Sync (Offline-First)

- **Start:** Listen/Kalender/Abwesenheiten sofort aus SQLite (`bootstrapLocalData`); Badge zunächst „Lokale Daten — Sync im Hintergrund“.
- **Lokal:** keine Dispo-URL konfiguriert (reines Offline-Arbeiten mit SQLite).
- **Offline:** URLs gesetzt, Dispo nicht erreichbar (`check_connection` mit 10 s Timeout).
- **Online / Syncing / Degraded:** `GET /api/sync_status` nach Hintergrund-Push/Pull; letzter fehlgeschlagener Pull oder ausstehende `pending_changes` → Badge „degraded“.
- **Offene Aufträge / Kalender:** nur **`jobs_open_local`** bzw. **`calendar_cached`** (kein Live-`jobs_open` / Live-`calendar` im Standard-Render-Pfad).
- **Queue-Priorität:** `dienstreise_pull` → `dienstreise_push` → `sync_push` → `sync_pull`; Intervall-`sync_pull` wird bei laufender Kopie mit `deferred` zurückgestellt.
- **TED:** nach „Auftrag annehmen“ unter `{Projektordner}/TED/`; Metadaten in `job_ted_index`.

### Manuelle Abnahme (Kurzcheckliste)

**Offline-First (neu):**

1. DevTools **Slow 3G**: App-Neustart → Startansicht & Kalender **&lt; ~2 s** mit lokalen Daten (Badge „Lokale Daten“).
2. **Flugmodus**: Listen/Kalender/Meine Aufträge weiter nutzbar aus SQLite.
3. **Auftrag annehmen** bei langsamer Leitung: UI nicht blockiert; Hintergrund-Job; nach Abschluss Dateien unter Projektordner, **TED/** mit XLSX.
4. Während `dienstreise_pull`: Intervall-`sync_pull` loggt „zurückgestellt“ (409/deferred), kein Fehler-Toast.
5. `GET /api/sync_status` und `GET /api/offline_manifest?job_id=` liefern sinnvolle Werte nach Pull.

**Regression (bestehend):**

1. Badge „Online“ nach erfolgreicher Probe ohne langes Warten auf vollständigen Pull.
2. Projektdaten speichern → Reload behält Werte (kein Zurückspringen durch Sync).
3. Anlagendetails: Felder aus lokalem Stamm + PROJEKTE NEU (Cache, kein Dauer-„Lade Struktur…“).
4. Intervall-Sync blockiert UI nicht (kein Poll auf Intervall).
5. Manueller Sync (Badge) wartet auf Push/Pull.
6. `in_arbeit`-Auftrag bleibt nach Pull unter „Meine Aufträge“.
7. Offene Aufträge mit Filter offline aus SQLite sichtbar.
8. Terminal: kein wiederholtes `[sync_pull] anlagenstamm_db_sync: Statement closed`.

## Icon (Kukla Monteur Tool)

- **Fenster/Taskbar:** `public/icon.png` (Windows nutzt PNG; für bessere Darstellung z. B. 256×256 px verwenden).
- **Browser-Tab (Favicon):** `public/icon.svg` (K-Logo auf blauem Grund).  
Zum Austauschen: `icon.svg` anpassen oder durch eigenes Logo ersetzen; für `icon.png` eine PNG-Version (z. B. aus dem SVG exportiert) nach `public/icon.png` legen.

## Parameter-PDF testen (Layout 1:1 wie Referenz)

Nach Änderungen an der Parameter-PDF-Generierung (`lib/csv-to-pdf.js`) kannst du das Layout automatisch prüfen:

```bash
cd electron
npm run test:parameter-pdf
```

- Erzeugt eine Test-PDF unter `electron/test-output/parameter-test.pdf`.
- Prüft, ob alle erwarteten Texte (DWC-7, Printout, Parameter, KUKLA, Vöcklabruck, Name, Value, Unit, Comment, Fußzeile) in der PDF vorkommen. Fehlt etwas, schlägt der Test fehl.
- Zum sofortigen Öffnen der PDF zum visuellen Vergleich mit dem Original:

```bash
npm run test:parameter-pdf:open
```

So siehst du ohne manuelles Exportieren in der App, ob das Layout stimmt.
