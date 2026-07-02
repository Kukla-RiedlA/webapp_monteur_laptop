# Offline-Gap-Audit – Monteur-Laptop (Phase 0)

**Stand:** 2026-07-02  
**Scope:** `electron/server.js`, `electron/lib/*`, `electron/public/app.js`, `serviceprotokoll-react/`  
**Regel:** [`.cursor/rules/webapps-offline-first.mdc`](../../.cursor/rules/webapps-offline-first.mdc)  
**Ist-Matrix:** [`OFFLINE_DATA_MATRIX.md`](OFFLINE_DATA_MATRIX.md)  
**Umsetzungsplan:** Cursor-Plan „Laptop Offline-First Audit“

---

## Legende

### API-Klassen

| Klasse | Bedeutung |
|--------|-----------|
| **A** | Lokal ohne Dispo (lesen + schreiben) |
| **B** | Lokal + Queue (`pending_changes`, `abrechnung_outbox`, `background_jobs`) |
| **C** | Live-Proxy / Dispo-Pflicht (Offline-Defekt) |
| **D** | Sync-only (darf online bleiben) |
| **E** | Bootstrap / Admin (einmalig oder optional) |

### Offline-Spalten (Feature-Ebene)

| Spalte | Bedeutung |
|--------|-----------|
| **Lesen** | UI kann ohne Netz/Dispo Daten anzeigen |
| **Schreiben** | Eingaben werden lokal persistiert |
| **Sync** | Server-Abgleich bei Verbindung |

### Priorität

| Prio | Bedeutung |
|------|-----------|
| **P0** | Kernworkflow blockiert (Accept, Finish, Release) |
| **P1** | Protokolle / tägliche Monteur-Arbeit |
| **P2** | Komfort / Anreicherung |
| **P3** | Bootstrap / Admin / nicht implementiert |

### Testfall-IDs

Format `T-NNN` — in Phase 3 manuell/automatisiert abarbeiten. Szenarien: **S1** Flugmodus, **S2** Netz da / Dispo down, **S3** Auth fehlt.

---

## Zusammenfassung

| Metrik | Anzahl |
|--------|--------|
| Gateway-Routen erfasst | **~115** |
| Klasse A (lokal) | ~45 |
| Klasse B (lokal+Queue) | ~25 |
| Klasse C (Live-Proxy, Defekt) | ~28 |
| Klasse D (Sync-only) | ~12 |
| Klasse E (Bootstrap) | ~5 |
| UI-Views mit Offline-Lücke | **12** |
| Kritische P0-Lücken | **4** |

---

## 1. API-Inventar (`electron/server.js` + `electron/lib/`)

### 1.1 System / Einstellungen / Version

| Route | Methode | Klasse | Offline lesen | Offline schreiben | Anmerkung |
|-------|---------|--------|---------------|-------------------|-----------|
| `/api/version` | GET | A | Ja | — | Lokal |
| `/api/dienstreise/config` | GET/POST | A | Ja | Ja | Lokale Pfade |
| `/api/settings_dispo_tls` | GET/POST | A | Ja | Ja | TLS-Flags lokal |
| `/api/technician` | GET | A | Ja | — | SQLite `users` |
| `/api/check_connection` | POST | D | — | — | Probe Dispo |
| `/api/dispo_pick_base` | POST | D/E | — | — | Basis-URL wählen |
| `/api/monteur_profile` | POST | E | Teilweise | — | Erstlogin online |
| `/api/server/health` | GET | E | — | — | Admin |
| `/api/server/reboot_policy` | GET | E | — | — | Admin |
| `/api/server/reboot_allowed` | GET | E | — | — | Admin |
| `/api/server/reboot` | POST | E | — | — | Admin |

### 1.2 Sync / Status / Queue

