# Versionshistorie – Monteur WebApp

Kurzfassung der wesentlichen Änderungen je Version. Format der Versionsnummer wie in der Dispo: **V &lt;Hauptversion&gt;.&lt;Build&gt;** (z. B. V 1.001).

---

## V 2.006.025
- **Stabilität:** Chromium-Occlusion-Flags und Auto-Reload bei „Keine Rückmeldung“ entfernt (Fenster wie vor 021). DirectComposition bleibt an.
- **Sync:** Datei-mtime-Scan und FN-Alias-Merge auf OneDrive geben den Event-Loop zwischendurch frei; welche Dateien erkannt/zusammengeführt werden, ist unverändert.
- **Login:** Dispo-Erreichbarkeit ohne implizite Monteur-ID 1; Erstinstallation erkennt den Host auch bei HTTP 400/401/403/429.
- **Zeitschreibung:** Web-Parity-CSS aktualisiert (Cache-Bust).

## V 2.006.024
- **Stabilität:** DirectComposition nicht mehr global aus (ganzer PC wurde sonst langsam). GPU-Softwarepfad nur nach GPU-Absturz auf diesem Gerät.
- **Diagnose:** hang-diag.log unter AppData (Event-Loop, Renderer-Heartbeat, Sync-Phasen); Bugreport hängt die letzten Zeilen an.
- **Main/Disk:** Kein rekursiver Ordner-Walk mehr bei Sync-Status; kein WAL-TRUNCATE mitten im Pull; Kalender „Alle Techniker“ gibt zwischen Wochen ab.

## V 2.006.023
- **Stabilität:** Glasiges „Keine Rückmeldung“ während Sync: WAL-Checkpoint blockiert den Hauptprozess nicht mehr; DirectComposition aus; Fenster lädt nach Hänger neu.

## V 2.006.021
- **Serviceprotokoll:** Auftragsliste wie die anderen Protokolle (keine Etex-Demo mehr im React-Dropdown).
- **Stabilität:** Transparentes Hängen auf manchen Windows-PCs abgesichert (PDF-Viewer-Timeout, GPU-Reload, max. zwei Auto-PDFs).

## V 2.006.020
- **Protokolle:** Nach dem Erstellen öffnen sich PDF bzw. mehrere PDFs (DE/EN, Alle PDF) im Electron-Viewer; Auto-Open ist standardmäßig an.
- **Parameterlisten:** PA3- und PAL-Dateien werden als PDF erzeugt (DWC-Ausdruck).
- **Bugreport:** Nebenfenster bleibt auf einem sichtbaren Bildschirm und kommt nach vorne.

## V 2.006.016
- **Textbausteine:** Eingabe wie Arbeitsschritte mit Bezeichnung DE und EN; Liste und Montagebericht-Chips nutzen die gewählte Sprache. Rich-Text-Editor entfällt.
- **Arbeitsschritte:** „Für alle“ übernimmt den Schritt lokal ins Globale; Katalog-Übernehmen wird nicht mehr vom React-iframe überschrieben.

## V 2.006.014
- **PWA-Fotos Allgemein/Angebot:** Ordner unter `Dokumente_Monteur/Montage/<Auftragsordner>/Bilder/` werden lokal angelegt, im Explorer auch leer angezeigt und beim Offline-Pull vom Server geholt. FN-Fotos bleiben unter `Dokumente_Monteur/<FN>/Montage/…/Bilder/`.

## V 2.006.013
- **Protokolle:** Hintergrund-Zwischenstand lokal (60 s, FN-Wechsel, Verlassen). Festes Speichern (JSON/PDF) geht auf den Server und fragt den Anlagenstamm. Beim Verlassen der Seite Hinweis, wenn noch nicht fest gespeichert – nicht beim FN-Wechsel.
- **Serviceprotokoll:** FN-Wechsel lädt den Inhalt der neuen Nummer; Speichern übernimmt den React-Stand.

## V 2.006.012
- **Protokolle Alle PDF:** Kontrollwiegung erzeugt je FN ein PDF; Montagebericht schreibt das Bericht-PDF in alle FN-Ordner (Button ab zwei FNs).
- **Protokolle für Kunden:** Filter PDF / CSV / PA / TXT neben Alle/Keine; deaktivierte Endungen werden nicht kopiert oder per E-Mail versendet.
- **FN-Ordner:** Bereichsordner (`500 - 501_…`) und Alias-Namen (Leerzeichen/Unterstrich) werden korrekt erkannt; Datums-Projektköpfe nicht als FN-Bereich gelesen.

