# Incident desk audit — 2026-09-10

Audit of every incident in `data/incidents.json` (generated 2026-09-10T06:40:32.563Z, 29 incidents: 5 active, 5 monitoring, 19 resolved) against the classifier prompt’s own definition in `src/taxonomy.js`: *a breaking district emergency the member is personally handling (active shooter, flood, wildfire, major accident, infrastructure failure — not national policy news)*. Machine-readable verdicts are in `data/incident-audit.json`.

## Headline

| | Count |
|---|---|
| TRUE — real, current, in-district, member acting, correctly located | **10** |
| FALSE POSITIVE — past event, reaction, policy, wrong place, out of district | **14** |
| AMBIGUOUS — advisory-class or mixed signals (see reasons) | **5** |
| Precision, TRUE / (TRUE + FALSE POSITIVE) | **0.417** |
| Precision, TRUE / all 29 (ambiguous counted as wrong) | 0.345 |
| Precision, House members only (drops the two Senator incidents) | 0.364 |

The five **active** incidents are what the dashboard shows as “Breaking in district” right now: `san-diego-ca--extreme-heat` (AMBIGUOUS), `kauai-hi--tropical-storm` (AMBIGUOUS), `ka-hi--hurricane-damage` (FALSE POSITIVE), `napa-county-ca--wildfire` (TRUE), `miami-fl--plane-crash` (FALSE POSITIVE). One of the five cards is a true breaking incident.

Sixteen of the 29 incidents are fragments of six events (see Grouping). No two different events were merged.

## Method

Each incident’s source posts were read from data/archive (full text, type, quoted/retweeted id), the author from data/authors.json (handle, stateDistrict, house/senate), and the classifier’s kind/place from data/topics/<date>.json. Verdicts follow the prompt’s own definition: a breaking district emergency the member is personally handling, correctly located. External facts used only to settle dates and places the corpus cannot: Hurricane Lala landfall 15-16 Aug (weather.com), Hurricane Lowell over Kauaʻi/Niʻihau 7-8 Sept (Honolulu Civil Beat, Star-Advertiser), 21 Air Flight 7598 runway overrun at MIA 6 Sept (Wikipedia, NPR), the 3-4 Sept Airport Fire in Thermal, Riverside County (KESQ, CAL FIRE), the Austin/Narrows fires in Mt. Hood National Forest (InciWeb, NWCC), the Aspen Acres and Gold Mountain fires and their 4 Sept declaration (CPR), and CA-38 including La Habra (lindasanchez.house.gov).

## Verdicts

