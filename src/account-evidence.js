import { createHash } from 'node:crypto';
import { atomic } from './sqlite.js';
import { verifyAccountBinding, promoteCaptured } from './roster.js';

const DAY=86_400_000;
const normalized=value=>new Date(value).toISOString();
function current(value,now){
  const at=Date.parse(value);
  if(!Number.isFinite(at)||at>now||now-at>DAY)throw new Error('Account evidence is stale or future dated.');
  return at;
}
function housePage(value){
  const url=new URL(value);
  if(url.protocol!=='https:'||!url.hostname.endsWith('.house.gov')||url.username||url.password||url.port)throw new Error('Invalid House evidence URL.');
  return url;
}
function profilePage(value){
  const url=new URL(value),handle=url.pathname.replace(/^\//,'').replace(/\/$/,'');
  if(url.protocol!=='https:'||!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname)||url.username||url.password||url.port||!/^[A-Za-z0-9_]{1,15}$/.test(handle)||/^(home|share|intent|search|i|hashtag|explore|settings|login)$/i.test(handle))throw new Error('Invalid X profile link.');
  return handle.toLowerCase();
}
function observedProfile(value,legacy){
  if(!legacy)return profilePage(value);
  const match=typeof value==='string'&&value.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})\/?(?:[?#][^\s]*)?$/i);
  if(!match)throw new Error('Invalid observed X profile link.');
  return profilePage(`https://x.com/${match[1]}`);
}
function verifySource(source,loadSource,now){
  if(!source||!/^[A-Za-z0-9-]+\.html$/.test(source.file??'')||!Number.isInteger(source.bytes)||source.bytes<1||source.bytes>3_000_000||!/^[a-f0-9]{64}$/.test(source.sha256??''))throw new Error('Invalid source artifact.');
  housePage(source.sourceUrl);housePage(source.finalUrl);current(source.retrievedAt,now);
  const bytes=loadSource(source.file);
  if(!Buffer.isBuffer(bytes)||bytes.length!==source.bytes||createHash('sha256').update(bytes).digest('hex')!==source.sha256)throw new Error('Source evidence hash or size does not match.');
}

/** Reads only local proof artifacts and previously observed numeric X profiles. */
export function accountEvidenceCandidates(store,report,{loadSource,listId,now=Date.now()}={}){
  if(!report||report.schemaVersion!==1||!['house-directory-office-link-v1','house-directory-office-link-v2'].includes(report.policy)||!Array.isArray(report.observations)||report.observations.length>441||typeof loadSource!=='function'||!/^\d+$/.test(listId??''))throw new Error('Invalid official account evidence report.');
  const v2=report.policy==='house-directory-office-link-v2';
  current(report.createdAt,now);
  if(report.directory?.sourceUrl!=='https://www.house.gov/representatives'||report.directory?.finalUrl!=='https://www.house.gov/representatives')throw new Error('The House directory source does not match.');
  verifySource(report.directory,loadSource,now);
  const roster=store.db.prepare('SELECT * FROM roster_snapshots WHERE id=?').get(`${report.rosterHash}:${normalized(report.rosterRetrievedAt)}`);
  if(!roster||Date.parse(roster.valid_until)<=now)throw new Error('A current matching Clerk snapshot is required.');
  const seen=new Set(),items=[];
  for(const observation of report.observations){
    if(seen.has(observation.memberId))throw new Error('Duplicate member evidence.');seen.add(observation.memberId);
    const member=store.db.prepare('SELECT * FROM roster_members WHERE snapshot_id=? AND member_id=?').get(roster.id,observation.memberId);
    if(!member||member.district!==observation.district)throw new Error('The directory observation does not match the roster district.');
    const item={memberId:member.member_id,memberName:member.member_name,district:member.district,status:'page-unavailable'};
    if(observation.status!=='observed'){items.push(item);continue;}
    verifySource(observation.page,loadSource,now);
    if(!Array.isArray(observation.profiles)||observation.profiles.length>100)throw new Error('Invalid observed profiles.');
    if(observation.profiles.length!==1){items.push({...item,status:observation.profiles.length?'multiple-profile-links':'no-profile-link'});continue;}
    const profile=observation.profiles[0],handle=profilePage(profile.url);
    if(observedProfile(profile.observedHref,v2)!==handle||profile.handle?.toLowerCase()!==handle)throw new Error('Observed profile links disagree.');
    if(v2&&!['anchor','drupal-social-settings'].includes(profile.sourceKind))throw new Error('Invalid office profile source kind.');
    if(['housedemocrats','theblackcaucus','demcaucus'].includes(handle)){
      items.push({...item,handle:profile.handle,status:'shared-organization-profile'});continue;
    }
    const matches=store.db.prepare(`SELECT a.*,r.list_id FROM list_inventory_accounts a JOIN list_inventory_runs r ON r.id=a.run_id
      WHERE r.list_id=? AND a.username=? COLLATE NOCASE AND a.observed_at>=? AND a.observed_at<=? ORDER BY a.observed_at DESC LIMIT 100`)
      .all(listId,handle,normalized(now-DAY),normalized(now));
    if(!matches.length){items.push({...item,handle:profile.handle,status:'numeric-profile-not-observed'});continue;}
    if(new Set(matches.map(row=>row.author_id)).size!==1){items.push({...item,handle:profile.handle,status:'conflicting-numeric-profiles'});continue;}
    const observed=matches[0];
    // Generic/personal/campaign-looking profiles remain candidates for separate account-type review.
    if(!/^(rep|congress|cong|usrep)/i.test(profile.handle)&&!/\b(rep\.?|congressman|congresswoman|representative)\b/i.test(observed.display_name)){
      items.push({...item,handle:profile.handle,authorId:observed.author_id,status:'account-type-review'});continue;
    }
    const end=Math.min(Date.parse(roster.valid_until),Date.parse(observation.page.retrievedAt)+DAY,Date.parse(observed.observed_at)+DAY);
    const start=Math.max(Date.parse(`${roster.published_on}T00:00:00Z`),now-DAY);
    const binding={memberId:member.member_id,authorId:observed.author_id,handle:profile.handle,accountType:'official',validFrom:normalized(start),validUntil:normalized(end),
      evidence:{officialPage:observation.page.finalUrl,linkedProfile:v2?profile.url:profile.observedHref,
        ...(v2?{observedProfileUrl:profile.observedHref,profileSourceKind:profile.sourceKind}:{}),
        xUser:{id:observed.author_id,username:observed.username,retrievedAt:observed.observed_at},
        explanation:'The current House directory links this member and district to an office website; that page identifies one X profile through a link or its social-icon settings, matched to a numeric author ID observed in the supplied List. The observed URL is preserved; older HTTP/profile formatting is normalized without following it. A limited current observation window is used operationally; it does not establish historical ownership.',
        policy:report.policy,ownershipBasis:'current-observation-window',directory:report.directory,officePage:observation.page,
        directoryName:observation.directoryName,rosterSnapshotId:roster.id,listId,listInventoryRunId:observed.run_id}};
    const overlaps=store.db.prepare('SELECT member_id,handle,account_type,valid_from,valid_until FROM account_bindings WHERE author_id=? AND valid_from<? AND valid_until>? ORDER BY valid_from').all(binding.authorId,binding.validUntil,binding.validFrom);
    const conflict=overlaps.some(row=>row.member_id!==binding.memberId||row.handle.toLowerCase()!==handle||row.account_type!=='official');
    const gaps=[];let cursor=binding.validFrom;
    if(!conflict){
      for(const prior of overlaps){
        if(prior.valid_from>cursor)gaps.push({...binding,validFrom:cursor,validUntil:prior.valid_from<binding.validUntil?prior.valid_from:binding.validUntil});
        if(prior.valid_until>cursor)cursor=prior.valid_until;
      }
      if(cursor<binding.validUntil)gaps.push({...binding,validFrom:cursor});
    }
    const status=conflict?'ownership-conflict':gaps.length?'ready':'already-covered';
    items.push({...item,handle:profile.handle,authorId:observed.author_id,status,binding,bindings:gaps});
  }
  // A page linked by two distinct member observations cannot silently assign the same author twice.
  const owners=new Map();
  for(const item of items.filter(i=>i.binding)){
    const members=owners.get(item.authorId)??new Set();members.add(item.memberId);owners.set(item.authorId,members);
  }
  for(const item of items)if(owners.get(item.authorId)?.size>1)item.status='ownership-conflict';
  return {policy:report.policy,listId,checkedAt:normalized(now),items,
    counts:items.reduce((counts,item)=>(counts[item.status]=(counts[item.status]??0)+1,counts),{}),
    note:'Current office-linked identity evidence only. This does not complete the List inventory or prove historical ownership.'};
}

export function applyAccountEvidence(store,candidates,{now=Date.now()}={}){
  if(!candidates||!Array.isArray(candidates.items)||candidates.items.length>441||!Number.isFinite(Date.parse(candidates.checkedAt))||now-Date.parse(candidates.checkedAt)>60_000||Date.parse(candidates.checkedAt)>now)throw new Error('Account evidence preview expired.');
  return atomic(store.db,()=>{
    const bindings=candidates.items.filter(item=>item.status==='ready').flatMap(item=>(item.bindings??[item.binding]).map(binding=>verifyAccountBinding(store.db,binding,{now})));
    return {bindingsAdded:bindings.length,promotion:promoteCaptured(store,{now}),note:candidates.note};
  });
}