## V 2.006.010
- **Start:** Oberfläche lädt auch ohne Gateway-Token (HTML/CSS/JS). `/api/health` existiert. Zweites Starten holt das Fenster nach vorne; belegter Port zeigt einen Dialog statt eines unsichtbaren Prozesses. Fenster erscheint spätestens nach 4 s.

## V 2.006.009
- **Sync Dead-Letter:** Button „Aufgegebene erneut versuchen“ legt fehlgeschlagene Queue-Einträge wieder in die Sync-Queue.
- **Hotel-Adresse:** Leeres Land wird als leerer String gespeichert, nicht als NULL (Dispo-MariaDB 1048).

## V 2.006.008
- **Zeitschreibung:** Mausrad über Stundenfeldern ändert den Wert nicht mehr, sondern scrollt die Tabelle.

## V 2.006.007
- **Projektdaten / FN:** Änderung an Leistung (z. B. `t/h` → `80 t/h`) wird in den Anlagenstamm übernommen (`dirty` + Pending). Der nächste Sync überschreibt sie nicht mehr mit dem alten Stammwert.
- **Anlagenakte-Galerie:** Thumbnails kommen aus der lokalen SQLite (`image_thumb_cache`), die Rasterliste aus dem Offline-Tree. Das Fenster lädt die Galerie erst beim Tab und nur sichtbare Thumbs; Vollbilder erst beim Öffnen (dann ggf. online).

## V 2.006.006
- **Sync-Queue:** Ausstehende Änderungen (Events) nutzen beim Push die aktuell erreichbare Dispo-URL und die Session-Zugangsdaten, nicht mehr eine festgebackene externe URL. Push-Fehler werden in den Einstellungen und in der Statusleiste angezeigt statt hinter „Online“ zu verschwinden. Bootstrap mit 0 B bei keinen Aufträgen in Arbeit ist der falsche Knopf für Events.
- **Anlagenstamm-Push:** „Fabrikationsnummer existiert bereits“ blockiert die Queue nicht mehr — lokale SQLite-IDs werden nicht als Dispo-IDs gesendet; bestehender Stamm wird per FN aktualisiert.
- **Einstellungen:** Kukla-Karten (Verbindung, Unterschrift, Speicherorte, Sync, Geräte, App). Neuer Block **Technischer Status** mit Queue, Push/Pull-Fehlern und ausstehenden Events.

## V 2.006.005
- **Auftrag annehmen:** Bei Dispo-Netzfehler (`fetch failed`) wird der Auftrag lokal auf „in Arbeit“ gesetzt; Projektdateien und Status-Push folgen beim nächsten Sync.
- **Sync intern:** Erreichbarkeit ohne paralleles Doppel-Login (weniger 429); interne URL `10.0.0.180:4433` wird auf Port 443 korrigiert; Push nutzt Session-Zugangsdaten.
- **Archiv:** PDF aus Protokoll-JSON im Dateibaum erzeugen.

## V 2.006.003
- **Sync/Login:** Kein Basic-Auth ohne Passwort in Proxy, Probe und Anlagenstamm; 401/429 nicht auf Zweit-URL wiederholen.

## V 2.006.002
- **Sync intern:** Abwesenheiten-Pull über `dispo_api` wie Aufträge; kein Basic-Auth ohne Passwort (verhindert 429-Sperre).
- **Anlagenstamm:** Umschalten hängt nicht mehr — Tabelle scrollt im Fenster, lädt nicht den ganzen Stamm in den DOM.

## V 2.006.001
- **Anlagenstamm:** Liste und TED/PN-Extras wieder offline-first — sofort aus SQLite, kein Warten auf Dispo beim Öffnen (App hing sonst komplett).

## V 2.006.000
- **Release:** Plattformweite Stufe 2.006; Patch-Zähler auf 000.
- **Härtung:** TLS Host-Pin (kein globaler Zertifikats-Bypass), Session-Cookies in JSON versiegelt, lokales API-Gateway nur mit Session-Token der eigenen App.