| Route | Methode | Klasse | Offline lesen | Offline schreiben | Anmerkung |
|-------|---------|--------|---------------|-------------------|-----------|
| `/api/sync_status` | GET | A | Ja | — | Lokaler Stand |
| `/api/offline_manifest` | GET | A | Ja | — | Job-Offline-Status |
| `/api/pending_changes` | GET | A | Ja | — | Queue-Anzeige |
| `/api/sync_pull` | POST | D | — | — | `baseUrl` Pflicht |
| `/api/sync_push` | POST | D | — | — | `baseUrl` Pflicht; bricht bei `job_ohne_server_id` |
| `/api/background_jobs` | POST/GET | D/B | Ja | Ja | Typ-abhängig; 503 wenn `bgJobs` null |
| `/api/background_jobs/:id` | GET | A | Ja | — | |
| `/api/background_jobs/:id/cancel` | POST | A | — | Ja | |
| `/api/background_jobs/recover` | POST | D | — | — | |
| `/api/background_jobs/reap` | POST | D | — | — | |
| `/api/events` | GET (SSE) | C | Nein | — | Push-Proxy; `absence_request_decided` nur live |

**`pending_changes` in `pushToServer` (Stand Code):**

| entity_type | action | Status |
|-------------|--------|--------|
| `job` | status, description, fabrikationsnummern, hotel_*, job_address, job_contacts | Implementiert |
| `absence` | create, update, delete | create ok; update/delete mit Fehler-Log |
| `anlagenstamm` | save, delete | Implementiert |
| *sonstige* | *beliebig* | **Log + bleibt in Queue** (kein Totalausfall) |

**Parallele Outboxen (nicht `pending_changes`):**

| Kanal | Tabelle/Mechanismus | Offline-Schreiben |
|-------|---------------------|-------------------|
| Abrechnung | `abrechnung_outbox` | Ja (note/upload/delete) |
| Dienstreise-Upload | `background_jobs` `dienstreise_push` | Nur wenn Job enqueued |
| Parameterlisten | kein dedizierter Outbox-Typ | Ingest optional, kein Queue |

### 1.3 Aufträge / Jobs

| Route | Methode | Klasse | Offline lesen | Offline schreiben | Prio | Test |
|-------|---------|--------|---------------|-------------------|------|------|
| `/api/my_jobs` | GET | A | Ja | — | — | T-010 |
| `/api/my_jobs_archive` | GET | A | Ja | — | — | T-011 |
| `/api/jobs_open_local` | GET | A | Ja | — | — | T-012 |
| `/api/jobs_open` | GET | C | Nein | — | P2 | T-013 |
| `/api/job` | GET | A/B | Ja | — | — | T-014 |
| `/api/job_from_dispo` | POST | C | Nein | — | P2 | T-015 |
| `/api/patch` `/api/job` | PATCH | B | — | Ja | — | T-016 |
| `/api/job_file` | POST | B | — | Teilweise | P2 | T-017 |

### 1.4 Dienstreise / Projektordner

| Route | Methode | Klasse | Offline lesen | Offline schreiben | Prio | Test |
|-------|---------|--------|---------------|-------------------|------|------|
| `/api/dienstreise/list` | GET | A | Ja | — | — | T-020 |
| `/api/dienstreise/:id` | GET | A | Ja | — | — | T-021 |
| `/api/dienstreise/create_folder` | POST | A | — | Ja | — | T-022 |
| `/api/dienstreise/upload` | POST | A | — | Ja | — | T-023 |
| `/api/dienstreise/mkdir` | POST | A | — | Ja | — | T-024 |
| `/api/dienstreise/delete_file` | POST | B | — | Ja | — | T-025 |
| `/api/dienstreise/project_files` | GET | A | Ja* | — | — | T-026 |
| `/api/dienstreise/project_file` | GET | A | Ja* | — | — | T-027 |
| `/api/dienstreise/projekte_neu_tree` | GET | A/B | Ja* | — | — | T-028 |
| `/api/dienstreise/projekte_neu_file` | GET | A/B | Ja* | — | — | T-029 |
| `/api/anlagenstamm/projekte_neu_resolve_local` | GET | A | Ja | — | — | T-030 |
| `/api/dienstreise` | POST | A | — | Ja | — | T-031 |
| `/api/dienstreise/accept_offline_preview` | GET | B | Teilweise | — | P0 | T-032 |
| `/api/dienstreise/accept_offline` | POST | A/B | — | Ja | **P0 erledigt** | T-033a |
| `/api/dienstreise/accept_job_stream` | POST | C | Nein | Nein | P1 (mit Pull) | T-033 |
| `/api/dienstreise/copy_project_stream` | POST | C | Nein | Nein | P1 | T-034 |
| `/api/dienstreise/copy_project` | POST | C | Nein | Nein | P1 | T-035 |
| `/api/dienstreise/sync_to_dispo` | POST | D | — | Queue | P0 | T-036 |
| `/api/dienstreise/finish_and_cleanup` | POST | B | Nein | Ja*** | **P0 teilweise** | T-037 |
| `/api/dienstreise/release_job` | POST | B | Nein | Ja | **P0 teilweise** | T-038 |

