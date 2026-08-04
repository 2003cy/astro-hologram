"""Shared interfaces for plate-solving backends."""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from astropy.wcs import WCS
from PIL import Image


@dataclass
class PlateSolveResult:
    wcs: WCS
    ra: float
    dec: float
    orientation: float
    pixscale: float
    radius: float

    def __repr__(self) -> str:
        return (
            f"PlateSolveResult(ra={self.ra:.4f} deg, dec={self.dec:.4f} deg, "
            f"orientation={self.orientation:.2f} deg, "
            f"pixscale={self.pixscale:.3f} arcsec/px)"
        )


class PlateSolver(ABC):
    """Common interface implemented by all plate-solving backends."""

    @abstractmethod
    def solve(self, image: np.ndarray, **hints) -> PlateSolveResult:
        """Solve an HxW or HxWxC image and return its WCS calibration."""

    def solve_file(self, path: str | Path, **hints) -> PlateSolveResult:
        return self.solve(np.array(Image.open(path)), **hints)
