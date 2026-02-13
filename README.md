# Monteur WebApp - Dispo Datenempfang

Dieser Stand ist ein Startpunkt, um Daten aus einer Monteur-Dispo per HTTP zu empfangen und in MySQL zu verarbeiten.

## Enthalten

- **Dispo-Daten empfangen (Push):** `api/receive_dispo.php` – POST JSON, speichert in eigener DB
- **Dispo-DB lesen/schreiben (fsm):** Monteur-APIs lesen und schreiben direkt in der Dispo-Datenbank `fsm`:
  - `api/my_jobs.php` – Auftraege des Monteurs (mit Adresse/Kunde)
  - `api/job.php` – Einzelauftrag abrufen (GET), Status/Beschreibung aendern (PATCH)
  - `api/my_absences.php` – Abwesenheiten des Monteurs
  - `api/absence.php` – Abwesenheit anlegen (POST), aendern (PATCH), loeschen (DELETE)
- `src/DispoRepository.php`: Lese-/Schreibzugriff auf fsm (jobs, job_addresses, job_technicians, absences)
- `src/Db.php`: Zwei Verbindungen – `Db::connection()` (WebApp), `Db::fsm()` (Dispo-DB)
- `db/schema.sql`: Tabellen fuer die WebApp-DB; Dispo-Struktur liegt in `htdocs/db/fsm_init.sql`
- **Electron-Desktop-App (Offline):** Unterordner `electron/` – Windows-App mit **eigener SQLite-DB**. Sync mit dem **Dispo-Server** („Vom Dispo-Server holen“ / „Aenderungen an Dispo senden“). Die Monteur-API (my_jobs, my_absences, job, absence) ist dazu **im Dispo-Projekt** unter `htdocs/api/` angelegt – siehe `electron/README.md`.

## Voraussetzungen

- PHP 8.1+ mit `pdo_mysql`
- MySQL 8+
- XAMPP/Apache (oder anderer PHP-Webserver)

## Setup

1. Datenbank und Tabellen anlegen:
   - Inhalt aus `db/schema.sql` ausfuehren
2. Environment setzen:
   - `.env.example` nach `.env` kopieren und Werte anpassen
   - Fuer Monteur-APIs: FSM_DB_* auf die Dispo-Datenbank `fsm` zeigen (gleicher Server wie htdocs)
3. Dispo-DB `fsm` muss existieren (z. B. via `htdocs/db/fsm_init.sql`). Fuer die Monteur-API mindestens einen Benutzer mit Rolle `monteur` anlegen; dessen `users.id` ist die `technician_id`. Auftraege ueber `job_technicians` dem Monteur zuordnen.
4. Endpoints:
   - Push: `POST /api/receive_dispo.php`
   - Monteur: siehe Abschnitt „Monteur-API (Dispo-DB lesen/schreiben)“.

## Sicherheit

- Optionaler API-Key:
  - Setze `DISPO_API_KEY` in `.env`
  - Sende dann `X-Api-Key: <dein_key>` oder `Authorization: Bearer <dein_key>`
- Wenn kein `DISPO_API_KEY` gesetzt ist, ist kein Key erforderlich (nur fuer lokale Entwicklung empfohlen).

## Idempotenz

- Batches werden ueber `sourceSystem + correlationId` idempotent verarbeitet.
- Wenn derselbe Request erneut ankommt und bereits verarbeitet wurde, liefert die API `idempotent: true` zurueck und schreibt keine Duplikate.

## Beispiel Payload

```json
{
  "sourceSystem": "MonteurDispo",
  "correlationId": "sync-2026-02-12-001",
  "jobs": [
    {
      "jobId": "A-1001",
      "customerName": "Musterkunde GmbH",
      "address": {
        "street": "Hauptstrasse 1",
        "postalCode": "12345",
        "city": "Berlin"
      },
      "schedule": {
        "date": "2026-02-12",
        "from": "08:00",
        "to": "10:00"
      },
      "priority": "normal",
      "status": "planned",
      "technicianCode": "MON001"
    }
  ],
  "absences": [
    {
      "absenceId": "ABS-1001",
      "technicianCode": "MON001",
      "dateFrom": "2026-02-14",
      "dateTo": "2026-02-18",
      "type": "vacation",
      "note": "Urlaub"
    }
  ],
  "assignments": [
    {
      "assignmentId": "ASG-1001",
      "jobId": "A-1001",
      "technicianCode": "MON001",
      "role": "lead"
    }
  ]
}
```

