# Laptop-App: Erscheinungsbild (Themes)

## Steuerung

- **Kopfzeile:** Schalter (Schieberegler) rechts neben dem Zahnrad (Einstellungen).
- **Aus:** Kukla-hell (Dispo/PWA-Parität, Markengrün).
- **Ein:** Klassisch dunkel (bisheriges dunkles UI).

## Technik

- `document.documentElement` trägt `data-ui-theme="kukla"` oder `data-ui-theme="dark"`.
- **localStorage-Key:** `monteur_uiTheme`, Werte `kukla` | `dark`.
- Vor dem ersten Paint setzt ein kleines Skript im `<head>` von `electron/public/index.html` das Attribut aus `localStorage` (vermeidet FOUC).
- **Styles:** `electron/public/ui-theme.css` (Body-Tokens Kukla-hell / Navy-dunkel), `css/kukpit-tokens.css`, `css/kukpit-shell.css` (KUKpit-Kopfzeile, auch bei Dark), `css/kukpit-components.css`.
- Visuelle Referenz: `electron/public/kukpit-ui-demo.html`.

## Offene Gaps (nicht in diesem Paket)

- React-Bundles Service/Inbetriebnahme (`serviceprotokoll-react/assets`).
- `image-gallery.html` eigenes Dark.
- `pdf-annotator.html` eigenes Annotator-Theme.
- Globale Kopfzeilen-Suche (kein totes Icon).

## Farb-Referenz (Kukla)

- Kanonische Hex-Werte: `dispo/assets/css/kukla-brand.css` (im Dispo-Repo; Werte in `ui-theme.css` gespiegelt, nicht per `<link>` eingebunden).
- Plattform-Übersicht: `Kukla_Monteur_Plattform/.cursor/rules/kukla-ui-design-tokens.mdc`.
- PWA-Orientierung (App-Bar, Kacheln): `webapp_handy/pwa/css/app-shell.css`.
