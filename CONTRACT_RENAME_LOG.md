# Contract-Umbenennungen / Semantik (Monteur-Laptop-Repo)

Chronologische Kurznotizen zu Feld- und Statusänderungen, die Laptop, Dispo oder PWA betreffen.

---

## 2026-09-05 – Abrechnung-Kommentar Edit/Delete (Monteur-API)

- **Alt:** Laptop-Edit sendete nur `comment_id` (ohne `job_id`); lokale Cache-Suche mit `job_server_id = 0` → „Kommentar nicht gefunden.“ Keine `dispo_api`-Endpunkte für Edit/Delete.
- **Neu:** FormData enthält `job_id` (und `bucket`). Cache-Suche über alle Jobs, falls `job_id` fehlt. `POST dispo_api/api/abrechnung_comment_edit.php` / `_delete.php`, Wrapper `api/monteur_abrechnung_comment_*`, Mobile `api/mobile/abrechnung_comment_*`. Outbox-Ops `comment_edit` / `comment_delete`.

## 2026-09-05 – Auftragszeitraum PATCH (`schedule`)

- **Alt:** Zeitraum in der Laptop-App nur Anzeige; PATCH `/api/job` und Dispo `job.php` ohne Start/Ende.
- **Neu (additiv):** `start_datetime`, `end_datetime`, optional `date_not_fixed`. Laptop queued `pending_changes` action `schedule`. Dispo `dispo_api/api/job.php` und `api/mobile/job.php`.

---

## 2026-09-04 – Mess-/Wiegungszeilen `in_pdf` (additiv)

- **Alt:** Nur Laptop-JSON/`payload_json`; KW-DB ohne Flags; SK-Messungen nur `in_summe`. PDF zeigte alle DB-Zeilen.
- **Neu (additiv):** `in_summe` + `in_pdf` an `kontrollwiegungsprotokoll_zeilen` und `schleppkettenprotokoll_messungen.in_pdf`. Summe erzwingt Druck. Dispo-Save/PDF/Prefill speichern und filtern relational (Migration 079).
- **API:** `wiegungen[]` / `messungen[]` in `kontrollwiegungsprotokoll_save` / `schleppkettenprotokoll_save`.

---

## 2026-08-25 – Textbausteine DE/EN analog Arbeitsschritte

- **Alt:** Item nur `text` (ein Feld, oft HTML).
- **Neu (additiv):** `text` bleibt Deutsch; Alias `text_de`; neu `text_en`. Speichern: mindestens DE oder EN.
- **API:** `textbausteine_list` / `_save` / `_global_*` / `_publish_global`; Laptop-SQLite `text_en`.
- **PWA:** Katalog-Editor nicht betroffen; Bericht speichert weiter `{ text }` aus Bemerkungszeilen.

---

## 2026-05-13 – Auftrags-Status statt Sammel-`geplant`

- **Alt:** fachlich oft alles unter `geplant`; lokale SQLite-Default `geplant`.
- **Neu:** `angelegt`, `zugeteilt`, `in_arbeit`, `erledigt`, `abgerechnet` (Dispo DB ab Migration 029); Laptop-Schema-Default `angelegt`; lokaler Backfill `geplant` → `angelegt` beim DB-Open.
- **API:** `POST dispo/api/job_mark_docs_loaded.php` (`job_id`, `technician_id`, Monteur-Auth wie andere `/api/*`-Aufrufe).
