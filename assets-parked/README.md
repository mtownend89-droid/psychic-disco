# assets-parked

Assets kept in the repo but **deliberately outside `public/`** so they are **not served
or deployed** (Express only serves `public/`, and Render deploys it).

- `*-richie/` — the per-theme Richie character poses extracted from the "Ask Richie" UI
  libraries (~2.5 MB each raster SVG). They are **not wired into any theme** yet; they were
  parked here for when Richie gets animated. When you wire them, either move the folder back
  under `public/theme-assets/` or reference them from `assets-parked/` via a served copy.

The theme ingester (`scripts/theme-from-richie-library.ps1`) writes new Richie poses here.
