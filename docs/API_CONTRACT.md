# API-Contract – Dispo, Monteur-Laptop, Handy-PWA

**Kanonische Beschreibung** der plattformweiten JSON-Konventionen.  
**Änderungsprotokoll (Alt → Neu):** [`CONTRACT_RENAME_LOG.md`](../CONTRACT_RENAME_LOG.md) (Root dieses Repos).  
**Cursor-Regel (durchsetzen):** `.cursor/rules/platform-contract-sync.mdc`

Workspace: `Kukla_Monteur_Plattform` mit Repos `dispo`, `webapp_monteur_laptop`, `webapp_handy`.

---

## 1. Geltungsbereich

| Schicht | Pfad / Nutzung | Contract |
|--------|----------------|----------|
| **Plattform** | `dispo/dispo_api/`, `dispo/api/mobile/`, Laptop ↔ Dispo (Electron `server.js`), Handy API + PWA | **Strikt** nach diesem Dokument |
| **Dispo-Web (intern)** | `dispo/api/*.php` nur für eigene PHP/JS-Seiten | Schrittweise angleichen; verbleibendes `success` nur **Legacy** – keine neuen externen Clients |

Neue Schnittstellen, die Laptop oder Handy erreichen, **müssen** die Regeln unten einhalten.

---

## 2. Feldnamen (JSON)

- **Keys:** `snake_case` (z. B. `job_id`, `technician_id`, `customer_name`, `base_url`, `batch_id`).
- **Keine** neuen produktiven CamelCase-Aliase (`jobId`, `customerName`, `success` als Erfolgsflag).

Ausnahmen nur nach expliziter Absprache und Eintrag in `CONTRACT_RENAME_LOG.md`.

---

## 3. Antwort-Envelope (JSON)

Erfolg / Fehler einheitlich über **`ok`** (boolean):

- Erfolg: `"ok": true` plus nutzdaten-spezifische Keys (z. B. `id`, `requests`, `absences`).
- Fehler: `"ok": false` plus mindestens **`error`** (menschlich lesbarer Text).
- Optional: `code`, `meta` – nur wenn fachlich nötig und dokumentiert.

**Nicht** `success` für dasselbe Semantikfeld verwenden (Legacy in reinem Dispo-Web wird nach und nach ersetzt).

---

## 4. HTTP

- Fehlerstatuscodes sinnvoll setzen (`400`, `403`, `404`, `405`, `500`, …).
- Clients: HTTP mit `fetch` → zuerst `response.ok` / Status prüfen, dann Body **`ok`** auswerten (beides ist erlaubt und hat unterschiedliche Bedeutung).

---

## 5. Bekannte plattformrelevante Endpunkte (Stichworte)

### 5.0 Monteur-Laptop – lokaler Electron-Gateway (`electron/server.js`)

**Offline-First Audit:** Vollständiges Inventar aller Gateway-Routen, UI-Gates und Testfälle in [`webapp_monteur_laptop/docs/OFFLINE_GAP_AUDIT.md`](../webapp_monteur_laptop/docs/OFFLINE_GAP_AUDIT.md). Kurzmatrix: [`OFFLINE_DATA_MATRIX.md`](../webapp_monteur_laptop/docs/OFFLINE_DATA_MATRIX.md).

**Hinweis:** `GET /api/version` kann `capabilities` (z. B. `anlagenstamm_search`, `anlagenstamm_save`) liefern. **Anlagenstamm Suche/Speichern:** In Electron nutzt der Renderer zuerst **`monteurApp.ipcInvoke('anlagenstamm:search'|'save', payload)`** (falls im Preload vorhanden), sonst **`monteurApp.anlagenstammSearch`** / **`anlagenstammSave`** – IPC → Main → `electron/lib/anlagenstamm-dispo-proxy.js`, **ohne** Pflicht zu `POST /api/anlagenstamm_*` auf `127.0.0.1`. Nur ohne Electron/IPC: **`POST /api/anlagenstamm_*`** auf dem lokalen Gateway.

Der **Renderer** (`electron/public/app.js`) spricht **`API_BASE`** (lokaler Express). Dispo wird vom Renderer nicht direkt per `fetch` angesprochen; die gewählte Basis-URL nutzt der Main-Prozess für Proxys, Sync und (IPC) Anlagenstamm.

