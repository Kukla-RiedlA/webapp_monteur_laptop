# Versionshistorie – Monteur WebApp

Kurzfassung der wesentlichen Änderungen je Version. Format der Versionsnummer wie in der Dispo: **V &lt;Hauptversion&gt;.&lt;Build&gt;** (z. B. V 1.001).

---

## V 1.004.042
- **Release-Nummer:** Korrektur nach Server-Drift (Uploads 041 ohne Git-Tag); Auto-Update wieder linear über 041.
- **Inhalt:** identisch zu V 1.004.040 (better-sqlite3, Anlagenstamm-Sync-Fix).

## V 1.004.040
- **SQLite:** Umstellung von sql.js auf **better-sqlite3** (WAL, `db.js` + `db-compat.js`).
- **Anlagenstamm-Sync:** Leere dirty-Stubs aus `jobs.fabrikationsnummern` blockieren keine Server-Daten mehr; Lookup/Anzeige nutzt lokalen Cache zuerst.
- **Diagnose:** Skripte unter `electron/scripts/` für FN-Abfrage und Reparatur leerer dirty-Stubs.

## V 1.004.000
- **Auftrag annehmen:** Button in der Auftragsliste, `POST /api/dienstreise/accept_job_stream` (**202** + `job_id`, Hintergrund-Job `dienstreise_pull`: Projektordner kopieren, danach Status `in_arbeit`, Dispo-Sync). Fortschritt per `GET /api/background_jobs/:id`; Resume nach Abbruch über Checkpoint + `POST /api/background_jobs/recover` bei erneutem Online-Badge.
- **Projektdaten:** Projektordner-Explorer und Upload unter Leistungsdaten; FN-Zeile (Semikolon/Bereiche wie Dispo); Tabelle mit Spalte **Position**.
- **Sync:** Abgelehnter Status-Push bricht gesamten `sync_push` nicht mehr ab; FN-Patch auch bei angelegt/geplant/zugeteilt. **`sync_pull` / `sync_push` / `sync_to_dispo`** stellen ebenfalls **202** + Background-Job bereit (globale Queue, ein Worker).
- **Abrechnung:** UI kann Abgleich per Background-Job `abrechnung_refresh` auslösen; `POST /api/abrechnung/refresh` bleibt synchron verfügbar.
- **Doku:** `docs/API_CONTRACT.md` um Hintergrund-Jobs und neue Antwort-Codes ergänzt.

## V 1.003.000
- **Montagebericht:** Nach „PDF & DOCX erstellen“ kann der Bericht über den Dispo-Server signiert werden (lokales PDF-Staging, Proxy `montagebericht_signature_stage`, Widget + `dispo_signature_*`).
- **Signatur-Widget:** `electron/public/signature_widget.js`, Einbindung in `index.html`.

## V 1.002.000
- **Hotel/FN Workflow:** Hotelauswahl pro Fabrikationsnummer direkt im Auftragsdetail (FN-Zeile mit Hotel-Icon und Auswahl-Popup).
- **Hotelbewertung:** Kommentar und Sternebewertung (0-5) im Hotel-Dialog; Anzeige des Durchschnitts als Sterne inkl. halber Sterne und Anzahl Bewertungen.
- **Contract/Sync:** `hotel_selection`-Payload in lokalem Gateway/Sync ergänzt; API-Contract-Doku um neue Hotel-/Rating-Felder aktualisiert.

## V 1.001.020
- **Versionskennung:** Einheitlich **V 1.001.020** mit Dispo und Handy-PWA; `config/version.php`, `electron/version.json`, `electron/package.json` (SemVer `1.1.20`).

## V 1.046
- **Anlagenstamm PROJEKTE NEU:** Elternordner als **Überschrift**, darunter klassische Baumliste (nur Namen der Einträge).

## V 1.045
- **Anlagenstamm:** PROJEKTE-NEU-Baum (Lesepfad wie Dispo) mit **Überordner / Name**-Labels; Download über Proxy mit **`source: projekte_neu`** und **`path`**. `electron/server.js`: `POST /api/anlagenstamm_file_download` leitet optional an Dispo `source=projekte_neu&path=` weiter.

## V 1.044
- **Abwesenheit: Kommentar:** SQLite `absences`/`absence_requests` Spalte `comment`; `DispoRepository` + `api/absence.php`; `electron/server.js` (Sync, pending_changes, my_absences); `electron/public` (Modal, Liste, Kalender-Tooltip). Migration per `ALTER` in `getDb()`.

## V 1.043
- **Plattform-Release:** Build um eins erhöht und Versionsstände in `config/version.php`, `electron/version.json` sowie `electron/package.json` synchronisiert.

