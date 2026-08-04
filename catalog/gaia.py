"""
Gaia DR3 catalog query and cross-matching.

Typical usage:
    gaia_df = query_gaia(ra, dec, radius=ps_result.radius * 1.05)
    matches = crossmatch(catalog, gaia_df, pixscale=ps_result.pixscale)
"""

import io
import warnings
from typing import Optional

import numpy as np
import pandas as pd
import requests
from astropy.coordinates import SkyCoord
from astropy.table import Table
import astropy.units as u

from .detection import SourceCatalog


_GAIA_COLUMNS = """
source_id, ra, dec,
phot_g_mean_mag, phot_bp_mean_mag, phot_rp_mean_mag, bp_rp,
parallax, parallax_error,
pmra, pmra_error, pmdec, pmdec_error,
radial_velocity, radial_velocity_error, ruwe
""".replace("\n", " ")

GAIA_CONE_URL = "https://gaia.ari.uni-heidelberg.de/cone/search"


def query_gaia(
    ra: float,
    dec: float,
    radius: float,
    row_limit: int = 500_000,
    cone_url: str = GAIA_CONE_URL,
    timeout: float = 300.0,
) -> pd.DataFrame:
    """
    Cone-search Gaia DR3 around (ra, dec).

    Parameters
    ----------
    ra, dec:
        Field center in degrees (ICRS).
    radius:
        Search radius in degrees. Pass PlateSolveResult.radius * 1.05 to
        slightly oversize the field and avoid edge clipping.
    row_limit:
        Safety cap on returned rows. A warning is emitted if the result
        hits this limit (TAP truncation may have occurred).
    cone_url:
        Gaia DR3 Simple Cone Search endpoint. Defaults to ARI's mirror.
    timeout:
        HTTP timeout in seconds.

    Returns
    -------
    pd.DataFrame
        Columns include astrometry, proper motion, G/BP/RP photometry,
        radial velocity, and RUWE for the interactive star catalog.
        Sorted brightest-first.
    """
    response = requests.get(
        cone_url,
        params={"RA": ra, "DEC": dec, "SR": radius, "VERB": 2},
        timeout=timeout,
    )
    response.raise_for_status()
    table = Table.read(io.BytesIO(response.content), format="votable")
    df = table.to_pandas()
    selected_columns = [name.strip() for name in _GAIA_COLUMNS.split(",")]
    df = df[selected_columns]
    df = df[df["phot_g_mean_mag"].notna()].sort_values("phot_g_mean_mag")

    if len(df) > row_limit:
        df = df.head(row_limit).copy()

    if len(df) == row_limit:
        warnings.warn(
            f"Gaia query returned exactly {row_limit} rows — TAP limit may have "
            "been hit. Consider reducing the search radius or increasing row_limit.",
            stacklevel=2,
        )

    return df