| Route | Methode | Body (JSON, Keys wie im Code) | Antwort (Kern) |
|-------|---------|-------------------------------|----------------|
| `/api/check_connection` | POST | `baseUrl`, `technicianId`, `serverUsername`, `serverPassword` | `{ "ok": true, "used_base_url"? }` oder `{ "ok": false, "error": "…" }` — Probe mit **Timeout 10 s** (wie `dispo_pick_base`). |
| `/api/sync_status` | GET | — (optional Session/`technician_id`) | `{ "ok": true, "last_sync_pull", "active_jobs", "pending_changes", "calendar_cache_synced_at", "anlagenstamm_local_count", "high_priority_jobs" }` |
| `/api/offline_manifest` | GET | Query `job_id` (lokal oder Server-ID) | `{ "ok": true, "local_job_id", "reise_dir", "dienstreise_pull", "ted_index", "projekte_neu_enabled", "project_file_count" }` |
| `/api/dispo_pick_base` | POST | `externalUrl`, `internalUrl` (optional leer), `technicianId`, `serverUsername`, `serverPassword` | `{ "ok": true, "selected_base_url": "https://…", "preferred_source": "internal"\|"external"\|"single", "tried": [ { "url", "ok", "error"? } ] }` oder `{ "ok": false, "error": "…", "tried": … }` |

Hinweis: Das sind **lokale** Laptop-Gateway-Payloads (historisch camelCase). Neue **Dispo-öffentliche** APIs bleiben bei `snake_case` gemäß Abschnitt 2.

**Semantik `dispo_pick_base`:** Beide URLs werden **parallel** geprüft mit **Timeout 10 s** pro Probe (wie `check_connection`: zuerst **`/api/my_jobs.php`**, bei Fehlschlag **`…/dispo_api/api/jobs_open.php`**). Sind **beide** URLs OK, wird die **interne** Basis gewählt. Nur eine URL konfiguriert → `preferred_source: "single"`. Abrechnung: wenn die dedizierte Abrechnungs-API nicht erreichbar ist, kann die App die Auftragsliste aus dem **lokalen Sync** befüllen (`/api/abrechnung/refresh` mit `partial`/`warnings`).

**Abrechnung (Electron-Gateway):** `GET /api/abrechnung/bundle` liefert neben Dateimetadaten **`comments`**: `{ "dispo": [ … ], "buchhaltung": [ … ] }` (Felder wie Dispo `dispo_api/api/abrechnung_notes.php`: u. a. `id`, `body`, `created_at`, `author_name`). **`notes`** (`dispo`/`buchhaltung` als Strings) bleibt für ältere Cache-Zeilen kompatibel; neue Daten liegen in **`comments_json`** im lokalen Cache.

Weitere lokale Routen (Sync, Projektdateien, Anlagenstamm): unverändert über denselben Host; sie erwarten die vom Client gesetzte **`baseUrl`** / aktive Basis aus der Pick-Antwort.

**`POST /api/dienstreise/accept_job_stream` (Auftrag annehmen):** **`202 Accepted`** mit JSON `{ "ok": true, "job_id": "<uuid>", "async": true }`. Die eigentliche Arbeit läuft als Hintergrund-Job-Typ **`dienstreise_pull`** (SQLite `background_jobs`). Fortschritt und Abschluss: **`GET /api/background_jobs/:id`** (`status`, `progress_phase`, `progress_current`, `progress_total`, `message`, `error`, `checkpoint`). Ablauf wie zuvor logisch gleich: Dispo-**`job_project_refresh`**, rekursive Dateiliste, Downloads über temporäre **`.part`**-Dateien, danach **`job_mark_docs_loaded`**. Nach erfolgreichem Abschluss (auch **0 Dateien**): lokaler Status **`in_arbeit`**, optional sofort **`PATCH …/dispo_api/api/job.php`** mit `{ "job_id": <server_id>, "status": "in_arbeit" }`; bei Fehlschlag bleibt `pending_changes`. Hinweis auf entfallenen Sofort-Sync liegt im Checkpoint unter **`status_sync_warning`** (Client kann `done`-Toast anreichern). Nur wenn lokaler Status **`angelegt`**, **`geplant`** oder **`zugeteilt`**. **`checkpoint_json`** ermöglicht Resume nach Abbruch; **`POST /api/background_jobs/recover`** stellt wiederaufnehmbare **`dienstreise_pull`**-Zeilen idempotent auf **`queued`**.

**`POST /api/dienstreise/copy_project_stream`:** gleiches **`202`**/`job_id`-Muster ohne Status-Wechsel (Dedupe-Key unterscheidet **`accept`** vs. **`copy`**).

**`POST /api/dienstreise/sync_to_dispo`:** **`202`** + `job_id`; Typ **`dienstreise_push`** (`syncDienstreiseFoldersToDispo` + optional Protokoll-Vorlagen).