## V 1.042
- **Release/Regelwerk:** `release-and-push` Regel im Repo aktualisiert; Versionsstände in `config/version.php`, `electron/version.json` und `electron/package.json` wieder synchron.

## V 1.041
- **Anlagenstamm (neu):** Eigene Ansicht in der Laptop-App mit Suche per Fabrikationsnummer, Stammdatenanzeige und Dokumentliste.
- **Proxy-API:** `electron/server.js` ergänzt um `anlagenstamm_lookup`, `anlagenstamm_files_list` und `anlagenstamm_file_download` zur Weiterleitung an die Dispo-Endpunkte.

## V 1.040
- **DispoRepository:** `getJobByIdForTechnician` an Dispo angeglichen (Rechnungsadresse, Audit, Kunden-E-Mail, Hotel-Kontakt mit schema-tolerantem Nachladen, `assigned_to_me`).
- **Dokumentation:** `docs/API_CONTRACT.md` um erweiterte Felder der Handy-Mobile-API ergänzt.

## V 1.039
- **API-Contract:** `docs/API_CONTRACT.md` – `dispo/api/mobile/job.php` für die Handy-PWA dokumentiert; Eintrag zu `dispo_api/api/job.php` (`assigned_to_me`) beibehalten.
- **Plattform-Release:** mit Dispo V 1.065 und Handy-PWA V 0.022.

## V 1.038
- **Offene Aufträge / Filter:** Kombination mehrerer Checkboxen korrigiert; konsistente Neuladung und stabile Anzeige bei aktiven Filtern.
- **Proxy:** `electron/server.js` reicht Filterparameter für offene Aufträge (`include_erledigt`, `filter_no_date`, `filter_no_technician`) zuverlässig an die Dispo-API weiter.

## V 1.035
- **Kalender:** „Heute“-Hervorhebung mit `box-shadow: inset` statt `outline`, damit Monatsbalken nicht überdeckt werden; klare z-index-Stapelung Grid vs. Balken-Overlay.
- **Offline:** Standardansicht nur eigener Monteur (ohne „Alle Techniker“); bei fehlender Dispo-URL oder Serverfehler Fallback auf lokale Termine aus SQLite.
- **Tool:** `tools/MkcertCaInstaller` – Quellcode zum Herunterladen und Installieren der mkcert-Stamm-CA unter Windows.
- **Plattform-Release:** mit Dispo V 1.045 und Handy-PWA V 0.011.

## V 1.034
- **Plattform-Release:** Build mit Dispo V 1.041 (Deploy-Admin, DB-Migration) und Handy-PWA V 0.010.

## V 1.033
- **Plattform-Release:** Build hochgezählt im Zuge des gemeinsamen Releases mit Dispo V 1.040 und Handy-PWA.

## V 1.032
- **Release:** Build hochgezählt (Commit, Tag, Push).

## V 1.031
- **Contract-Sync:** Plattformweite API-Konvention vereinheitlicht (`snake_case`, Response-Flag `ok`) inkl. Abwesenheits- und Pairing-Schnittstellen.
- **Abwesenheiten/Kalender:** Doppelte Anzeige beantragter Abwesenheiten entfernt (stabile Deduplizierung zwischen lokalen Requests und Server-Absences).
- **Dokumentation/Regeln:** `docs/API_CONTRACT.md` angelegt, Contract-Rules und Rename-Log erweitert.

## V 1.030
- **Release:** Vollständiges Plattform-Release. Dispo V 1.031: Outlook-Import Urlaub/KM als Abwesenheit.

## V 1.029
- **Release:** Nach Rule (Build hochgezählt, Tag, Push). Dispo V 1.030: Anlagenstamm Popup-Aktualisierung ohne Reload.

## V 1.026
- **Montagebericht:** PDF wird aus DOCX erzeugt (docx2pdf-converter). Unter Windows wird Microsoft Word für die Konvertierung verwendet, unter Linux LibreOffice/unoconv. PDF und DOCX haben identisches Layout.

## V 1.025
- **Release:** Vollständiges Release nach Rule (Build hochgezählt, Tag, Push).

## V 1.024
- **Release:** Vollständiges Release nach Rule (Build hochgezählt, Tag, Push).

## V 1.023
- **Kalender:** Gleiche Grundstruktur wie Referenz (Dispo Monat): pro Woche Grid + Bands-Overlay, alle Balken (eintägig und mehrtägig) im Overlay mit grid-column/grid-row; Abwesenheiten zuletzt gerendert (immer sichtbar). CSS: cal-week-row, cal-week-bands, month2-band.

