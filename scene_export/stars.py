"""Export detected stars as textured sprites and browser catalog records."""

from dataclasses import dataclass
import json
from pathlib import Path

import numpy as np
import pandas as pd
from astropy.io import fits
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales
from PIL import Image


@dataclass
class StarSceneExportResult:
    stars: pd.DataFrame
    atlas: np.ndarray
    star_records: list[dict]
    catalog_records: list[dict]
    atlas_path: Path
    stars_path: Path
    catalog_path: Path
    scene_config_path: Path


DEFAULT_SCENE_CONFIG = {
    "transform": "log10",
    "bg_dist_pc": 2000.0,
    "bg_z_scene": 0.0,
    "depth_coeff": 0.1,
    "no_parallax_dist_factor": 1.2,
    "nebula_transform": "linear",
    "nebula_brightness": 1.0,
    "nebula_opacity": 1.0,
    "camera_roll_deg": 0.0,
    "star_size_scale": 0.4,
    "small_star_protection": True,
    "min_star_core_px": 0.9,
}


def load_scene_config(path: str | Path) -> dict:
    config_path = Path(path)
    if config_path.is_file():
        with config_path.open(encoding="utf-8") as handle:
            return {**DEFAULT_SCENE_CONFIG, **json.load(handle)}
    return dict(DEFAULT_SCENE_CONFIG)


def load_star_rgb(path: str | Path) -> np.ndarray:
    with fits.open(path) as hdul:
        data = np.asarray(hdul[0].data, dtype=np.float32)
    scale = float(data.max()) + 1e-9
    if data.ndim == 3:
        return np.clip(data[:3] / scale, 0.0, 1.0)
    mono = np.clip(data / scale, 0.0, 1.0)
    return np.stack([mono, mono, mono], axis=0)


def extract_cutout(
    rgb: np.ndarray,
    center_x: float,
    center_y: float,
    fwhm: float,
) -> tuple[np.ndarray | None, int]:
    """Extract the same natural-size circular RGBA cutout used by the notebook."""
    half_size = int(min(15, 1.2 * fwhm))
    x0 = int(round(center_x)) - half_size
    x1 = int(round(center_x)) + half_size + 1
    y0 = int(round(center_y)) - half_size
    y1 = int(round(center_y)) + half_size + 1
    if x0 < 0 or y0 < 0 or x1 > rgb.shape[2] or y1 > rgb.shape[1]:
        return None, 0

    patch = np.transpose(rgb[:, y0:y1, x0:x1], (1, 2, 0)).copy()
    patch = (patch - patch.min()) / (patch.max() + 1e-9)
    diameter = 2 * half_size + 1
    rgba = np.array(
        Image.fromarray((patch * 255).astype(np.uint8), mode="RGB").convert("RGBA")
    )
    ys, xs = np.ogrid[:diameter, :diameter]
    radius = np.sqrt((xs - half_size) ** 2 + (ys - half_size) ** 2)
    rgba[:, :, 3] = np.where(radius <= half_size, 255, 0).astype(np.uint8)
    return rgba, diameter


def pack_atlas(
    cutouts: list[tuple[np.ndarray, int]], atlas_width: int = 4096
) -> tuple[np.ndarray, list[int], list[tuple[int, int, int, int]]]:
    atlas = np.zeros((atlas_width, atlas_width, 4), dtype=np.uint8)
    x_cursor = y_cursor = row_height = 0
    placed_indices = []
    placements = []
    order = sorted(range(len(cutouts)), key=lambda index: cutouts[index][1], reverse=True)

    for index in order:
        cutout, diameter = cutouts[index]
        if x_cursor + diameter > atlas_width:
            y_cursor += row_height
            x_cursor = 0
            row_height = 0
        if y_cursor + diameter > atlas_width:
            break
        atlas[y_cursor:y_cursor + diameter, x_cursor:x_cursor + diameter] = cutout
        placed_indices.append(index)
        placements.append((x_cursor, y_cursor, diameter, diameter))
        x_cursor += diameter
        row_height = max(row_height, diameter)

    used_height = y_cursor + row_height
    return atlas[:used_height], placed_indices, placements


