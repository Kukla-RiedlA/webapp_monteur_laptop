# Versionshistorie – Monteur WebApp

Kurzfassung der wesentlichen Änderungen je Version. Format der Versionsnummer wie in der Dispo: **V &lt;Hauptversion&gt;.&lt;Build&gt;** (z. B. V 1.001).

---

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