## V 1.022
- **Kalender:** Abwesenheitsbalken (mehrtägig) mit höherem z-index als Aufträge, damit Abwesenheiten nicht von Aufträgen überdeckt werden; Mindesthöhe der Lane-Referenz; vertikale Referenz nur bei gültiger Lane-Höhe; Overlay vor Positionierung geleert; Text-Zentrierung (line-height) für Span-Balken.

## V 1.021
- **Abwesenheiten:** Kalender zeigt Abwesenheiten in Technikerfarbe (schraffiert); eigene Abwesenheit auch in Einzeltechniker-Ansicht (ohne „Alle Techniker“); genehmigte/ausstehende Anfragen in my_absences; Löschen von Abwesenheitsanfragen korrekt (Button „Anfrage entfernen“).
- **Cursor-Regeln:** Release-Regel für Dispo und WebApp (alwaysApply), Dispo-Regel in htdocs angelegt.

---

## V 1.019
- **Dienstreise-Upload:** JSON-Body-Limit auf 50 MB erhöht (Upload großer Dateien); Frontend zeigt bei HTML-Antwort des Servers verständliche Meldung statt JSON-Parse-Fehler.
- **Cursor Rule:** Release-Workflow in `.cursor/rules/release-and-push.mdc` festgelegt.

---

## V 1.018
- **Abwesenheitsanfragen mit Freigabe:** Beantragen, Liste offener Anfragen, Toast bei Entscheidung; Sync mit Dispo über dispo_api; Fehlerbehandlung und Aufräumen fehlerhafter Einträge.

---

## V 1.017
- **Release/Dokumentation:** Cursor Rule für Release- und Push-Workflow; README-Verweis auf .cursor/rules.

---

## V 1.016
- **Dispo – Dateien (Auftrag):** Größeres Drop-Feld, Dateiname wird im Feld und in der Zeile „Ausgewählt“ angezeigt (Klick und Drag & Drop). Firefox: Drag-Over-Feedback (Zähler, Hervorhebung der Dropzone).
- **Dispo – Einzeldatei löschen:** API zum Löschen einer Datei, Papierkorb-Button pro Datei in der Liste, Löschen ohne Seiten-Reload.

---

## V 1.004
- **Kalender:** Mehrtägige Balken als ein durchgehendes Element (Overlay-Layer), keine Überlappung mehr; Lanes nach Länge (längere oben, kürzere darunter), keine Überlagerung; Abwesenheitsbalken über Auftragsbalken (z-index); Kalender volle Breite.
- **Abwesenheiten:** Grund als Überschrift, Datum kleiner darunter; Abwesenheitsbalken des eingeloggten Technikers in Technikerfarbe (auch bei Einzelansicht, via /api/technician).
- **Datumsanzeige (überall einheitlich):** Nur Datum (TT.MM.JJJJ), keine Uhrzeit; bei eintägigen Terminen kein „bis“, bei mehrtägigen „von – bis“. Gilt für Auftragsliste, Auftragsdetail, Abwesenheiten, Kalender-Tooltips.

---

## V 1.001
- **Grundversion**
  - Electron-Desktop-App (Windows) mit lokaler SQLite-DB (sql.js), Offline-fähig.
  - Toolbar: Ansichten „Aufträge“, „Kalender“, Einstellungen (Zahnrad), Verbindungs-Badge (Online/Offline/Lokal), Techniker-Name, Versionsanzeige.
  - **Aufträge:** Liste der Aufträge des Monteurs (1 Monat vor bis 1 Jahr nach heute), Status „Start“ / „Erledigt“, Abwesenheiten-Liste.
  - **Kalender:** Monatskalender mit Balken für Jobs und Abwesenheiten; eintägige Einträge in der Zelle, mehrtägige als durchgängiger Balken; Option „Alle Techniker anzeigen“ (Daten vom Dispo).
  - **Einstellungen:** Server-Adresse (Dispo), Monteur-ID, Benutzername/Passwort (Dispo-Login); Speichern in localStorage; bei Speichern und bei Online automatisch Pull/Push.
  - **Sync:** Beim Start und alle 5 Minuten Verbindungsprüfung; bei Online automatisch Pull (Aufträge/Abwesenheiten + Techniker-Name aus Dispo) und Push (lokale Änderungen). Techniker-Name aus der Dispo-Antwort von `my_jobs.php` (`technician_full_name` / `technician_username`).
  - **Versionsverwaltung:** Zentrale Version in `config/version.php` (PHP) und `electron/version.json` (Electron), Format wie Dispo (V 1.xxx); Anzeige in der Toolbar.
