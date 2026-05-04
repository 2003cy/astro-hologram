"""
Gaia DR3 catalog query and cross-matching.

Typical usage:
    gaia_df = query_gaia(ra, dec, radius=ps_result.radius * 1.05)
    matches = crossmatch(catalog, gaia_df, pixscale=ps_result.pixscale)
"""

import warnings
from typing import Optional

import numpy as np
import pandas as pd
from astropy.coordinates import SkyCoord
import astropy.units as u
from astroquery.gaia import Gaia

from detect.sep_det import SourceCatalog


_GAIA_COLUMNS = "source_id, ra, dec, phot_g_mean_mag, parallax, pmra, pmdec"

_ADQL = """
SELECT {cols}
FROM gaiadr3.gaia_source
WHERE 1 = CONTAINS(
    POINT('ICRS', ra, dec),
    CIRCLE('ICRS', {ra:.6f}, {dec:.6f}, {radius:.6f})
)
AND phot_g_mean_mag IS NOT NULL
ORDER BY phot_g_mean_mag ASC
""".strip()


def query_gaia(
    ra: float,
    dec: float,
    radius: float,
    row_limit: int = 500_000,
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

    Returns
    -------
    pd.DataFrame
        Columns: source_id, ra, dec, phot_g_mean_mag,
                 parallax, pmra, pmdec.
        Sorted brightest-first.
    """
    query = _ADQL.format(cols=_GAIA_COLUMNS, ra=ra, dec=dec, radius=radius)
    Gaia.ROW_LIMIT = row_limit
    job = Gaia.launch_job_async(query)
    df = job.get_results().to_pandas()

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
    gaia_match_cols = {
        "gaia_source_id": pd.array([], dtype="Int64"),
        "gaia_ra": np.array([]),
        "gaia_dec": np.array([]),
        "gaia_g_mag": np.array([]),
        "gaia_parallax": np.array([]),
        "gaia_pmra": np.array([]),
        "gaia_pmdec": np.array([]),
    }

    # nearest-neighbour match
    matched_gaia: dict[int, dict] = {}  # source index → gaia row info

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
                    gaia_g_mag=float(g["phot_g_mean_mag"]),
                    gaia_parallax=float(g["parallax"]) if g["parallax"] is not None else float("nan"),
                    gaia_pmra=float(g["pmra"])   if g["pmra"]   is not None else float("nan"),
                    gaia_pmdec=float(g["pmdec"]) if g["pmdec"]  is not None else float("nan"),
                )

    # --- assemble rows ---
    _nan_gaia = dict(
        sep_arcsec=float("nan"),
        gaia_matched=False,
        gaia_source_id=pd.NA,
        gaia_ra=float("nan"),
        gaia_dec=float("nan"),
        gaia_g_mag=float("nan"),
        gaia_parallax=float("nan"),
        gaia_pmra=float("nan"),
        gaia_pmdec=float("nan"),
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
