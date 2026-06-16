# Offline-Datenmatrix – Monteur-Laptop (Electron)

Überblick: Welche Daten wo liegen, wie sie synchronisiert werden und ob sie ohne Dispo-Verbindung nutzbar sind.

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
| Aufträge / Stammdaten | `jobs`, `customers`, `job_addresses`, `job_technicians`, `job_contacts`, `job_hotel_addresses` | `sync_pull` u. a. | Status, Beschreibung, Hotel, FNs → teils `pending_changes` / Push | Ja (letzter Stand) | Ja; Push wenn online |
| Lokale Dateien zu Jobs | `job_files` | Download über Gateway-Routen | Uploads über Gateway bei Verbindung | Ja (bereits geladene Dateien) | Teilweise (Queue bis Upload) |
| Abwesenheiten | `absences` | Pull mit Sync | Create/Delete zu Dispo | Ja | Abhängig vom Flow (Server muss bestätigen) |
| Abwesenheits**anfragen** | `absence_requests` | Pull | Status-Updates / neue Anfragen | Ja | Anfragen ggf. queued |
| Dienstreisen | `dienstreisen` | über Sync mit Dispo-Basis | wie implementiert | Ja | lokal + Sync |
| Kalender-Ansicht (Dispo-Spiegel) | `calendar_cache_technicians`, `calendar_cache_jobs`, `calendar_cache_absences` | nach Pull / Fetch vom Server | — | Ja (Cache-Stand) | — |
| Anlagenstamm-Baum (Cache) | `anlagenstamm_tree_cache` | Lazy/Fetch über Gateway | — | Ja nach Sync | — |
| **Anlagenstamm (Liste/Edit)** | `anlagenstamm_local`, `pending_changes` | `sync_pull` (Vollsync) | `sync_push` / `anlagenstamm_save` | Ja (offline-first UI) | Ja (lokal + Push) |
| Benutzer-Textbausteine | `textbausteine_user_categories`, `textbausteine_user` | Sync mit Dispo | Sync | Ja | Ja (lokal; Sync später) |

---

## Hinweise

- **Aktive Dispo-Basis:** Nach Start bzw. nach `checkConnectionAndSync` wird die erreichbare URL gewählt (`POST /api/dispo_pick_base`), in LocalStorage als aktive Basis gespeichert und für Sync/Push/EventSource verwendet.
- **Reconnect:** Bei Browser-`online` wird die Verbindung erneut geprüft (`checkConnectionAndSync`), damit nach Netzwechsel nicht eine veraltete Basis „kleben“ bleibt.
- Detail-Endpunkte und JSON-Konventionen: `docs/API_CONTRACT.md` (Plattform), Dispo-Pfade unter `dispo/dispo_api/` und `dispo/api/`.