\* Nach Accept / lokalem Ordner bzw. Cache  
\** Schreiben nur wenn `changedCount === 0`; bei geänderten Dateien 409 ohne Dispo-Upload

### 1.5 Kalender

| Route | Methode | Klasse | Offline lesen | Offline schreiben | Prio | Test |
|-------|---------|--------|---------------|-------------------|------|------|
| `/api/calendar_cached` | GET | A | Ja | — | — | T-040 |
| `/api/calendar` | GET/POST | C | Nein | Nein | P2 | T-041 |

### 1.6 Abwesenheiten

| Route | Methode | Klasse | Offline lesen | Offline schreiben | Prio | Test |
|-------|---------|--------|---------------|-------------------|------|------|
| `/api/my_absences` | GET | A | Ja | — | — | T-050 |
| `/api/absence` | POST/PATCH/DELETE | B | — | Ja | — | T-051 |
| `/api/my_absence_requests` | GET | A | Ja | — | — | T-052 |
| `/api/absence_request` | POST/DELETE | B | — | Ja | P2 | T-053 |
| `/api/absence_requests_cleanup_errors` | POST | A | — | Ja | — | T-054 |

### 1.7 Anlagenstamm

| Route | Methode | Klasse | Offline lesen | Offline schreiben | Prio | Test |
|-------|---------|--------|---------------|-------------------|------|------|
| `/api/anlagenstamm_lookup` | POST | A/B | Ja | — | — | T-060 |
| `/api/anlagenstamm_search` | POST | A/B | Ja* | — | P2 | T-061 |
| `/api/anlagenstamm_save` | POST | B | — | Ja | — | T-062 |
| `/api/anlagenstamm_from_dispo` | POST | B | Ja* | — | P2 | T-063 |
| `/api/anlagenstamm_tree_cached` | GET | A | Ja | — | — | T-064 |
| `/api/anlagenstamm_files_list` | POST | C | Nein | — | P2 | T-065 |
| `/api/anlagenstamm_parameter_files_list` | POST | B | Ja* | — | — | T-066 |
| `/api/anlagenstamm_parameter_trend` | POST | B | Ja* | — | P2 | T-067 |
| `/api/anlagenstamm_parameter_download` | POST | B | Ja* | — | P2 | T-068 |
| `/api/anlagenstamm_file_download` | POST/GET | B | Ja* | — | — | T-069 |
| `/api/anlagenstamm_file_open` | POST | C | Ja* | Nein | P2 | T-070 |

\* Cache / `anlagenstamm_local` nach Sync

### 1.8 TED / Mechanik-Excel / Hotels

| Route | Methode | Klasse | Offline lesen | Offline schreiben | Prio | Test |
|-------|---------|--------|---------------|-------------------|------|------|
| `/api/mechanik_ted_excel_open` | POST | B | Ja* | — | P2 | T-080 |
| `/api/mechanik_ted_excel_download.php` | GET | B | Ja* | — | — | T-081 |
| `/api/mechanik_ted_excel_view.php` | GET | B | Ja* | — | — | T-082 |
| `/api/mechanik_ted_excel_from_dispo` | POST | C | Nein | — | P2 | T-083 |
| `/api/mechanik_ted_excel_pull_job` | POST | C | Nein | — | P2 | T-084 |
| `/api/job_hotels_from_dispo` | POST | C | Nein | — | P2 | T-085 |

\* Wenn Datei in Reiseordner / `job_ted_index` nach Pull

### 1.9 Protokolle

