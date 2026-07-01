# Serviceprotokoll React Prototyp

Nachbau des Referenz-Mockups als **React + TypeScript + Tailwind** (Vite).

## Start (Standalone)

```bash
cd webapp_monteur_laptop/serviceprotokoll-react
npm install
npm run dev
```

Browser: http://localhost:5174

## Electron-Integration

Build erzeugt statische Dateien unter `electron/public/serviceprotokoll-react/`:

```bash
cd webapp_monteur_laptop/serviceprotokoll-react
npm run build:electron
```

Die Monteur-App lädt das Formular in `viewProtokolleService` per **iframe**.  
Datenfluss: React ↔ `js/serviceprotokoll-react-bridge.js` ↔ Legacy-DOM in `app.js` (Speichern/PDF/Auftrag/FN).

## Icons

- Primär: **Custom-SVGs** in `public/icons/` (Kopie aus `serviceprotokoll_icons_exakt_nachgebaut`)
- Electron: zusätzlich `electron/public/icons/` für Legacy-Header und FAB-Check
- Fallback in React: **lucide-react**

## Hinweis

Unterschriften in React sind noch Platzhalter (PenLine-Icon). Canvas-Unterschriften bleiben vorerst im Legacy-DOM für PDF/Speichern.