def wcs_metadata(
    image_width: int,
    image_height: int,
    candidate_paths: list[str | Path],
) -> tuple[float, dict | None]:
    for candidate in candidate_paths:
        path = Path(candidate)
        if not path.is_file():
            continue
        try:
            with fits.open(path) as hdul:
                header = hdul[0].header
                if "CRVAL1" not in header:
                    continue
                wcs = WCS(header, naxis=2)
            scales = proj_plane_pixel_scales(wcs)
            pixel_scale_arcsec = float(np.mean(scales) * 3600)
            corners = np.array(
                [
                    [0, 0],
                    [image_width - 1, 0],
                    [image_width - 1, image_height - 1],
                    [0, image_height - 1],
                ],
                dtype=float,
            )
            footprint = wcs.all_pix2world(corners, 0)
            metadata = {
                "ctype": [str(value) for value in wcs.wcs.ctype],
                "crval": [float(value) for value in wcs.wcs.crval],
                "crpix": [float(value) for value in wcs.wcs.crpix],
                "pc": [[float(value) for value in row] for row in wcs.wcs.get_pc()],
                "cdelt": [float(value) for value in wcs.wcs.cdelt],
                "radesys": str(wcs.wcs.radesys),
                "equinox": float(wcs.wcs.equinox),
                "footprint": [[float(value) for value in row] for row in footprint],
            }
            return pixel_scale_arcsec, metadata
        except Exception as error:
            print(f"Could not read WCS from {path}: {error}")
    return 1.0, None


def json_number(row: pd.Series, name: str, digits: int | None = None):
    value = row.get(name)
    if value is None or pd.isna(value):
        return None
    number = float(value)
    return round(number, digits) if digits is not None else number


