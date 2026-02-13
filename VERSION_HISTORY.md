# Versionshistorie – Monteur WebApp

Kurzfassung der wesentlichen Änderungen je Version. Format der Versionsnummer wie in der Dispo: **V &lt;Hauptversion&gt;.&lt;Build&gt;** (z. B. V 1.001).

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