## V 2.005.028
- **Anlagenstamm Persistenz:** Leistung, Versorgung und Sensitivität halten beim Speichern/Öffnen.
- **Technik-Card Elektronik:** Type, Geräte Nummer GN, Bussystem; Übersicht-Elektronik bleibt gespiegelt.
- **Serviceprotokoll:** Qmax folgt der Stamm-Leistung; Protokoll-Übernahme schreibt Vers/Sens vollständig.

## V 2.005.027
- **Protokoll-JSON Multi-Laptop:** Zwischenstände (Montagebericht, Serviceprotokoll, Kontrollwiegung, Schleppkette, Prüfzertifikat) werden vom Server auf den zweiten Laptop geholt; Ablage bleibt unter `Dokumente_Monteur/`.

## V 2.005.020
- **Kalender (Alle Techniker):** Aufträge mit mehreren Monteuren erscheinen wieder als eigener Balken je Techniker (nicht nur einmal).
- **Auftrag annehmen:** Dialog zur Auswahl der PROJEKTE-NEU-Ordner/Dateien kommt wieder; Liste wird von Dispo geladen.

## V 2.005.019
- **Serviceprotokoll-PDF:** Kopf als festes 4-Spalten-Raster; Status im Kopf (Zeile 3 Spalte 4); Abschluss-Box Status/Monteur/Datum entfernt.
- **Serviceprotokoll Status:** Abschlussstatus (z. B. Justiert) bleibt erhalten; leere Arrays `abschluss: []` werden normalisiert.
- **Montagebericht-PDF:** mehr Abstand unter FN-Balken; mehrere Ansprechpartner untereinander.
- **Prüfzertifikat-PDF:** Layout auf eine A4-Seite; Siegelbox BESTANDEN; klare Block-/Zeilenabstände ohne Überlappungen.
- **PDF-Viewer / Protokolle:** lokale PDF-Anzeige und zugehörige Bridge-/UI-Anpassungen.

## V 2.005.018
- **Serviceprotokoll-PDF Header:** Wägezellen-Felder (Type/SN/Vers/Sens) aus dem Kopf entfernt; Meta in 3 Zeilen: Kunde/Projekt/FN · Type/Qmax/Pos.Nr./DWC · Datum/Techniker.

## V 2.005.017
- **Prüfzertifikat-PDF:** Label „Unterschrift“ entfernt; Signatur rechts neben Monteur-Name und Datum (kein Abschneiden am Seitenende).
- **Serviceprotokoll Alle-PDF:** PDFs lokal zuerst erzeugen (wie Einzel-PDF); Dispo-Sync optional ohne Abbruch bei Server-PDF-Fehler.
- **Schleppketten:** Button „Alle PDF erstellen“ für alle FNs.

## V 2.005.015
- **Serviceprotokoll Wägezelle:** Stammdaten (Type, Seriennummer, Pos., Vers. V, Sens. mV/V) in einer kompakten Zeile; Vers/Sens schmal, Pos. breiter; keine Platzhalter in Vers/Sens.

## V 2.005.014
- **Serviceprotokoll:** Abschnitte Wägezelle + Messwerte zusammengeführt; Block pro Wägezelle inkl. eigener Messwert-Tabelle; `messwerte.waegezellen[]` inkl. Legacy-Kompatibilität; Anlagenstamm-Prefill für Primär + Extra-Zellen; PDF blockweise.

## V 2.005.013
- **Profil-Unterschrift:** zeichnen/hochladen in Einstellungen; Cache + Sync von Dispo; Einbettung in Service-/KW-/Schleppketten-/Prüfzertifikat-/Montagebericht-PDFs; finales PDF nur mit Signatur; Kunden-Unterschrift entfernt.

## V 2.005.012
- **Protokolle für Kunden:** Montagebericht nur einmal in der Liste (gilt für alle FN), auch wenn die PDF unter mehreren FN-Ordnern liegt.

## V 2.005.011
- **Protokolle für Kunden:** neuer Menüpunkt – Auftrags-PDFs/CSVs und Bilder auswählen, nach `Dokumente_Monteur/Kunden Dokumentation` kopieren; optional Outlook-Entwurf (Einzeldateien oder ZIP) mit Baustellen-Ansprechpartner-Empfängern; Bilder mit FN-Prefix, Kollisionen nummeriert.

