"""Prepare a Linux CPU wheel lock without installing or executing downloaded code.

Maintainer tool: requires packaging in the invoking environment. It downloads public
CPython 3.12 x86_64 wheels, checks their published hashes and their dependency metadata.
An actual Linux installation and model smoke test remain separate required checks.
"""
import concurrent.futures
from email.parser import BytesParser
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sys
import urllib.parse
import urllib.request
import zipfile

from packaging.requirements import Requirement
from packaging.tags import Tag
from packaging.utils import canonicalize_name, parse_wheel_filename
from packaging.version import Version

ROOT=Path(__file__).resolve().parents[1]
DEST=ROOT/'data/linux-cpu-wheels'
MAX_WHEEL_BYTES=350_000_000
ALLOWED={'pypi.org','files.pythonhosted.org','download.pytorch.org','download-r2.pytorch.org'}

class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        check_url(newurl)
        return super().redirect_request(req,fp,code,msg,headers,newurl)

OPENER=urllib.request.build_opener(SafeRedirect())

def check_url(url):
    parsed=urllib.parse.urlsplit(url)
    if parsed.scheme!='https' or parsed.hostname not in ALLOWED or parsed.username or parsed.password or parsed.port not in (None,443):
        raise ValueError('Unexpected public package source')

def get(url,max_bytes=8_000_000):
    check_url(url)
    with OPENER.open(urllib.request.Request(url,headers={'User-Agent':'CaucusPulseDependencyPreparation/1.0'}),timeout=30) as response:
        body=response.read(max_bytes+1)
        if len(body)>max_bytes:
            raise ValueError('Public metadata exceeded its bound')
        return body

class Links(HTMLParser):
    def __init__(self):
        super().__init__();self.urls=[]
    def handle_starttag(self,tag,attrs):
        if tag=='a':
            href=dict(attrs).get('href')
            if href:self.urls.append(href)

def compatible(filename):
    _,_,_,tags=parse_wheel_filename(filename)
    platforms={f'manylinux_2_{n}_x86_64' for n in range(5,29)}|{'manylinux2014_x86_64','manylinux2010_x86_64','manylinux1_x86_64','any'}
    allowed={Tag('cp312','cp312',p) for p in platforms}|{Tag(f'cp3{n}','abi3',p) for n in range(2,13) for p in platforms}|{Tag('cp312','none',p) for p in platforms}|{Tag(py,'none',p) for py in ['py3','py312'] for p in platforms}
    return bool(tags&allowed)

def select(name,version):
    if name=='torch':
        parser=Links();parser.feed(get('https://download.pytorch.org/whl/cpu/torch/').decode())
        suffix=f'torch-{version}+cpu-cp312-cp312-manylinux_2_28_x86_64.whl'
        matches=[url for url in parser.urls if urllib.parse.unquote(urllib.parse.urlsplit(url).path).endswith('/'+suffix)]
        if len(matches)!=1:raise ValueError('Expected exactly one pinned Linux CPU torch wheel')
        url=matches[0];check_url(url)
        digest=urllib.parse.parse_qs(urllib.parse.urlsplit(url).fragment).get('sha256',[''])[0]
        if not re.fullmatch('[a-f0-9]{64}',digest):raise ValueError('CPU wheel has no valid published digest')
        return {'name':name,'version':version+'+cpu','filename':suffix,'url':url.split('#')[0],'sha256':digest}
    metadata=json.loads(get(f'https://pypi.org/pypi/{urllib.parse.quote(name)}/{urllib.parse.quote(version)}/json'))
    choices=[f for f in metadata['urls'] if f.get('packagetype')=='bdist_wheel' and not f.get('yanked') and compatible(f['filename']) and f.get('size',MAX_WHEEL_BYTES+1)<=MAX_WHEEL_BYTES]
    if not choices:raise ValueError(f'No compatible pinned Linux wheel for {name}')
    # Prefer universal wheels, then a deterministic platform-specific file.
    choice=sorted(choices,key=lambda f:(not f['filename'].endswith('py3-none-any.whl'),f['filename']))[0]
    check_url(choice['url'])
    return {'name':name,'version':version,'filename':choice['filename'],'url':choice['url'],'sha256':choice['digests']['sha256']}

