# Theme skins — plug-and-play UI libraries

Wire a theme's SVG asset library (a ZIP) into the app so a theme gets a full-border
**frame** and **themed controls** (buttons, toggles, inputs, checkbox/radio, segmented
tabs, badges).

## Add / update a theme from a ZIP

```powershell
pwsh scripts/build-theme-skin.ps1 -Zip "C:\path\to\my-theme-ui-library.zip" -ThemeId slime
```

- `-ThemeId` is the theme's id in `THEME_PRESETS` (e.g. `slime`, `galaxy`, `merlot`).
- Re-running replaces that theme's existing entry, so it's safe to iterate.

## What the ZIP must contain

Same shape as `ask-richie-slime-ui-library.zip`:

- `*-symbols.svg` — an SVG whose `<defs>` holds shared gradients/filters/primitives,
  followed by `<symbol id="...">` components.
- `component-map.json` (optional) — a `tokens` object; `text` and `outline` colors are
  used for control label colors.

Standard symbol ids it looks for (missing ones are skipped):

```
slime-frame  button-secondary  button-primary  button-danger
toggle-off   toggle-on         input-field
checkbox-empty  checkbox-checked  radio-selected
tab-inactive tab-active         badge            slime-panel
```

## How it works

The script converts each symbol into a self-contained `data:` URI (its markup + the
library's shared `<defs>`) and writes `THEME_SKINS.<themeId> = { frame:…, controls:… };`
into `public/theme-skins.js` at the `/*__THEME_SKINS__*/` marker. That file is loaded
before `app.js` (via a `<script>` tag in `index.html`) and defines the global
`THEME_SKINS` the app reads. Frame/panel symbols are theme-prefixed (`<id>-frame`,
`<id>-panel`); control ids are generic.

At runtime `_applyThemeSkin(themeId)` (called from `applyThemeFx`) reads that entry and
injects scoped CSS (`body.fx-<theme> …`) — filled controls use stretched background art,
the frame uses `border-image`. It clears when the theme's animations are turned off or under
reduced-motion. No build step; the generated `THEME_SKINS` is plain data in `app.js`.
