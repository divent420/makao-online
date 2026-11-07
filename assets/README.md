# Graphics asset structure

The game currently draws cards and tables with CSS. The visual layer is deliberately separated from game rules and network code:

- `index.html` CSS custom properties (`--felt`, `--felt2`, `--table-pattern`, `--back-pattern`, `--card-radius`) control table/card appearance.
- `cardEl()` is the single card-face renderer. Replace its inner markup with an `<img>` or CSS background when a card sprite set is ready.
- `assets/cards/` is reserved for card faces, backs and suit/rank artwork.
- `assets/tables/` is reserved for felt/table textures.

Files in this folder can be loaded at `/assets/<filename>`. Supported image types: PNG, JPG/JPEG, WebP and SVG. Keep filenames lowercase and use descriptive names (for example `ace-of-spades.webp`).