| Route | Methode | Klasse | Offline lesen | Offline schreiben | Prio | Test |
|-------|---------|--------|---------------|-------------------|------|------|
| `/api/protokolle/montagebericht` | GET | A | Ja | — | — | T-090 |
| `/api/protokolle/montagebericht` | POST | B | — | Ja*** | — | T-091 |
| `/api/protokolle/serviceprotokoll` | GET/POST | A/B | Ja | Ja (JSON) | — | T-092 |
| `/api/serviceprotokoll_defaults` | GET | C | Teilweise | — | P1 | T-093 |
| `/api/serviceprotokoll_save` | POST | C | — | JSON ja / PDF nein | **P1** | T-094 |
| `/api/serviceprotokoll_pdf` | GET | C | Nein | — | **P1** | T-095 |
| `/api/protokolle/serviceprotokoll/all-pdf` | POST | C | — | Nein | **P1** | T-096 |
| `/api/kontrollwiegungsprotokoll_save` | POST | C | Nein | Nein | **P1** | T-097 |
| `/api/kontrollwiegungsprotokoll_pdf` | GET | C | Nein | — | **P1** | T-098 |
| `/api/protokolle/parameterlisten` | POST | B | — | Ja | — | T-099 |

\*** PDF braucht Word/LibreOffice lokal (`docx2pdf-converter`)

### 1.10 Textbausteine

| Route | Methode | Klasse | Offline lesen | Offline schreiben | Prio | Test |
|-------|---------|--------|---------------|-------------------|------|------|
| `/api/textbausteine_list` | GET | C | Nein | — | **P1** | T-100 |
| `/api/textbausteine_save` | POST | C | — | Nein | **P1** | T-101 |
| `/api/textbausteine_delete` | POST | C | — | Nein | **P1** | T-102 |
| `/api/textbausteine_category_save` | POST | C | — | Nein | **P1** | T-103 |
| `/api/textbausteine_category_delete` | POST | C | — | Nein | **P1** | T-104 |
| `/api/textbausteine_publish_global` | POST | C | — | Nein | P2 | T-105 |

**Schema-Lücke:** `textbausteine_user_*` ohne globale Kategorien; `sync_pull` lädt Textbausteine nicht.

### 1.11 Signatur / RAMS

| Route | Methode | Klasse | Offline lesen | Offline schreiben | Prio | Test |
|-------|---------|--------|---------------|-------------------|------|------|
| `/api/montagebericht_signature_stage` | POST | C | — | Nein | P1 | T-110 |
| `/api/dispo_signature_session_open` | POST | C | — | Nein | P1 | T-111 |
| `/api/dispo_signature_submit` | POST | C | — | Nein | P1 | T-112 |
| `/api/dispo_signature_stage_pdf_b64` | POST | C | — | Nein | P1 | T-113 |
| `/api/laptop_rams_proxy` | ALL | C | Nein | Nein | P1 | T-114 |
| `/api/laptop_active_jobs_for_rams` | POST | C | Nein | — | P1 | T-115 |
| `/api/laptop_mobile_post` | POST | C | — | Nein | P1 | T-116 |

### 1.12 Abrechnung (`electron/lib/abrechnung-routes.js`)

| Route | Methode | Klasse | Offline lesen | Offline schreiben | Prio | Test |
|-------|---------|--------|---------------|-------------------|------|------|
| `/api/abrechnung/jobs` | GET | A/B | Ja | — | — | T-120 |
| `/api/abrechnung/bundle` | GET | B | Ja | — | — | T-121 |
| `/api/abrechnung/file` | GET | B | Ja* | — | — | T-122 |
| `/api/abrechnung/note` | POST | B | — | Ja | — | T-123 |
| `/api/abrechnung/upload` | POST | B | — | Ja | — | T-124 |
| `/api/abrechnung/delete_file` | POST | B | — | Ja | — | T-125 |
| `/api/abrechnung/refresh` | POST | D | — | — | P2 | T-126 |
| `/api/abrechnung/schedule_refresh` | POST | D | — | — | P2 | T-127 |
| `/api/abrechnung/outbox_count` | GET | A | Ja | — | — | T-128 |

\* Aus Cache / Dienstreise-Ordner

---

## 2. UI-Inventar (`electron/public/app.js`)

