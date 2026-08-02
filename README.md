# Astro Hologram

Astrophotography pipeline: plate solve a star field → detect sources → cross-match Gaia catalog → build a 3D sprite scene → display as a hologram on Looking Glass.

```
Image (.PNG)
  └─► Plate solve (astrometry.net)  → WCS
        └─► Source detection (SEP)  → catalog
              └─► Gaia DR3 crossmatch → distances (parallax)
                    └─► Distance transform (log10)
                          └─► Sprite atlas + stars.json
                                └─► Three.js scene → Looking Glass hologram
```

---

## Prerequisites

| Tool | Purpose |
|------|---------|
| [pixi](https://pixi.sh) | Python environment + task runner |
| Node.js ≥ 18 | Three.js dev server |
| Chrome (windowed) | Looking Glass WebXR |
| [HoloPlay Bridge](https://lookingglassfactory.com/software/holoplay-bridge) | Looking Glass driver |

---

## Setup

```bash
# 1. Install Python environment
pixi install

# 2. Register Jupyter kernel
pixi run register-kernel
```

Create a `.env` file in the project root with your astrometry.net API key:

```
ASTROMETRY_API_KEY=your_key_here
```

Get a free key at https://nova.astrometry.net/api_help

---

## Project Structure

```
astro-hologram/
├── platesolve/                 # Plate solving abstraction
│   ├── base.py                 #   PlateSolver ABC + PlateSolveResult dataclass
│   ├── __init__.py             #   create_solver() factory
│   └── solvers/
│       └── astrometry_net.py   #   Astrometry.net Nova API backend
│
├── detect/                     # Source detection
│   ├── sep_det.py              #   SEPDetector, Source, SourceCatalog
│   └── __init__.py
│
├── catalog/                    # Gaia catalog query + crossmatch
│   ├── gaia.py                 #   query_gaia(), crossmatch()
│   └── __init__.py
│
├── threejs/                    # 3D visualization (Vite + Three.js)
│   ├── package.json
│   ├── vite.config.js          #   serves repo root as publicDir
│   ├── index.html
│   └── src/
│       ├── main.js             #   scene, camera, Looking Glass polyfill
│       └── starfield.js        #   sprite atlas loader, nebula plane
│
├── test_platesolve.ipynb       # Step 1: solve image → FITS with WCS
├── test_detection.ipynb        # Step 2: detect sources → data/matches.parquet
├── distance_transform.ipynb    # Step 3: explore distance mappings (log10 chosen)
├── export_stars.ipynb          # Step 4: export sprite atlas + stars.json + nebula
├── test_depth.ipynb            # Nebula preprocessing → linear signal + metadata
│
├── data/                       # Images, astronomy data, and generated assets
│   ├── test.PNG                #   source sky image
│   ├── test_solved*.fits       #   solved, star-only, and nebula FITS data
│   ├── matches.parquet         #   cached Gaia crossmatch output
│   └── export/                 #   Three.js stars, nebula, and scene config
├── pixi.toml                   # Environment + tasks
├── run-threejs.py              # Cross-platform Three.js dev launcher
├── run-threejs.cmd             # Windows convenience launcher
└── .env                        # API keys (not committed)
```

---

## Pipeline — Step by Step

### Step 1 — Plate solve

Open `test_platesolve.ipynb`. It submits the image to astrometry.net and saves a FITS file with WCS headers.

```bash
pixi run lab   # or: pixi run notebook
```

Outputs:
- `data/test_solved.fits` — original image with WCS
- `data/test_solved_star.fits` — star-only version (processed externally with StarNet)

The solver is accessed through the `platesolve` package:

```python
from platesolve import create_solver

solver = create_solver("astrometry_net", api_key="...")
result = solver.solve(img)
# result.wcs, result.ra, result.dec, result.pixscale, result.radius
```

### Step 2 — Source detection + Gaia crossmatch

Open `test_detection.ipynb`. Detects all sources with SEP, queries Gaia DR3, cross-matches by on-sky separation (≤ 2 arcsec), and saves the result.

```python
from detect import SEPDetector
from catalog import query_gaia, crossmatch

detector = SEPDetector(threshold_sigma=3.0)
catalog  = detector.detect(img, wcs=wcs)         # wcs must be 2D

gaia_df  = query_gaia(ra, dec, radius=0.75)
matches  = crossmatch(catalog, gaia_df, pixscale=2.697)
matches.to_parquet("data/matches.parquet")
```

`data/matches.parquet` columns: `x, y, flux, fwhm, fwhm_arcsec, ellipticity, is_stellar, ra, dec, sep_arcsec, gaia_matched, gaia_source_id, gaia_ra, gaia_dec, gaia_g_mag, gaia_parallax, gaia_pmra, gaia_pmdec`

Results for this field (M31 area, ~0.75° radius):
- 20,130 detected sources
- 7,243 with Gaia parallax → true distance `d = 1000 / parallax_mas` pc
- 12,887 without → placed at background distance (5,000 pc)

### Step 3 — Distance transform exploration

Open `distance_transform.ipynb` to compare how different functions map `d_real (pc) → d_scene`.

Eight transforms are compared (linear, sqrt, cbrt, log10, d^0.3, d^0.2, arctan, hyperbolic). **log10** was chosen as the default — it gives a good spread across the 36–1,097,319 pc range.

3D scene coordinate system:
```
X = x_pixel − img_cx      (image left→right)
Y = log10(dist_pc)         (depth, into screen)
Z = −(y_pixel − img_cy)   (image bottom→top, north up)
```

### Step 4 — Export sprite atlas

Open `export_stars.ipynb`. Extracts star cutouts from `data/test_solved_star.fits`, packs them into a sprite atlas, and writes the Three.js-ready assets.

```bash
pixi run lab
# run export_stars.ipynb top to bottom
```

Per-star cutout process:
1. Half-size: `max(16, 3 × fwhm)` pixels
2. Normalize per-star: `(cutout − min) / (max + ε)`
3. Resize to 32 × 32 px via LANCZOS

Atlas layout: `⌈√N⌉ × ⌈√N/⌈√N⌉⌉` grid, up to 16,384 stars.

Outputs in `data/export/`:

| File | Description |
|------|-------------|
| `stars_atlas.png` | Grayscale sprite grid (≤ 4096 × 4096 px) |
| `stars.json` | Per-star positions, UV coords, flux, fwhm, G-mag |
| `nebula.png` | Background nebula = original − star-only |

`stars.json` structure:
```json
{
  "meta": {
    "atlas": "stars_atlas.png",
    "sprite_size": 32,
    "atlas_cols": 128,
    "atlas_rows": 128,
    "du": 0.0078125,
    "dv": 0.0078125,
    "transform": "log10",
    "img_cx": 1500.0,
    "img_cy": 1500.0,
    "bg_dist_pc": 5000,
    "bg_y_scene": 3.699
  },
  "stars": [
    { "x": 512.3, "y": 3.27, "z": 158.3, "u": 0.0, "v": 0.0,
      "flux": 184234.0, "fwhm": 14.2, "g_mag": 8.6 }
  ]
}
```

### Step 5 — 3D visualization

```bash
pixi run threejs-dev
# installs npm packages + opens http://127.0.0.1:4173
```

The Three.js scene:
- **Stars** — one `THREE.Sprite` per star, atlas UV offset per sprite, size ∝ `flux^0.3`
- **Nebula preprocessing (Python)** — `test_depth.ipynb` fits/subtracts the background, isolates the nebula signal, smooths it, and exports `nebula_signal.png` plus histogram metadata
- **Nebula depth (Three.js)** — the vertex shader transforms that signal at runtime; linear, sqrt, cbrt, log, power², and threshold mappings can be selected without re-exporting Python data
- **Adaptive coordinate grid (Three.js)** — optional FK5/J2000 RA, Dec, and pc/kpc grid generated from the solved FITS TAN WCS; sightlines rebuild with the selected star distance and XY transforms
- **Controls** — OrbitControls for mouse drag / scroll in browser
- **Looking Glass** — `LookingGlassWebXRPolyfill` + `VRButton`; click the VR button, drag the popup to the Looking Glass display, double-click to go fullscreen

Looking Glass requirements (Mac):
- Chrome in windowed mode (not fullscreen)
- HoloPlay Bridge running in background
- Looking Glass Portrait or Pro connected via USB-C

---

## pixi Tasks

```bash
pixi run notebook         # launch Jupyter Notebook
pixi run lab              # launch JupyterLab
pixi run register-kernel  # install Python kernel for Jupyter
pixi run threejs-dev      # npm install + vite dev server
pixi run threejs-build    # production build
```

---

## Key Implementation Notes

**WCS dimensionality** — astrometry.net returns a header-only FITS (`NAXIS=0`). Always load with `WCS(header, naxis=2)` to force 2D interpretation; omitting `naxis=2` causes `WCS projection has 0 dimensions` errors.

**Sprite UV flip** — PIL/numpy atlases have `y=0` at the top; Three.js textures have `y=0` at the bottom. The UV vertical coordinate is flipped in `starfield.js`: `v_gl = 1 − v − dv`.

**Gaia parallax distances** — parallax can be negative (unphysical) or very large (nearby stars). Negative parallax sources are treated as no-parallax and placed at the background distance. The raw `1000/parallax` formula is used without Bayesian correction — sufficient for visualization.
