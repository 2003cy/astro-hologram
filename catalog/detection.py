"""SEP-based astronomical source detection."""

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
    fwhm: float
    ellipticity: float
    is_stellar: bool
    ra: Optional[float] = None
    dec: Optional[float] = None


@dataclass
class SourceCatalog:
    sources: list[Source]
    psf_fwhm: float

    @property
    def stars(self) -> list[Source]:
        return [source for source in self.sources if source.is_stellar]

    @property
    def extended(self) -> list[Source]:
        return [source for source in self.sources if not source.is_stellar]

    def __len__(self) -> int:
        return len(self.sources)

    def __repr__(self) -> str:
        return (
            f"SourceCatalog({len(self.sources)} sources: "
            f"{len(self.stars)} stellar, {len(self.extended)} extended, "
            f"psf_fwhm={self.psf_fwhm:.2f}px)"
        )


class SEPDetector:
    """Detect and classify image sources with SEP."""

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
        background = sep.Background(data, bw=self.box_size, bh=self.box_size)
        objects = sep.extract(
            data - background.back(),
            thresh=self.threshold_sigma,
            err=background.globalrms,
            minarea=self.minarea,
        )

        if len(objects) == 0:
            return SourceCatalog(sources=[], psf_fwhm=0.0)

        fwhms = 2.35 * np.sqrt(objects["a"] * objects["b"])
        ellipticities = 1.0 - objects["b"] / objects["a"]
        round_mask = ellipticities < 0.2
        sample = fwhms[round_mask] if round_mask.sum() >= 3 else fwhms
        psf_fwhm = float(np.percentile(sample, 20))
        stellar_fwhm_limit = psf_fwhm * self.fwhm_scale_stellar

        sources = []
        for index in range(len(objects)):
            fwhm = float(fwhms[index])
            ellipticity = float(ellipticities[index])
            source = Source(
                x=float(objects["x"][index]),
                y=float(objects["y"][index]),
                flux=float(objects["flux"][index]),
                fwhm=fwhm,
                ellipticity=ellipticity,
                is_stellar=(
                    fwhm <= stellar_fwhm_limit
                    and ellipticity < self.max_ellipticity_stellar
                ),
            )
            if wcs is not None:
                sky = wcs.pixel_to_world(source.x, source.y)
                source.ra = float(sky.ra.deg)
                source.dec = float(sky.dec.deg)
            sources.append(source)

        return SourceCatalog(sources=sources, psf_fwhm=psf_fwhm)

    @staticmethod
    def _prepare(image: np.ndarray) -> np.ndarray:
        prepared = image.astype(np.float64)
        if prepared.ndim == 3:
            prepared = (
                0.2126 * prepared[..., 0]
                + 0.7152 * prepared[..., 1]
                + 0.0722 * prepared[..., 2]
            )
        return np.ascontiguousarray(prepared)
