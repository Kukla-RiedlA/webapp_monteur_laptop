# Contract-Umbenennungen / Semantik (Monteur-Laptop-Repo)

Chronologische Kurznotizen zu Feld- und Statusänderungen, die Laptop, Dispo oder PWA betreffen.

---

## 2026-05-13 – Auftrags-Status statt Sammel-`geplant`

- **Alt:** fachlich oft alles unter `geplant`; lokale SQLite-Default `geplant`.
- **Neu:** `angelegt`, `zugeteilt`, `in_arbeit`, `erledigt`, `abgerechnet` (Dispo DB ab Migration 029); Laptop-Schema-Default `angelegt`; lokaler Backfill `geplant` → `angelegt` beim DB-Open.
- **API:** `POST dispo/api/job_mark_docs_loaded.php` (`job_id`, `technician_id`, Monteur-Auth wie andere `/api/*`-Aufrufe).
