"""Plate solver backed by the astrometry.net Nova API."""

import io
import json
import time
from typing import Optional

import numpy as np
import requests
from astropy.io import fits
from astropy.wcs import WCS
from PIL import Image

from .base import PlateSolver, PlateSolveResult


API_URL = "https://nova.astrometry.net/api"


class AstrometryNetSolver(PlateSolver):
    def __init__(self, api_key: str, poll_interval: float = 5.0, timeout: float = 300.0):
        self.api_key = api_key
        self.poll_interval = poll_interval
        self.timeout = timeout
        self._session_key: Optional[str] = None

    def solve(self, image: np.ndarray, **hints) -> PlateSolveResult:
        return self._submit_and_wait(self._to_jpeg_bytes(image), **hints)

    def _login(self) -> str:
        response = requests.post(
            f"{API_URL}/login",
            data={"request-json": json.dumps({"apikey": self.api_key})},
            timeout=30,
        )
        response.raise_for_status()
        data = response.json()
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
            low, high = image.min(), image.max()
            image = (
                ((image - low) / (high - low) * 255).astype(np.uint8)
                if high > low
                else np.zeros_like(image, dtype=np.uint8)
            )
        pil_image = Image.fromarray(image)
        if pil_image.mode not in ("RGB", "L"):
            pil_image = pil_image.convert("RGB")
        buffer = io.BytesIO()
        pil_image.save(buffer, format="JPEG", quality=90)
        return buffer.getvalue()

    def _upload(self, image_bytes: bytes, **hints) -> int:
        params = {
            "session": self._get_session(),
            **{key: value for key, value in hints.items() if value is not None},
        }
        response = requests.post(
            f"{API_URL}/upload",
            files={"file": ("image.jpg", image_bytes, "image/jpeg")},
            data={"request-json": json.dumps(params)},
            timeout=60,
        )
        response.raise_for_status()
        data = response.json()
        if data.get("status") != "success":
            raise RuntimeError(f"Upload failed: {data}")
        return data["subid"]

    def _wait_for_job(self, submission_id: int) -> int:
        deadline = time.time() + self.timeout
        while time.time() < deadline:
            response = requests.get(f"{API_URL}/submissions/{submission_id}", timeout=30)
            response.raise_for_status()
            jobs = response.json().get("jobs") or []
            if jobs and jobs[0] is not None:
                return jobs[0]
            time.sleep(self.poll_interval)
        raise TimeoutError(f"Timed out waiting for job assignment after {self.timeout}s")

    def _wait_for_result(self, job_id: int) -> None:
        deadline = time.time() + self.timeout
        while time.time() < deadline:
            response = requests.get(f"{API_URL}/jobs/{job_id}", timeout=30)
            response.raise_for_status()
            status = response.json().get("status")
            if status == "success":
                return
            if status == "failure":
                raise RuntimeError("astrometry.net reported solve failure")
            time.sleep(self.poll_interval)
        raise TimeoutError(f"Job {job_id} timed out after {self.timeout}s")

    def _fetch_wcs(self, job_id: int) -> tuple[WCS, dict]:
        calibration_response = requests.get(
            f"{API_URL}/jobs/{job_id}/calibration", timeout=30
        )
        calibration_response.raise_for_status()
        wcs_response = requests.get(
            f"https://nova.astrometry.net/wcs_file/{job_id}", timeout=30
        )
        wcs_response.raise_for_status()
        with fits.open(io.BytesIO(wcs_response.content)) as hdul:
            wcs = WCS(hdul[0].header, naxis=2)
        return wcs, calibration_response.json()

    def _submit_and_wait(self, image_bytes: bytes, **hints) -> PlateSolveResult:
        submission_id = self._upload(image_bytes, **hints)
        print(f"Submitted (subid={submission_id}), waiting for job...")
        job_id = self._wait_for_job(submission_id)
        print(f"Job {job_id} assigned, solving...")
        self._wait_for_result(job_id)
        print("Solved. Fetching WCS...")
        wcs, calibration = self._fetch_wcs(job_id)
        return PlateSolveResult(
            wcs=wcs,
            ra=calibration["ra"],
            dec=calibration["dec"],
            orientation=calibration["orientation"],
            pixscale=calibration["pixscale"],
            radius=calibration["radius"],
        )