def crossmatch(
    catalog: SourceCatalog,
    gaia_df: pd.DataFrame,
    pixscale: float,
    max_sep_arcsec: float = 2.0,
) -> pd.DataFrame:
    """
    Cross-match a SourceCatalog against a Gaia DataFrame.

    Parameters
    ----------
    catalog:
        Output of SEPDetector.detect(). Sources need ra/dec set (i.e.
        WCS was provided at detection time); those without are included
        as unmatched rows.
    gaia_df:
        Output of query_gaia().
    pixscale:
        Plate scale in arcsec/pixel (PlateSolveResult.pixscale).
        Used to add a fwhm_arcsec column for convenience.
    max_sep_arcsec:
        Maximum on-sky separation for a valid match.

    Returns
    -------
    pd.DataFrame
        One row per detected source. Gaia columns are NaN for unmatched
        sources. Boolean column gaia_matched indicates match status.
    """
    if len(gaia_df) == 0:
        warnings.warn("Gaia DataFrame is empty — all sources will be unmatched.", stacklevel=2)

    sources_with_coords = [(i, s) for i, s in enumerate(catalog.sources) if s.ra is not None]
    sources_no_coords   = [(i, s) for i, s in enumerate(catalog.sources) if s.ra is None]

    if not sources_with_coords:
        warnings.warn("No sources have ra/dec — was WCS provided to detect()?", stacklevel=2)

    # --- build match arrays ---
    # nearest-neighbour match
    matched_gaia: dict[int, dict] = {}  # source index → gaia row info

    def optional_float(row: pd.Series, name: str) -> float:
        value = row.get(name)
        return float(value) if value is not None and pd.notna(value) else float("nan")

    if sources_with_coords and len(gaia_df) > 0:
        det_ra  = np.array([s.ra  for _, s in sources_with_coords])
        det_dec = np.array([s.dec for _, s in sources_with_coords])
        det_coords  = SkyCoord(ra=det_ra  * u.deg, dec=det_dec  * u.deg)
        gaia_coords = SkyCoord(ra=gaia_df["ra"].values * u.deg,
                               dec=gaia_df["dec"].values * u.deg)

        idx, sep2d, _ = det_coords.match_to_catalog_sky(gaia_coords)
        matched_mask = sep2d.arcsec <= max_sep_arcsec

        if matched_mask.sum() == 0:
            warnings.warn(
                f"No sources matched within {max_sep_arcsec}\". "
                "Check pixscale and that WCS is correct.",
                stacklevel=2,
            )

        for local_i, (src_i, _) in enumerate(sources_with_coords):
            if matched_mask[local_i]:
                g = gaia_df.iloc[idx[local_i]]
                matched_gaia[src_i] = dict(
                    sep_arcsec=float(sep2d[local_i].arcsec),
                    gaia_matched=True,
                    gaia_source_id=int(g["source_id"]),
                    gaia_ra=float(g["ra"]),
                    gaia_dec=float(g["dec"]),
                    gaia_g_mag=optional_float(g, "phot_g_mean_mag"),
                    gaia_bp_mag=optional_float(g, "phot_bp_mean_mag"),
                    gaia_rp_mag=optional_float(g, "phot_rp_mean_mag"),
                    gaia_bp_rp=optional_float(g, "bp_rp"),
                    gaia_parallax=optional_float(g, "parallax"),
                    gaia_parallax_error=optional_float(g, "parallax_error"),
                    gaia_pmra=optional_float(g, "pmra"),
                    gaia_pmra_error=optional_float(g, "pmra_error"),
                    gaia_pmdec=optional_float(g, "pmdec"),
                    gaia_pmdec_error=optional_float(g, "pmdec_error"),
                    gaia_radial_velocity=optional_float(g, "radial_velocity"),
                    gaia_radial_velocity_error=optional_float(g, "radial_velocity_error"),
                    gaia_ruwe=optional_float(g, "ruwe"),
                )

    # --- assemble rows ---
    _nan_gaia = dict(
        sep_arcsec=float("nan"),
        gaia_matched=False,
        gaia_source_id=pd.NA,
        gaia_ra=float("nan"),
        gaia_dec=float("nan"),
        gaia_g_mag=float("nan"),
        gaia_bp_mag=float("nan"),
        gaia_rp_mag=float("nan"),
        gaia_bp_rp=float("nan"),
        gaia_parallax=float("nan"),
        gaia_parallax_error=float("nan"),
        gaia_pmra=float("nan"),
        gaia_pmra_error=float("nan"),
        gaia_pmdec=float("nan"),
        gaia_pmdec_error=float("nan"),
        gaia_radial_velocity=float("nan"),
        gaia_radial_velocity_error=float("nan"),
        gaia_ruwe=float("nan"),
    )

    rows = []
    for i, src in enumerate(catalog.sources):
        base = dict(
            x=src.x, y=src.y,
            flux=src.flux,
            fwhm=src.fwhm,
            fwhm_arcsec=src.fwhm * pixscale,
            ellipticity=src.ellipticity,
            is_stellar=src.is_stellar,
            ra=src.ra,
            dec=src.dec,
        )
        base.update(matched_gaia.get(i, _nan_gaia))
        rows.append(base)

    df = pd.DataFrame(rows)
    df["gaia_source_id"] = df["gaia_source_id"].astype("Int64")
    return df
