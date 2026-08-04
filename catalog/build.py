"""High-level plate solve, source detection, and Gaia catalog construction."""

from dataclasses import dataclass
from pathlib import Path
import warnings

import numpy as np
import pandas as pd
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import FITSFixedWarning, WCS
from astropy.wcs.utils import proj_plane_pixel_scales
import astropy.units as u
from PIL import Image

from .detection import SEPDetector, SourceCatalog
from .gaia import crossmatch, query_gaia
from .platesolve import PlateSolveResult, create_solver


@dataclass
class CatalogBuildResult:
    solved_fits_path: Path
    matches_path: Path
    image: np.ndarray
    wcs: WCS
    matches: pd.DataFrame
    source_catalog: SourceCatalog | None = None
    gaia: pd.DataFrame | None = None
    plate_solution: PlateSolveResult | None = None


def load_solved_fits(path: str | Path) -> tuple[np.ndarray, WCS]:
    """Load a plate-solved FITS as an HxW or HxWxC array plus 2D WCS."""
    source = Path(path)
    with fits.open(source) as hdul:
        image = np.asarray(hdul[0].data, dtype=np.float32)
        if image.ndim == 3 and image.shape[0] in (3, 4):
            image = np.transpose(image, (1, 2, 0))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FITSFixedWarning)
            wcs = WCS(hdul[0].header, naxis=2)
    return image, wcs


def write_solved_fits(
    image: np.ndarray,
    wcs: WCS,
    output_path: str | Path,
    overwrite: bool = True,
) -> Path:
    """Write an image and WCS using the channel-first FITS convention."""
    destination = Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    data = np.asarray(image, dtype=np.float32)
    if data.ndim == 3 and data.shape[-1] in (3, 4):
        data = np.transpose(data[..., :3], (2, 0, 1))
    hdu = fits.PrimaryHDU(data=data, header=wcs.to_header())
    hdu.header["SOLVER"] = "Astrometry.net"
    hdu.header["COMMENT"] = "Plate-solved image with WCS information"
    hdu.writeto(destination, overwrite=overwrite)
    return destination


def field_geometry(image: np.ndarray, wcs: WCS) -> tuple[float, float, float, float]:
    """Return center RA/Dec, radius in degrees, and pixel scale in arcsec/pixel."""
    height, width = image.shape[:2]
    center = wcs.pixel_to_world(width / 2, height / 2)
    corners = np.array(
        [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]],
        dtype=float,
    )
    corner_world = wcs.all_pix2world(corners, 0)
    corner_coords = SkyCoord(
        ra=corner_world[:, 0] * u.deg,
        dec=corner_world[:, 1] * u.deg,
    )
    center_coord = SkyCoord(ra=center.ra, dec=center.dec)
    radius = float(center_coord.separation(corner_coords).deg.max())
    pixel_scale = float(np.mean(proj_plane_pixel_scales(wcs)) * 3600)
    return float(center.ra.deg), float(center.dec.deg), radius, pixel_scale


def build_catalog(
    input_path: str | Path,
    solved_fits_path: str | Path,
    matches_path: str | Path,
    *,
    astrometry_api_key: str | None = None,
    reuse_solved: bool = True,
    reuse_matches: bool = True,
    detector: SEPDetector | None = None,
    gaia_radius_factor: float = 1.05,
    max_sep_arcsec: float = 10.0,
    solve_hints: dict | None = None,
) -> CatalogBuildResult:
    """Build or reuse the solved image and matched source catalog."""
    input_path = Path(input_path)
    solved_fits_path = Path(solved_fits_path)
    matches_path = Path(matches_path)
    plate_solution = None

    if reuse_solved and solved_fits_path.is_file():
        image, wcs = load_solved_fits(solved_fits_path)
    else:
        if not astrometry_api_key:
            raise ValueError(
                "astrometry_api_key is required when no reusable solved FITS exists"
            )
        image = np.asarray(Image.open(input_path))
        solver = create_solver("astrometry_net", api_key=astrometry_api_key)
        plate_solution = solver.solve(image, **(solve_hints or {}))
        wcs = plate_solution.wcs
        write_solved_fits(image, wcs, solved_fits_path)

    if reuse_matches and matches_path.is_file():
        matches = pd.read_parquet(matches_path)
        return CatalogBuildResult(
            solved_fits_path=solved_fits_path,
            matches_path=matches_path,
            image=image,
            wcs=wcs,
            matches=matches,
            plate_solution=plate_solution,
        )

    detector = detector or SEPDetector(
        threshold_sigma=3.0,
        fwhm_scale_stellar=20.0,
        max_ellipticity_stellar=0.3,
    )
    source_catalog = detector.detect(image, wcs=wcs)
    ra, dec, radius, pixel_scale = field_geometry(image, wcs)
    gaia = query_gaia(ra, dec, radius=radius * gaia_radius_factor)
    matches = crossmatch(
        source_catalog,
        gaia,
        pixscale=pixel_scale,
        max_sep_arcsec=max_sep_arcsec,
    )
    matches_path.parent.mkdir(parents=True, exist_ok=True)
    matches.to_parquet(matches_path, index=False)

    return CatalogBuildResult(
        solved_fits_path=solved_fits_path,
        matches_path=matches_path,
        image=image,
        wcs=wcs,
        matches=matches,
        source_catalog=source_catalog,
        gaia=gaia,
        plate_solution=plate_solution,
    )