**`POST /api/sync_pull`** / **`POST /api/sync_push`:** jeweils **`202`** + `job_id` (globale Queue, max. ein Job gleichzeitig). Pull umfasst Kalender-Cache, Fab-Anlagenstamm (bis 200 FN, **Priorität angenommene/in_arbeit-Jobs**), **TED-Metadaten** (`job_ted_index` via `mechanik_ted_excel_list`) und Protokoll-Vorlagen. **`sync_pull`** antwortet mit **HTTP 409** und `{ "ok": false, "deferred": true, "error": "…" }`, wenn **`dienstreise_pull`** / **`dienstreise_push`** / **`sync_push`** noch in der Queue sind (Client wertet `deferred` nicht als harten Fehler).

**TED im Projektordner:** `dienstreise_pull` lädt nach Projektdateien (auch bei **0 Projektdateien**) XLSX nach `{DienstreiseOrdner}/TED/` (`checkpoint_json.ted_completed`). `POST /api/mechanik_ted_excel_open` speichert bei bekannter `local_job_id` zuerst dorthin (sonst Fallback `anlagenstamm_open/`).

**Hintergrund-Jobs (Express, nur Laptop):**

| Route | Methode | Kurzbeschreibung |
|-------|---------|------------------|
| `/api/background_jobs` | POST | Body: `type`, `payload`, optional `dedupe_key` → **`202`**, `{ ok, job_id }`. |
| `/api/background_jobs` | GET | Query `active=1`\|`true`, optional `limit` → `{ ok, jobs }`. |
| `/api/background_jobs/:id` | GET | `{ ok, job }` inkl. geparstem `checkpoint`-Objekt. |
| `/api/background_jobs/:id/cancel` | POST | `{ ok }` oder Fehler. |
| `/api/background_jobs/recover` | POST | `{ ok, reopened }` — zählt wieder eingereihte **`dienstreise_pull`**-Jobs. |

**Typen:** `dienstreise_pull`, `dienstreise_push`, `sync_pull`, `sync_push`, `abrechnung_refresh` (Payload wie die bisherigen JSON-Body der jeweiligen Legacy-Routen).

**`POST /api/abrechnung/refresh`:** unverändert synchron über `runAbrechnungRefreshCore` (`partial`/`warnings`); die UI kann stattdessen **`POST /api/background_jobs`** mit `type: "abrechnung_refresh"` nutzen.

**Legacy-Hinweis:** Früher lieferte `accept_job_stream` einen **NDJSON**-Stream; Clients müssen auf **`202` + Polling** umstellen.

