# Theme skins — how to add / adapt a theme

The theme-skin system lets a theme replace the app's chrome (widget frames, buttons, toggles,
slider, modals, ambient FX) with artwork, driven entirely by data. Three pieces:

1. **`public/app.js` → `_applyThemeSkin(themeId)`** — the generic applier. Reads `THEME_SKINS[themeId]`
   and injects scoped CSS (`body.fx-<id> …`) into `<style id="_themeSkin">`. **This is the only place
   that knows how to render a skin — you rarely edit it; you feed it data.**
2. **`public/theme-skins.js` → `THEME_SKINS[id] = {…}`** — the per-theme data (art URLs + flags).
   Loaded before `app.js`. Entries are inserted at the `/*__THEME_SKINS__*/` marker.
3. **`public/app.js` → `THEME_PRESETS` + `THEME_FX`** — registers the theme so it's selectable
   (colors) and gives it drifting ambient (count/size/anim).

Adding a theme = produce the art (ingest a library **or** hand-author SVGs), write a `THEME_SKINS`
entry, and add a `THEME_PRESETS` + `THEME_FX` line. No new applier code for the common cases.

---

## The `THEME_SKINS[id]` schema

```js
THEME_SKINS.mytheme = {
  // ── Frame (9-slice border-image) ──
  frame:     { url, slice, repeat:'stretch', width, outset:0, bleed:0, glow:0, glowColor },
  frameHalf: { … },          // optional: half-width (:not(.span-2)) widgets; else `frame` is used for both
  frameFront: true,          // draw the frame ON TOP via ::after so corners/glow aren't clipped by the widget view
                             //   (card→overflow:visible, body→overflow:hidden). Use with `outset`/`glow`.

  // ── Top-edge decorations (alternative to a wrapping frame) ──
  controls: {
    topDrip:     { url },    // full-width strip across the top of .span-2 widgets (or ALL widgets if no corners)
    cornerLeft:  { url },    // top-left corner piece on non-span-2 widgets
    cornerRight: { url },    // top-right corner piece
    pageHeader:  { url },    // stretched across the app's top bar (#topbar), not the widgets

    // ── Controls (each { url, text?, filter? }) ──
    btn: {url,text}, btnPrimary:{url,text}, btnDanger:{url,text,filter},   // filter e.g. "hue-rotate(105deg) saturate(1.5)"
    toggleOff:{url}, toggleOn:{url},
    input:{url}, checkboxEmpty:{url}, checkboxChecked:{url}, radioSelected:{url},
    tabInactive:{url}, tabActive:{url},          // segmented .pl-gbtn
    badge:{url,text},                             // small .txf-tag chip
    panel:{url},                                  // pop-out modal / dialog background
    chatRichie:{url,text},                        // Richie's speech bubble
    sliderThumb:{url},                            // range thumb (track = accent gradient); also skins .zb-slider
  },

  // ── Layout flags ──
  centerTitle: true,          // centre the widget title; drag handle + actions go to the corners
  titleInFrame: 24,           // lift the centred title UP into the frame's top cartouche (px)
  titleBar: true,             // angular clipped-corner header + accent underline + faint gradient
  dividers: true,             // thin accent rule under in-widget section headers

  // ── Ambient ──
  emoji: [url, url, …],       // drifting FX images; falls back to THEME_FX[id].emojis (text) if omitted
};
```

**`slice` / `width` can be a number (uniform) or a `"top right bottom left"` string** (per-side 9-slice —
use this so an ornate top/bottom is sliced separately from thin sides, e.g. princess `slice:"85 30 46 30"`,
`width:"60 22 34 22"`). `bleed` (numeric only) makes `border-image-width > border-width` so the frame
overhangs inward onto content.

### Register it (always)

`public/app.js`:
```js
// THEME_PRESETS (near line ~4118) — id, name, bg/sidebar/surface*/text/muted/border*/accent, light:true for light bg
{id:'mytheme',name:'My Theme',bg:'#03080f',…,accent:'#34e7ff'},
// THEME_FX (near line ~4183) — ambient
mytheme: {emojis:['◈','▹'], anim:'drift', count:6, size:[12,22], op:0.5, dur:[14,30]},
```

---

## Workflow A — ingest an "Ask Richie" library ZIP

Use **`scripts/theme-from-richie-library.ps1`** (edit `$zip`, `$theme`, `$tokens`, run it). All the
"Ask Richie" ZIPs share one 5-file template (`*-symbols.svg`, `component-map.json`, `demo.html`, …) with
the same `symbol-*` (or bare) ids, so themes are interchangeable — one run wires the whole theme.

Then add the `THEME_PRESETS` + `THEME_FX` lines. If the old inline entry existed, the script replaces it.

## Workflow B — hand-author a geometric theme (no ZIP)

Use **`scripts/theme-tron-geometric.ps1`** as the template: it writes compact hand-built SVGs to
`public/theme-assets/<theme>/` and assembles the `THEME_SKINS` entry. Simplest backend for clean vector
styles (HUD/Tron, minimalist, etc.). Edit the SVG strings + palette, run it.

---

## Gotchas (all learned the hard way — don't relitigate)

- **SVG used as `border-image` MUST have explicit `width`/`height`** (not just `viewBox`), or the browser
  misreads the slice unit and garbles the 9-slice into stretched triangles. (Ask-Richie frames embed a
  raster so they have intrinsic size; hand-built vector frames need `width=… height=…` added.)
- **Ask-Richie art is an opaque JPEG on a baked black background** (`#000`/`#050505` "Base Metal" layer +
  an undefined-class `hit-area` rect that defaults to black). There's no silhouette mask, so strip the
  background with a **luminance-key filter** (near-black → transparent). The ingester bakes this in
  (`dropblk` filter). Verify with an alpha probe: full-box opacity should drop below 1.0.
- **Shared `<defs>`:** extract content between `<defs>` and the **first `</defs>`** — NOT up to the first
  `<symbol>`. This family closes defs long before the symbols; the naive grab pulls ~300 KB of junk and
  the art won't parse.
- **Baked-in button labels:** some libraries render "Cancel/Save/Delete" INTO the button art. Probe the
  centre ink density (blank ≈ 0, labelled ≈ 8–17). If labelled, repoint `btn/btnPrimary/btnDanger` to the
  blank input bar and tint danger via `filter:"hue-rotate(…)"`. If the library is textless (grep for
  `<text>` in vector art = none), use the real coloured buttons.
- **`preserveAspectRatio="none"`** on a served SVG lets `background-size:100% 100%` truly stretch it
  full-width (default `meet` letterboxes → a centred blob).
- **Overflow:** a card's own `overflow:hidden` does NOT clip its own `border-image`/outset, but an ancestor
  can. To draw the frame ON TOP and let corners/glow spill, use `frameFront` (card `overflow:visible` +
  body `overflow:hidden` so content still can't spill). `titleInFrame` uses the same trick to put the title
  in the top border.
- **Absolute `inset` is measured from the padding box**, so a frame `::after` needs `inset:-(width+outset)`
  to reach the border-box outer edge + outset.
- **Per-side slice** stops thin side art being stretched into fat blurry columns and keeps tall tops from
  squashing — reach for the `"T R B L"` string whenever the frame is asymmetric.
- **Richie character poses** are huge (~2.5 MB raster each) — keep them in a separate
  `theme-assets/<theme>-richie/` folder, unwired, for lazy loading later.
- **Validate** after every change: `new Function(code)` over `public/app.js` + `public/theme-skins.js`
  (both must parse), and `DOMParser` over a few served SVGs (no `parsererror`).
```
