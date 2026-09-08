"""Offline boundary checks for exact entity mentions; no model or network required."""
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('entity_extractor',Path(__file__).resolve().parents[1]/'scripts/entity-extractor.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class EntityTests(unittest.TestCase):
    def test_explicit_windows_reach_the_final_source_token(self):
        text='a b c d e f g h i j k';offsets=[(i,i+1) for i,c in enumerate(text) if c!=' '];ids=list(range(len(offsets)))
        windows=module.token_windows(text,ids,offsets,{'maxTokens':6,'overlapTokens':1,'maxWindows':10})
        self.assertEqual({i for window in windows for i in window['ids']},set(ids));self.assertEqual(windows[-1]['offsets'][-1][1],len(text));self.assertGreater(len(windows),2)
        self.assertFalse(windows[0]['startCut']);self.assertFalse(windows[-1]['endCut'])

    def test_missing_tokens_and_excess_windows_fail_instead_of_truncating(self):
        limits={'maxTokens':4,'overlapTokens':1,'maxWindows':2}
        for text,ids,offsets in [('abc',[1,2],[(0,1),(2,3)]),('abc',[1],[(0,1)]),('abcde',list(range(5)),[(i,i+1) for i in range(5)])]:
            with self.assertRaises(ValueError):module.token_windows(text,ids,offsets,limits)

    def test_original_unicode_and_spacing_survive_wordpieces(self):
        text='🌧 José  García spoke.'
        self.assertEqual(module.utf16_length(text),len(text)+1)
        result=module.named_tokens(text,[(0,0),(0,1),(2,6),(8,11),(11,14),(15,20),(0,0)],['O','O','B-PER','I-PER','I-PER','O','O'],[1,1,.98,.99,.97,1,1])
        self.assertEqual(result,[{'start':2,'end':14,'name':'José  García','kind':'person','score':.97}])
        mapped=module.mentions_in_passages(result,[{'id':'p1','text':'🌧 '},{'id':'p2','text':text[2:]}])
        self.assertEqual(mapped['entities'],[{'kind':'person','name':'José  García','contextId':'p2'}])

    def test_whole_names_are_rejected_for_low_scores_or_cut_window_edges(self):
        text='New York';offsets=[(0,0),(0,3),(4,8),(0,0)];labels=['O','B-LOC','I-LOC','O']
        self.assertEqual(module.named_tokens(text,offsets,labels,[1,.99,.4,1]),[])
        for flags in [{'start_cut':True},{'end_cut':True}]:self.assertEqual(module.named_tokens(text,offsets,labels,[1,.99,.99,1],**flags),[])
        self.assertEqual(module.named_tokens(text,offsets,labels,[1,.99,.99,1])[0]['name'],'New York')
        self.assertEqual(module.named_tokens('Routine',[(0,1),(1,4),(4,7)],['B-ORG','O','O'],[.99,.99,.99]),[])
        self.assertEqual(module.named_tokens('Routine',[(0,1),(1,4),(4,7)],['O','B-ORG','I-ORG'],[.99,.99,.99]),[])

    def test_adjacent_names_stay_separate_and_repeated_context_is_omitted(self):
        text='Alice Bob';result=module.named_tokens(text,[(0,5),(6,9)],['B-PER','B-PER'],[.99,.99])
        self.assertEqual([r['name'] for r in result],['Alice','Bob'])
        repeated=module.mentions_in_passages([{'start':0,'end':5,'name':'Alice','kind':'person'}],[{'id':'p1','text':'Alice thanked Alice.'}])
        self.assertEqual(repeated['entities'],[]);self.assertEqual(repeated['omitted'],1)

    def test_passage_splits_and_display_limits_do_not_create_partial_names(self):
        mentions=[{'start':0,'end':8,'name':'New York','kind':'location'}]
        result=module.mentions_in_passages(mentions,[{'id':'p1','text':'New '},{'id':'p2','text':'York'}])
        self.assertEqual(result['entities'],[]);self.assertEqual(result['omitted'],1)
        result=module.mentions_in_passages([{'start':0,'end':5,'name':'Alice','kind':'person'},{'start':6,'end':9,'name':'Bob','kind':'person'}],[{'id':'p1','text':'Alice Bob'}],limit=1)
        self.assertEqual(len(result['entities']),1);self.assertEqual(result['omitted'],1)

if __name__=='__main__':unittest.main()