- **Import:** `dispo/dispo_api/api/receive_dispo.php` – u. a. `batch_id`, `processed_jobs`, `processed_absences`, `processed_assignments`.
- **Pairing / Mobile:** `dispo/api/mobile/pairing.php` – u. a. `base_url` (nicht `baseUrl`); **nur native Android-App**. PWA-Login: `POST dispo/api/mobile/login.php` mit `username`, `password`, `device_id` (nur HTTPS).
- **Monteur-Auftrag (dispo_api):** `dispo/dispo_api/api/job.php` – GET liefert unter `job` u. a. **`assigned_to_me`** (bool): der abfragende Monteur ist in `job_technicians` eingetragen (Steuerung von Schreibzugriffen in PWA/Laptop). Hotel-Felder umfassen zusätzlich **`hotel_id`**, **`hotel_comment`**, **`hotel_rating_stars`**, **`hotel_rating_avg`**, **`hotel_rating_count`**. PATCH akzeptiert zusätzlich **`hotel_selection`** (`hotel_id`, optional `comment`, optional `rating_stars` 0..5).
- **Handy-PWA / Mobile:** `dispo/api/mobile/job.php` – GET `?id=` (Bearer-Token wie `jobs.php`), vollständiger Auftrag inkl. `assigned_to_me`, `technicians_on_job`; Stammdaten wie in der Dispo-Maske u. a. **`customer_email`**, **`billing_*`** (Rechnungsadresse aus `job_billing_addresses`), **`created_at`/`updated_at`**, **`created_by_name`/`updated_by_name`**, Hotel **`hotel_phone`/`hotel_email`/`hotel_website`** aus `job_hotel_addresses` (nicht mehr leer), plus **`hotel_id`**, **`hotel_comment`**, **`hotel_rating_stars`**, **`hotel_rating_avg`**, **`hotel_rating_count`**. Das Feld **`rams`** liefert seit Migration 022 immer **`null`** — RAMS-Dokumente werden über den separaten Endpoint `dispo/api/mobile/rams.php` (`?action=list&job_id=...` etc.) geladen. POST-Felder `rams_save` und `rams_submit` antworten mit HTTP 410 Gone (Hinweis: `Use /api/mobile/rams.php`). Bei Statuswechsel nach `erledigt` erfolgt serverseitig zusätzlich die automatische FN->Hotel-Zuordnung. Auftragsobjekt kann **`montage_abgerechnet`** / **`montage_verrechnet`** (0/1) und **`status`** **`abgerechnet`** enthalten (nach Schema-Migration). Status **`abgerechnet`:** kein Status-Update durch Monteur (`updateJobStatus`); Upload gesperrt in `upload_job_document.php` (HTTP 409, `code`: `job_abgerechnet`).
- **RAMS (ISO 12100 / 45001) — Web + Mobile:** Das alte MVP `job_rams` (Endpoints `dispo/api/job_rams_request.php`, `dispo/api/job_rams_generate_pdf.php`, `dispo/api/job_rams_pdf_download.php`) wurde mit **Migration 022** vollständig entfernt. Aktueller Vertrag siehe [`dispo/docs/RAMS_ISO_API.md`](../../dispo/docs/RAMS_ISO_API.md).
  - **Dispo-Web (Session):** `dispo/api/rams/{document,list,pdf,submit,approve,reject,archive,sign,finalize_signature,test_confirm,catalog,templates,apply_template,delete,audit}.php`. Permissions via `RamsPermissions` (Admin / Dispo / Buchhaltung / Techniker).
  - **Handy-PWA (Bearer-Token):** `dispo/api/mobile/rams.php?action=...` (Actions: `list`, `document`, `catalog`, `templates`, `save`, `submit`, `sign_open`, `sign_link`). Mobile-Endpoint setzt Techniker-Rolle und prüft Job-Zuordnung über `job_technicians`.
  - **Status-Maschine:** `draft → validated → submitted_for_review → approved → archived` (plus `rejected → draft`, `forceArchive` für Admin). Edit nach `validated` setzt automatisch auf `draft` zurück und invalidiert Signaturen.
  - **PDF-Workflow:** `submit` friert das mPDF-PDF ein (`rams_documents.pdf_relative_path`); FES-Signatur arbeitet immer auf der eingefrorenen Datei (`ref_type='rams_iso'`, sealed PDF unter `sealed_pdf_relative_path`).
  - **Test-Modus:** Admin kann Dokumente ohne `job_id` mit `is_test_document=1` erzeugen (Wasserzeichen "TEST"). Löschung über `dispo/api/rams/delete.php` oder Cron `dispo/cli/cleanup_rams_test_documents.php`.
