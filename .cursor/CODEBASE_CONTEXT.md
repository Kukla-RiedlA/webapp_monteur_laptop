# Codebase-Kontext – Monteur WebApp (Workspace Wiedereinstieg)

Diese Datei dient dem schnellen Wiedereinstieg: Sie beschreibt Aufbau und Zusammenhänge des Projekts. **Bei neuem Chat oder neuem Einstieg:** diese Datei zuerst lesen (oder dem Agent mitgeben: „Lies .cursor/CODEBASE_CONTEXT.md“).

---

## 1. Was ist dieses Projekt?

- **Monteur WebApp (Offline/Desktop):** Electron-App mit lokalem Node-Server und SQLite (sql.js). Zeigt Monteuren ihre Aufträge und Abwesenheiten; kann mit dem **Dispo-Server** synchronisieren („Vom Dispo holen“ / „Änderungen senden“).
- **PHP-APIs in diesem Repo:** Werden genutzt, wenn die Dispo (andere Anwendung) die Monteur-Daten bereitstellt – z. B. `api/calendar.php`, `api/my_jobs.php`, `api/job.php`, `api/absence.php` usw. Sie lesen/schreiben in der **Dispo-Datenbank (fsm)** über `DispoRepository` und `Db::fsm()`.
- **Dispo (Kalender-UI):** Die **Dispo-Oberfläche** (Wochen-/Monatskalender, Kalender-Tooltips, Auftragsverwaltung) liegt **nicht** in diesem Repo, sondern im **übergeordneten Workspace** unter `htdocs/` (z. B. `c:\xampp_2\htdocs`). Dort: `htdocs/modules/calendar.php`, `htdocs/calendar_month.php`, `htdocs/calendar_month_lanes.php`, `htdocs/api/calendar.php` usw.  
  **Regel für Bearbeitungen:** Nur im **htdocs dieses Workspaces** arbeiten (siehe `.cursor/rules/htdocs-workspace.mdc`). Wenn der Nutzer „Dispo“ oder „Kalender“ sagt, prüfen, ob die Änderung in `htdocs/` des Workspace-Roots gehört.

---

## 2. Projektstruktur (webapp_monteur_laptop)

| Pfad | Zweck |
|------|--------|
| **api/** | PHP-API-Endpunkte für Dispo-Backend: `calendar.php`, `job.php`, `my_jobs.php`, `my_absences.php`, `absence.php`, `technician_info.php`, `anlagenstamm_by_fab.php`, `receive_dispo.php`. Alle (außer receive_dispo) nutzen `Db::fsm()` + `DispoRepository`. |
| **src/** | `Db.php` (connection = WebApp-DB, fsm = Dispo-DB), `DispoRepository.php` (Lese/Schreibzugriff auf jobs, job_technicians, job_addresses, absences, getCalendarData, getJobsForTechnician, …), `DispoImportService.php`, `DispoPayloadValidator.php`. |
| **config/** | `version.php` – Versionsnummer für die App. |
| **electron/** | Desktop-App: `main.js` (Electron-Fenster, lädt Node-Server), `server.js` (Express, Port 39678, sql.js-SQLite, implementiert /api/calendar, /api/job, /api/absence, …; bei „Vom Dispo holen“ Proxy zu Dispo-PHP-APIs), `public/app.js` (Frontend-Logik, Kalender, Aufträge, Abwesenheiten), `public/index.html`, `db/schema.sql`, `version.json`. |
| **db/** | Schema/Migrationen für die WebApp-DB (receive_dispo). |
| **bootstrap.php** | Lädt Autoload, .env; wird von allen api/*.php per `require_once __DIR__ . '/../bootstrap.php'` eingebunden. |

---

## 3. Datenfluss

- **Electron offline:** App spricht mit `http://127.0.0.1:39678` → `electron/server.js` → lokale SQLite (sql.js). Keine PHP-APIs.
- **Electron mit Dispo-Sync:** Nutzer konfiguriert Dispo-URL. Dann:
  - **Kalender:** `GET /api/calendar?baseUrl=…&start=…&end=…` → server.js ruft `baseUrl/api/calendar.php?start=…&end=…` auf (Dispo-PHP) und gibt JSON durch. Optional Anreicherung mit Einzelauftrag (job.php) für customer_name, city, country.
  - **Aufträge/Abwesenheiten:** Ähnlich Proxy zu Dispo-PHP (my_jobs, my_absences, job, absence).
- **Dispo (htdocs):** Eigenes Projekt. `htdocs/api/calendar.php` liefert Kalenderdaten (jobs, absences, technicians) – oft mit Anreicherung wie `customer`, `city`, `country_code`, `offset_to_at`, `job_number`, `technician_name` für Tooltips. Die **Tooltip-Logik** (Firma – Ort CC – Techniker, Zeitverschiebung „+1“/„-2“) steht in **htdocs**: `modules/calendar.php` (Woche + Monat Lanes), `calendar_month.php`, `calendar_month_lanes.php`.

---

## 4. Wichtige fachliche Begriffe

- **technician_id:** Entspricht `users.id` in der Dispo-DB (Rolle `monteur`). Wird in allen Monteur-APIs erwartet (Query oder Header `X-Technician-Id`).
- **fsm:** Dispo-Datenbank (MySQL). Tabellen u. a.: jobs, job_technicians, job_addresses, customers, users, absences.
- **getCalendarData(start, end):** Liefert `{ jobs, absences, technicians }`. Jobs pro Techniker-Zeile; Felder u. a. id, job_number, start_datetime, end_datetime, customer_name, city, country, technician_id. Erweiterungen wie `offset_to_at`, `country_code`, `technician_name` werden ggf. in der **Dispo** (htdocs) ergänzt.
- **Kalender-Tooltips (Dispo):** Einheitliches Format in Woche und Monat: „Firmenname – Ort CC – Technikername“, optional „| +1“/„-2“ (Zeitverschiebung zu AT). Keine Auftragsnummer im Tooltip.

---

## 5. Wiedereinstieg – so die Daten wieder nutzen

1. **Diese Datei lesen:** `.cursor/CODEBASE_CONTEXT.md` (oder im Chat: „Lies .cursor/CODEBASE_CONTEXT.md“).
2. **Regel beachten:** `.cursor/rules/htdocs-workspace.mdc` – Änderungen an Kalender/Dispo-UI nur im htdocs dieses Workspaces (relativer Pfad `htdocs/`).
3. **Schnellsuche:**  
   - Kalender-API: `api/calendar.php`, `electron/server.js` („/api/calendar“), `src/DispoRepository.php` (getCalendarData).  
   - Tooltips/Labels: in **htdocs** in `modules/calendar.php`, `calendar_month.php`, `calendar_month_lanes.php`.  
   - Version: `config/version.php`, `electron/version.json`, `VERSION_HISTORY.md`, `release.ps1`.

---

*Stand: Nach Code-Scan und Kalender-Tooltip-Vereinheitlichung.*