| # | Incident | Status | Lead member (district) | Verdict | Why |
|---|---|---|---|---|---|
| 1 | `san-diego-ca--extreme-heat` | active | Scott H. Peters (CA-50) | **AMBIGUOUS** | Heat advisory PSA, in-district; advisory-class, no impact reported |
| 2 | `kauai-hi--tropical-storm` | active | Ed Case (HI-01) | **AMBIGUOUS** | Hurricane Lowell 7-8 Sept is real and current; Kauaʻi is HI-02 not HI-01; framed as recovery; kind should be hurricane |
| 3 | `ka-hi--hurricane-damage` | active | Jill N. Tokuda (HI-02) | **FALSE POSITIVE** | Lala hit 15-16 Aug; recovery advocacy 3.5 weeks later; split of hawaii-island key |
| 4 | `napa-county-ca--wildfire` | active | Mike Thompson (CA-04) | **TRUE** | Live evacuation warning, Steele Fire, in-district |
| 5 | `miami-fl--plane-crash` | active | Darren Soto (FL-09) +3 | **FALSE POSITIVE** | Four condolence posts about the 6 Sept MIA crash; no member handling; lead FL-09 and one MN-04 are far from Miami |
| 6 | `eastern-oregon-or--wildfire` | monitoring | Maxine Dexter (OR-03) | **FALSE POSITIVE** | Austin/Narrows fires are in Mt. Hood NF, not Eastern Oregon; site visit + legislation |
| 7 | `monterey-county-ca--wildfire` | monitoring | Jimmy Panetta (CA-19) | **TRUE** | Timber/Plaskett evacuation and containment updates, in-district; split with big-sur |
| 8 | `la-habra-ca--chemical-leak` | monitoring | Linda T. Sánchez (CA-38) | **TRUE** | All-clear RTs for the 8 Sept hazmat evacuation; split from hazmat-release by a kind synonym |
| 9 | `la-habra-ca--hazmat-release` | monitoring | Linda T. Sánchez (CA-38) | **TRUE** | Live 1-mile evacuation order relayed to residents |
| 10 | `orange-and-la-counties-ca--extreme-heat` | monitoring | Derek Tran (CA-45) | **AMBIGUOUS** | Extreme Heat Warning PSA; advisory-class |
| 11 | `gary-in--storm-damage` | resolved | Frank J. Mrvan (IN-01) | **FALSE POSITIVE** | Recovery admin for the 11 Aug storm; one of four Mrvan keys |
| 12 | `lake-station-in--flooding` | resolved | Frank J. Mrvan (IN-01) | **FALSE POSITIVE** | Same recovery thread; "flooding" not in post |
| 13 | `porter-county-in--storm-damage` | resolved | Frank J. Mrvan (IN-01) | **FALSE POSITIVE** | Assistance event "next week" for a 3.5-week-old storm |
| 14 | `indianapolis-in--flooding` | resolved | André Carson (IN-07) | **FALSE POSITIVE** | FEMA deadline PSA for mid-August flooding |
| 15 | `big-sur-ca--wildfire` | resolved | Jimmy Panetta (CA-19) | **TRUE** | Highway 1 reopening on the Timber/Plaskett fires; same event as monterey-county |
| 16 | `detroit-mi--tornado` | resolved | Sen. Elissa Slotkin (US Senate) | **TRUE** | 3 Sept tornado, resources two days later; author is a Senator; one of four keys for the storm |
| 17 | `detroit-mi--severe-storms` | resolved | Shri Thanedar (MI-13) | **TRUE** | Next-day shelter and outage hotlines, in-district; split |
| 18 | `aspen-acres-gold-mountain-co--wildfire` | resolved | Brittany Pettersen (CO-07) | **FALSE POSITIVE** | Disaster declaration for June fires; "spent months" in post; split with aspen-co |
| 19 | `lake-county-ca--wildfire` | resolved | Mike Thompson (CA-04) | **TRUE** | Live evacuation order, Scott Fire, in-district |
| 20 | `northwest-indiana-in--storm-damage` | resolved | Frank J. Mrvan (IN-01) | **FALSE POSITIVE** | USDA assistance for "the August storm" |
| 21 | `washington-wa--wildfire` | resolved | Kim Schrier (WA-08) | **FALSE POSITIVE** | Weekly newsletter; no specific fire; place is a state |
| 22 | `orange-county-ca--wildfire` | resolved | Raul Ruiz (CA-25) | **FALSE POSITIVE** | Airport Fire was 50 acres in Thermal (Riverside County, CA-25), not Orange County; contained, no evacuations |
| 23 | `illinois-il--severe-storms` | resolved | Robin L. Kelly (IL-02) | **FALSE POSITIVE** | Thank-you for July/August storms; place is a state |
| 24 | `southeast-michigan-mi--severe-storms` | resolved | Sen. Elissa Slotkin (US Senate) | **TRUE** | Next-day storm post, office engaged; author is a Senator; split |
| 25 | `hawaii-island-hi--hurricane-damage` | resolved | Jill N. Tokuda (HI-02) | **FALSE POSITIVE** | "Lala is gone"; damage tour 18 days after landfall |
| 26 | `burlingame-ca--train-collision` | resolved | Kevin Mullin (CA-15) | **AMBIGUOUS** | Real in-district collision but an advocacy post; below "major accident" |
| 27 | `michigan-mi--severe-weather` | resolved | Debbie Dingell (MI-06) | **AMBIGUOUS** | Generic stay-alert quote; quoted post not in corpus; place is a state; belongs to the SE Michigan cluster |
| 28 | `detroit-mi--power-outage` | resolved | Rashida Tlaib (MI-12) | **TRUE** | DTE outages, office engaged, hotline; in-district |
| 29 | `aspen-co--wildfire` | resolved | Jason Crow (CO-06) | **FALSE POSITIVE** | Declaration advocacy for June fires; out of district; "Aspen, CO" is the wrong place |