## V 2.005.010
- **FN-Ordner offline:** Neue Anlagen ohne PROJEKTE-NEU-Treffer heißen `FN_Kundenname_Ort_LK` (Parität Dispo); Bare-FN-Ordner werden migriert.

## V 2.005.009
- **Serviceprotokoll Qmax (React-UI):** Freitext inkl. Einheiten (z. B. `t/h`, `kg/h`); Zahlenfilter in der sichtbaren Anlagendaten-Eingabe entfernt.

## V 2.005.008
- **Serviceprotokoll Qmax:** freie Eingabe (Buchstaben/Sonderzeichen), kein Zahlen-Cap mehr.
- **Protokolle:** Kontrollwiegung- und Schleppketten-Messfelder ohne Hoch/Runter-Spinner (`type=text`).

## V 2.005.007
- **Auftrag erledigt:** Status wird beim Finish sofort an Dispo gepusht (wie Handy-PWA); bei `angelegt`/`geplant` Zwischenstufe `in_arbeit`. Pending `erledigt` wird bei abgelehntem Sync-Push nicht mehr verworfen — verhindert, dass der Auftrag nach Sync wieder als offen erscheint.

## V 2.005.006
- **Prüfzertifikat:** Service-Messwerte und Prüfgewichtstest (bis 4 %-Abweichungen) aus Serviceprotokoll; PDF-Tabelle wie Messpunkt; EN-Konformitätstext; Meta-Box kompakter.
- **Logo:** Kukla Claim-PNG mit transparentem Hintergrund in Protokoll-PDFs.
- **UI:** Prüfgewichtstest-Felder als Abweichung (%) nebeneinander.

## V 2.005.000
- **Rechtschreibung:** DE + en-GB (Chromium); Kontextmenü mit Vorschlägen und „Zum Wörterbuch hinzufügen“; Freitext/contenteditable mit spellcheck.
- **Release:** Plattformweite Ausrichtung auf V 2.005.000.

## V 2.004.001
- **Auftragsordner-Sanitize:** ASCII-Whitelist explizit (`ņ`/`ū` → `_`), Parität zu Dispo — verhindert Doppelordner Transfer/Montage.

## V 2.004.000
- **Montagebericht:** Corporate-PDF (pdf-lib), Speichern + PDF öffnen, Richtext/Bilder/Projektfotos; Legacy-DOCX in Protokolle lokal und auf Dispo bereinigen.
- **Sync-Push:** permanente Fehler (Parse/4xx) Dead-Letter statt Endlos-Retry; `pending_changes_failed`.
- **Protokolle:** Service-/Kontrollwiegung-/Schleppketten-PDF und UI-Anpassungen.

## V 2.003.003
- **Projektdaten FN hinzufügen:** Leistungsdaten (Type/Leistung/…) werden beim Speichern aus dem lokalen Anlagenstamm befüllt und in der UI nachgeladen.

## V 2.003.002
- **Abrechnung Dateien:** Löschen-UI lädt Liste bei Fehler neu; Server-Löschen nutzt gehärtete Dispo-API (`job_files` + Mirror-Event).

## V 2.003.001
- **Projektdaten Anlagen:** Button „Anlage(n) hinzufügen“ (Mehrfach-FN) und Entfernen pro Zeile; Freitext-Ersetzen-Feld entfernt.
- **Offline-Pull:** Nach Hinzufügen bei Auftrag in Arbeit Offline-Ordnerdialog (nur neue FNs) und `copy_project_stream` mit Merge der bestehenden Offline-Auswahl.

## V 2.003.000
- **Protokoll-Draft-JSON:** Ablage nur unter `Dokumente_Monteur/` (Serviceprotokoll, Montagebericht, Kontrollwiegung); Legacy Root/Dispo → Monteur-Migration.
- **Sync:** Draft-JSONs werden nicht als generischer Dienstreise-Datei-Sync hochgeladen (nur `*_draft.php`).

## V 2.002.002
- **PWA-Bilder Sync:** Fotos unter Dokumente_Monteur/Bilder und unter Montage/.../Bilder bleiben lokal unter Monteur (kein Remap nach Anlage) und werden im Offline-Modus explicit immer gezogen.
- **Montage-Pfade:** ensureMonteurMontageDirs legt Unterordner Bilder unter dem Auftragsordner an; Pull-Hints erkennen Montage/.../Bilder.

