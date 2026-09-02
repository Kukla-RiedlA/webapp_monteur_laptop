# PDF-Seitenumbruch-Test (Laptop)

Neues oder geändertes Protokoll-PDF braucht ein Fixture wie
`electron/scripts/test-montagebericht-pdf-pagebreak.js`.

Ziel: eine Leiste (FN, Sektion) darf nicht allein am unteren Seitenrand stehen.

```bash
cd electron
npm run test:montagebericht-pdf-pagebreak
```

Für ein neues Dokument: Skript kopieren, Generator-Funktion und Marker-Text anpassen, gleichen Assert (Block und Folgezeile auf derselben Seite bzw. gemeinsam umgebrochen).

Siehe `.cursor/rules/formular-pdf-design.mdc` und die Plattform-Checkliste `docs/design/FORMULAR_PDF_CHECKLISTE.md`.
