from dataclasses import dataclass
from typing import Optional

import numpy as np
import sep
from astropy.wcs import WCS


@dataclass
class Source:
    x: float
    y: float
    flux: float
    fwhm: float          # pixels
    ellipticity: float   # 0 = circular, 1 = infinitely elongated
    is_stellar: bool
    ra: Optional[float] = None   # degrees, set when WCS is provided
    dec: Optional[float] = None


@dataclass
class SourceCatalog:
    sources: list[Source]
    psf_fwhm: float      # estimated PSF FWHM in pixels

    @property
    def stars(self) -> list[Source]:
        return [s for s in self.sources if s.is_stellar]

    @property
    def extended(self) -> list[Source]:
        return [s for s in self.sources if not s.is_stellar]

    def __len__(self) -> int:
        return len(self.sources)

    def __repr__(self) -> str:
        return (
            f"SourceCatalog({len(self.sources)} sources: "
            f"{len(self.stars)} stellar, {len(self.extended)} extended, "
            f"psf_fwhm={self.psf_fwhm:.2f}px)"
        )


class SEPDetector:
    """
    Parameters
    ----------
    threshold_sigma:
        Detection threshold in units of background RMS.
    box_size:
        Background estimation tile size in pixels.
    fwhm_scale_stellar:
        Source is stellar if fwhm < psf_fwhm * this factor.
    max_ellipticity_stellar:
        Source is stellar only if ellipticity < this value.
    minarea:
        Minimum connected pixels to count as a detection.
    """

    def __init__(
        self,
        threshold_sigma: float = 3.0,
        box_size: int = 64,
        fwhm_scale_stellar: float = 1.5,
        max_ellipticity_stellar: float = 0.3,
        minarea: int = 5,
    ):
        self.threshold_sigma = threshold_sigma
        self.box_size = box_size
        self.fwhm_scale_stellar = fwhm_scale_stellar
        self.max_ellipticity_stellar = max_ellipticity_stellar
        self.minarea = minarea

    def detect(self, image: np.ndarray, wcs: Optional[WCS] = None) -> SourceCatalog:
        data = self._prepare(image)

        bkg = sep.Background(data, bw=self.box_size, bh=self.box_size)
        data_sub = data - bkg.back()

        objects = sep.extract(
            data_sub,
            thresh=self.threshold_sigma,
            err=bkg.globalrms,
            minarea=self.minarea,
        )

        if len(objects) == 0:
            return SourceCatalog(sources=[], psf_fwhm=0.0)

        fwhms = 2.35 * np.sqrt(objects["a"] * objects["b"])
        ellips = 1.0 - objects["b"] / objects["a"]

        round_mask = ellips < 0.2
        sample = fwhms[round_mask] if round_mask.sum() >= 3 else fwhms
        psf_fwhm = float(np.percentile(sample, 20))
        stellar_fwhm_limit = psf_fwhm * self.fwhm_scale_stellar

        sources = []
        for i in range(len(objects)):
            fwhm = float(fwhms[i])
            ellip = float(ellips[i])
            src = Source(
                x=float(objects["x"][i]),
                y=float(objects["y"][i]),
                flux=float(objects["flux"][i]),
                fwhm=fwhm,
                ellipticity=ellip,
                is_stellar=fwhm <= stellar_fwhm_limit and ellip < self.max_ellipticity_stellar,
            )
            if wcs is not None:
                sky = wcs.pixel_to_world(src.x, src.y)
                src.ra = float(sky.ra.deg)
                src.dec = float(sky.dec.deg)
            sources.append(src)

        return SourceCatalog(sources=sources, psf_fwhm=psf_fwhm)

    @staticmethod
    def _prepare(image: np.ndarray) -> np.ndarray:
        img = image.astype(np.float64)
        if img.ndim == 3:
            img = 0.2126 * img[..., 0] + 0.7152 * img[..., 1] + 0.0722 * img[..., 2]
        return np.ascontiguousarray(img)
