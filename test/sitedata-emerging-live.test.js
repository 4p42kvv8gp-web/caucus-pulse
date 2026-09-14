import test from 'node:test';
import assert from 'node:assert/strict';
import {combineEmergingSources} from '../src/sitedata.js';

const now=Date.parse('2026-09-14T12:00:00Z');
const posts=[
 {id:'1',authorId:'old',createdAt:'2026-09-10T12:00:00Z'},
 {id:'2',authorId:'a',createdAt:'2026-09-14T09:00:00Z'},
 {id:'3',authorId:'b',createdAt:'2026-09-14T10:00:00Z'},
 {id:'4',authorId:'c',createdAt:'2026-09-14T11:00:00Z'},
 {id:'5',authorId:'alias',createdAt:'2026-09-14T11:30:00Z'}
];
const authorsById={old:{member:'Prior Member'},a:{member:'Member A'},b:{member:'Member B'},c:{member:'Member C'},alias:{member:'Member A'}};
const placed=[{label:'Existing placed story',key:'existing-story',macro:'immigration',ids:['1']}];
test('an existing placed story never suppresses a fresh live discovery from three members',()=>{
 const result=combineEmergingSources({placed,raw:[{label:'Liam Ramos / Dilley',ids:['2','3','4','4','invented','999']}],posts,authorsById,now});
 assert.equal(result.length,2);
 assert.equal(result[0].label,'Liam Ramos / Dilley');
 assert.equal(result[0].thresholdMet,true);
 assert.equal(result[0].activeMembers,3);
 assert.equal(result[0].provisional,true);
 assert.deepEqual(result[0].ids,['2','3','4']);
 assert.equal(result[1].label,'Existing placed story');
});
test('exact label matches merge IDs, account aliases do not inflate members, and broad categories do not merge unrelated stories',()=>{
 const result=combineEmergingSources({placed,raw:[
  {label:'Liam Ramos / Dilley',macro:'immigration',ids:['2','5']},
  {label:'LIAM RAMOS — DILLEY',macro:'immigration',ids:['3']},
  {label:'Separate Dilley facility case',macro:'immigration',ids:['4']}
 ],posts,authorsById,now});
 const liam=result.find((entry)=>entry.label==='Liam Ramos / Dilley');
 assert.deepEqual(liam.ids,['2','5','3']);
 assert.equal(liam.memberCount,2);
 assert.equal(liam.thresholdMet,false);
 assert.equal(result.length,3);
});