Full reasons, the exact quoted evidence span, the corrected kind/place and the post ids for each row are in `data/incident-audit.json` → `verdicts`.

## Grouping

- **split** — `la-habra-ca--hazmat-release`, `la-habra-ca--chemical-leak`: 8 Sept La Habra hazmat evacuation (one member, three posts in 2.5 hours) _(cause: kind synonym: "hazmat release" vs "chemical leak")_
- **split** — `monterey-county-ca--wildfire`, `big-sur-ca--wildfire`: Timber & Plaskett fires, Monterey County (one member, 28 flags across the corpus; a third key, mariposa-county-ca--wildfire, held a Timber Fire RT with a hallucinated county) _(cause: place granularity: county vs locality)_
- **split** — `detroit-mi--tornado`, `detroit-mi--severe-storms`, `southeast-michigan-mi--severe-storms`, `michigan-mi--severe-weather`: 3 Sept Southeast Michigan storm / Detroit east-side tornado (four members) _(cause: place granularity (city / region / state) and kind synonyms (tornado / severe storms / severe weather); detroit-mi--power-outage (same afternoon, DTE outages attributed to the heat wave) is possibly the same event)_
- **split** — `gary-in--storm-damage`, `lake-station-in--flooding`, `porter-county-in--storm-damage`, `northwest-indiana-in--storm-damage`: 11 Aug Northwest Indiana storm recovery (one member’s daily updates; nine keys across the corpus including calumet-township-in--severe-storms, district--storm-recovery, gary-in--power-outage, lake-county-in--disaster-recovery, northwest-indiana-in--flooding, northwest-indiana-in--severe-storms and a Mrvan post keyed to passaic-county-nj--power-outage) _(cause: place taken from whichever town the day’s update mentioned; kind varies between storm damage / flooding / power outage / disaster recovery; one place hallucinated into New Jersey)_
- **split** — `ka-hi--hurricane-damage`, `hawaii-island-hi--hurricane-damage`: Hurricane Lala aftermath, Hawaiʻi Island (one member) _(cause: place granularity: district (Kaʻū) vs island)_
- **split** — `aspen-acres-gold-mountain-co--wildfire`, `aspen-co--wildfire`: Aspen Acres & Gold Mountain fires disaster declaration (two members) _(cause: fire name truncated to "Aspen" (which is also a different place) by one classification)_
- **possible-split** — `san-diego-ca--extreme-heat`, `orange-and-la-counties-ca--extreme-heat`: 8-9 Sept Southern California Extreme Heat Warning _(cause: regional advisory keyed by each member’s own area; moot if advisories are excluded)_
- **no-merge-errors** — No two different events were merged into one incident in the current file. napa-county-ca--wildfire (Steele Fire) and lake-county-ca--wildfire (Scott Fire) are correctly separate; monterey-county-ca--wildfire covers two fires (Timber, Plaskett) that the member reports jointly, which is acceptable.
- **cross-member-merge-with-wrong-lead** — `miami-fl--plane-crash`: Four members’ reaction posts to the MIA crash grouped correctly by kind+place, but the incident takes the first poster’s district (FL-09, Central Florida) as its location suffix and lead; one poster is from Minnesota _(cause: incidents.js appends the lead author’s stateDistrict to the place without checking that the place is in it)_

Across the whole corpus (174 flags, 20 days) there are 102 distinct incident keys and 41 distinct kind strings; the same pattern recurs outside the current window: the 30-31 Aug Grand Canyon flooding sits under four keys (`flash-flooding`, `flooding`, `missing-hikers`, `missing-persons`), the 2 Sept Minneapolis shooting under three (`active-shooter`, `mass-shooting`, `shooting`), the 31 Aug Tucson shooting under three, and Tropical Storm Edouard in Houston under three (`flooding`, `tropical-storm`, `hurricane-landfall`) plus `harris-county-tx--flooding`.