- **Mobile-API `dispo/api/mobile/job.php` — Feld `rams`:** Liefert seit Migration 022 immer **`rams: null`**. RAMS-Daten werden separat über `dispo/api/mobile/rams.php` geladen. POST-Felder `rams_save` und `rams_submit` antworten mit HTTP 410 Gone (deprecated).
- **Handy-PWA / Mobile – Foto in Projektordner:** `dispo/api/mobile/upload_job_photo.php` – `POST` `multipart/form-data` mit `job_id`, `fabrikationsnummer` (string), Datei-Feld `photo` (JPEG/PNG/WebP). Monteur-Token. Speichert unter `Dokumente_Monteur/Bilder/{FN-Segment}/` im Jobordner; `fabrikationsnummer` muss zu den FNs des Auftrags passen. Erfolg: JSON `{ "ok": true, "file_name", "relative_path", "job_id", "fabrikationsnummer" }`.
- **Handy-PWA / Mobile – Dokument (PDF) in Projektordner:** `dispo/api/mobile/upload_job_document.php` – `POST` `multipart/form-data`, Monteur-Token, gleiche Job-/Speicherort-/Belegart-Logik wie bisher. **Zwei Modi:** (1) **Legacy:** genau ein Feld **`document`** (`application/pdf`). (2) **Server-Scan:** `document_mode=pages` (string), mehrere **`page[]`**-Dateien (nur **`image/png`**, Reihenfolge = Seiten), optional `captured_at_local`. Server führt `dispo/cli/docscan_pages_to_pdf.py` (Python, Modus **`--assemble-only`**: `img2pdf`, ohne OpenCV auf den PNG-Pixeln) aus und speichert **ein** PDF unter `Dokumente_*`. Grenzen (implementierungsnah): max. **25** Seiten, max. **12 MB** pro Seite, max. **72 MB** gesamt. Fehler u. a.: `docscan_pipeline_failed` / `docscan_pdf_empty` (HTTP **503**), ungültiger MIME (HTTP **400**). Erfolg wie Legacy: `{ "ok": true, "file_name", "relative_path", "job_id", "storage_target", "document_type" }`. Betrieb: venv unter `dispo/cli/docscan_venv` (relativ zum **laufenden** Release) und/oder **`KUKLA_DOCSCAN_CLI_HOME`** (empfohlen: ein Pfad zu `shared/cli` mit Skript + venv), **`KUKLA_DOCSCAN_PYTHON`**, **`KUKLA_DOCSCAN_SCRIPT`**; Abhängigkeiten: `dispo/cli/requirements-docscan.lock` (u. a. `img2pdf`).
- **Docscan mit Server-Vorschau (PWA):** Zusätzlich `pages_action` bei `document_mode=pages`: **`preview`** — gleiche `page[]`-Uploads, Antwort enthält **`preview_token`** und Metadaten, PDF liegt temporär serverseitig; Abruf **`GET dispo/api/mobile/docscan_preview_pdf.php?token=`** mit Monteur-Bearer. **`commit`** / **`discard`** jeweils `POST` auf `upload_job_document.php` mit `preview_token` (weiterhin `job_id`, Speicherort, Belegart wie üblich); `commit` speichert final, `discard` verwirft die Vorschau (TTL ca. **30 Min**). Ohne `pages_action` bzw. `save`: direktes Speichern wie bisher (z. B. Offline-Warteschlange).
- **Handy-PWA / Mobile – TED (nur Fabrikationsnummer):** `dispo/api/mobile/mechanik_ted_excel_by_fab.php` – GET `?fab=` (Pflicht), JSON `{ "ok": true, "fab", "rows": [ { "rel_path", "file_name", "file_mtime", "file_size" } ] }` aus `mechanik_ted_excel_index` (Monteur-Token, kein `job_id`). Download: `dispo/api/mobile/mechanik_ted_excel_download_by_fab.php?fab=&rel_path=` – nur wenn Index-Zeile zu `fab` passt. Spiegel unter `webapp_handy/api/mobile/` für getrenntes Handy-Deploy.
- **Monteur-Laptop (lokaler Electron-Server):** `POST /api/anlagenstamm_file_download` mit JSON `baseUrl`, `fab`, Monteur-Auth wie bestehend – entweder **`file`** (Upload-Ordner, Lazy-Cache unter `electron/db/anlagenstamm_upload_cache/`) oder **`source`: `"projekte_neu"`** plus **`path`**. **Lokal-first:** mit optional **`job_id`** zuerst Datei aus `Dienstreise/…/Dokumente_Monteur/` (nach `dienstreise_pull`); sonst Dispo-Proxy. Thumbnails lokal via **sharp** oder Dispo `thumb=1`.
- **PROJEKTE NEU lokal (Laptop):** `GET /api/dienstreise/projekte_neu_tree?job_id=&fab=`, `GET /api/dienstreise/projekte_neu_file?…`, `GET /api/anlagenstamm/projekte_neu_resolve_local?fab=` – Baum/Dateien aus lokaler Dienstreise-Kopie; UI-Fallback Dispo `anlagenstamm_files_list`.
- **Anlagenstamm-Stammdaten lokal (Laptop):** SQLite `anlagenstamm_local`; Vollabgleich per Background-Job `anlagenstamm_db_sync` und am Ende von `sync_pull` gegen `dispo_api/api/anlagenstamm_monteur_export_chunk.php` (paginiert, inkl. **`customer_country`**). `POST /api/anlagenstamm_search` / `lookup` / `save` lokal-first; Offline-Saves in `pending_changes` (`entity_type=anlagenstamm`).
- **Dispo `anlagenstamm_file_download` (Web-Session, Mobile-Bearer, `dispo_api`):** Zusätzliche GET-Parameter **`thumb=1`**, **`thumb_max`** (optional), **`inline=1`** (optional). Mit **`thumb=1`** liefert der Server bei Rasterbildern eine verkleinerte **WebP**- oder **JPEG**-Vorschau (PHP-**gd**); keine Rasterdatei → JSON **415**.
- **Nur Monteur-Laptop / Dispo `dispo_api` (nicht Handy-PWA):** Zentraler Anlagenstamm lesen/suchen/speichern:
  - **`POST /api/anlagenstamm_search`** (Express-Proxy, Fallback) bzw. **IPC `anlagenstamm:search`** mit gleicher JSON-Nutzlast inkl. **`technician_id`** → `dispo_api/api/anlagenstamm_monteur_search.php?technician_id=` mit **`baseUrl`**, **`serverUsername`**, **`serverPassword`**, **`filter_fn`**, **`filter_type`**, **`filter_aktueller_kunde`**, **`filter_land`** (mindestens eines nicht leer), optional **`page`**, **`page_size`** (max. 100 serverseitig). Erfolg: **`ok`**, **`rows`**, **`total_count`**, **`page`**, **`page_size`**, **`total_pages`**. **`filter_land`:** Subselect auf **`customers.country`** bei Namensgleichheit mit **`anlagenstamm.aktueller_kunde`**.
  - **`POST /api/anlagenstamm_save`** (Fallback) bzw. **IPC `anlagenstamm:save`** → `dispo_api/api/anlagenstamm_monteur_save.php?technician_id=` mit **`baseUrl`**, Auth wie oben, plus **`id`**, **`fabrikationsnummer`**, **`type`**, **`leistung`**, **`kraftaufnehmer`**, optional **`kraftaufnehmer_extra`** (JSON-Array von Objekten `{kraftaufnehmer,dms_nr,dms_position}` für Zusatzzeilen, nur Formular/Popup, nicht Listen-Spalte), **`nenngeschwindigkeit`**, **`material`**, **`tacho`**, **`elektronik`**, **`dms_nr`**, **`dms_position`**, **`position`**, **`geliefert_ueber`**, **`projekt`**, **`bemerkungen`** (wie Dispo-Web `api/anlagenstamm_save.php`; **`aktueller_kunde`** / **`letzter_besuch`** nicht setzbar). Erfolg: **`ok`**, **`id`**.
