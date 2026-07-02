# Offline-Datenmatrix – Monteur-Laptop (Electron)

Überblick: Welche Daten wo liegen, wie sie synchronisiert werden und ob sie ohne Dispo-Verbindung nutzbar sind.

**Vollständiges Gap-Audit (Phase 0):** [`OFFLINE_GAP_AUDIT.md`](OFFLINE_GAP_AUDIT.md) — alle Routen, UI-Views, Testfall-IDs, P0–P3-Backlog.

## Verbindlicher Grundsatz (Offline-First)

Fuer alle bestehenden und neuen Funktionen gilt:

- Die Funktion muss offline benutzbar sein (lesen + schreiben).
- Online dient nur dem Synchronisieren mit Dispo.
- Fehlende Offline-Faehigkeit ist ein Defekt und als Umbaupunkt zu priorisieren.

**Gateway:** Der Renderer spricht nur mit dem lokalen Express (`API_BASE`). Alle Dispo-Zugriffe laufen über `electron/server.js` und die gewählte Basis-URL (extern oder intern). Siehe `.cursor/rules/laptop-dispo-gateway.mdc` und `docs/API_CONTRACT.md` (Abschnitt Gateway).

Legende:

| Spalte | Bedeutung |
|--------|-----------|
| **SQLite** | Persistenz in `monteur.db` (Schema `electron/db/schema.sql` plus Migrationen in `server.js`). |
| **Sync In** | Daten kommen von Dispo → lokale DB (z. B. `sync_pull`, Kalender-Cache-Updates). |
| **Sync Out** | Lokale Änderungen werden bei Verbindung zu Dispo übermittelt (Push / dedizierte APIs). |
| **Offline lesen** | UI kann aus lokaler DB / Cache bedient werden. |
| **Offline schreiben** | Eingaben möglich; werden gequeued oder erst nach Reconnect wirksam serverseitig. |

---

## Kernbereiche

| Bereich | SQLite (Auszug) | Sync In | Sync Out | Offline lesen | Offline schreiben |
|---------|-------------------|---------|----------|---------------|-------------------|
| Aufträge / Stammdaten | `jobs`, `customers`, `job_addresses`, `job_technicians`, `job_contacts`, `job_hotel_addresses` | `sync_pull` u. a. | Status, Beschreibung, Hotel, FNs → `pending_changes` / Push | Ja (letzter Stand) | Ja (`PATCH /api/job`); Push wenn online |
| **Auftrag annehmen** | `jobs`, Dienstreise-Ordner | optional Pull | Status `in_arbeit` | Teilweise | **Ja** (`POST /api/dienstreise/accept_offline`) |
| **Auftrag abschließen** | Dienstreise-Ordner | `dienstreise_push` | Finish-Sync | Ja | **Ja** (defer bei Offline) |
| **Auftrag freigeben** | `jobs` | — | `pending_changes` | Ja | **Ja** (lokal + Queue) |
| Lokale Dateien zu Jobs | `job_files` | Download über Gateway | Upload bei Verbindung | Ja (geladene Dateien) | Teilweise (Queue) |
| Abwesenheiten | `absences` | Pull mit Sync | `pending_changes` | Ja | Ja (Queue); update/delete still bei Fehler |
| Abwesenheits**anfragen** | `absence_requests` | Pull; SSE live | Push / Anfragen | Ja | Ja (Queue); Entscheidung per SSE oder Pull |
| Dienstreisen | `dienstreisen` | Sync | `dienstreise_*` Jobs | Ja | Upload lokal; Push online |
| Kalender-Ansicht | `calendar_cache_*` | `sync_pull` / live `/api/calendar` | — | Ja (`calendar_cached`) | — |
| Anlagenstamm-Baum | `anlagenstamm_tree_cache` | Lazy/Fetch | — | Ja nach Sync | — |
| **Anlagenstamm (Liste/Edit)** | `anlagenstamm_local`, `pending_changes` | `sync_pull` | `sync_push` / save | Ja | Ja |
| **Textbausteine** | `textbausteine_user_*` (**Schema vorhanden, Routen nutzen es nicht**) | **fehlt in sync_pull** | Live-Proxy | **Nein** | **Nein** — GAP-007 |
| **Abrechnung** | `abrechnung_*_cache`, `abrechnung_outbox` | `abrechnung_refresh` | Outbox-Flush | Ja (Cache) | Ja (Outbox) |
| **RAMS** | — | Live | Live | Nein | Nein — GAP-009 |
| TED-Metadaten | `job_ted_index` | `sync_pull` / `dienstreise_pull` | — | Ja (Index); Datei wenn im Ordner | Pull online |

