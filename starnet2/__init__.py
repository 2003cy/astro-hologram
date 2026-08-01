"""Local StarNet2 command-line integration."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .extract import ExtractionResult, extract_layers, resolve_starnet2

__all__ = ["ExtractionResult", "extract_layers", "resolve_starnet2"]


def __getattr__(name: str):
    if name in __all__:
        from . import extract

        return getattr(extract, name)
    raise AttributeError(name)
