"""Plate-solving interfaces and registered backends."""

from .astrometry_net import AstrometryNetSolver
from .base import PlateSolver, PlateSolveResult


_SOLVERS = {"astrometry_net": AstrometryNetSolver}


def create_solver(backend: str, **kwargs) -> PlateSolver:
    if backend not in _SOLVERS:
        raise ValueError(f"Unknown solver {backend!r}. Available: {list(_SOLVERS)}")
    return _SOLVERS[backend](**kwargs)


__all__ = [
    "PlateSolver",
    "PlateSolveResult",
    "AstrometryNetSolver",
    "create_solver",
]
