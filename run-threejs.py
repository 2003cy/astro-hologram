#!/usr/bin/env python3
"""Start the Three.js development server on Windows, Linux, or macOS."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path


REPO_DIR = Path(__file__).resolve().parent
APP_DIR = REPO_DIR / "threejs"


def main() -> int:
    package_json = APP_DIR / "package.json"
    if not package_json.is_file():
        print(f"[ERROR] Cannot find {package_json}.", file=sys.stderr)
        return 1

    npm = shutil.which("npm")
    if npm is None:
        print("[ERROR] npm was not found. Install Node.js and try again.", file=sys.stderr)
        return 1

    if not (APP_DIR / "node_modules").is_dir():
        print("Installing dependencies...", flush=True)
        install = subprocess.run([npm, "install"], cwd=APP_DIR)
        if install.returncode != 0:
            return install.returncode

    print("Starting the Three.js development server at http://127.0.0.1:4173/ ...", flush=True)
    try:
        process = subprocess.run(
            [npm, "run", "dev", "--", *sys.argv[1:]],
            cwd=APP_DIR,
        )
        return process.returncode
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
