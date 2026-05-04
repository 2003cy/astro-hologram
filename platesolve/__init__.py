from .base import PlateSolver, PlateSolveResult
from .solvers.astrometry_net import AstrometryNetSolver

_SOLVERS = {
    "astrometry_net": AstrometryNetSolver,
}


def create_solver(backend: str, **kwargs) -> PlateSolver:
    """
    Factory that returns a PlateSolver by name.

    Parameters
    ----------
    backend:
        One of the registered solver names (e.g. 'astrometry_net').
    **kwargs:
        Passed directly to the solver's constructor.

    Example
    -------
        solver = create_solver("astrometry_net", api_key="...")
        result = solver.solve(img)
    """
    if backend not in _SOLVERS:
        raise ValueError(f"Unknown solver '{backend}'. Available: {list(_SOLVERS)}")
    return _SOLVERS[backend](**kwargs)


__all__ = [
    "PlateSolver",
    "PlateSolveResult",
    "AstrometryNetSolver",
    "create_solver",
]
