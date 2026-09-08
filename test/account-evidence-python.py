"""Offline checks for public identity evidence parsing; no real verification fixtures."""
import importlib.util
import json
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('account_evidence',Path(__file__).resolve().parents[1]/'scripts/fetch-account-evidence.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class EvidenceTests(unittest.TestCase):
    def test_legacy_links_are_normalized_without_fetching(self):
        p=module.Links()
        p.feed('<a href="http://www.twitter.com/@RepSynthetic/">X</a><a href="hhttp://twitter.com/Someone">bad</a><a href="http://x.com:80/Someone">bad</a>')
        self.assertEqual(p.links,[{'handle':'RepSynthetic','url':'https://x.com/RepSynthetic','observedHref':'http://www.twitter.com/@RepSynthetic/','sourceKind':'anchor'}])

    def test_only_enabled_known_drupal_social_configuration(self):
        config={'evo_social_icons':{'EvoSocialIconsJS':{'order':{'-1':{'X':{'checkbox':'1','url':'https://x.com/RepSynthetic'}},'0':{'X':{'checkbox':'0','url':'https://x.com/Disabled'}},'1':{'Facebook':{'checkbox':'1','url':'https://x.com/WrongPlatform'}}}}}}
        p=module.Links()
        p.feed('<script type="application/json" data-drupal-selector="drupal-settings-json">'+json.dumps(config)+'</script><script>"https://x.com/Someone"</script>')
        self.assertEqual(len(p.links),1)
        self.assertEqual(p.links[0]['sourceKind'],'drupal-social-settings')
        q=module.Links();q.feed('<script type="application/json">'+json.dumps(config)+'</script>')
        self.assertEqual(q.links,[])

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
