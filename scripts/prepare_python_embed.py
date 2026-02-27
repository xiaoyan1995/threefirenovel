#!/usr/bin/env python3
"""
Download and stage a relocatable python-build-standalone runtime.

This script is intended for CI release builds (especially macOS) so that
release artifacts include a bundled Python runtime and do not depend on a
user machine Python install.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path


GITHUB_API = "https://api.github.com/repos/astral-sh/python-build-standalone/releases"


def _request_json(url: str) -> dict:
    req = urllib.request.Request(url)
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _download(url: str, dest: Path) -> None:
    req = urllib.request.Request(url)
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=300) as resp, dest.open("wb") as out:
        shutil.copyfileobj(resp, out)


def _pick_asset(release: dict, python_series: str, triple: str) -> dict:
    # Example:
    # cpython-3.10.16+20250212-aarch64-apple-darwin-install_only.tar.gz
    pattern = re.compile(
        rf"^cpython-{re.escape(python_series)}\.\d+\+.*-{re.escape(triple)}-install_only\.tar\.gz$"
    )
    assets = release.get("assets", [])
    for asset in assets:
        if pattern.match(asset.get("name", "")):
            return asset
    names = [a.get("name", "") for a in assets]
    raise RuntimeError(
        "No matching python-build-standalone asset found.\n"
        f"Wanted triple={triple}, python_series={python_series}\n"
        f"Available assets:\n- " + "\n- ".join(names[:80])
    )


def _find_install_dir(root: Path) -> Path:
    # Expected extracted layout typically contains ".../python/install/..."
    install_candidates = [p for p in root.rglob("install") if p.is_dir()]
    for cand in install_candidates:
        if (cand / "bin").exists() or (cand / "python.exe").exists():
            return cand

    # Fallback: directory that already looks like runtime root
    for cand in root.rglob("*"):
        if not cand.is_dir():
            continue
        if (cand / "bin" / "python3").exists() or (cand / "python.exe").exists():
            return cand

    raise RuntimeError("Cannot locate extracted runtime install directory")


def _clean_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--triple", required=True, help="target triple, e.g. aarch64-apple-darwin")
    parser.add_argument("--dest", required=True, help="destination directory, e.g. python_embed")
    parser.add_argument("--python-series", default="3.10", help="python series to match, default 3.10")
    parser.add_argument("--release-tag", default="", help="optional release tag override")
    args = parser.parse_args()

    dest = Path(args.dest).resolve()

    if args.release_tag:
        release_url = f"{GITHUB_API}/tags/{args.release_tag}"
    else:
        release_url = f"{GITHUB_API}/latest"
    release = _request_json(release_url)
    asset = _pick_asset(release, args.python_series, args.triple)

    print(f"[python-embed] release: {release.get('tag_name', 'unknown')}")
    print(f"[python-embed] asset:   {asset.get('name', 'unknown')}")

    with tempfile.TemporaryDirectory(prefix="pyembed_") as td:
        td_path = Path(td)
        archive = td_path / asset["name"]
        _download(asset["browser_download_url"], archive)

        extract_root = td_path / "extract"
        extract_root.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive, "r:gz") as tar:
            tar.extractall(extract_root)

        runtime_src = _find_install_dir(extract_root)
        _clean_dir(dest)
        shutil.copytree(runtime_src, dest, dirs_exist_ok=True)

    print(f"[python-embed] staged at: {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