## Akzeptierte Feldvarianten (Auszug)

- Root:
  - `sourceSystem` / `source_system`
  - `correlationId` / `correlation_id`
  - `jobs` / `orders` / `auftraege` (auch unter `data`)
  - `absences` / `abwesenheiten` (auch unter `data`)
  - `assignments` / `jobAssignments` / `zuweisungen` (auch unter `data`)
- Jobs:
  - `jobId` / `job_id` / `auftragId`
  - `customerName` / `customer_name` / `kundenname`
  - `address.street` / `adresse.strasse`
  - `schedule.date` / `termin.datum`

## Monteur-API (Dispo-DB lesen/schreiben)

Alle Monteur-Endpoints erwarten **technician_id** (die `users.id` aus der Dispo-DB, Rolle `monteur`) per Query oder Header `X-Technician-Id`.

| Methode | Endpoint | Beschreibung |
|--------|----------|--------------|
| GET | `my_jobs.php?technician_id=3` | Auftraege des Monteurs; optional `date_from`, `date_to` (YYYY-MM-DD) |
| GET | `job.php?id=5&technician_id=3` | Einzelauftrag inkl. Adresse/Kunde |
| PATCH | `job.php?technician_id=3` | Body: `{"job_id": 5, "status": "in_arbeit"}` oder `"description": "..."` (Status: geplant, in_arbeit, erledigt) |
| GET | `my_absences.php?technician_id=3` | Abwesenheiten; optional `date_from`, `date_to` |
| GET | `technician_info.php?technician_id=3` | Monteur-Infos (id, username, full_name) fuer Anzeige in der Electron-App |
| POST | `absence.php?technician_id=3` | Body: `{"start_datetime": "2026-02-14", "end_datetime": "2026-02-18", "type": "Urlaub"}` |
| PATCH | `absence.php?technician_id=3` | Body: `{"id": 1, "start_datetime": "...", "end_datetime": "...", "type": "..."}` |
| DELETE | `absence.php?id=1&technician_id=3` | Abwesenheit loeschen |

Beispiel: Auftraege abrufen und Status setzen:

```bash
curl -s "http://localhost/webapp_monteur_laptop/api/my_jobs.php?technician_id=3"
curl -X PATCH "http://localhost/webapp_monteur_laptop/api/job.php?technician_id=3" \
  -H "Content-Type: application/json" \
  -d '{"job_id": 5, "status": "erledigt"}'
```

## Test mit curl (Push)

```bash
curl -X POST "http://localhost/webapp_monteur_laptop/api/receive_dispo.php" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: DEIN_KEY" \
  -d @payload.json
```

## Antwort (Beispiel)

```json
{
  "ok": true,
  "batchId": 1,
  "processedJobs": 1,
  "processedAbsences": 1,
  "processedAssignments": 1,
  "idempotent": false
}
```

## Release (Version setzen, Git-Push, Tag/Label)

Bei jedem Release die Version in `config/version.php` und `electron/version.json` setzen, committen, einen Git-Tag (Label) setzen und pushen – dafür gibt es ein Skript:

```powershell
# Neue Version explizit setzen (z.B. V 1.002)
.\release.ps1 "V 1.002"

# Oder Build-Nummer automatisch um 1 erhoehen (z.B. 1.001 -> 1.002)
.\release.ps1 --bump
```

Das Skript:

1. Aktualisiert `config/version.php` und `electron/version.json`
2. Fuehrt `git add`, `git commit -m "Release V x.xxx"` aus
3. Setzt einen annotierten Tag (z.B. `v1.002`)
4. Fuehrt `git push` und `git push origin <tag>` aus

Optional vorher in `VERSION_HISTORY.md` die Aenderungen fuer die neue Version eintragen und die Datei mit committen (dafuer vor dem Aufruf von `release.ps1` manuell `git add VERSION_HISTORY.md` und in einem separaten Commit oder im Release-Commit mit anlegen).
