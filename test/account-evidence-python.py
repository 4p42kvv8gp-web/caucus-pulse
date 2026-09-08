"""Offline checks for public identity evidence parsing; no real verification fixtures."""
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('account_evidence',Path(__file__).resolve().parents[1]/'scripts/fetch-account-evidence.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class EvidenceTests(unittest.TestCase):
    def test_only_profile_anchors(self):
        p=module.Links()
        p.feed('''<a href="https://twitter.com/RepSynthetic ">X</a><a href="https://x.com/RepSynthetic/status/12">post</a><a href="https://x.com/intent/tweet">share</a><a href="https://x.com.evil.invalid/RepSynthetic">bad</a><script>"https://x.com/Someone"</script>''')
        self.assertEqual([link['handle'] for link in p.links],['RepSynthetic'])

    def test_directory_agrees_on_district_and_surname(self):
        raw=b'''<table><caption id="state-new-jersey">New Jersey</caption><tr><td>5th</td><td><a href="https://synthetic.house.gov">Example, Test</a></td><td>D</td></tr></table>'''
        roster={'members':[{'memberId':'T000001','district':'NJ05','state':'NJ','name':'Test Example'}]}
        self.assertEqual(len(module.map_directory(raw,roster)),1)
        roster['members'][0]['district']='NJ06'
        self.assertEqual(module.map_directory(raw,roster),[])
        roster['members'][0].update(district='NJ05',name='Another Person')
        self.assertEqual(module.map_directory(raw,roster),[])

    def test_urls_reject_credentials_ports_and_nonhouse_redirects(self):
        for value in ['https://synthetic.house.gov.evil.invalid','http://synthetic.house.gov','https://x@synthetic.house.gov','https://synthetic.house.gov:8443']:
            self.assertFalse(module.official_url(value))
        for value in ['https://x.com:8443/RepSynthetic','https://x@x.com/RepSynthetic','https://x.com/intent']:
            self.assertIsNone(module.profile_url(value))


if __name__=='__main__':
    unittest.main()