- **Abwesenheitsanfragen:** `absence_request*.php`, `absence_requests_pending.php` – `ok`; GET-Liste der Anfragen unter **`requests`** (nicht `data`). JSON-Felder u. a. `type`, optional **`comment`** (Text, sichtbar je nach Endpunkt/Rolle).
- **Zeitschreibung (Monteur-Laptop ↔ Dispo):** Monatsblatt `timesheets` / `timesheet_days`. Sicht: eigener Techniker oder `perm_lohnbuchhaltung` (nur Lesen). Schreiben: nur eigener Techniker.
  - Laptop lokal: `GET/POST /api/zeitschreibung/config`, `GET /api/zeitschreibung?technician_id=&year=&month=`, `POST /api/zeitschreibung/save`, `POST /api/zeitschreibung/submit` (PDF+XLSX + Outbox).
  - Dispo: `POST /api/monteur_timesheet_submit.php` (JSON `technician_id`, `year`, `month`, `days[]`, `sums`, `gesamt` → `{ ok, id }`); `GET /api/timesheet_get.php`, `GET /api/timesheet_list.php`, `GET /api/timesheet_technicians.php` (nur Lohn).
- **Abwesenheiten Monteure-UI / Monteur-API:** `absences_list.php`, `absence_create.php`, `absence_delete.php`, `api/absence.php` (POST/PATCH) – `ok`; Abwesenheitszeilen enthalten optional **`comment`**. `api/calendar.php` / `api/mobile/calendar.php`: `comment` nur für berechtigte Nutzer; öffentlich ohne Sitzung ohne `comment` inhaltlich. Kalender-**Jobs** zusätzlich: **`montage_verrechnet`** (0|1), **`billing_travel_complete`** (0|1, abgeleitet wie `job_billing_travel_complete()` in Dispo), **`date_not_fixed`** (0|1 — Auftrag mit Datum, Termin noch nicht fix; UI: **`???`** fett vor Länderflagge im Kalender-Balken).

Details und Dateilisten: `CONTRACT_RENAME_LOG.md`.

### 5.1a Projektordner / Monteur (Dispo `api/`, Login oder Monteur-Session)

Gleiche Basis-URL wie die Dispo. Authentifizierung wie bisher: Monteur mit `technician_id` (Query und/oder Header `X-Technician-Id`) und Dispo-Login (`require_login.php`), wo die jeweilige Datei das vorsieht.

