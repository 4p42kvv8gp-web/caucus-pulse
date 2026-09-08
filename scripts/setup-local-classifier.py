"""Install the selected pinned local runtime into an isolated directory."""
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import venv

ROOT=Path(__file__).resolve().parents[1]
mac=platform.system()=='Darwin' and platform.machine()=='arm64'
linux=platform.system()=='Linux' and platform.machine()=='x86_64'
if not (mac or linux) or sys.version_info[:2]!=(3,12):
    raise SystemExit('Supported locks target Python 3.12 on macOS ARM64 or Linux x86_64 CPU. The archive remains independently available on other hosts.')
os.umask(0o077)
profile=json.loads((ROOT/"config/local-classifier.json").read_text())
nli=profile.get('engine')=='political-debate-nli'
if linux and not nli:raise SystemExit('The experimental MLX runtime is only supported on the Mac.')
if linux:
    libc,version=platform.libc_ver()
    if libc!='glibc' or tuple(int(n) for n in version.split('.')[:2])<(2,28):
        raise SystemExit('The Linux CPU wheels require glibc 2.28 or newer.')
lock=ROOT/('requirements-nli-linux-cpu.txt' if linux else 'requirements-nli.txt' if nli else 'requirements-classifier.txt')
if not lock.is_file() or lock.is_symlink():raise SystemExit('The selected pinned runtime lock is missing or unsafe.')
runtime=ROOT/('data/nli-runtime' if nli else 'data/classifier-runtime')
if runtime.is_symlink():
    raise SystemExit("The runtime directory must not be a symbolic link.")
if not runtime.exists():
    venv.EnvBuilder(with_pip=True).create(runtime)
python=runtime/"bin/python"
if not python.exists():
    raise SystemExit("The existing runtime directory needs inspection; it was not replaced.")
subprocess.run([str(python),"-m","pip","install","--disable-pip-version-check","--no-input","--require-hashes","--only-binary=:all:",
    "--cache-dir",str(ROOT/"data/pip-cache"),"-r",str(lock)],check=True,cwd=ROOT)
subprocess.run([str(python),"-m","pip","check","--cache-dir",str(ROOT/"data/pip-cache")],check=True,cwd=ROOT)
print("Local classifier runtime installed. Download the pinned model separately; no inference endpoint was started.")
if linux:print('The Linux wheel hashes and dependency metadata were checked during preparation. Run the host smoke test before enabling the model service; Linux execution is a separate validation.')
