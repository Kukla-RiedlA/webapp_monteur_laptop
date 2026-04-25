# Contract Rename Log

Stand: 2026-03-12

## Kanonische Vorgaben

- Naming: `snake_case`
- Response-Flag: `ok` (statt `success`)

## Neue Endpunkte (ohne Rename)

- **2026-04-25:** `POST dispo/api/mobile/upload_job_photo.php` — Form: `job_id`, `fabrikationsnummer`, `photo` (Datei). JSON-Erfolg: `ok`, `file_name`, `relative_path`, `job_id`, `fabrikationsnummer` (Monteur-Token; FN muss im Auftrag existieren).
- **2026-04-22:** `GET dispo/api/mobile/mechanik_ted_excel_by_fab.php` — `fab`; JSON `{ "ok": true, "rows": [ … ] }` (Monteur-Token). `GET dispo/api/mobile/mechanik_ted_excel_download_by_fab.php` — `fab`, `rel_path` (Download). Duplikate unter `webapp_handy/api/mobile/`.

## Durchgefuehrte Umbenennungen

### Response-Keys (Handy API)

- `success` -> `ok`
  - `webapp_handy/api/mobile/technicians.php`
  - `webapp_handy/api/mobile/claim_pairing.php`
  - `webapp_handy/api/mobile/device_settings.php`
  - `webapp_handy/api/mobile/upload_photo.php`
  - `webapp_handy/api/mobile/login.php`
  - `dispo/api/mobile/technicians.php`
  - `dispo/api/mobile/claim_pairing.php`
  - `dispo/api/mobile/device_settings.php`
  - `dispo/api/mobile/login.php`
  - `dispo/api/mobile/pairing.php`

### Request-Keys (Laptop Dienstreise-Sync)

- `dispoBaseUrl` -> `dispo_base_url`
- `technicianId` -> `technician_id`
- `dispoUsername` -> `dispo_username`
- `dispoPassword` -> `dispo_password`
  - Sender: `webapp_monteur_laptop/electron/public/app.js`
  - Empfaenger: `webapp_monteur_laptop/electron/server.js`

### Payload-Felder in Clients

- `customerName` (Fallback) entfernt, nur `customer_name`
  - `webapp_handy/pwa/js/jobs.js`
  - `webapp_handy/pwa/js/reports.js`
  - `webapp_handy/pwa/js/kontrollwiegung.js`
  - `webapp_monteur_laptop/electron/public/app.js`

- `Fabrikationsnummer` (Fallback) entfernt, nur `fabrikationsnummer`
  - `webapp_handy/pwa/js/kontrollwiegung.js`
  - `webapp_monteur_laptop/electron/public/app.js`

- `Fabrikationsnummern` (Fallback) entfernt, nur `fabrikationsnummern`
  - `webapp_monteur_laptop/electron/public/app.js`

### Response-Auswertung in Clients

- `res.success` -> `res.ok`
  - `webapp_handy/pwa/js/pending-photos.js`

- `result.data.success` -> `result.data.ok`
  - `webapp_handy/pwa/pair.html`

### Weitere Contract-Keys (Dispo Import API)

- `batchId` -> `batch_id`
- `processedJobs` -> `processed_jobs`
- `processedAbsences` -> `processed_absences`
- `processedAssignments` -> `processed_assignments`
  - `dispo/dispo_api/api/receive_dispo.php`

### Weitere Contract-Keys (QR Pairing Payload)

- `baseUrl` -> `base_url`
  - `dispo/api/mobile/pairing.php`

### Abwesenheitsanfragen (Dispo API + dispo_api + Laptop)

- `success` -> `ok` in JSON-Antworten
  - `dispo/api/absence_request.php`, `absence_request_status.php`, `absence_request_decision.php`, `absence_requests_pending.php`
  - `dispo/dispo_api/api/` (gleiche vier Dateien)
- GET `absence_request.php`: Listen-Key `data` -> `requests` (einheitlich mit `absence_request_status`)
- Client-Auswertung: `dispo/assets/js/monteure.js`, `dispo/assets/js/service_nav_highlight.js`
- `webapp_monteur_laptop/electron/server.js` (Sync zu Dispo: `data.ok`, `statusData.ok`)

### Abwesenheiten Monteure-Modal (Liste / Anlegen / Löschen)

- `success` -> `ok`
  - `dispo/api/absences_list.php`, `absence_create.php`, `absence_delete.php`
- Client: `dispo/assets/js/monteure.js` (`loadAbsenceList`, Löschen-Button, `absenceForm`-Submit)