## Pipeline issues (not the prompt)

- **roster** — Non-House accounts produce incidents: two of the 29 (detroit-mi--tornado, southeast-michigan-mi--severe-storms) are from @SenatorSlotkin; across the corpus 14 of 174 flags come from @SenatorSlotkin, @SenAdamSchiff, @RubenGallego/@SenRubenGallego and @GovSherrillNJ. sitedata.js filters non-House accounts out of the feed and member counts but incidents.js applies no such filter.
- **district-suffix** — incidents.js sets place = flag.place + " · " + leadAuthor.stateDistrict. When the flagged place is outside the lead’s district the card is wrong: "Kauai, HI · HI-01" (Kauaʻi is HI-02), "Miami, FL · FL-09" (Central Florida), "Aspen, CO · CO-06" (Aurora), "Orange County, CA · CA-25" (Coachella Valley), "Eastern Oregon, OR · OR-03" (Portland). In the wider corpus gary-in--power-outage would have led with IL-03 (Delia Ramirez) for Gary, Indiana.
- **lifecycle** — The active/monitoring/resolved lifecycle keys off the last member post, so a member who posts daily recovery updates (Mrvan, 11 Aug storm) keeps a four-week-old event alive indefinitely, and a slow-burn fire with a weekly update (Panetta) oscillates between resolved and active. There is no cap on incident age.
- **no-author-context** — chunkRequests sends only {id, text}; the model never sees the author’s handle, state or district, so it cannot tell in-district from out-of-district and cannot supply a state when the tweet omits one. It also sees one 40-tweet chunk at a time, so "reuse identical kind+place strings" cannot work across chunks or days.
- **kind-vocabulary** — 41 distinct kind strings across 174 flags ("flooding", "flash flooding", "heavy rain flooding", "heavy rain"; "shooting", "mass shooting", "active shooter", "shooting attack", "hate crime shooting"; "hazmat incident", "hazmat release", "chemical leak"; "power outage", "storm power outage"). incidentKey() only lower-cases and strips punctuation, so every synonym is a new incident.

## Failure modes

### Aftermath and recovery posts flagged as breaking

_12 of 29 incidents._ The largest failure. Eleven of the fourteen false positives are posts about the recovery from an event weeks old: FEMA/USDA assistance information, application deadlines, disaster-declaration requests and approvals, intake-centre schedules, daily "storm update" newsletters, thank-you messages and site visits. The prompt says "breaking" but gives no test for it, and the posts carry unmistakable cues the model ignored: "recovering", "storm recovery", "the August storm", "recover after the July and August severe storms", "apply by October 25", "Lala is gone", "left behind", "spent months wondering".

Examples:
  - `gary-in--storm-damage` (Frank J. Mrvan, IN-01): “As we continue in the storm recovery, I wanted to share information today on certain assistance that is now available from the City of Gary.”
  - `indianapolis-in--flooding` (André Carson, IN-07): “If you were impacted by recent flooding in Indianapolis, federal assistance may be available. Here’s what you need to know to apply by October 25, 2026.”
  - `hawaii-island-hi--hurricane-damage` (Jill N. Tokuda, HI-02): “Lala is gone, but for families across Hawaiʻi Island, the work is just beginning. I saw washed-out roads, damaged homes and schools, and communities still picking up the pieces.”
  - `aspen-acres-gold-mountain-co--wildfire` (Brittany Pettersen, CO-07): “This disaster declaration is a critical step forward for every family affected by the Aspen Acres and Gold Mountain fires who have been desperately waiting for this moment. These communities have endured unimaginable loss &amp; spent months wondering whether help was coming.”
  - `washington-wa--wildfire` (Kim Schrier, WA-08): “Here is this week’s Schrier Flyer - with another round of wildfire resources.”

### Reaction and condolence posts from members who are not handling the event