## V 2.002.000
- **Release:** Plattformweite Release-Stufe 2.002; Patch-Zaehler auf 000.
- **Montagebericht:** E-Mail-HTML mit Bildern im PDF/DOCX; keine Bullet-Zerlegung; doppelte Logos entfernt.
- **Editor:** Outlook-Paste (HTTPS/file/RTF) mit Deduplizierung der Zwischenablage-Bilder.

## V 2.001.005
- **Montagebericht Sync:** Pseudo-Konflikte (`.conflict-*`) behoben — Revision-Meta bleibt beim Speichern erhalten; Draft-Push richtet `base_revision` am Server aus und retry’t bei 409 (lokales Speichern gewinnt).
- **Zeitschreibung:** Spalte „Kommentar Buchhaltung“ (`lohn_kommentar`); breitere Card; Freigabe-PDF 1:1 wie Druckvorlage.

## V 2.001.000
- **Release:** Plattformweite Release-Stufe 2.001; Patch-Zaehler zurueck auf 000.
- **Zeitschreibung:** Speichern/Freigeben in Kopfzeile; Druck mit Dispo-Vorlage (A4 quer); Krank/Arzt getrennt; Sticky-Kopf/-Spalten; Lohn-Korrektur als Tooltip; Entsperren lokal.
- **Sync / Kalender:** Multi-Device (device_id, Draft-Push, Bootstrap); sichtbarer Zeitraum online in Cache; Unassigned-Jobs gecacht.
- **Leistungsdaten / PROJEKTE NEU:** Type aus Anlagenstamm heilt Index-Bug; Soft-Refresh ohne Flackern; Windows-Stil-Icons; „Nicht loeschen“ schuetzt Ordnerinhalt.
- **Auto-Update:** TLS-Fix fuer electron-updater bei selbstsigniertem Dispo-HTTPS.

## V 2.000.030
- **Zeitschreibung UI:** Speichern und Freigeben (PDF) in der Monatsübersicht-Kopfzeile vor Drucken; Sektion „Speichern & Freigabe“ entfernt.
- **Zeitschreibung Druck:** Gruppen-Trennerlinien dicker (wie Dispo).

## V 2.000.029
- **Zeitschreibung Druck:** Button „Drucken…“ mit Dispo-Druckvorlage (A4 Querformat, Farbe, feste mm-Spalten).

## V 2.000.028
- **Leistungsdaten Type:** Anlagenstamm überschreibt Job-Types beim Enrich (heilt vertauschte Types aus dem Dispo-Index-Bug); Job spiegelt Type nicht mehr in den Stamm zurück.
- **Sync-UI:** Soft-Refresh — Kalender/Startseite flackern nicht mehr (kein Leer-Grid / „Wird geladen…“ ohne Datenänderung).
- **PROJEKTE NEU:** Card ~halbe Breite; Ordnerzeilen wie Projektordner lokal; Windows-Stil-Icons (Word/Excel/PDF/…) auch im lokalen Explorer.
- **Auftrag erledigt:** „Nicht löschen“ am Ordner schützt den gesamten Inhalt (Prefix-Match); geschützte Pfade aus DB statt unvollständiger UI-Liste.

## V 2.000.027
- **Kalender-Sync:** Sichtbarer Zeitraum wird online von Dispo in den Cache geschrieben; umgebuchte Aufträge/Abwesenheiten (z. B. Georgia-Pacific, Köprinner-Urlaub) bleiben nicht mehr als Geistertermine.
- **Kalender-Cache:** Unassigned-Jobs (`technician_id = 0`) werden gecacht; Datumsnormalisierung DATE vs. DATETIME (Randtage fehlen nicht mehr).
- **Sync:** `shouldPreserveLocalJobOnPull` schützt nur noch `in_arbeit`/Pending — zugeteilt/angelegt folgen Dispo-Umbuchungen.
- **Leistungszeilen:** `dms_position` im Stamm↔Job-Sync ergänzt.

## V 2.000.026
- **Montage-Auftragsordner:** Bei Änderung von Ort/Kunde/Techniker wird der bestehende Ordner unter `Dokumente_Monteur/<FN>/Montage/` umbenannt bzw. gemerged statt neu angelegt (Multi-Laptop).
- **Sticky-Name:** Folgt nach Align dem Desired-Namen; Accept/Pull/Push alignen vor dem Schreiben.

