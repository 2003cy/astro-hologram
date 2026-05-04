"""
Plate solver backed by the astrometry.net Nova API.
Docs: https://nova.astrometry.net/api_help
"""

import io
import json
import time
from typing import Optional

import numpy as np
import requests
from astropy.io import fits
from astropy.wcs import WCS
from PIL import Image

from platesolve.base import PlateSolver, PlateSolveResult


API_URL = "https://nova.astrometry.net/api"


class AstrometryNetSolver(PlateSolver):
    """
    Submits images to nova.astrometry.net and polls until solved.

    Hints accepted by solve():
        scale_units:    'arcsecperpix' | 'arcminwidth' | 'degwidth' | 'focalmm'
        scale_lower:    lower bound for scale hint
        scale_upper:    upper bound for scale hint
        center_ra:      RA prior, degrees
        center_dec:     Dec prior, degrees
        radius:         search radius around prior, degrees
        downsample_factor: reduce upload size / noise sensitivity (default 2)
    """

    def __init__(
        self,
        api_key: str,
        poll_interval: float = 5.0,
        timeout: float = 300.0,
    ):
        self.api_key = api_key
        self.poll_interval = poll_interval
        self.timeout = timeout
        self._session_key: Optional[str] = None

    # ------------------------------------------------------------------
    # PlateSolver interface
    # ------------------------------------------------------------------

    def solve(self, image: np.ndarray, **hints) -> PlateSolveResult:
        img_bytes = self._to_jpeg_bytes(image)
        return self._submit_and_wait(img_bytes, **hints)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _login(self) -> str:
        resp = requests.post(
            f"{API_URL}/login",
            data={"request-json": json.dumps({"apikey": self.api_key})},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("status") != "success":
            raise RuntimeError(f"Login failed: {data}")
        return data["session"]

    def _get_session(self) -> str:
        if self._session_key is None:
            self._session_key = self._login()
        return self._session_key

    @staticmethod
    def _to_jpeg_bytes(image: np.ndarray) -> bytes:
        if image.dtype != np.uint8:
            lo, hi = image.min(), image.max()
            image = ((image - lo) / (hi - lo) * 255).astype(np.uint8) if hi > lo else np.zeros_like(image, dtype=np.uint8)
        pil = Image.fromarray(image)
        if pil.mode not in ("RGB", "L"):
            pil = pil.convert("RGB")
        buf = io.BytesIO()
        pil.save(buf, format="JPEG", quality=90)
        return buf.getvalue()

    def _upload(self, img_bytes: bytes, **hints) -> int:
        params = {"session": self._get_session(), **{k: v for k, v in hints.items() if v is not None}}
        resp = requests.post(
            f"{API_URL}/upload",
            files={"file": ("image.jpg", img_bytes, "image/jpeg")},
            data={"request-json": json.dumps(params)},
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("status") != "success":
            raise RuntimeError(f"Upload failed: {data}")
        return data["subid"]

    def _wait_for_job(self, subid: int) -> int:
        deadline = time.time() + self.timeout
        while time.time() < deadline:
            data = requests.get(f"{API_URL}/submissions/{subid}", timeout=30).json()
            jobs = data.get("jobs") or []
            if jobs and jobs[0] is not None:
                return jobs[0]
            time.sleep(self.poll_interval)
        raise TimeoutError(f"Timed out waiting for job assignment after {self.timeout}s")

    def _wait_for_result(self, job_id: int) -> None:
        deadline = time.time() + self.timeout
        while time.time() < deadline:
            data = requests.get(f"{API_URL}/jobs/{job_id}", timeout=30).json()
            status = data.get("status")
            if status == "success":
                return
            if status == "failure":
                raise RuntimeError("astrometry.net reported solve failure")
            time.sleep(self.poll_interval)
        raise TimeoutError(f"Job {job_id} timed out after {self.timeout}s")

    def _fetch_wcs(self, job_id: int) -> tuple[WCS, dict]:
        calib = requests.get(f"{API_URL}/jobs/{job_id}/calibration", timeout=30).json()
        fits_bytes = requests.get(f"https://nova.astrometry.net/wcs_file/{job_id}", timeout=30).content
        with fits.open(io.BytesIO(fits_bytes)) as hdul:
            # astrometry.net's wcs_file has NAXIS=0 (header-only, no pixel data).
            # naxis=2 tells astropy to read only the two spatial axes and ignore NAXIS=0.
            wcs = WCS(hdul[0].header, naxis=2)
        return wcs, calib

    def _submit_and_wait(self, img_bytes: bytes, **hints) -> PlateSolveResult:
        subid = self._upload(img_bytes, **hints)
        print(f"Submitted (subid={subid}), waiting for job…")
        job_id = self._wait_for_job(subid)
        print(f"Job {job_id} assigned, solving…")
        self._wait_for_result(job_id)
        print("Solved! Fetching WCS…")
        wcs, calib = self._fetch_wcs(job_id)
        return PlateSolveResult(
            wcs=wcs,
            ra=calib["ra"],
            dec=calib["dec"],
            orientation=calib["orientation"],
            pixscale=calib["pixscale"],
            radius=calib["radius"],
        )