| Endpunkt | Methode | Kurzbeschreibung |
|----------|---------|------------------|
| `dispo/api/job_project_files_list.php` | GET | `job_id`, `technician_id`, optional `path` (relativ zum Projektordner). **`Dokumente_Monteur`:** physische Uploads ∪ ELEKTRO-Mount (`$FILESERVER_ELEKTRO_PROJEKTE_NEU_ROOT`), ohne Kopie. **`Dokumente_Anlage`:** physische Dateien ∪ Zentral-Anlagen (`FILESERVER_BASE_PATH` / Anlagen), ohne Kopie. |
| `dispo/api/job_project_file_download.php` | GET | `job_id`, `technician_id`, `path` – Datei aus Projektordner; unter `Dokumente_Monteur` bzw. `Dokumente_Anlage` zuerst physische Datei, sonst Stream vom Mount bzw. Zentral-Anlagen-Pfad. |
| `dispo/api/job_project_refresh.php` | POST JSON | `job_id`, `technician_id`, optional `include_bilder` (wird ignoriert) – stellt nur die Standard-Unterordner sicher; **kein** Kopieren vom Fileserver. |
| `dispo/api/job_project_file_delete.php` | POST form | `job_id`, `technician_id`, `path` – nur **physische** Dateien; reine ELEKTRO- oder Zentral-Anlagen-Quelle → 403. |
| `dispo/api/job_mark_docs_loaded.php` | POST JSON | `job_id`, `technician_id` – nach erfolgreichem Projektordner-Kopieren: Status **`zugeteilt` → `in_arbeit`** (idempotent wenn schon `in_arbeit`; 409 wenn anderer Ausgangsstatus). Monteur-Session bzw. Basic wie `require_login.php`. |
| `dispo/api/job_status_dispo_set_in_arbeit.php` | POST form | Dispo/Admin, CSRF-Scope `job_status_dispo_in_arbeit`: `job_id` – **`angelegt`/`zugeteilt` → `in_arbeit`** (mind. eine `job_technicians`-Zeile). |
| `dispo/api/job_status_admin_revert_erledigt.php` | POST form | Nur Admin, CSRF-Scope `job_status_admin_revert`: `job_id` – **`abgerechnet` → `erledigt`**. |

### 5.1b Serviceprotokoll (Dispo `dispo_api/`, Monteur `technician_id`)

Authentifizierung wie Kontrollwiegung: Query/Header `technician_id`, Dispo-Basic oder Monteur-Session je nach Client.

| Endpunkt | Methode | Kurzbeschreibung |
|----------|---------|------------------|
| `dispo_api/api/serviceprotokoll_defaults.php` | GET | `fabrikationsnummer`, `technician_id` → `{ ok, source: "fn"\|"preset"\|"global"\|"builtin", arbeitsschritte: [{ bezeichnung }], kopf?: { projekt, kopf_pos_nr, kopf_qmax, kopf_type, kopf_dwc }, preset_name?, preset_type_code? }` — Lade-Priorität: FN-Vorlage → Typ-Preset (Substring in `anlagenstamm.type`) → globaler Grundstock → Builtin |
| `dispo_api/api/serviceprotokoll_save.php` | POST JSON | … → erzeugt PDF unter `Dokumente_Monteur/{FN}/Montage/{Auftragsordner}/Serviceprotokolle/` → `{ ok, protokoll_id, pdf_path?, warning? }` |
| `dispo_api/api/serviceprotokoll_pdf.php` | GET | `id`, `technician_id` → PDF-Binary (aus Projektordner oder Regenerierung) |
| `dispo_api/api/serviceprotokoll_draft.php` | GET / POST | Zwischenstand `serviceprotokoll.json` im Projektordner: GET `job_id`, `technician_id` → `{ ok, store: { byFab } }`; POST JSON `technician_id`, `job_id`, `store` → merge nach `updatedAt`, `{ ok, store }` (Laptop ↔ PWA) |

**Monteur-Laptop (Electron-Gateway, wie Montagebericht):**
- `GET /api/protokolle/serviceprotokoll?job_id=` → lädt `serviceprotokoll.json` (lokal + Merge mit Dispo `serviceprotokoll_draft.php` wenn `server_id` und Dispo-Creds) → `{ ok, store: { byFab: { [fn]: draft } } }`.
- `POST /api/protokolle/serviceprotokoll` JSON: … `jsonOnly: false` → JSON + `serviceprotokoll_save` Dispo + PDF lokal unter `Dokumente_Monteur/{FN}/Montage/{Auftragsordner}/Serviceprotokolle/` → `{ ok, jsonOnly?, protokoll_id?, saved?: [relPath], warning? }`.
- `GET /api/serviceprotokoll_defaults` (Proxy + lokaler Fallback), `GET /api/serviceprotokoll_pdf` (Proxy).

**FN-Vorlage:** Beim Save werden Bezeichnung + Reihenfolge der Arbeitsschritte pro `fabrikationsnummer` persistiert; Status/Bemerkungen starten beim nächsten Formular leer.

### 5.1c Arbeitsschritte-Bausteine (Dispo `dispo_api/`, Monteur `technician_id`)

Masterliste + Typ-Presets (global + privat pro Techniker). Scope analog Textbausteine; keine Kategorien — Gruppierung über Presets (`type_code`, max. 6 Zeichen, Substring-Match in `anlagenstamm.type`).