_1 of 29 incidents._ A real emergency somewhere in the country draws "heartbroken", "praying for", "horrified to hear" posts from members far from it. The prompt says "the member is personally handling" but gives no test for handling, so the model flags any member who mentions the event. In the current file this is the MIA crash (four members, one in Minnesota); in the wider corpus the 2 Sept Minneapolis shooting drew a flagged reaction from NY-25, the Grand Canyon flooding from NV-01, and the Gary, Indiana outage from IL-03 and MI-12.

Examples:
  - `miami-fl--plane-crash` (Darren Soto, FL-09): “What a tragedy. Praying for the families of those who perished at Miami Airport […] / It is devastating to see the loss of five lives as a result of the Amazon plane that over ran the runway at the Miami International Airport.”

### Weather advisories and PSAs treated as emergencies

_3 of 29 incidents._ Heat advisories with cooling-centre links, flood watches, "stay safe and stay alert" posts and travel advisories are flagged with kinds like "extreme heat", "heat advisory", "heat wave", "severe weather". Twelve of the 174 corpus flags are heat PSAs alone (LA County x4, Chicago/Cook County x4, Orange County, Southern California, St. Louis, San Diego). They report no impact and involve no member action beyond a link; the prompt’s examples are all impact events.

Examples:
  - `san-diego-ca--extreme-heat` (Scott H. Peters, CA-50): “San Diego is experiencing an extreme heat wave expected to last through 8pm today and possibly into tomorrow. Find a designated cool zone near you”
  - `orange-and-la-counties-ca--extreme-heat` (Derek Tran, CA-45): “Orange and L.A. counties are under an Extreme Heat Warning through Wednesday, September 9th”
  - `michigan-mi--severe-weather` (Debbie Dingell, MI-06): “Stay safe and stay alert, Michigan. Follow local news for the latest information and heed warnings from public safety officials.”

### Place invented when the tweet names none

_3 of 29 incidents._ When the tweet names a fire but not a location, the model fills in a place from its own associations: "#AirportFire" became Orange County (the 2024 fire of that name) although this one was in Thermal, Riverside County; the Austin and Narrows fires became "Eastern Oregon" although they are in Mt. Hood National Forest; the Aspen Acres Fire became "Aspen, CO", a different place 200 miles away. In the wider corpus a Mrvan storm-recovery post was placed in "Passaic County, NJ" and a Timber Fire RT in "Mariposa County". The card then carries the wrong county and a wrong district suffix.

Examples:
  - `orange-county-ca--wildfire` (Raul Ruiz, CA-25): “Emergency responders have successfully stopped the #AirportFire’s forward spread across approximately 50 acres”
  - `eastern-oregon-or--wildfire` (Maxine Dexter, OR-03): “I visited the incident command posts servicing the Austin and Narrows fires with @SenJeffMerkley to learn how to better support our firefighters this wildfire season and beyond.”
  - `aspen-co--wildfire` (Jason Crow, CO-06): “Every member of Colorado’s congressional delegation is calling on President Trump to do the right thing and support a major disaster declaration for the Aspen and Gold Mountain fires.”

### One event split across several incidents

_16 of 29 incidents._ The desk keys incidents on the exact normalised kind+place string, and the model has no memory across chunks or days, so the same event lands under several keys: city vs county vs region vs state ("Detroit" / "Southeast Michigan" / "Michigan"; "Big Sur" / "Monterey County"; "Kaʻū" / "Hawaii Island"), kind synonyms ("hazmat release" / "chemical leak"; "tornado" / "severe storms" / "severe weather"), and whichever town a daily update happened to mention (Gary / Lake Station / Porter County / Northwest Indiana). Sixteen of the 29 incidents are fragments of six events.

Examples:
  - `la-habra-ca--chemical-leak` (Linda T. Sánchez, CA-38): “RT @ocregister: Shelter-in-place order lifted following hazmat incident in La Habra”
  - `big-sur-ca--wildfire` (Jimmy Panetta, CA-19): “Part of Highway 1 is reopen for Big Sur businesses and residents. We are grateful to the firefighters and first responders who are working around the clock to protect our communities and put out the fires.”
  - `detroit-mi--tornado` (Sen. Elissa Slotkin, US Senate): “The National Weather Service has confirmed a tornado touched down on the city’s east side — the first tornado to hit Detroit in nearly 30 years.”
  - `ka-hi--hurricane-damage` (Jill N. Tokuda, HI-02): “The destruction Hurricane Lala left behind on farms across Kaʻū is extensive.”

