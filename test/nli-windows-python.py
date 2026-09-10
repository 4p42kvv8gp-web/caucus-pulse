"""Offline source-coverage checks; no model loading or network access."""
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('nli_worker',Path(__file__).resolve().parents[1]/'scripts/nli-classifier-worker.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CharacterTokenizer:
    def encode(self,text,**kwargs):
        return list(text)


class WindowTests(unittest.TestCase):
    limits={'maxPassagesPerWindow':3,'maxSequenceTokens':110,'maxWindows':30}

    def test_all_source_passages_survive_with_overlap(self):
        passages=[{'id':f'p{i+1}','text':f'{i:02d} words. '} for i in range(20)]
        windows=module.source_windows(passages,CharacterTokenizer(),self.limits)
        self.assertEqual({i for w in windows for i in w['ids']},{p['id'] for p in passages})
        self.assertTrue(all(len(w['text'])<=14 for w in windows))

    def test_source_limit_is_explicit_and_does_not_truncate(self):
        with self.assertRaises(module.InputLimit):
            module.source_windows([{'id':'p1','text':'x'*15}],CharacterTokenizer(),self.limits)
        with self.assertRaises(module.InputLimit):
            module.source_windows([{'id':f'p{i+1}','text':'words.'} for i in range(5)],CharacterTokenizer(),{**self.limits,'maxWindows':1})

    def test_original_whitespace_is_retained_but_not_used_as_evidence_alone(self):
        passages=[{'id':'p1','text':'A. '},{'id':'p2','text':'\n\n'},{'id':'p3','text':'B.\n'}]
        windows=module.source_windows(passages,CharacterTokenizer(),self.limits)
        self.assertEqual(windows[0]['text'],'A. \n\nB.\n')
        self.assertEqual(windows[0]['ids'],['p1','p3'])


if __name__=='__main__':
    unittest.main()