def download(item):
    path=DEST/item['filename'];temporary=path.with_suffix('.partial')
    if path.is_symlink() or temporary.exists():raise ValueError('Inspect the existing wheel or interrupted download first')
    if not path.exists():
        check_url(item['url']);size=0
        try:
            request=urllib.request.Request(item['url'],headers={'User-Agent':'CaucusPulseDependencyPreparation/1.0'})
            with OPENER.open(request,timeout=60) as response,temporary.open('xb') as out:
                while chunk:=response.read(1024*1024):
                    size+=len(chunk)
                    if size>MAX_WHEEL_BYTES:raise ValueError('Public wheel exceeded its size bound')
                    out.write(chunk)
            temporary.rename(path)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    with path.open('rb') as source:digest=hashlib.file_digest(source,'sha256').hexdigest()
    if digest!=item['sha256']:raise ValueError(f'Published hash mismatch for {item["name"]}')
    with zipfile.ZipFile(path) as archive:
        names=[n for n in archive.namelist() if n.count('/')==1 and n.endswith('.dist-info/METADATA')]
        if len(names)!=1 or archive.getinfo(names[0]).file_size>4_000_000:raise ValueError('Unexpected wheel metadata')
        meta=BytesParser().parsebytes(archive.read(names[0]))
    if canonicalize_name(meta['Name'])!=canonicalize_name(item['name']) or Version(meta['Version'])!=Version(item['version']):raise ValueError('Wheel metadata identity mismatch')
    return {**item,'bytes':path.stat().st_size,'requires':meta.get_all('Requires-Dist',[])}

def main():
    os.umask(0o077)
    if DEST.is_symlink():raise ValueError('Wheel directory cannot be a symlink')
    DEST.mkdir(parents=True,exist_ok=True,mode=0o700)
    reports=ROOT/'data/reports'
    if reports.is_symlink():raise ValueError('Report directory cannot be a symlink')
    reports.mkdir(parents=True,exist_ok=True,mode=0o700)
    pinned=re.findall(r'^([A-Za-z0-9_-]+)==([^\s]+)',(ROOT/'requirements-nli.txt').read_text(),re.M)
    if not 1<=len(pinned)<=60:raise ValueError('Unexpected source lock size')
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        selected=list(pool.map(lambda pair:select(*pair),pinned))
        downloaded=list(pool.map(download,selected))
    versions={canonicalize_name(i['name']):Version(i['version']) for i in downloaded}
    environment={'implementation_name':'cpython','implementation_version':'3.12.0','os_name':'posix','platform_machine':'x86_64','platform_release':'6.8.0','platform_system':'Linux','platform_version':'','python_full_version':'3.12.0','platform_python_implementation':'CPython','python_version':'3.12','sys_platform':'linux','extra':''}
    errors=[]
    for item in downloaded:
        for value in item['requires']:
            req=Requirement(value)
            if req.marker and not req.marker.evaluate(environment):continue
            found=versions.get(canonicalize_name(req.name))
            if found is None or found not in req.specifier:errors.append({'package':item['name'],'requires':value,'found':str(found) if found else None})
    report={'target':'CPython 3.12 / Linux x86_64 / glibc >= 2.28 / CPU','packages':len(downloaded),'bytes':sum(i['bytes'] for i in downloaded),'dependencyErrors':errors,'runtimeExecuted':False,'wheels':downloaded}
    (ROOT/'data/reports/linux-cpu-dependency-preparation.json').write_text(json.dumps(report,indent=2)+'\n')
    if errors:raise ValueError('Linux dependency closure is incomplete; inspect the private preparation report')
    lines=['# CPython 3.12, Linux x86_64, glibc >= 2.28; CPU only.','# Public wheel hashes and dependency metadata verified. Actual Linux execution still required.']
    for item in sorted(downloaded,key=lambda i:canonicalize_name(i['name'])):
        requirement=f'{item["name"]} @ {item["url"]}' if item['name']=='torch' else f'{item["name"]}=={item["version"]}'
        lines.append(requirement+' \\\n    --hash=sha256:'+item['sha256'])
    output=ROOT/'requirements-nli-linux-cpu.txt'
    if output.exists():raise ValueError('A Linux lock already exists; compare explicitly instead of overwriting it')
    output.write_text('\n'.join(lines)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='wheels'}))

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(str(error),file=sys.stderr);sys.exit(1)