def export_star_scene(
    matches: str | Path | pd.DataFrame,
    star_fits_path: str | Path,
    export_dir: str | Path,
    *,
    solved_fits_path: str | Path | None = None,
    scene_config_path: str | Path | None = None,
    max_stars: int = 16_384,
    crop_fraction: float = 1.0,
    minimum_fwhm: float = 3.5,
    atlas_width: int = 4096,
) -> StarSceneExportResult:
    """Export the star atlas, render records, Gaia catalog, and scene config."""
    matches_df = (
        pd.read_parquet(matches) if isinstance(matches, (str, Path)) else matches.copy()
    )
    star_fits_path = Path(star_fits_path)
    destination = Path(export_dir)
    destination.mkdir(parents=True, exist_ok=True)
    scene_config_path = Path(scene_config_path or destination / "scene_config.json")
    scene_config = load_scene_config(scene_config_path)
    star_rgb = load_star_rgb(star_fits_path)
    image_height, image_width = star_rgb.shape[1:]
    center_x, center_y = image_width / 2, image_height / 2

    matched = matches_df.get("gaia_matched", False)
    has_parallax = (
        matched.astype(bool)
        & matches_df["gaia_parallax"].notna()
        & (matches_df["gaia_parallax"] > 0)
    )
    matches_df["dist_pc"] = np.nan
    matches_df.loc[has_parallax, "dist_pc"] = (
        1000.0 / matches_df.loc[has_parallax, "gaia_parallax"]
    )
    matches_df["x_scene"] = matches_df["x"] - center_x
    matches_df["y_scene"] = -(matches_df["y"] - center_y)

    x_low = center_x - crop_fraction * image_width / 2
    x_high = center_x + crop_fraction * image_width / 2
    y_low = center_y - crop_fraction * image_height / 2
    y_high = center_y + crop_fraction * image_height / 2
    stars = matches_df[
        matches_df["is_stellar"]
        & matches_df["x"].between(x_low, x_high)
        & matches_df["y"].between(y_low, y_high)
        & (matches_df["fwhm"] >= minimum_fwhm)
    ].copy()
    stars = stars.sort_values("flux", ascending=False).head(max_stars).reset_index(drop=True)

    cutouts = []
    valid_indices = []
    for index, row in stars.iterrows():
        cutout, diameter = extract_cutout(
            star_rgb, row["x"], row["y"], row["fwhm"]
        )
        if cutout is not None:
            cutouts.append((cutout, diameter))
            valid_indices.append(index)
    stars = stars.loc[valid_indices].reset_index(drop=True)
    if not cutouts:
        raise ValueError("No valid stellar cutouts were available for export")

    atlas, placed_indices, placements = pack_atlas(cutouts, atlas_width=atlas_width)
    stars = stars.iloc[placed_indices].reset_index(drop=True)
    stars[["px_x", "px_y", "px_w", "px_h"]] = pd.DataFrame(
        placements, index=stars.index
    )
    atlas_path = destination / "stars_atlas.png"
    Image.fromarray(atlas, mode="RGBA").save(atlas_path)

    candidates = [star_fits_path]
    if solved_fits_path is not None:
        candidates.append(Path(solved_fits_path))
    pixel_scale_arcsec, grid_wcs = wcs_metadata(
        image_width, image_height, candidates
    )
    render_records = []
    catalog_records = []
    for star_index, (_, row) in enumerate(stars.iterrows()):
        star_id = f"star-{star_index:06d}"
        distance = json_number(row, "dist_pc", 1)
        g_magnitude = json_number(row, "gaia_g_mag", 3)
        render_records.append(
            {
                "id": star_id,
                "x": round(float(row["x_scene"]), 3),
                "y": round(float(row["y_scene"]), 3),
                "dist_pc": distance,
                "px_x": int(row["px_x"]),
                "px_y": int(row["px_y"]),
                "px_w": int(row["px_w"]),
                "px_h": int(row["px_h"]),
                "flux": round(float(row["flux"]), 1),
                "fwhm": round(float(row["fwhm"]), 2),
                "g_mag": g_magnitude,
            }
        )
        source_id = row.get("gaia_source_id")
        gaia = None
        if bool(row.get("gaia_matched", False)) and pd.notna(source_id):
            gaia = {
                "source_id": str(int(source_id)),
                "ra_deg": json_number(row, "gaia_ra", 8),
                "dec_deg": json_number(row, "gaia_dec", 8),
                "g_mag": json_number(row, "gaia_g_mag", 4),
                "bp_mag": json_number(row, "gaia_bp_mag", 4),
                "rp_mag": json_number(row, "gaia_rp_mag", 4),
                "bp_rp": json_number(row, "gaia_bp_rp", 4),
                "parallax_mas": json_number(row, "gaia_parallax", 6),
                "parallax_error_mas": json_number(row, "gaia_parallax_error", 6),
                "pmra_mas_yr": json_number(row, "gaia_pmra", 6),
                "pmra_error_mas_yr": json_number(row, "gaia_pmra_error", 6),
                "pmdec_mas_yr": json_number(row, "gaia_pmdec", 6),
                "pmdec_error_mas_yr": json_number(row, "gaia_pmdec_error", 6),
                "radial_velocity_km_s": json_number(row, "gaia_radial_velocity", 4),
                "radial_velocity_error_km_s": json_number(
                    row, "gaia_radial_velocity_error", 4
                ),
                "ruwe": json_number(row, "gaia_ruwe", 4),
                "match_sep_arcsec": json_number(row, "sep_arcsec", 4),
            }
        catalog_records.append(
            {
                "id": star_id,
                "detection": {
                    "image_x": round(float(row["x"]), 3),
                    "image_y": round(float(row["y"]), 3),
                    "ra_deg": json_number(row, "ra", 8),
                    "dec_deg": json_number(row, "dec", 8),
                    "flux": round(float(row["flux"]), 2),
                    "fwhm_px": round(float(row["fwhm"]), 3),
                    "ellipticity": json_number(row, "ellipticity", 5),
                },
                "gaia": gaia,
                "derived": {"distance_pc": distance},
            }
        )

    stars_path = destination / "stars.json"
    catalog_path = destination / "star_catalog.json"
    metadata = {
        "atlas": atlas_path.name,
        "catalog": catalog_path.name,
        "img_cx": center_x,
        "img_cy": center_y,
        "img_w": image_width,
        "img_h": image_height,
    }
    with stars_path.open("w", encoding="utf-8") as handle:
        json.dump({"meta": metadata, "stars": render_records}, handle, separators=(",", ":"))
    with catalog_path.open("w", encoding="utf-8") as handle:
        json.dump({"stars": catalog_records}, handle, separators=(",", ":"))

    scene_config.update(
        {
            "pixel_scale_arcsec": round(pixel_scale_arcsec, 6),
            "img_w": image_width,
            "wcs": grid_wcs,
        }
    )
    with scene_config_path.open("w", encoding="utf-8") as handle:
        json.dump(scene_config, handle, indent=2)

    return StarSceneExportResult(
        stars=stars,
        atlas=atlas,
        star_records=render_records,
        catalog_records=catalog_records,
        atlas_path=atlas_path,
        stars_path=stars_path,
        catalog_path=catalog_path,
        scene_config_path=scene_config_path,
    )
