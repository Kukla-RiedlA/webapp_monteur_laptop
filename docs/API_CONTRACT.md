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
- **Abwesenheitsanfragen:** `absence_request*.php`, `absence_requests_pending.php` – `ok`; GET-Liste der Anfragen unter **`requests`** (nicht `data`).
- **Abwesenheiten Monteure-UI:** `absences_list.php`, `absence_create.php`, `absence_delete.php` – `ok`.

Details und Dateilisten: `CONTRACT_RENAME_LOG.md`.

### 5.1 Dispo-Web Admin (nur eingeloggte Dispo-Session, `perm_admin`)

Nur für die **interne** PHP/JS-Oberfläche; keine Monteur-Apps. Antworten nutzen **`ok`** (boolean) wie in Abschnitt 3.

| Endpunkt | Methode | Kurzbeschreibung |
|----------|---------|------------------|
| `dispo/api/admin/releases_status.php` | GET | Release-Bäume (test/prod/default), optional `activate_available` |
| `dispo/api/admin/release_activate.php` | POST JSON | `environment`, `release_id`, `csrf_token` — aktiviert Release (Wrapper) |
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
