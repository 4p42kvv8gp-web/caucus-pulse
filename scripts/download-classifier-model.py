"""Download pinned public model files, streamed and verified before use. No Hub login."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SPEC = json.loads((ROOT / "config/local-classifier.json").read_text())
MODEL_ROOT = ROOT / "data/models"
DEST = MODEL_ROOT / f'{SPEC["name"]}-{SPEC["revision"]}'


def digest(path, size, expected):
    if path.is_symlink() or path.stat().st_size != size:
        raise ValueError("Model file size does not match its pinned manifest")
    h = hashlib.sha256() if len(expected) == 64 else hashlib.sha1()
    if len(expected) == 40:
        h.update(f"blob {size}\0".encode())
    with path.open("rb") as f:
        while block := f.read(1024 * 1024):
            h.update(block)
    if h.hexdigest() != expected:
        raise ValueError("Model file digest does not match its pinned manifest")


def verify(directory, spec=None):
    for name, size, expected in (spec or SPEC)["files"]:
        digest(directory / name, size, expected)


class PublicRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.startswith("https://"):
            raise ValueError("Model download requires HTTPS")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(spec):
    os.umask(0o077)
    destination=MODEL_ROOT/f'{spec["name"]}-{spec["revision"]}'
    MODEL_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    if destination.is_symlink():raise ValueError('Model directory must not be a symbolic link')
    if destination.exists():
        verify(destination,spec)
        print(json.dumps({"status": "already-verified", "model": spec["name"]}), flush=True)
        return
    staging = Path(tempfile.mkdtemp(prefix=destination.name + ".partial-", dir=MODEL_ROOT))
    # No proxies, cookies, credentials, or user configuration are inherited.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), PublicRedirects())
    try:
        for name, size, expected in spec["files"]:
            url = f'https://huggingface.co/{spec["repository"]}/resolve/{spec["revision"]}/{name}'
            received = 0
            started = time.monotonic()
            report_at = 256 * 1024 * 1024
            with opener.open(urllib.request.Request(url, headers={"User-Agent": "caucus-pulse-model-download/1"}), timeout=60) as response, (staging / name).open("xb") as out:
                while block := response.read(1024 * 1024):
                    received += len(block)
                    if received > size or time.monotonic() - started > 1200:
                        raise ValueError("Model download exceeded its size or time limit")
                    out.write(block)
                    if received >= report_at:
                        print(json.dumps({"file": name, "receivedBytes": received, "expectedBytes": size}), flush=True)
                        report_at += 256 * 1024 * 1024
            digest(staging / name, size, expected)
            print(json.dumps({"verifiedFile": name, "bytes": size}), flush=True)
        (staging / "manifest.json").write_text(json.dumps(spec, indent=2) + "\n")
        staging.rename(destination)
        print(json.dumps({"status": "downloaded-and-verified", "model": spec["name"], "bytes": sum(f[1] for f in spec["files"])}), flush=True)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


if __name__ == "__main__":
    import sys
    if sys.argv[1:]==['--entities']:
        download(json.loads((ROOT/'config/entity-model.json').read_text()))
    elif not sys.argv[1:]:download(SPEC)
    else:raise SystemExit('Use download-classifier-model.py with no arguments or --entities.')
