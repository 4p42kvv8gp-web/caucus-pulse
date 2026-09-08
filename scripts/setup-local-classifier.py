"""Install the selected pinned local runtime into an isolated directory."""
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import venv

ROOT=Path(__file__).resolve().parents[1]
if platform.system()!="Darwin" or platform.machine()!="arm64" or sys.version_info[:2]!=(3,12):
    raise SystemExit("The current dependency lock was tested on macOS ARM64 and Python 3.12. Prepare a platform-specific CPU lock before installing on Linux. The archive remains independently available.")
os.umask(0o077)
profile=json.loads((ROOT/"config/local-classifier.json").read_text())
nli=profile.get('engine')=='political-debate-nli'
runtime=ROOT/('data/nli-runtime' if nli else 'data/classifier-runtime')
if runtime.is_symlink():
    raise SystemExit("The runtime directory must not be a symbolic link.")
if not runtime.exists():
    venv.EnvBuilder(with_pip=True).create(runtime)
python=runtime/"bin/python"
if not python.exists():
    raise SystemExit("The existing runtime directory needs inspection; it was not replaced.")
subprocess.run([str(python),"-m","pip","install","--disable-pip-version-check","--no-input","--require-hashes","--only-binary=:all:",
    "--cache-dir",str(ROOT/"data/pip-cache"),"-r",str(ROOT/('requirements-nli.txt' if nli else 'requirements-classifier.txt'))],check=True,cwd=ROOT)
subprocess.run([str(python),"-m","pip","check","--cache-dir",str(ROOT/"data/pip-cache")],check=True,cwd=ROOT)
print("Local classifier runtime installed. Download the pinned model separately; no inference endpoint was started.")
