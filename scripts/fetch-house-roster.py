"""Fetch a dated House Clerk caucus inventory. Does not infer X account ownership."""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import urllib.request
import xml.etree.ElementTree as ET

SOURCE = 'https://clerk.house.gov/xml/lists/MemberData.xml'


def parse_roster(data, retrieved_at):
    if len(data) > 5_000_000 or b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        raise ValueError('Unsupported roster XML')
    root = ET.fromstring(data)
    if root.tag != 'MemberData':
        raise ValueError('Not a House Clerk roster')
    published = dt.datetime.strptime(root.attrib['publish-date'], '%B %d, %Y').date().isoformat()
    members = []
    for member in root.findall('./members/member'):
        info = member.find('member-info')
        if info is None or info.findtext('caucus') != 'D' or not info.findtext('bioguideID'):
            continue
        sworn = info.find('sworn-date')
        sworn_on = None
        if sworn is not None and sworn.attrib.get('date'):
            sworn_on = dt.datetime.strptime(sworn.attrib['date'], '%Y%m%d').date().isoformat()
        members.append({
            'memberId': info.findtext('bioguideID'), 'name': info.findtext('official-name'),
            'state': info.find('state').attrib['postal-code'], 'district': member.findtext('statedistrict'),
            'party': info.findtext('party'), 'caucus': info.findtext('caucus'), 'swornOn': sworn_on
        })
    if not 100 <= len(members) <= 441:
        raise ValueError('Unexpected roster size; inspect the source before import')
    return {'schemaVersion': 1, 'id': hashlib.sha256(data).hexdigest(), 'sourceUrl': SOURCE,
            'publishedOn': published, 'retrievedAt': retrieved_at,
            'congress': root.findtext('./title-info/congress-num'),
            'members': sorted(members, key=lambda member: member['memberId']),
            'limitations': ['Current Clerk snapshot; does not establish historical party affiliation before publication.',
                            'Includes delegates reported with Democratic caucus affiliation.',
                            'X account ownership and List membership are separate verifications.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', help='Parse an already downloaded Clerk XML instead of making a request')
    parser.add_argument('--output', default='data/reference/house-roster.json')
    parser.add_argument('--retrieved-at', help='Actual retrieval time for an existing XML file; required with --input')
    args = parser.parse_args()
    if args.input:
        if not args.retrieved_at:
            parser.error('--input requires its actual --retrieved-at time')
        data = Path(args.input).read_bytes()
        retrieved_at = args.retrieved_at
    else:
        with urllib.request.urlopen(SOURCE, timeout=30) as response:
            data = response.read(5_000_001)
        retrieved_at = dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z')
    snapshot = parse_roster(data, retrieved_at)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'members': len(snapshot['members']), 'publishedOn': snapshot['publishedOn'],
                      'sourceUrl': SOURCE, 'output': str(output)}))


if __name__ == '__main__':
    main()