| View / Feature | DOM / Trigger | Offline lesen | Offline schreiben | UI-Gate | Prio | Test |
|----------------|---------------|---------------|-------------------|---------|------|------|
| Start / Kalender | `viewKalender` | Ja (Cache) | — | — | — | T-200 |
| Aktiver Auftrag | `viewStartActiveJob` | Ja | Teilweise | — | — | T-201 |
| Aufträge (Dienstreise) | `viewDienstreise` | Ja | Teilweise | Accept: URL+Auth | **P0** | T-202 |
| Projektdaten | `viewProjektdaten` | Ja | Ja (PATCH job) | TED/Hotel ohne URL | P2 | T-203 |
| Projektdaten Explorer | Modal | Ja* | Ja (upload) | ohne Accept kein Ordner | P0 | T-204 |
| Montagebericht | `viewProtokolleMontagebericht` | Ja | Ja (JSON) | Signatur, Textbausteine | P1 | T-205 |
| Serviceprotokoll (Legacy+React) | `viewProtokolleServiceprotokoll` | Ja | JSON ja / PDF nein | PDF `dispoBaseUrl` | **P1** | T-206 |
| Kontrollwiegungen | `viewProtokolleKontrollwiegungen` | Teilweise | Nein | Save/PDF Dispo | **P1** | T-207 |
| Parameterlisten | `viewProtokolleParameterlisten` | Ja | Ja | Ingest-Warnung | P2 | T-208 |
| Inbetriebnahme | Platzhalter | — | — | nicht implementiert | P3 | — |
| Anlagenstamm | `viewAnlagenstamm` | Ja | Ja | Live-Suche 7843 | P2 | T-209 |
| Textbausteine | `viewTextbausteine` | Nein | Nein | 14082 | **P1** | T-210 |
| Abwesenheiten | `viewAbwesenheiten` | Ja | Ja (Queue) | SSE-Entscheidung | P2 | T-211 |
| Abrechnung | `view-abrechnung` | Ja* | Ja (Outbox) | Refresh online | P2 | T-212 |
| Archiv | `viewArchiv` | Ja | — | — | — | T-213 |
| Einstellungen | `viewEinstellungen` | Ja | Ja | — | E | T-214 |

### 2.1 Harte `getDispoBaseUrl()`-Gates (Auswahl)

| Zeile (app.js) | Verhalten | Soll |
|----------------|-----------|------|
| 1239 | Accept ohne URL blockiert | Lokal accept + Queue |
| 2595 | TED/Hotel deferred load | Lokaler Cache |
| 3545, 3878 | TED pull/open | Lokale Datei zuerst |
| 6778 | App-Update-Check | Bootstrap OK |
| 7843 | Anlagenstamm-Suche | Nur `anlagenstamm_local` |
| 11694 | MB-Textbausteine leer | SQLite-Cache |
| 11817 | MB-Signatur | Queue |
| 12297, 12327 | Kontrollwiegung | Lokal + Queue |
| 13578+, 13641 | SP-PDF | Lokal printToPDF + Queue |
| 14082+ | Textbausteine-View | SQLite |

### 2.2 React-Bridge (`serviceprotokoll-react`)

| Komponente | Offline | Lücke |
|------------|---------|-------|
| `useElectronBridge.ts` | Neutral | — |
| `ServiceProtocolPage.tsx` | Daten via Bridge | — |
| `ActionPanel.tsx` PDF-Buttons | Blockiert via Parent | Kein `SP_CONNECTION` / Tooltip |
| `serviceprotokoll-react-bridge.js` | Delegiert Legacy | PDF = Legacy-Gate |

---

## 3. Background-Job-Typen

| Typ | Offline-fähig | Anmerkung |
|-----|---------------|-----------|
| `dienstreise_pull` | Nein | Dispo + Auth Pflicht |
| `dienstreise_push` | Nein | Ordner-Upload |
| `dienstreise_finish` | Nein | Sync vor Cleanup |
| `sync_pull` | Nein | Dispo Pflicht |
| `sync_push` | Nein | Dispo Pflicht |
| `anlagenstamm_db_sync` | Nein | Vollsync Dispo |
| `abrechnung_refresh` | Nein | Dispo Pflicht |
| *unbekannt* | Nein | `POST /api/background_jobs` ohne Whitelist → Laufzeitfehler |

---

## 4. Priorisierte Lücken (Umsetzungs-Backlog)

