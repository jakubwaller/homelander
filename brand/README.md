# Homelander Brand Assets

Primary mark: brass/gold Homelander key on transparent square canvas.

## Colors

- Gold: `#D9A441`
- Highlight gold: `#E6BD62`
- Dark background: `#07090E`
- Panel dark: `#0F1420`
- Light background: `#F6F7F9`
- Muted text: `#9CA3AF`

## Usage

- Use `brand/icon.svg` as the scalable source.
- Use `brand/icon.png` as the canonical high-resolution transparent PNG master.
- Use `brand/app/macos/icon.icns` for macOS app packaging.
- Use `brand/web/favicon.ico` and the PNG web icons for browser/site surfaces.
- Keep main icon exports square with transparent background and centered padding.
- Do not recolor the primary icon away from gold/brass unless using explicit black/white utility variants.

## Generation pipeline

This kit was rebuilt from a free `autotrace` vector trace of the cleaned original key silhouette, rendered from SVG using `librsvg`, and packaged with macOS `iconutil`.

## Main folders

- `source/` — source SVG, 2048 master, trace assets
- `png/` — transparent and background PNG exports
- `app/macos/` — macOS `.icns` and `.iconset`
- `app/windows/` — Windows `.ico`
- `web/` — favicon/apple/android/site icons
- `social/` — avatars, previews, banners
- `docs/` — brand notes and JSON color spec
