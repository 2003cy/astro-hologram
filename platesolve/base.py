from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional

import numpy as np
from astropy.wcs import WCS
from dataclasses import dataclass
from PIL import Image


@dataclass
class PlateSolveResult:
    wcs: WCS
    ra: float        # degrees, center of field
    dec: float       # degrees, center of field
    orientation: float  # degrees E of N
    pixscale: float  # arcsec/pixel
    radius: float    # field radius, degrees

    def __repr__(self) -> str:
        return (
            f"PlateSolveResult(ra={self.ra:.4f}°, dec={self.dec:.4f}°, "
            f"orientation={self.orientation:.2f}°, pixscale={self.pixscale:.3f}\"/px)"
        )


class PlateSolver(ABC):
    """
    Common interface for all plate solvers.

    Subclasses implement `solve(image, **hints) -> PlateSolveResult`.
    Hints are solver-specific kwargs (scale, position priors, etc.) and
    are always keyword-only so callers can ignore ones they don't need.
    """

    @abstractmethod
    def solve(self, image: np.ndarray, **hints) -> PlateSolveResult:
        """
        Parameters
        ----------
        image:
            numpy array, shape (H, W) or (H, W, 3). Any numeric dtype —
            implementations are responsible for normalising to uint8.
        **hints:
            Solver-specific keyword arguments (e.g. scale_lower, center_ra).
        """

    def solve_file(self, path: str | Path, **hints) -> PlateSolveResult:
        img = np.array(Image.open(path))
        return self.solve(img, **hints)