| ID | Lücke | Prio | Welle (Plan) | Tests |
|----|-------|------|--------------|-------|
| GAP-001 | Kein echter Offline-Accept (`accept_job_stream` Dispo-Pflicht) | P0 | 4a | **Teilweise:** `accept_offline` + UI |
| GAP-002 | Finish mit Dateiänderungen → 409 ohne Upload-Queue | P0 | 4a | **Teilweise:** defer + push-Job |
| GAP-003 | Release nur nach Dispo-Push | P0 | 4a | **Teilweise:** lokal + Queue |
| GAP-004 | `sync_push` Totalausfall bei `job_ohne_server_id` | P0 | Infra | **Erledigt** |
| GAP-005 | Serviceprotokoll-PDF nur Dispo | P1 | 2 | T-094–T-096 |
| GAP-006 | Kontrollwiegungen komplett live | P1 | 3 | T-097, T-098 |
| GAP-007 | Textbausteine live-only + Schema global | P1 | 1 | T-100–T-105 |
| GAP-008 | Montagebericht-Signatur live | P1 | 6 | T-110 |
| GAP-009 | RAMS live | P1 | 6 | T-114–T-116 |
| GAP-010 | `pending_changes` unbekannte Typen / stille Absence-Fehler | P1 | Infra | **Teilweise:** Logging |
| GAP-011 | SSE ohne Offline-Ersatz | P2 | 8 | T-211 |
| GAP-012 | `jobs_open` ohne Auto-Fallback local | P2 | 4 | T-013 |
| GAP-013 | `anlagenstamm_files_list` ohne Cache | P2 | 5 | T-065 |
| GAP-014 | TED/Hotel UI-Gates | P2 | 5 | T-080, T-085 |
| GAP-015 | Parameterlisten Ingest ohne Outbox | P2 | Infra | T-099 |
| GAP-016 | Kalender live ohne Cache-Fallback | P2 | 5 | T-041 |
| GAP-017 | `serviceprotokoll_defaults` nicht gecacht | P2 | 2 | T-093 |
| GAP-018 | React PDF ohne Connection-Feedback | P2 | 7 | T-206 |

---

## 5. Implizite Abhängigkeiten (nicht nur Dispo-URL)

| Abhängigkeit | Betroffene Flows |
|--------------|------------------|
| Basic-Auth (`dispo_username` / `dispo_password`) | Accept, Pull, Finish, Proxys |
| `resolveDispoWorkingBase` | Sync, Background-Jobs |
| `bgJobs` initialisiert | 503 bei Accept/Finish/Sync kurz nach Start |
| Microsoft Word / LibreOffice | Montagebericht-PDF |
| OneDrive / Dateisperren (`EBUSY`) | Protokoll-Dateien, DOCX |
| `server_id` auf `jobs` | Push aller job-bezogenen Änderungen |
| Kontrollwiegung-PHP | Nicht im `dispo`-Submodule — Referenz Handy-App / Server |

---

## 6. Bootstrap-Ausnahmen (kein Offline-Defekt)

- Erstes `monteur_profile` / Techniker ohne vorherigen Sync
- `dispo_pick_base` / URL-Konfiguration in Einstellungen
- Server-Reboot / Health-Admin
- App-Update-Check (optional)
- Inbetriebnahme-Protokoll (nicht implementiert)

---

## 7. Verifikations-Matrix (Phase 3)

Jeder Testfall `T-NNN` mindestens unter **S1** (Flugmodus). P0/P1 zusätzlich **S2** und **S3**.

| Szenario | Beschreibung |
|----------|--------------|
| **S1** | Flugmodus / kein Netz |
| **S2** | Netz aktiv, Dispo-Host unreachable |
| **S3** | URL gesetzt, Basic-Auth leer |

**Logs nach Reconnect:** `sync_push_errors.log`, `absence_request_errors.log`, DevTools-Konsole.

**Referenzmuster (bereits offline-first):** `GET /api/job` + `enrich_local_only`, Anlagenstamm `performAnlagenstammSave`, Montagebericht JSON, Parameterlisten-Upload lokal, Abrechnung-Outbox.

---

## 8. Nächste Schritte (Phase 1+)

1. Infra: `pending_changes`-Härtung (GAP-004, GAP-010)
2. Welle 4a: Accept / Finish / Release-Outbox (GAP-001–003)
3. Welle 1: Textbausteine SQLite + globaler Cache (GAP-007)
4. PDF-Prototyp `protocol_pdf.js` dann Welle 2–3 (GAP-005, GAP-006)

---

*Erstellt in Phase 0 — keine Code-Änderungen an Gateway/UI; nur Dokumentation.*
