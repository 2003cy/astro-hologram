"""Extract star and nebula layers with the locally installed StarNet2 CLI."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np
from astropy.io import fits


WINDOWS_INSTALL_CANDIDATES = (
    Path(r"J:\StarNet2\bin\starnet2.exe"),
    Path(r"C:\Program Files\StarNet2\bin\starnet2.exe"),
)


@dataclass(frozen=True)
class ExtractionResult:
    """Paths produced by a StarNet2 extraction run."""

    input_path: Path
    nebula_path: Path
    stars_path: Path
    unscreen_path: Path | None
    executable: Path
    command: tuple[str, ...]
    input_scale: float


def resolve_starnet2(executable: str | os.PathLike[str] | None = None) -> Path:
    """Resolve StarNet2 from an explicit path, environment, PATH, or known installs."""

    requested = executable or os.environ.get("STARNET2_PATH")
    if requested:
        requested_text = os.fspath(requested)
        direct = Path(requested_text).expanduser()
        if direct.is_file():
            return direct.resolve()

        from_path = shutil.which(requested_text)
        if from_path:
            return Path(from_path).resolve()

        raise FileNotFoundError(f"StarNet2 executable not found: {requested_text}")

    from_path = shutil.which("starnet2") or shutil.which("starnet2.exe")
    if from_path:
        return Path(from_path).resolve()

    for candidate in WINDOWS_INSTALL_CANDIDATES:
        if candidate.is_file():
            return candidate.resolve()

    raise FileNotFoundError(
        "Could not find StarNet2. Put starnet2 on PATH, set STARNET2_PATH, "
        "or pass executable=r'J:\\StarNet2\\bin\\starnet2.exe'."
    )


def extract_layers(
    input_path: str | os.PathLike[str],
    output_dir: str | os.PathLike[str] = "data/starnet2",
    *,
    executable: str | os.PathLike[str] | None = None,
    output_suffix: str = ".fits",
    stride: int | None = None,
    upsample: bool = False,
    disable_highlights_protection: bool = False,
    include_unscreen: bool = False,
    input_scale: float | None = None,
    overwrite: bool = False,
    quiet: bool = False,
    extra_args: Sequence[str] = (),
) -> ExtractionResult:
    """Run StarNet2 and return its starless (nebula) and subtractive star layers.

    FITS output is recommended for this project because StarNet2 writes it as
    32-bit floating point without reducing the result to an 8/16-bit image.
    Floating-point FITS inputs that clearly use 0..255 or 0..65535 encoding are
    normalized to 0..1 in the temporary copy passed to StarNet2.
    """

    source = Path(input_path).expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(f"Input image not found: {source}")

    suffix = output_suffix if output_suffix.startswith(".") else f".{output_suffix}"
    if suffix.lower() not in {".fit", ".fits", ".fts", ".tif", ".tiff", ".png"}:
        raise ValueError(f"Unsupported output suffix: {suffix}")

    destination = Path(output_dir).expanduser().resolve()
    destination.mkdir(parents=True, exist_ok=True)
    nebula_path = destination / f"{source.stem}_nebula{suffix}"
    stars_path = destination / f"{source.stem}_stars{suffix}"
    unscreen_path = destination / f"{source.stem}_stars_unscreen{suffix}" if include_unscreen else None

    requested_outputs = [nebula_path, stars_path]
    if unscreen_path is not None:
        requested_outputs.append(unscreen_path)
    existing = [path for path in requested_outputs if path.exists()]
    if existing and not overwrite:
        names = ", ".join(str(path) for path in existing)
        raise FileExistsError(f"Output already exists: {names}. Use overwrite=True to replace it.")

    exe = resolve_starnet2(executable)

    # StarNet2 2.5.4 on Windows passes paths through a narrow-character FITS API.
    # Non-ASCII paths such as this repository's `J:\桌面\...` are corrupted before
    # CFITSIO opens them. Stage the run under the ASCII system temp path, then let
    # Python copy the completed files back to their requested Unicode paths.
    with tempfile.TemporaryDirectory(prefix="astro_starnet2_") as temporary:
        staging_dir = Path(temporary)
        staged_input = staging_dir / f"input{source.suffix}"
        staged_nebula = staging_dir / f"nebula{suffix}"
        staged_stars = staging_dir / f"stars{suffix}"
        staged_unscreen = staging_dir / f"stars_unscreen{suffix}" if include_unscreen else None

        applied_scale = _stage_input(source, staged_input, input_scale)

        command = [
            str(exe),
            "--input", str(staged_input),
            "--output", str(staged_nebula),
            "--mask", str(staged_stars),
        ]
        if staged_unscreen is not None:
            command.extend(("--unscreen", str(staged_unscreen)))
        if stride is not None:
            if stride < 2 or stride > 512 or stride % 2:
                raise ValueError("stride must be an even integer between 2 and 512")
            command.extend(("--stride", str(stride)))
        if upsample:
            command.append("--upsample")
        if disable_highlights_protection:
            command.append("--disable-highlights-protection")
        if quiet:
            command.append("--quiet")
        command.extend(map(str, extra_args))

        subprocess.run(command, check=True)

        staged_outputs = [staged_nebula, staged_stars]
        if staged_unscreen is not None:
            staged_outputs.append(staged_unscreen)
        missing = [path for path in staged_outputs if not path.is_file()]
        if missing:
            raise RuntimeError(f"StarNet2 completed without creating: {', '.join(map(str, missing))}")

        _copy_output_to_rgb(staged_nebula, nebula_path)
        _copy_output_to_rgb(staged_stars, stars_path)
        if staged_unscreen is not None and unscreen_path is not None:
            _copy_output_to_rgb(staged_unscreen, unscreen_path)

    return ExtractionResult(
        input_path=source,
        nebula_path=nebula_path,
        stars_path=stars_path,
        unscreen_path=unscreen_path,
        executable=exe,
        command=tuple(command),
        input_scale=applied_scale,
    )


def _stage_input(source: Path, staged_input: Path, input_scale: float | None) -> float:
    """Copy an input to the ASCII staging path, normalizing float FITS when needed."""

    if source.suffix.lower() not in {".fit", ".fits", ".fts"}:
        shutil.copy2(source, staged_input)
        return 1.0

    with fits.open(source) as hdul:
        data = np.asarray(hdul[0].data)
        header = hdul[0].header.copy()

    if input_scale is not None:
        scale = float(input_scale)
        if not np.isfinite(scale) or scale <= 0:
            raise ValueError("input_scale must be a positive finite number")
    elif np.issubdtype(data.dtype, np.floating):
        finite = data[np.isfinite(data)]
        if finite.size == 0:
            raise ValueError(f"FITS input contains no finite pixels: {source}")
        minimum = float(finite.min())
        maximum = float(finite.max())
        if minimum >= 0 and maximum > 2 and maximum <= 255 * 1.01:
            scale = 255.0
        elif minimum >= 0 and maximum > 255 * 1.01 and maximum <= 65535 * 1.01:
            scale = 65535.0
        else:
            scale = 1.0
    else:
        # StarNet2 already normalizes integer FITS inputs based on their bit depth.
        shutil.copy2(source, staged_input)
        return 1.0

    if scale == 1.0:
        shutil.copy2(source, staged_input)
    else:
        normalized = np.asarray(data, dtype=np.float32) / scale
        fits.PrimaryHDU(data=normalized, header=header).writeto(staged_input, overwrite=True)
        print(f"Normalized floating-point FITS input by {scale:g} to the StarNet2 0..1 range.")
    return scale


def _copy_output_to_rgb(staged_output: Path, destination: Path) -> None:
    """Copy a StarNet2 output, correcting its BGR channel order for color FITS."""

    if staged_output.suffix.lower() not in {".fit", ".fits", ".fts"}:
        shutil.copy2(staged_output, destination)
        return

    with fits.open(staged_output, memmap=False) as hdul:
        data = np.array(hdul[0].data, copy=True)
        header = hdul[0].header.copy()

    # StarNet2 2.5.4 uses OpenCV's BGR convention internally and writes that
    # order directly into a three-plane FITS cube. The rest of this project
    # stores and displays FITS color planes as RGB.
    if data.ndim == 3 and data.shape[0] == 3:
        data = data[[2, 1, 0]]

    fits.PrimaryHDU(data=data, header=header).writeto(destination, overwrite=True)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="Input PNG, TIFF, or FITS image")
    parser.add_argument("--output-dir", default="data/starnet2")
    parser.add_argument("--executable", help="starnet2 alias or explicit executable path")
    parser.add_argument("--output-suffix", default=".fits")
    parser.add_argument("--stride", type=int)
    parser.add_argument("--upsample", action="store_true")
    parser.add_argument("--disable-highlights-protection", action="store_true")
    parser.add_argument("--include-unscreen", action="store_true")
    parser.add_argument("--input-scale", type=float)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    return parser


def main() -> int:
    args = _build_parser().parse_args()
    result = extract_layers(
        args.input,
        args.output_dir,
        executable=args.executable,
        output_suffix=args.output_suffix,
        stride=args.stride,
        upsample=args.upsample,
        disable_highlights_protection=args.disable_highlights_protection,
        include_unscreen=args.include_unscreen,
        input_scale=args.input_scale,
        overwrite=args.overwrite,
        quiet=args.quiet,
    )
    print(f"Nebula: {result.nebula_path}")
    print(f"Stars:  {result.stars_path}")
    if result.unscreen_path is not None:
        print(f"Unscreen stars: {result.unscreen_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
