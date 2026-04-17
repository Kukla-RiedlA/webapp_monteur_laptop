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
- **Abwesenheitsanfragen:** `absence_request*.php`, `absence_requests_pending.php` – `ok`; GET-Liste der Anfragen unter **`requests`** (nicht `data`).
- **Abwesenheiten Monteure-UI:** `absences_list.php`, `absence_create.php`, `absence_delete.php` – `ok`.

Details und Dateilisten: `CONTRACT_RENAME_LOG.md`.

### 5.1a Projektordner / Monteur (Dispo `api/`, Login oder Monteur-Session)

Gleiche Basis-URL wie die Dispo. Authentifizierung wie bisher: Monteur mit `technician_id` (Query und/oder Header `X-Technician-Id`) und Dispo-Login (`require_login.php`), wo die jeweilige Datei das vorsieht.

| Endpunkt | Methode | Kurzbeschreibung |
|----------|---------|------------------|
| `dispo/api/job_project_files_list.php` | GET | `job_id`, `technician_id`, optional `path` (relativ zum Projektordner). **`Dokumente_Monteur`:** Einträge = physische Uploads ∪ Inhalte vom ELEKTRO-Mount (`$FILESERVER_ELEKTRO_PROJEKTE_NEU_ROOT`), ohne Kopie auf dem Dispo-Server. |
| `dispo/api/job_project_file_download.php` | GET | `job_id`, `technician_id`, `path` – Datei aus Projektordner; unter `Dokumente_Monteur` zuerst physische Datei, sonst Stream vom ELEKTRO-Mount. |
| `dispo/api/job_project_refresh.php` | POST JSON | `job_id`, `technician_id`, optional `include_bilder` – aktualisiert **Dokumente_Anlage** vom zentralen Fileserver (`copyJobProjectFromFileServer`); **kein** Kopieren aus PROJEKTE NEU. |
| `dispo/api/job_project_file_delete.php` | POST form | `job_id`, `technician_id`, `path` – nur **physische** Dateien; reine ELEKTRO-Quelle → 403. |

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
