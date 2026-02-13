# Monteur WebApp – Electron (Windows, Offline)

Desktop-App mit **eigener lokaler SQLite-DB** für Offline-Nutzung. Bei Bedarf Sync mit der PHP-WebApp (Dispo-Server).

## Voraussetzungen

- Node.js 18+ (z. B. von [nodejs.org](https://nodejs.org))
- Windows (für `npm run dist` → Windows-Installer)
- **Keine Build-Tools nötig:** Es wird **sql.js** (reines JavaScript/WASM) statt better-sqlite3 verwendet – kein C++-Compiler erforderlich.

## Schnellstart

```bash
cd electron
npm install
npm start
```

Es öffnet sich ein Fenster mit der Monteur-Oberfläche. Die App läuft **offline** gegen die lokale SQLite-DB unter `electron/db/monteur.db`.

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

Die UI spricht immer mit diesem lokalen Server; Sync verbindet sich mit dem **Dispo-Server**. Die Monteur-API (my_jobs.php, my_absences.php, job.php, absence.php) ist im Dispo-Projekt unter `htdocs/api/` angelegt – bei Dispo unter `http://localhost/` also z. B. `http://localhost/api/my_jobs.php`.

## Icon (Kukla Monteur Tool)

- **Fenster/Taskbar:** `public/icon.png` (Windows nutzt PNG; für bessere Darstellung z. B. 256×256 px verwenden).
- **Browser-Tab (Favicon):** `public/icon.svg` (K-Logo auf blauem Grund).  
Zum Austauschen: `icon.svg` anpassen oder durch eigenes Logo ersetzen; für `icon.png` eine PNG-Version (z. B. aus dem SVG exportiert) nach `public/icon.png` legen.
