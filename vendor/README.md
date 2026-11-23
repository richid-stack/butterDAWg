# Vendored front-end assets

These files are committed so the app runs offline. They used to load from the
internet at start-up (Font Awesome kit, desvg from jsDelivr, Google Fonts, jQuery).

| Folder | Package | Version | Licence |
| --- | --- | --- | --- |
| `fontawesome/` | Font Awesome Free (solid and brands icons) | 6.7.2 | Icons CC BY 4.0, fonts SIL OFL 1.1, code MIT. See `fontawesome/LICENSE.txt`. |
| `desvg/` | desvg | 1.0.2 | ISC (declared in the package's `package.json`) |

Removed instead of vendored: jQuery (no code called it) and the Open Sans web
font (it was only a fallback behind `system-ui` in one stylesheet).

To update an asset, install the package in a scratch folder and copy the files
listed above; do not add these packages to the app's `package.json`.
