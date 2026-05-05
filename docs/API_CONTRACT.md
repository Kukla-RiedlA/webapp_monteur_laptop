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

- **Import:** `dispo/dispo_api/api/receive_dispo.php` – u. a. `batch_id`, `processed_jobs`, `processed_absences`, `processed_assignments`.
- **Pairing / Mobile:** `dispo/api/mobile/pairing.php` – u. a. `base_url` (nicht `baseUrl`).
- **Monteur-Auftrag (dispo_api):** `dispo/dispo_api/api/job.php` – GET liefert unter `job` u. a. **`assigned_to_me`** (bool): der abfragende Monteur ist in `job_technicians` eingetragen (Steuerung von Schreibzugriffen in PWA/Laptop).
- **Handy-PWA / Mobile:** `dispo/api/mobile/job.php` – GET `?id=` (Bearer-Token wie `jobs.php`), vollständiger Auftrag inkl. `assigned_to_me`, `technicians_on_job`; Stammdaten wie in der Dispo-Maske u. a. **`customer_email`**, **`billing_*`** (Rechnungsadresse aus `job_billing_addresses`), **`created_at`/`updated_at`**, **`created_by_name`/`updated_by_name`**, Hotel **`hotel_phone`/`hotel_email`/`hotel_website`** aus `job_hotel_addresses` (nicht mehr leer); POST optional Status, Beschreibung, Hotelfelder u. a. Auftragsobjekt kann **`montage_abgerechnet`** / **`montage_verrechnet`** (0/1) und **`status`** **`abgerechnet`** enthalten (nach Schema-Migration). Status **`abgerechnet`:** kein Status-Update durch Monteur (`updateJobStatus`); Upload gesperrt in `upload_job_document.php` (HTTP 409, `code`: `job_abgerechnet`).
- **Handy-PWA / Mobile – Foto in Projektordner:** `dispo/api/mobile/upload_job_photo.php` – `POST` `multipart/form-data` mit `job_id`, `fabrikationsnummer` (string), Datei-Feld `photo` (JPEG/PNG/WebP). Monteur-Token. Speichert unter `Dokumente_Monteur/Bilder/{FN-Segment}/` im Jobordner; `fabrikationsnummer` muss zu den FNs des Auftrags passen. Erfolg: JSON `{ "ok": true, "file_name", "relative_path", "job_id", "fabrikationsnummer" }`.
- **Handy-PWA / Mobile – TED (nur Fabrikationsnummer):** `dispo/api/mobile/mechanik_ted_excel_by_fab.php` – GET `?fab=` (Pflicht), JSON `{ "ok": true, "fab", "rows": [ { "rel_path", "file_name", "file_mtime", "file_size" } ] }` aus `mechanik_ted_excel_index` (Monteur-Token, kein `job_id`). Download: `dispo/api/mobile/mechanik_ted_excel_download_by_fab.php?fab=&rel_path=` – nur wenn Index-Zeile zu `fab` passt. Spiegel unter `webapp_handy/api/mobile/` für getrenntes Handy-Deploy.
- **Monteur-Laptop (lokaler Electron-Server):** `POST /api/anlagenstamm_file_download` mit JSON `baseUrl`, `fab`, Monteur-Auth wie bestehend – entweder **`file`** (Dokumente aus dem Anlagenstamm-Upload-Ordner) oder **`source`: `"projekte_neu"`** plus **`path`** (relativ zum Fabrikationsordner auf dem ELEKTRO-Mount); Weiterleitung an `dispo_api/api/anlagenstamm_file_download.php` mit denselben Query-Parametern.
- **Abwesenheitsanfragen:** `absence_request*.php`, `absence_requests_pending.php` – `ok`; GET-Liste der Anfragen unter **`requests`** (nicht `data`). JSON-Felder u. a. `type`, optional **`comment`** (Text, sichtbar je nach Endpunkt/Rolle).
- **Abwesenheiten Monteure-UI / Monteur-API:** `absences_list.php`, `absence_create.php`, `absence_delete.php`, `api/absence.php` (POST/PATCH) – `ok`; Abwesenheitszeilen enthalten optional **`comment`**. `api/calendar.php` / `api/mobile/calendar.php`: `comment` nur für berechtigte Nutzer; öffentlich ohne Sitzung ohne `comment` inhaltlich.

Details und Dateilisten: `CONTRACT_RENAME_LOG.md`.

### 5.1a Projektordner / Monteur (Dispo `api/`, Login oder Monteur-Session)

Gleiche Basis-URL wie die Dispo. Authentifizierung wie bisher: Monteur mit `technician_id` (Query und/oder Header `X-Technician-Id`) und Dispo-Login (`require_login.php`), wo die jeweilige Datei das vorsieht.

| Endpunkt | Methode | Kurzbeschreibung |
|----------|---------|------------------|
| `dispo/api/job_project_files_list.php` | GET | `job_id`, `technician_id`, optional `path` (relativ zum Projektordner). **`Dokumente_Monteur`:** physische Uploads ∪ ELEKTRO-Mount (`$FILESERVER_ELEKTRO_PROJEKTE_NEU_ROOT`), ohne Kopie. **`Dokumente_Anlage`:** physische Dateien ∪ Zentral-Anlagen (`FILESERVER_BASE_PATH` / Anlagen), ohne Kopie. |
| `dispo/api/job_project_file_download.php` | GET | `job_id`, `technician_id`, `path` – Datei aus Projektordner; unter `Dokumente_Monteur` bzw. `Dokumente_Anlage` zuerst physische Datei, sonst Stream vom Mount bzw. Zentral-Anlagen-Pfad. |
| `dispo/api/job_project_refresh.php` | POST JSON | `job_id`, `technician_id`, optional `include_bilder` (wird ignoriert) – stellt nur die Standard-Unterordner sicher; **kein** Kopieren vom Fileserver. |
| `dispo/api/job_project_file_delete.php` | POST form | `job_id`, `technician_id`, `path` – nur **physische** Dateien; reine ELEKTRO- oder Zentral-Anlagen-Quelle → 403. |

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