---

## Protokolle (Dienstreise-Ordner + Gateway)

Speicherort Zwischenstände: `{DienstreiseOrdner}/` pro angenommenem Auftrag (`in_arbeit`). Upload beim Abschluss / `dienstreise_push`.

| Protokoll | Lokale Datei | Sync In | Sync Out | Offline lesen (Formular) | Offline schreiben |
|-----------|--------------|---------|----------|---------------------------|-------------------|
| **Montagebericht** | `montagebericht.json` (+ PDF/DOCX lokal) | optional Dispo-Anreicherung | optional; Push bei Finish | Ja | Ja: „nur Daten“; PDF lokal (**Word/LibreOffice**); Signatur nur online |
| **Serviceprotokoll** | `serviceprotokoll.json` (`byFab`) | Defaults optional live | PDF nur Dispo | Ja | Ja: „nur Daten“; **PDF nur online** — GAP-005 |
| **Parameterlisten** | CSV + PDF im Ordner | — | Ingest optional (kein Outbox) | Ja | Ja lokal; Ingest queued fehlt — GAP-015 |
| **Kontrollwiegungen** | — (nur Dispo) | Live-Proxy | Live-Proxy | Teilweise | **Nein** — GAP-006 |
| **Inbetriebnahme** | — | — | — | Nein (Platzhalter) | Nein (nicht implementiert) |

**Badge / Verbindung:** `offline`-Event setzt Badge sofort auf Offline; State `degraded` zeigt „Sync-Probleme“ (nicht „Online“).

### Priorisierte Lücken (P0–P1, siehe Audit)

| ID | Thema |
|----|-------|
| GAP-001 | Offline-Accept | P0 | 4a | **teilweise umgesetzt** (`accept_offline`) |
| GAP-002 | Finish mit geänderten Dateien | P0 | 4a | **teilweise** (defer + push) |
| GAP-003 | Release nur nach Dispo | P0 | 4a | **teilweise** (lokal + Queue) |
| GAP-004 | `sync_push` bricht bei fehlender `server_id` ab | P0 | Infra | **erledigt** |
| GAP-005 | Serviceprotokoll-PDF |
| GAP-006 | Kontrollwiegungen |
| GAP-007 | Textbausteine (Routen + globaler Cache + sync_pull) |
| GAP-008–009 | Signatur, RAMS |

---

## Queue-Übersicht

| Mechanismus | Tabelle / Job | Offline-Schreiben |
|-------------|---------------|-------------------|
| `pending_changes` | SQLite | job, absence, anlagenstamm |
| `abrechnung_outbox` | SQLite | note, upload, delete |
| `background_jobs` | SQLite | dienstreise_*, sync_*, abrechnung_refresh |

Unbekannte `pending_changes`-Typen werden **nicht** verarbeitet (bleiben in Queue).

---

## Hinweise

- **Aktive Dispo-Basis:** `POST /api/dispo_pick_base` → LocalStorage; für Sync/Push/SSE.
- **Basic-Auth:** Accept, Pull, Finish und viele Proxys brauchen **Benutzername + Passwort** (nicht nur URL).
- **Reconnect:** `checkConnectionAndSync` bei Browser-`online`.
- **Implizite Deps:** Word/LibreOffice (Montagebericht-PDF), OneDrive-Dateisperren (`EBUSY`).
- Detail-Routen: [`OFFLINE_GAP_AUDIT.md`](OFFLINE_GAP_AUDIT.md); API: `docs/API_CONTRACT.md`.
