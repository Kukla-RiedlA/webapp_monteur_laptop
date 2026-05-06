# Laptop-App: Erscheinungsbild (Themes)

## Steuerung

- **Kopfzeile:** Schalter (Schieberegler) rechts neben dem Zahnrad (Einstellungen).
- **Aus:** Kukla-hell (Dispo/PWA-Parität, Markengrün).
- **Ein:** Klassisch dunkel (bisheriges dunkles UI).

## Technik

- `document.documentElement` trägt `data-ui-theme="kukla"` oder `data-ui-theme="dark"`.
- **localStorage-Key:** `monteur_uiTheme`, Werte `kukla` | `dark`.
- Vor dem ersten Paint setzt ein kleines Skript im `<head>` von `electron/public/index.html` das Attribut aus `localStorage` (vermeidet FOUC).
- **Styles:** `electron/public/ui-theme.css` (Theme-Variablen + Kukla-Kopfzeile).

## Farb-Referenz (Kukla)

- Kanonische Hex-Werte: `dispo/assets/css/kukla-brand.css` (im Dispo-Repo; Werte in `ui-theme.css` gespiegelt, nicht per `<link>` eingebunden).
- Plattform-Übersicht: `Kukla_Monteur_Plattform/.cursor/rules/kukla-ui-design-tokens.mdc`.
- PWA-Orientierung (App-Bar, Kacheln): `webapp_handy/pwa/css/app-shell.css`.