### Policy and advocacy posts hung on a local incident

_4 of 29 incidents._ Posts that use an incident to argue for a disaster declaration, a grade-separation grant or firefighter legislation are policy posts. The prompt excludes "national policy news" but says nothing about local policy, so a post whose only incident content is the hook gets flagged.

Examples:
  - `aspen-co--wildfire` (Jason Crow, CO-06): “Every member of Colorado’s congressional delegation is calling on President Trump to do the right thing and support a major disaster declaration for the Aspen and Gold Mountain fires.”
  - `burlingame-ca--train-collision` (Kevin Mullin, CA-15): “Difficult to see another train-vehicle collision at the Broadway crossing in Burlingame, which is considered the deadliest crossing in California.”
  - `eastern-oregon-or--wildfire` (Maxine Dexter, OR-03): “I visited the incident command posts servicing the Austin and Narrows fires with @SenJeffMerkley to learn how to better support our firefighters this wildfire season and beyond.”

### Minor, contained events

_2 of 29 incidents._ A 50-acre brush fire with no evacuations whose forward progress was already stopped, and a single train-vehicle collision, were flagged. The prompt lists "major accident" but sets no scale.

Examples:
  - `orange-county-ca--wildfire` (Raul Ruiz, CA-25): “Emergency responders have successfully stopped the #AirportFire’s forward spread across approximately 50 acres”
  - `burlingame-ca--train-collision` (Kevin Mullin, CA-15): “Difficult to see another train-vehicle collision at the Broadway crossing in Burlingame, which is considered the deadliest crossing in California.”

### State or "unspecified" used as the place

_3 of 29 incidents._ "Washington, WA", "Illinois, IL", "Michigan, MI" and, in the wider corpus, "district-unspecified", "unspecified-district", "district" and "GKN plant area unknown" (18 of 174 flags). A place that is a whole state cannot be an incident location and can never match another post’s key.

Examples:
  - `washington-wa--wildfire` (Kim Schrier, WA-08): “Here is this week’s Schrier Flyer - with another round of wildfire resources.”
  - `illinois-il--severe-storms` (Robin L. Kelly, IL-02): “Our skilled laborers and first responders who are helping our communities recover after the July and August severe storms are a testament to the spirit of the people of Illinois.”
  - `michigan-mi--severe-weather` (Debbie Dingell, MI-06): “Stay safe and stay alert, Michigan. Follow local news for the latest information and heed warnings from public safety officials.”

### Kind not supported by the post

_1 of 29 incidents._ lake-station-in--flooding says nothing about flooding; gary-in--storm-damage says nothing about damage. The kind was inferred from the member’s earlier posts or general knowledge, which then keys a new incident.

Examples:
  - `lake-station-in--flooding` (Frank J. Mrvan, IN-01): “I also wanted to share this daily storm update with information on the Mobile Registration Intake Center in Lake Station happening this week.”

### Non-House accounts on the desk

_2 of 29 incidents._ Not a prompt failure: the classifier never sees the author. incidents.js needs the same isHouse filter sitedata.js uses.

Examples:
  - `detroit-mi--tornado` (Sen. Elissa Slotkin, US Senate): “The National Weather Service has confirmed a tornado touched down on the city’s east side — the first tornado to hit Detroit in nearly 30 years.”
  - `southeast-michigan-mi--severe-storms` (Sen. Elissa Slotkin, US Senate): “Severe storms have devastated communities across Southeast Michigan, causing downed trees and power lines, property damage, flooding, and widespread power outages. My team and I are in direct communication with local officials”

### Location labelled with the lead poster’s district

_3 of 29 incidents._ Not a prompt failure: incidents.js appends the lead author’s stateDistrict to any place.

