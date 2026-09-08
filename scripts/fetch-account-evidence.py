"""Collect bounded, public House-directory and office-link evidence. Never calls X."""
import argparse
import concurrent.futures
import datetime as dt
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import time
import unicodedata
import urllib.parse
import urllib.request

DIRECTORY = 'https://www.house.gov/representatives'
STATES = dict(item.split(':') for item in ('Alabama:AL|Alaska:AK|American Samoa:AS|Arizona:AZ|Arkansas:AR|California:CA|Colorado:CO|Connecticut:CT|Delaware:DE|District of Columbia:DC|Florida:FL|Georgia:GA|Guam:GU|Hawaii:HI|Idaho:ID|Illinois:IL|Indiana:IN|Iowa:IA|Kansas:KS|Kentucky:KY|Louisiana:LA|Maine:ME|Maryland:MD|Massachusetts:MA|Michigan:MI|Minnesota:MN|Mississippi:MS|Missouri:MO|Montana:MT|Nebraska:NE|Nevada:NV|New Hampshire:NH|New Jersey:NJ|New Mexico:NM|New York:NY|North Carolina:NC|North Dakota:ND|Northern Mariana Islands:MP|Ohio:OH|Oklahoma:OK|Oregon:OR|Pennsylvania:PA|Puerto Rico:PR|Rhode Island:RI|South Carolina:SC|South Dakota:SD|Tennessee:TN|Texas:TX|Utah:UT|Vermont:VT|Virginia:VA|Virgin Islands:VI|Washington:WA|West Virginia:WV|Wisconsin:WI|Wyoming:WY').split('|'))


def official_url(value):
    url = urllib.parse.urlsplit(value)
    return url.scheme == 'https' and bool(url.hostname) and url.hostname.endswith('.house.gov') and not url.username and not url.password and url.port in (None, 443)


def profile_url(value):
    try:
        url = urllib.parse.urlsplit(value.strip())
        # These are links in a verified HTTPS office page, never fetch targets.
        # Preserve the observed URL and canonicalize only the exact X host/handle.
        if url.scheme not in ('http', 'https') or url.hostname not in ('x.com', 'www.x.com', 'twitter.com', 'www.twitter.com') or url.username or url.password or url.port is not None:
            return None
        handle = url.path.strip('/')
        if handle.startswith('@'):
            handle = handle[1:]
        if not re.fullmatch(r'[A-Za-z0-9_]{1,15}', handle) or handle.lower() in ('home', 'share', 'intent', 'search', 'i', 'hashtag', 'explore', 'settings', 'login'):
            return None
        return {'handle': handle, 'url': f'https://x.com/{handle}'}
    except ValueError:
        return None