## V 2.000.005
- **Montagebericht Sprachen:** Deutsch/Englisch als Checkboxen; bei beiden Auswahl werden zwei DOCX/PDF erzeugt.
- **Montagebericht Dateinamen:** ohne führende Indexnummer; DE → `…_Montage_DE`, EN → `…_report_GB`.
- **Montagebericht Layout:** schmalere Label-Spalte, mehr Zelleneinzug; Ansprechperson nur Name; HTML-Entities (`&nbsp;`) im Einsatzgrund bereinigt.
- **DOCX→PDF:** Eigenes Word-COM-Skript (funktioniert in der gepackten EXE trotz `app.asar`); PDF danach Acrobat-freundlich normalisiert.
- **PDF öffnen:** Temp-Kopie bei langen Pfaden / Sonderzeichen (Acrobat vs. PDF24).
- **Nicht löschen:** Geschützte Pfade unter `Dokumente_Monteur` persistent (API, UI, Finish-Cleanup Exact-Match).

## V 2.000.000
- **Major Release:** Plattformweite Versionsausrichtung auf V 2.000.000.
- **Serviceprotokoll:** Arbeitsschritte per Katalog-Modal; Zuruecksetzen auf Fabrikationsnummer-Defaults; React-Embed und Legacy-Formular synchronisiert.

## V 1.004.058
- **Sync FN:** Leeres Fabrikationsnummern-Pending wird nicht mehr an Dispo gepusht (verhindert Löschen der Admin-FN nach Pull/Annehmen).
- **Sync Pull:** Veraltetes leeres FN-Pending wird verworfen, wenn der Server Leistungszeilen liefert.
- **Kalender/Techniker:** Nach Kalender-Sync Zuordnung und Termin-Daten mit Server abgleichen; Techniker-Wechsel verschwindet aus eigener Ansicht nach Sync.
- **UI:** Nach Sync Kalender, Meine Aufträge und Listen automatisch aktualisieren.

## V 1.004.048
- **Sync Büro-LAN:** Interne Dispo-URL (`10.0.0.180`) wird bei aktiver LAN-Session bevorzugt; laufender `sync_pull` wird bei Auftrag annehmen/Erledigt abgebrochen (kein Hängen mehr hinter langem Sync).
- **Dispo-Proxy:** `fetchDispo` liefert wieder `{ res, base }` statt verschachteltem Ergebnis — behebt Login-Crash (`Cannot read properties of undefined (reading 'status')`) bei Anlagenstamm-Remote-Aufrufen.
- **Anlagenstamm:** PROJEKTE-NEU-Cache, erweiterte lokale Suche, Bildergalerie-Fenster, Parameterlisten/Trend-Vergleich (Fortsetzung 1.004.045–047).

## V 1.004.044
- **Anlagenstamm (Dispo-Parität):** Online-Iframe `anlagenstamm.php` über `/dispo-remote`; offline Cache-Liste im Layout von `anlagenstamm.php` (Filter, Spalten-Panel, volle Breite).
- **Dispo-Web-Proxy:** Session, HTML-Rewrite und Routen für Monteur-Desktop-Embed (`dispo-proxy`, `monteur-dispo-web-routes`).
- **Anlagenstamm-Sync:** Vollständiger Pull über `anlagenstamm_list.php?omit_fn_filter=1` (wie Dispo Desktop).
- **Einstellungen:** Sync-Status und DB-/Projektordner-Größe wie Dispo Desktop (`/api/sync_status` erweitert).

## V 1.004.043
- **Auto-Update/TLS:** `ERR_CERT_AUTHORITY_INVALID` beim Update-Check behoben — selbstsigniertes Dispo-Zertifikat (`fsm.kukla.co.at`, LAN) wird für `electron-updater`/`electron.net` zuverlässig akzeptiert; `app_config` unter `userData/db` vereinheitlicht.

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

## V 2.005.006
- **Prüfzertifikat:** Service-Messwerte und Prüfgewichtstest (bis 4 %-Abweichungen) aus Serviceprotokoll; PDF-Tabelle wie Messpunkt; EN-Konformitätstext; Meta-Box kompakter.
- **Logo:** Kukla Claim-PNG mit transparentem Hintergrund in Protokoll-PDFs.
- **UI:** Prüfgewichtstest-Felder als Abweichung (%) nebeneinander.
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