Examples:
  - `kauai-hi--tropical-storm` (Ed Case, HI-01): “Thinking of all our ‘ohana recovering from devastating Lowell. […] especially for Kaua’i/Ni’ihau, the link to report storm damage which will be used to request a presidential disaster declaration”
  - `miami-fl--plane-crash` (Darren Soto, FL-09): “What a tragedy. Praying for the families of those who perished at Miami Airport […] / It is devastating to see the loss of five lives as a result of the Amazon plane that over ran the runway at the Miami International Airport.”
  - `aspen-co--wildfire` (Jason Crow, CO-06): “Every member of Colorado’s congressional delegation is calling on President Trump to do the right thing and support a major disaster declaration for the Aspen and Gold Mountain fires.”

## Proposed prompt changes for `src/taxonomy.js`

Replace the current `INCIDENTS` bullet in `systemPrompt()` with the rule below. Each lettered clause maps to a failure mode above: (a) minor events, (b) aftermath/recovery, (c) reactions and policy hooks, (d) invented places and state-level places; the “Not incidents” paragraph handles advisories; the fixed kind vocabulary and the `name` field handle splits.

```
- INCIDENTS: flag a tweet as an incident only when ALL of the following hold.
  (a) Community-scale emergency. The tweet is about a specific emergency
      affecting many people: active shooter or mass shooting, wildfire with
      evacuations, flooding, tornado or severe-storm damage, hurricane or
      tropical storm impact, hazmat release, major crash or explosion,
      widespread power or water outage, infrastructure failure. A single
      vehicle or rail collision, a contained brush fire with no evacuations,
      or a single house fire is not community-scale.
  (b) Happening now. As the tweet describes it, the emergency is under way
      or struck within the last three days: evacuation orders or warnings,
      shelter-in-place, rescues or searches, outages being restored, damage
      being assessed, shelters or hotlines being announced. Aftermath and
      recovery posts are NOT incidents: FEMA/SBA/USDA assistance
      information, application deadlines, disaster-declaration requests or
      approvals, intake-center schedules, "daily storm update" newsletters,
      thank-you messages to responders, and site visits or damage tours
      weeks later. Wording such as "recovering", "recovery", "aftermath",
      "left behind", "is gone", "the August storm", "spent months",
      "apply by <date>" means the event is past: give the tweet its normal
      topics (usually climate/disasters or constituent-services) instead.
  (c) The member is acting, not reacting. The tweet relays official
      instructions or resources ("evacuate zone ...", "call 866-...",
      "avoid the area", "report damage here"), says the member's office is
      in contact with officials or on scene, or gives constituents a way
      to get help. "Thoughts and prayers", "heartbroken", "horrified to
      hear", "grateful to first responders" posts are reactions, even
      when the event is nearby: classify them normally and do not flag
      them. A tweet that uses an incident to argue for legislation,
      funding or a policy position is a policy tweet, not an incident,
      unless it also relays live instructions.
  (d) The place is in the tweet. Take "place" only from the tweet: the
      city or county named in it plus the state ("Napa County, CA",
      "La Habra, CA", "Kauaʻi, HI"). If the tweet names the event
      ("#SteeleFire", "Hurricane Lowell", "Timber Fire") put that in
      "name". Never infer the location from a similarly named past event
      or from what you know about the member; a bare state ("Michigan,
      MI") is not a place. If the tweet gives neither a place nor a named
      event, do not flag it.
  Not incidents: routine weather advisories and public-safety PSAs (heat
  advisories or warnings, cooling-center lists, flood watches, travel
  advisories, "stay safe and stay alert") unless the tweet reports an
  actual impact — an emergency declaration, evacuations, shelters open,
  outages, closures, injuries or deaths.
  Format: {"kind": "<one of: active shooter, shooting, wildfire,
  flooding, severe storm, tornado, hurricane, extreme heat, power outage,
  water outage, hazmat, structure fire, explosion, plane crash, train
  crash, industrial accident, infrastructure failure, missing persons,
  other>", "place": "<city or county, state abbr>", "name": "<official
  event name from the tweet, or null>"}. Use exactly the same kind, place
  and name for every tweet about the same event, and do not switch
  between city, county and region for one event; when the tweet only
  names the event, reuse the place from the open-incident list below.
  Incident tweets still get topics [] unless they also carry policy
  content.
```