| Endpunkt | Methode | Kurzbeschreibung |
|----------|---------|------------------|
| `dispo_api/api/arbeitsschritte_list.php` | GET | `technician_id` → `{ ok, steps: [{ id, scope, bezeichnung_de, bezeichnung_en, bezeichnung, sort_order }], presets: [{ id, scope, name, type_code, step_refs[] }] }` |
| `dispo_api/api/arbeitsschritte_save.php` | POST | User-Schritt anlegen/ändern (`technician_id`, `id?`, `bezeichnung_de`, `bezeichnung_en`, `sort_order`) |
| `dispo_api/api/arbeitsschritte_delete.php` | POST | User-Schritt löschen (`technician_id`, `id`) |
| `dispo_api/api/arbeitsschritte_publish_global.php` | POST | User-Schritt → global freigeben |
| `dispo_api/api/arbeitsschritte_preset_save.php` | POST | User-Preset inkl. `step_refs` (Checkbox-Liste) |
| `dispo_api/api/arbeitsschritte_preset_delete.php` | POST | User-Preset löschen |
| `dispo_api/api/arbeitsschritte_reorder.php` | POST | User-Schritte umsortieren: `technician_id`, `orders` (Array `[{ id, sort_order }, …]` oder JSON-String) |
| `dispo_api/api/arbeitsschritte_global_reorder.php` | POST | Globale Masterliste umsortieren (Admin): `orders` wie oben |

**Dispo-Admin** (nur `perm_admin`, Seite `arbeitsschritte_admin.php`): `arbeitsschritte_global_save.php`, `arbeitsschritte_global_delete.php`, `arbeitsschritte_global_reorder.php`, `arbeitsschritte_preset_global_save.php`, `arbeitsschritte_preset_global_delete.php`.

**Monteur-Laptop (Electron-Gateway):**
- `GET /api/arbeitsschritte_list` — lokaler SQLite-Cache + optional Merge vom Server (`base_url`, `technician_id`)
- `POST /api/arbeitsschritte_save`, `_delete`, `_publish_global`, `_preset_save`, `_preset_delete`, `_reorder`
- `_reorder`: nur **user**-Schritte lokal (`sort_order`); optional Proxy zu `arbeitsschritte_reorder.php` bei Online (`base_url`, `technician_id`, `orders`)
- `sync_pull` / `sync_push` mit `entity_type='arbeitsschritte'` in `pending_changes`

**PWA:** Katalog im Serviceprotokoll ruft `arbeitsschritte_list.php` direkt auf; keine Offline-Verwaltung.

### 5.1 Dispo-Web Admin (nur eingeloggte Dispo-Session, `perm_admin`)

Nur für die **interne** PHP/JS-Oberfläche; keine Monteur-Apps. Antworten nutzen **`ok`** (boolean) wie in Abschnitt 3.

| Endpunkt | Methode | Kurzbeschreibung |
|----------|---------|------------------|
| `dispo/api/admin/releases_status.php` | GET | Release-Bäume (test/prod/default), `activate_method` (`wrapper` \| `direct`) |
| `dispo/api/admin/release_activate.php` | POST JSON | `environment`, `release_id`, `csrf_token` — `current` per Wrapper (falls gesetzt) oder Symlink wie `activate-release.sh` |
| `dispo/api/admin/git_pull_migrate.php` | POST JSON | `environment`, `csrf_token` (Scope `system_deploy_git_pull_migrate`) — im aktiven Release `git pull --ff-only`, danach `database/run_migrations.php` ohne Prod-Gate |
| `dispo/api/admin/migrations_status.php` | GET | Stand `database/migrations` vs. Tabelle `schema_migrations` (nur lesen) |
| `dispo/api/admin/migrations_approval.php` | POST JSON | `action` (`request`/`approve`/`clear`), `reason`, `csrf_token` — Freigabe-Workflow für Prod-Migration |
| `dispo/api/admin/migrations_run_prod.php` | POST JSON | `csrf_token` — führt Prod-Migrationen aus (nur wenn CLI-Gate ok) |

---

## 6. Arbeitspaket bei Contract-Änderungen

1. **Alle Gegenstellen** im gleichen Paket anpassen: `dispo`, `webapp_monteur_laptop`, `webapp_handy` (soweit betroffen).
2. **`CONTRACT_RENAME_LOG.md`** um Eintrag „alt → neu“ ergänzen.
3. **Diese Datei** nur bei neuen **allgemeinen** Regeln oder neuen Bereichen aktualisieren.
4. Idealerweise **Smoke-Test** (Login/Sync/Kernscreen) oder geplante Contract-Tests.

---

## 7. Stand

Dokument angelegt zur Abstimmung mit `platform-contract-sync` und `CONTRACT_RENAME_LOG`.  
Bei größeren API-Erweiterungen: Abschnitt 5 oder neue Unterabschnitte ergänzen.
