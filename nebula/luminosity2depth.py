"""Brightness-derived nebula depth signal used by the current Three.js scene."""

from dataclasses import dataclass
import json
from pathlib import Path

from typing import Callable
import numpy as np
from astropy.io import fits
from PIL import Image
from scipy.ndimage import gaussian_filter
from scipy.optimize import curve_fit


@dataclass
class BackgroundModel:
    amplitude: float
    mean: float
    sigma: float
    threshold: float
    histogram_counts: np.ndarray
    histogram_edges: np.ndarray


@dataclass
class LuminosityDepthResult:
    source_path: Path
    normalization_reference_path: Path
    normalization_factor: float
    normalization_input_scale: float
    color_rgb: np.ndarray
    luminance: np.ndarray
    normalized_luminance: np.ndarray
    background_subtracted: np.ndarray
    nebula_mask: np.ndarray
    signal: np.ndarray
    background: BackgroundModel
    nebula_depth_scale: float
    nebula_z_center: float
    color_path: Path | None = None
    signal_path: Path | None = None
    metadata_path: Path | None = None


def gaussian(x: np.ndarray, amplitude: float, mean: float, sigma: float) -> np.ndarray:
    return amplitude * np.exp(-0.5 * ((x - mean) / sigma) ** 2)


def depth_transforms() -> dict[str, Callable[[np.ndarray], np.ndarray]]:
    """Transforms mirrored by the Three.js vertex shader for diagnostics."""
    return {
        "linear": lambda value: value,
        "sqrt": lambda value: np.sqrt(value),
        "cbrt": lambda value: np.cbrt(value),
        "log": lambda value: np.log10(1.0 + value * 99.0) / np.log10(100.0),
        "power2": lambda value: value**2.0,
        "threshold": lambda value: np.where(value > 0.05, value, 0.0),
    }


def _load_fits_data(path: str | Path) -> np.ndarray:
    with fits.open(Path(path)) as hdul:
        raw = np.asarray(hdul[0].data, dtype=np.float32)
    return np.clip(raw, 0.0, None)


def _infer_starnet_input_scale(raw: np.ndarray) -> float:
    finite = raw[np.isfinite(raw)]
    if finite.size == 0:
        raise ValueError("Normalization reference contains no finite pixels")
    minimum = float(finite.min())
    maximum = float(finite.max())
    if minimum >= 0 and maximum > 2 and maximum <= 255 * 1.01:
        return 255.0
    if minimum >= 0 and maximum > 255 * 1.01 and maximum <= 65535 * 1.01:
        return 65535.0
    return 1.0


def calculate_normalization_factor(
    path: str | Path,
    *,
    white_percentile: float = 99.8,
    input_scale: float | None = None,
) -> tuple[float, float]:
    """Return a white point in the normalized units written by StarNet2."""
    if not 0 < white_percentile <= 100:
        raise ValueError("white_percentile must be in the interval (0, 100]")
    raw = _load_fits_data(path)
    scale = _infer_starnet_input_scale(raw) if input_scale is None else float(input_scale)
    if not np.isfinite(scale) or scale <= 0:
        raise ValueError("input_scale must be a positive finite number")
    factor = float(np.percentile(raw / scale, white_percentile))
    return factor + 1e-9, scale