Then render the currently open incidents into the system prompt the same way `renderExamples()` renders editor corrections, so the model can actually obey “reuse identical strings” across chunks and days (today it sees one 40-tweet chunk with no memory). Built from `data/incidents.json` at classify time; changes daily like the corrections block, and stays byte-identical across the chunks of one run so the cache still hits:

```
Open incidents (reuse these exact kind, place and name strings for any
tweet about the same event; do not create a variant):
- wildfire | Napa County, CA | Steele Fire
- wildfire | Monterey County, CA | Timber & Plaskett fires
- hazmat | La Habra, CA | null
- severe storm | Detroit, MI | null
- hurricane | Kauaʻi, HI | Hurricane Lowell
```

If the editors would rather keep recovery threads visible than drop them, use this variant of clause (b) and let `incidents.js` route on `phase`:

```
  (b') If the editors want recovery threads kept on the desk rather than
      dropped, replace the exclusion in (b) with a field: add "phase":
      "breaking" when (b) holds and "phase": "recovery" for assistance,
      declaration, intake-center and site-visit posts about an event that
      struck within the last 30 days; the desk shows only "breaking"
      incidents on the dashboard and lists "recovery" threads separately.
      Posts about events older than 30 days are never incidents.
```

### Code-side changes that the prompt cannot make

1. `incidents.js` — apply the same `isHouse` filter `sitedata.js` uses before grouping (removes the two Senator incidents; 14 of 174 corpus flags are from non-House accounts).
2. `incidents.js` — only append the lead author’s `stateDistrict` to `place` when the flag’s state matches the author’s state; otherwise show the place alone (fixes “Miami, FL · FL-09”, “Kauai, HI · HI-01”, “Aspen, CO · CO-06”).
3. `incidents.js` — key on `name` when the model supplies one, and fold kind synonyms with a small map before `incidentKey()` (hazmat release/chemical leak/hazmat incident → hazmat; severe storms/severe weather/storm damage → severe storm; flash flooding/heavy rain flooding → flooding; mass shooting/active shooter/shooting attack → shooting).
4. `classify.js chunkRequests()` — send `{id, text, author: "@handle (CA-19)"}` so the model can judge in-district and supply the state when the tweet omits it.
5. `incidents.js` — cap incident age (drop or mark as recovery anything whose first post is older than 10 days) so daily recovery updates cannot keep a month-old storm “active”.

## Sources used for dates and places outside the corpus

- Hurricane Lala, Hawaiʻi Island, 15-16 Aug: https://weather.com/2026/08/17/storms/hurricane/hawaii-hurricane-tropical-storm-lala-forecast
- Hurricane Lowell, Kauaʻi/Niʻihau, 7-8 Sept: https://www.civilbeat.org/2026/09/hurricane-lowell-hit-kauai-hard-but-worst-fears-averted/ and https://www.staradvertiser.com/2026/09/08/hawaii-news/kauai-urges-residents-to-shelter-in-place-as-hurricane-lowell-hits/
- 21 Air Flight 7598, MIA, 6 Sept: https://en.wikipedia.org/wiki/21_Air_Flight_7598 and https://www.npr.org/2026/09/06/nx-s1-5959749/amazon-cargo-plane-crashes-at-miami-airport
- Airport Fire, Thermal (Riverside County), 3-4 Sept: https://kesq.com/news/2026/09/03/brush-fire-burns-50-acres-in-thermal-forward-progress-stopped/ and https://www.fire.ca.gov/incidents/2026/9/4/airport-fire
- Austin and Narrows fires, Mt. Hood National Forest: https://inciweb.wildfire.gov/incident-information/ormhf-austin-fire and https://nwccinfo.blogspot.com/2026/09/982026-austin-and-narrows-fires-update.html
- Aspen Acres and Gold Mountain fires, declaration 4 Sept: https://www.cpr.org/2026/09/04/colorado-aspen-acres-gold-mountain-disaster-declaration/
- CA-38 includes La Habra: https://lindasanchez.house.gov/about-linda/our-district