class Links(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = []
        self.settings = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and attrs.get('type') == 'application/json' and attrs.get('data-drupal-selector') == 'drupal-settings-json':
            self.settings = ''
        if tag == 'a':
            value = attrs.get('href', '')
            profile = profile_url(value)
            if profile:
                self.links.append({**profile, 'observedHref': value.strip(), 'sourceKind': 'anchor'})

    def handle_data(self, value):
        if self.settings is not None:
            self.settings += value

    def handle_endtag(self, tag):
        if tag != 'script' or self.settings is None:
            return
        raw, self.settings = self.settings, None
        try:
            # Parse only the known social-icon configuration, never executable
            # scripts or arbitrary quoted URLs from the rest of the page.
            config = json.loads(raw)['evo_social_icons']['EvoSocialIconsJS']['order']
            if not isinstance(config, dict) or len(config) > 100:
                return
            for entry in config.values():
                if not isinstance(entry, dict):
                    continue
                for platform in ('X', 'Twitter'):
                    value = entry.get(platform)
                    if not isinstance(value, dict) or value.get('checkbox') not in ('1', 1):
                        continue
                    url = value.get('url')
                    profile = profile_url(url) if isinstance(url, str) else None
                    if profile:
                        self.links.append({**profile, 'observedHref': url.strip(), 'sourceKind': 'drupal-social-settings'})
        except (ValueError, KeyError, TypeError):
            return


class Directory(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows, self.state, self.caption, self.cells, self.cell, self.hrefs = [], None, None, None, None, []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'table':
            self.state = None
        elif tag == 'caption' and attrs.get('id', '').startswith('state-'):
            self.caption = ''
        elif tag == 'tr' and self.state:
            self.cells, self.hrefs = [], []
        elif tag == 'td' and self.cells is not None:
            self.cell = ''
        elif tag == 'a' and self.cell is not None:
            self.hrefs.append(attrs.get('href', '').strip())

    def handle_data(self, value):
        if self.caption is not None:
            self.caption += value
        if self.cell is not None:
            self.cell += value

    def handle_endtag(self, tag):
        if tag == 'caption' and self.caption is not None:
            self.state = STATES.get(' '.join(self.caption.split()))
            self.caption = None
        elif tag == 'td' and self.cell is not None:
            self.cells.append(' '.join(self.cell.split()))
            self.cell = None
        elif tag == 'tr' and self.cells is not None:
            if len(self.cells) >= 3 and self.cells[2] == 'D':
                value = self.cells[0]
                number = 0 if value.lower() in ('at large', 'delegate', 'resident commissioner') else int(re.match(r'^(\d+)(?:st|nd|rd|th)$', value)[1]) if re.match(r'^(\d+)(?:st|nd|rd|th)$', value) else None
                urls = sorted(set(url for url in self.hrefs if official_url(url)))
                if number is not None and len(urls) == 1:
                    self.rows.append({'state': self.state, 'district': f'{self.state}{number:02d}', 'directoryName': self.cells[1], 'officialPage': urls[0], 'party': 'D'})
            self.cells, self.cell = None, None
        elif tag == 'table':
            self.state = None


def words(value):
    return set(re.findall(r'[a-z]+', ''.join(c for c in unicodedata.normalize('NFKD', value.lower()) if not unicodedata.combining(c))))


def map_directory(data, roster):
    parser = Directory()
    parser.feed(data.decode('utf-8'))
    results = []
    for member in roster['members']:
        candidates = [row for row in parser.rows if row['district'] == member['district'] and words(row['directoryName'].split(',')[0]) <= words(member['name'])]
        # Both sources must agree on the occupied district and surname. Never guess an alias.
        if len(candidates) == 1:
            results.append({**member, **candidates[0]})
    return results


class HouseRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not official_url(newurl):
            raise ValueError('The official page redirected outside House HTTPS hosts')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_page(url, output, stem):
    if not official_url(url):
        raise ValueError('Unsupported official source URL')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), HouseRedirect())
    request = urllib.request.Request(url, headers={'User-Agent': 'CaucusPulse/0.1 (public official-account verification)', 'Accept': 'text/html', 'Accept-Encoding': 'identity'})
    deadline = time.monotonic() + 40
    with opener.open(request, timeout=15) as response:
        if response.status != 200 or not official_url(response.url) or response.headers.get_content_type() != 'text/html':
            raise ValueError('Unexpected official page response')
        chunks, size = [], 0
        while True:
            block = response.read(65536)
            if not block:
                break
            size += len(block)
            if size > 3_000_000 or time.monotonic() > deadline:
                raise ValueError('Official page exceeded the fetch limit')
            chunks.append(block)
        data = b''.join(chunks)
        final_url = response.url
    retrieved_at = dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z')
    digest = hashlib.sha256(data).hexdigest()
    path = output / f'{stem}-{digest[:16]}.html'
    path.write_bytes(data)
    return data, {'sourceUrl': url, 'finalUrl': final_url, 'retrievedAt': retrieved_at, 'sha256': digest, 'file': path.name, 'bytes': len(data)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--roster', default='data/reference/house-roster.json')
    parser.add_argument('--output', default='data/reference/identity')
    parser.add_argument('--member-id', action='append', default=[])
    parser.add_argument('--limit', type=int, default=25)
    args = parser.parse_args()
    if not 1 <= args.limit <= 441:
        parser.error('Use a limit from 1 through 441')
    os.umask(0o077)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    roster = json.loads(Path(args.roster).read_text())
    raw, directory = fetch_page(DIRECTORY, output, 'house-directory')
    mapped = map_directory(raw, roster)
    selected = [member for member in mapped if not args.member_id or member['memberId'] in args.member_id][:args.limit]

    def fetch_member(member):
        try:
            data, page = fetch_page(member['officialPage'], output, member['memberId'])
            links = Links()
            links.feed(data.decode('utf-8', errors='replace'))
            profiles = {item['handle'].lower(): item for item in links.links}
            return {'memberId': member['memberId'], 'district': member['district'], 'directoryName': member['directoryName'], 'page': page, 'profiles': list(profiles.values()), 'status': 'observed'}
        except Exception:
            return {'memberId': member['memberId'], 'district': member['district'], 'status': 'unavailable', 'note': 'No ownership inference was made from a failed or unsupported page.'}

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        observations = list(executor.map(fetch_member, selected))
    report = {'schemaVersion': 1, 'policy': 'house-directory-office-link-v2', 'createdAt': dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z'), 'rosterHash': roster['id'], 'rosterRetrievedAt': roster['retrievedAt'], 'directory': directory, 'mappedMembers': len(mapped), 'rosterMembers': len(roster['members']), 'observations': observations, 'limitations': ['Office links are current observations, not historical ownership proof.', 'A profile anchor alone does not identify an X numeric author ID.', 'An unavailable page or missing link is not evidence that a member has no X account.']}
    path = output / f'account-evidence-{int(time.time() * 1000)}.json'
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'report': str(path), 'mappedMembers': len(mapped), 'attempted': len(selected), 'observed': sum(o['status'] == 'observed' for o in observations), 'profileLinks': sum(len(o.get('profiles', [])) for o in observations)}))


if __name__ == '__main__':
    main()