def load_nebula_layer(
    path: str | Path,
    *,
    white_percentile: float = 99.8,
    normalization_factor: float | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return raw FITS data, robustly normalized RGB, and Rec.709 luminance."""
    source = Path(path)
    raw = _load_fits_data(source)
    if normalization_factor is None:
        normalization_factor, _ = calculate_normalization_factor(
            source,
            white_percentile=white_percentile,
        )
    if not np.isfinite(normalization_factor) or normalization_factor <= 0:
        raise ValueError("normalization_factor must be a positive finite number")

    if raw.ndim == 3:
        normalized_channels = raw / normalization_factor
        color_rgb = np.transpose(normalized_channels[:3], (1, 2, 0))
        luminance = (
            0.2126 * normalized_channels[0]
            + 0.7152 * normalized_channels[1]
            + 0.0722 * normalized_channels[2]
        )
    else:
        luminance = raw / normalization_factor
        color_rgb = np.stack([luminance] * 3, axis=-1)
    return raw, np.clip(color_rgb, 0.0, 1.0), np.clip(luminance, 0.0, 1.0)


def fit_background(
    normalized_luminance: np.ndarray,
    threshold_sigma: float = 3.0,
    histogram_bins: int = 200,
) -> tuple[BackgroundModel, np.ndarray, np.ndarray]:
    """Fit the low-brightness Gaussian background and build the nebula signal."""
    counts, edges = np.histogram(
        normalized_luminance.ravel(), bins=histogram_bins, range=(0.0, 1.0)
    )
    centers = 0.5 * (edges[:-1] + edges[1:])
    peak_index = int(np.argmax(counts))
    fit_selection = centers <= centers[peak_index] * 2
    initial = [counts[peak_index], centers[peak_index], 1e-2]
    parameters, _ = curve_fit(
        gaussian,
        centers[fit_selection],
        counts[fit_selection],
        p0=initial,
        maxfev=10_000,
    )
    amplitude, mean, sigma = (
        float(parameters[0]),
        float(parameters[1]),
        abs(float(parameters[2])),
    )
    threshold = mean + threshold_sigma * sigma
    nebula_mask = normalized_luminance > threshold
    background_subtracted = np.clip(normalized_luminance - mean, 0.0, None)
    background_subtracted /= float(background_subtracted.max()) + 1e-9
    model = BackgroundModel(
        amplitude=amplitude,
        mean=mean,
        sigma=sigma,
        threshold=threshold,
        histogram_counts=counts,
        histogram_edges=edges,
    )
    return model, nebula_mask, background_subtracted


def calculate_depth_scale(
    image_width: int,
    *,
    background_distance_pc: float,
    depth_coefficient: float,
    nebula_distance_pc: float,
    nebula_thickness_pc: float,
    visual_scale: float,
    depth_sign: float,
) -> float:
    scene_scale = depth_coefficient * image_width / 2
    near_distance = nebula_distance_pc - nebula_thickness_pc / 2
    far_distance = nebula_distance_pc + nebula_thickness_pc / 2
    near_z = -(
        np.log10(near_distance) - np.log10(background_distance_pc)
    ) * scene_scale
    far_z = -(
        np.log10(far_distance) - np.log10(background_distance_pc)
    ) * scene_scale
    return float((near_z - far_z) * visual_scale * depth_sign)


def luminosity2depth(
    nebula_fits_path: str | Path,
    output_dir: str | Path | None = None,
    *,
    normalization_reference_path: str | Path | None = None,
    normalization_reference_input_scale: float | None = None,
    background_distance_pc: float = 2000.0,
    background_z: float = 0.0,
    depth_coefficient: float = 0.1,
    nebula_distance_pc: float | None = None,
    nebula_thickness_pc: float = 250.0,
    visual_scale: float = 50.0,
    depth_sign: float = -1.0,
    detection_threshold_sigma: float = 3.0,
    background_histogram_bins: int = 200,
    smoothing_sigma: float = 6.0,
    signal_histogram_bins: int = 256,
    default_transform: str = "linear",
    color_white_percentile: float = 99.8,
) -> LuminosityDepthResult:
    """Compute and optionally export the pre-transform luminosity depth signal."""
    source = Path(nebula_fits_path)
    normalization_reference = (
        Path(normalization_reference_path)
        if normalization_reference_path is not None
        else source
    )
    normalization_factor, normalization_input_scale = calculate_normalization_factor(
        normalization_reference,
        white_percentile=color_white_percentile,
        input_scale=normalization_reference_input_scale,
    )
    _, color_rgb, luminance = load_nebula_layer(
        source,
        white_percentile=color_white_percentile,
        normalization_factor=normalization_factor,
    )
    background, nebula_mask, background_subtracted = fit_background(
        luminance,
        threshold_sigma=detection_threshold_sigma,
        histogram_bins=background_histogram_bins,
    )
    signal = (
        gaussian_filter(background_subtracted, sigma=smoothing_sigma)
        if smoothing_sigma > 0
        else background_subtracted.copy()
    )
    signal = np.clip(signal, 0.0, 1.0)
    nebula_distance_pc = nebula_distance_pc or background_distance_pc
    depth_scale = calculate_depth_scale(
        signal.shape[1],
        background_distance_pc=background_distance_pc,
        depth_coefficient=depth_coefficient,
        nebula_distance_pc=nebula_distance_pc,
        nebula_thickness_pc=nebula_thickness_pc,
        visual_scale=visual_scale,
        depth_sign=depth_sign,
    )
    result = LuminosityDepthResult(
        source_path=source,
        normalization_reference_path=normalization_reference,
        normalization_factor=normalization_factor,
        normalization_input_scale=normalization_input_scale,
        color_rgb=color_rgb,
        luminance=luminance,
        normalized_luminance=luminance,
        background_subtracted=background_subtracted,
        nebula_mask=nebula_mask,
        signal=signal,
        background=background,
        nebula_depth_scale=depth_scale,
        nebula_z_center=background_z,
    )

    if output_dir is not None:
        destination = Path(output_dir)
        destination.mkdir(parents=True, exist_ok=True)
        result.color_path = destination / "nebula.png"
        result.signal_path = destination / "nebula_signal.png"
        result.metadata_path = destination / "nebula_meta.json"
        Image.fromarray(np.asarray(color_rgb * 255, dtype=np.uint8), mode="RGB").save(
            result.color_path
        )
        Image.fromarray(np.round(signal * 255).astype(np.uint8), mode="L").save(
            result.signal_path
        )

        histogram_counts, histogram_edges = np.histogram(
            signal[nebula_mask], bins=signal_histogram_bins, range=(0.0, 1.0)
        )
        histogram_centers = 0.5 * (histogram_edges[:-1] + histogram_edges[1:])
        metadata = {
            "nebula_depth_scale": round(depth_scale, 6),
            "nebula_z_center": round(float(background_z), 4),
            "nebula_dist_pc": nebula_distance_pc,
            "depth_nebula_parsec": nebula_thickness_pc,
            "default_transform": default_transform,
            "color_white_percentile": color_white_percentile,
            "color_normalization_factor": round(normalization_factor, 8),
            "normalization_input_scale": normalization_input_scale,
            "normalization_reference_fits": str(normalization_reference),
            "smooth_sigma": smoothing_sigma,
            "source_nebula_fits": str(source),
            "signal_histogram": {
                "centers": [round(float(value), 8) for value in histogram_centers],
                "counts": [int(value) for value in histogram_counts],
            },
            "background_model": {
                "mu": round(background.mean, 8),
                "sigma": round(background.sigma, 8),
                "threshold": round(background.threshold, 8),
            },
            "bg_dist_pc": background_distance_pc,
            "bg_z_scene": background_z,
        }
        with result.metadata_path.open("w", encoding="utf-8") as handle:
            json.dump(metadata, handle, separators=(",", ":"), indent=2)

    return result
