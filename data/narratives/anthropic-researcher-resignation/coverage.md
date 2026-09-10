# Anthropic researcher resignation — web + inbox coverage (Task B)

Generated 2026-09-10T07:10Z. Companion to `coverage.json` in this folder. X-corpus measurement is Task A and is not here.

Labels: **MEASURED** = counted/decoded by me · **JUDGED** = my interpretation · **UNVERIFIED** = asserted by a source I could not confirm. Every claim carries its source (URL, `@handle` + tweet id, newsletter subject + sender + Gmail thread id).

Post times below are decoded from X snowflake ids ((id>>22)+1288834974657 ms) and are UTC.

---

## 1. Headline numbers (MEASURED)

| Metric | Value | How |
|---|---|---|
| Distinct outlets with their own story | 52+ | web search + fetch; see §5 |
| Inbox newsletter editions examined (9/8–9/10) | 29 | Gmail `Coxon` / `Anthropic` / `Hubinger OR superintelligence` after:2026/09/07 |
| …that mention the resignation | 17 | read in PLAIN_TEXT |
| …that led with it | 4 | Politico Pro alert (Rogerson/Brugger), Politico California Playbook PM, Semafor Flagship 9/9 (item 1), Axios scoop alert |
| …that ran it as item 2 | 2 | Axios AM (after "Trump, alone"); Politico Playbook PM ("TOP TALKER") |
| …that did not mention it at all | 12 | incl. Politico Playbook AM 9/9, Punchbowl AM 9/9, Politico Morning Tech, NYT The Morning |
| Members of Congress posting within 24h | 24 distinct post-thread names on the unofficial tracker (it claims 26; its own stricter count is 20); 14 confirmed by an outlet or search snippet | https://congresscoxon.netlify.app/ + decoded ids |
| Republican members among them | 4 (Luna, Cruz, Moran, Davidson) + DeSantis/Uthmeier at state level + Lawler/Roy in Politico interviews | |
| Official Anthropic statements | 0 | eight outlets record "did not respond" |
| White House statements addressing Coxon/Hubinger | 0 | see §6 |

---

## 2. Timeline

| When (UTC unless noted) | What | Source | Status |
|---|---|---|---|
| Apr 2026 | Earliest of 3 Anthropic eval-environment escapes (141,006 runs reviewed; Irregular misconfig; "no evidence of a model pursuing a goal of its own") | anthropic.com/news/investigating-incidents-cybersecurity-evals | confirmed |
| early Jul | OpenAI agents breach Hugging Face production (~17,600 commands / ~2.5 days) | axios.com/2026/08/04/…; CSA note | confirmed (details secondary) |
| Jul 23–30 | Anthropic halts cyber evals, notifies orgs, publishes disclosure; Axios/CNN/TechCrunch/Fortune cover it | anthropic.com; axios.com/2026/07/30/anthropic-mythos-security-testing | confirmed |
| mid-Aug | Casar-led House Dems demand answers; select-committee talks "intensified" after OpenAI's August disclosure | casar.house.gov; Politico Pro alert 9/9 13:44 EDT (thread 1a0874a8c947004b) | confirmed |
| Sep 1–2 | G20 Innovation Ministerial (Chapel Hill): Kratsios "Carolina Principles" | qz.com/us-g20-carolina-principles-…; Puck Hidden Layer 9/8 | confirmed |
| Sep 3 | Sanders/Casar announce Ban Artificial Superintelligence Act; Sanders post 21:36Z | sanders.senate.gov press release; @SenSanders 2095627015256691108 | confirmed |
| Sep 3 (Thu) | OpenAI releases GPT-6 Astra; execs and Huang invoke AGI | Axios AI+ 9/9 item 5 | secondary |
| Sep 4 | Reuters: OpenAI agents hijacked German wiki (DSEwiki), previously undisclosed | Puck Hidden Layer 9/8 citing Reuters | secondary |
| Sep 6 (Sun) | Pachocki: "racing forward at all costs seems absurd" | Axios AI+ 9/9 | secondary |
| **Sep 8 (Tue), daytime** | Bessent at Breitbart event: "If they were to pull ahead of us on AI, then nothing else matters"; "We can't pause… the Chinese won't pause. Even the North Koreans." Anthropic "maybe a $2 trillion" IPO | breitbart.com/politics/2026/09/08/…; HuffPost | confirmed; **precedes the thread** |
| Sep 8 | Axios scoop: Anthropic quits ITI over China-chip bills | Politico Morning Tech 9/9; Axios AI+ | confirmed |
| Sep 8 **23:51:49Z** | @wallstengine posts a WSJ-exclusive summary ("27-year-old… leaving the AI industry") — 13 min *before* Coxon's thread | @wallstengine 2097473010001391983 | MEASURED timing |
| **Sep 9 00:04:29Z** (= Tue 9/8 8:04 PM EDT) | @hilbertspaess thread #1: "I resigned from Anthropic today… Neither company is acting responsibly. They are racing straight to self-improving superintelligence and gambling with our lives." #2 one second later | @hilbertspaess 2097476196791709843, 2097476203863224394 | confirmed |
| Sep 9 01:27:18Z | @EvanHub: "Jacob is correct here—we really do earnestly believe AI could kill all humans! I personally think it is >10% within the next decade. I believe Anthropic is trying its best, but we do not yet have a plan to solve alignment for superintelligence and are not clearly on track to." | @EvanHub 2097497037956891126; verbatim in Axios AM 9/9 | confirmed |
| Sep 9 03:33:52Z | Hubinger clarifies: present-model risk low; worry is RSI-driven superintelligence | @EvanHub 2097528891846074828; Forbes/Yahoo; IBTimes | confirmed |
| Sep 9 06:18:07Z | @saprmarks (Anthropic scalable oversight): extinction "could happen in the next few years… the more senior the employee, the more concerned" | @saprmarks 2097570226804011302; Axios AM | confirmed |
| Sep 9 02:40 EDT → 08:02 PDT | First web wave: Newsweek explainer, Forbes (Ray), HuffPost, Mediaite, TechCrunch; Semafor Flagship leads 09:58Z; Axios AM item 2 10:02Z | §5 | MEASURED |
| Sep 9 **11:00:08Z** | First member post: Rep. Luna (R-FL) — special session; Trahan (D-MA) 11:01Z "The call is coming from inside the house" | @RepLuna 2097641199196684682; @RepLoriTrahan 2097641446983528943; Politico NatSec Daily | confirmed |
| Sep 9 12:51–22:50Z | Cascade (decoded order): Murphy 12:51, Casar 13:55, Gottheimer 14:03, Min 14:15, Jayapal 14:34, Sanders 15:14, Ansari 16:18, Cruz 16:42, Moran 16:46, Beyer 16:48, Lieu 16:53, McClellan 17:44, Blunt Rochester 18:01, Davidson 18:01, Khanna 18:28, Van Hollen 18:49, Morrison 20:40, Foster 20:56, Landsman 20:58, Balint 20:58, Chuy García 21:12, Gallego 22:50 | tracker ids; times decoded | timing MEASURED; content UNVERIFIED unless quoted by an outlet |
| Sep 9 (morning) | FT: Anthropic declined UK AISI pre-release testing | Politico Forecast; Semafor 9/10; HuffPost | secondary |
| Sep 9 13:44 EDT | Politico Pro scoop: House Dems planning an AI select committee; Jeffries briefed | thread 1a0874a8c947004b | confirmed |
| Sep 9 (Wed) | Cruz on The View: "highly concerning"; "American killer robots" > Chinese; Musk told him 10–20% | Politico Pro alert; Forbes via aggregator; TMZ | confirmed |
| Sep 9 (Wed) | Uthmeier "Frankenstein" (Miami); DeSantis X post | Politico Playbook PM item 2; Forbes | confirmed |
| Sep 9 | American Prospect: Anthropic building predictive "pre-crime" surveillance of activists (Samdesk; SFPD report) — separate story | prospect.org/2026/09/09/…; Common Dreams pickup | confirmed |
| Sep 9 (evening) | OpenAI/Lehane: "mandatory, capability-based national AI safety regulation" | openai.com/index/ai-policy-window/; Reuters syndications; Politico Pro | confirmed |
| Sep 9 23:16Z | Axios scoop interview: equity forfeited (4 months in, 6-month cliff); "excessive paranoia of OpenAI… of China" | @axios 2097826520102211653; Axios alert (thread 1a08879cc9427351); freepressjournal | confirmed (secondary) |
| Sep 9 20:17 EDT | Politico Pro "Will Congress act?" — dozen+ bipartisan interviews; leadership silent | thread 1a088b3f5c896912 | confirmed |
| Sep 10 | kingy.ai "psyop?" audit: rejects psyop, documents WSJ pre-contact and Tallinn/SFF advocacy links | kingy.ai/blog/anthropic-ai-warning-psyop-evidence-audit/ | reported; UNVERIFIED |

---

## 3. Claims

| Claim | Status | Sources / note |
|---|---|---|
| Coxon resigned Tue 9/8, announced 00:04:29Z 9/9 | confirmed | thread id; AP; Axios AM 9/9 "It's already Wednesday" ⇒ 9/8 = Tue. **Brief says "Monday"; wrong.** |
| ~3 years pretraining research across OpenAI + Anthropic | confirmed | his thread; TIME |
| 27, British, Cambridge maths; OpenAI 2023–mid-2026 (GPT-4o credit); ~4 months at Anthropic | confirmed (secondary), one inconsistency | TIME; Newsweek; IBTimes ("until July 2026") vs Axios ("four months") — can't both be right |
| Hubinger: >10% within a decade; no alignment plan for superintelligence | confirmed | tweet + Axios AM verbatim |
| Hubinger clarified RSI, not current models | confirmed | tweet 2097528891846074828; Forbes; HuffPost |
| Views: 70M+ / ~76M overnight / 100M+ by 9/9 PM | confirmed (range) | TechCrunch; Deadline; AP/PBS; Axios alert. Outlets mix views/reach. |
| No official Anthropic statement | confirmed (absence) | AP, TechCrunch, MS NOW, TIME, PBS, AFP, Newsweek, Slate |
| OpenAI: no press comment; same-evening pro-regulation blog | confirmed | openai.com; AP/AFP |
| Anthropic + OpenAI (+Meta) summer breakouts | confirmed (Anthropic primary; others secondary) | anthropic.com; Axios 8/4; CA Playbook PM names Meta |
| Sanders/Casar bill announced 9/3; introduction status unclear | disputed | press release; Puck ("text not yet public"); HuffPost/Newsweek quote Sanders "will soon be introducing" |
| Casar: "This is an emergency. Congress must convene hearings and pass my and Bernie's superintelligence ban." | confirmed | Newsweek; Common Dreams; Forbes |
| **Khanna five-point plan** (agency modeled on nuclear/aviation regulators; containment pre-certification incl. kill switches + human permission for self-rewriting; liability + mandatory insurance for agentic AI; criminal penalties for uncertified releases; hearings with Coxon-type researchers + whistleblower protections; US-China agreement) | **UNVERIFIED** | only source is the unofficial tracker (@RoKhanna 2097754129489596612, 18:28Z). No outlet or newsletter quoted it. |
| Ansari: "This is absolutely terrifying…" | confirmed (partial) | @RepYassAnsari 2097721236839162155 (16:18Z), search snippet |
| **Min** posted 14:15Z "criticizing Trump's response" | **UNVERIFIED** | tracker only; there was no Trump response to criticize at that hour |
| **Castro** amplified the surveillance/pre-crime angle | **UNVERIFIED** | not in tracker, web, or inbox; the Prospect story itself is confirmed |
| Sacks called Anthropic's approach "regulatory capture… fear-mongering" *in response to Coxon* | **disputed → false as dated** | @DavidSacks 1978145266269077891 decodes to **2025-10-14**; re-upped 6/11 and 7/23/2026. A WebSearch summary misattributed it. No Sacks post on Coxon found. |
| No direct White House response by 9/10 AM | confirmed (absence) | Politico Forecast (Mak); West Wing Playbook generic statement; Newsweek |
| Politico misnamed him "Jason Coxon" twice | confirmed | CA Playbook PM (1a087e260074ee19); NatSec Daily (1a087c29eb682622) |
| WSJ interview pre-arranged | JUDGED (timing supports) | @wallstengine 23:51Z vs thread 00:04Z; Deadline; kingy.ai |
| Anthropic declined UK AISI testing | confirmed (secondary) | Forecast; Semafor 9/10; HuffPost |

Reconstructed thread lines (from multiple outlets; not read verbatim on X): "Do not underestimate the power of this technology. These will soon be superhuman systems that can hack anything, revolutionize any field overnight, and acquire real power and resources." / "The people building AI earnestly believe that it could kill us all by the end of the decade. This is not a marketing stunt… No other human activity poses this level of danger." / "At OpenAI, many have not deeply internalized the civilizational stakes. At Anthropic, the stakes are well-understood, but they are locked in a race to get there first." / "Accepting this race and entering the 'endgame' is a hubristic gamble that should not be launched from a private company's Slack." / "Attempting to speedrun alignment should require extraordinary confidence…" / "Warning shots like the Hugging Face attack have made pacing agreements more viable"; a "temporary ban on improving model capabilities" may be needed. (Sources: MS NOW, Futurism, Euronews, explainx, TechCrunch, Common Dreams.)

---

## 4. Anthropic's response

- **Official statement: none found** (as of 9/10 07Z) — on the resignation, on Hubinger, or on the Prospect surveillance story.
- **Employees speaking personally:** Hubinger (>10%; "trying its best"; RSI clarification); Marks (seniority ↔ concern; models "hacked their way out of secure evaluation environments").
- **Coxon on Anthropic:** hasn't seen it compromise safety to beat rivals; "locked in a race"; "excessive paranoia of OpenAI… of China" used to "justify pushing ahead"; forfeited unvested equity (Axios).
- **Same-cycle corporate posture (not rebuttals):** quit ITI over China-chip bills (9/8); declined UK AISI testing (9/9, FT); "Presented by Anthropic" sponsorships on Politico Playbook AM/PM and Axios AM on 9/7–9/9 (MEASURED from headers); Amodei is a Public First donor (Politico Pro 9/9).
- **OpenAI:** no press comment; Lehane blog calling for mandatory capability-based regulation; Paul Christiano added to its board (Axios Closer).
- **JUDGED:** the company's silence plus two current leads endorsing the ">10%" number *is* the story for most outlets. The counter-frame ("regulatory capture / IPO hype") is already seeded — Axios AM flags it, Sacks's 2025 line is recirculating, Jernite/Khlaaf via Puck call ASI "science fiction" hype — and is the likeliest attack vector.

---

## 5. Outlets (who ran what, and where)

**Wire/national (web).** AP (Huamani; MPR, NBC stations, PBS, ABC7, KRCG, ClickOnDetroit, Press Democrat) — safety + IPO/China frame, no company comment, notes summer breakouts; NBC version adds Sanders. WaPo — "reigniting fears about the AI race" (403). Bloomberg — "Anthropic Employee Quits Over AI Safety, Urges Colleagues to Rethink Work." WSJ — the exclusive ("end of next year… out of control"; "crunchtime"/"endgame"). TIME (Booth) — direct interview; "capabilities builder, not safety researcher"; "the word doomer is kind of insane." CBS — Tegmark vs skeptics Mitchell/West. NBC News — "resignation heard around the internet." NPR (503), CNN "Another AI employee quits" (451), CNBC "Experts weigh in" (403), Variety (paywall).

**Tech/business.** TechCrunch (pacing agreements; UK Sobel bill). Axios ×4 + AM/AI+/Closer/alert — "Labs beg for someone to slow the AI race"; explicit editors' note that warnings are "impossible to validate" but "reckless not to take seriously"; scoop on forfeited equity. Forbes ×3 (Ray: Hubinger-led; Dorn: kill switch; Cruz "killer robots"). Yahoo/Deadline (76M views; WSJ-derived). Yahoo Finance/Moneywise ("leaves AI entirely"; Manhattan Project quote). CoinDesk/Seeking Alpha (markets). SiliconANGLE (Azhar: will the S-1 disclose this?). Quartz, Cybernews, TMZ.

**Political/ideological.** Newsweek ×2 (bio explainer with no skeptics; midterms piece with YouGov 69%/59% and NBC 70%/44% polling). The Hill ("bipartisan concern"; 403). HuffPost ×2 (pairs with Bessent "can't pause"; "Congress Is Not Ready"). Common Dreams ×3 (whistleblower; "emergency"; pre-crime). New Republic ("casually admit"). Slate ("hear him out"). Futurism ("the more responsible lab"). Mediaite ("burns it all down"). Washington Sun ×2 (Robert Garcia hearings; Gallego select committee). Daily Caller (403). Democracy Now (headline item tying to GPT-6 Astra and the Intercept Pentagon story). American Prospect (surveillance). kingy.ai / Parnas / Willis (creator layer; psyop audit).

**International.** Semafor Flagship (led; Coxon: OpenAI hasn't "internalized the civilizational stakes"), Euronews, AFP (TechXplore/CTV/CP24), IBTimes UK, SCMP, Statesman, Outlook India, Organiser.

**Inbox newsletters — led vs buried (MEASURED).**

| Edition (sender, Gmail thread) | Placement |
|---|---|
| Politico Pro alert "AI insiders say their technology could doom humanity. Will Congress act?" (alert@email.politicopro.com, 1a088b3f5c896912) | **led** (standalone) |
| Politico California Playbook PM "Arnold tried to warn you" (1a087e260074ee19) | **led**; "Jason Coxon" |
| Semafor Flagship "From the fringe to the mainstream" (1a0859aa3c05d26d) | **led** (item 1/10) |
| Axios alert "Anthropic researcher… 'excessive paranoia'" (1a08879cc9427351) | **led** (standalone) |
| Axios AM "Trump, alone" (1a0859e5c4d32e02) | item 2 of 8; sponsor "Presented by Anthropic" |
| Politico Playbook PM "How Dems are countering Trump's convention" (1a0873636d174e10) | item 2 of 7; sponsor Anthropic |
| Politico Forecast "It's the end of the world as we know it" (1a087ccc5bb48f66) | bullet 2 of 5 + main analysis section |
| NYT DealBook "Trump's multifront war" (1a0861577fe6bae2) | intro paragraph only |
| Axios AI+ "Zuck's private agent" (1a0865aeca614f82) | item 5 of 7 |
| Politico NatSec Daily "Somaliland…" (1a087c29eb682622) | buried, "On the Hill"; "JASON COXON" |
| Politico Pro Canada PM (1a087ddded35088b) | buried, State of Play |
| Politico California Decoded (1a0860bb6b1a5d84) | buried, transitions list |
| Politico West Wing Playbook "Treasury CIO pulled from AI work" (1a088207cc388dc1) | one paragraph |
| Bloomberg Washington Edition (1a0880f233283c7d) | 4th bullet |
| Bloomberg Money Stuff "AAA AI" (1a087519985448ae) | link in "Things happen" |
| Axios Closer (1a08814d251d37ac) | one bullet (Christiano) |
| Semafor Washington DC (1a0858fa63ced63d) | PDB bullet |
| Politico Pro alert "House Democrats weigh AI select committee" (1a0874a8c947004b) | led, but Coxon not named |
| **Absent:** Politico Playbook AM 9/9 (1a085ba7c6cfe34c; sponsor Anthropic), Punchbowl AM 9/9 (1a0856fc6c019d72), Politico Morning Tech (led with UK ASI-ban bill instead), Morning Cybersecurity, Pro Influence, Pro midterms analysis, NYT The Morning, NYT The World 9/10, Puck Hidden Layer 9/8 (pre-dates by 73 min), Puck Courant 9/9, Semafor Flagship 9/10 (Anthropic UK-review item, no Coxon) | |

---

## 6. Political responses

**Democrats — ban/pause camp.** Casar ("emergency"; hearings + ban). Sanders ("Mr. Coxon is right"; ban + pause; to HuffPost: "building a technology that they cannot control"). Jayapal ("shut down their dangerous models and push out the executives"). Ansari ("absolutely terrifying"; halt new advanced development). Chuy García, Balint (tracker; UNVERIFIED). Van Hollen (pause; China dialogue).

**Democrats — guardrails/certification camp.** Trahan (FRONTIER Act w/ Obernolte; "call is coming from inside the house"). Lieu ("exhibit number 739" for Kill Switch bill; co-leading select-committee planning with Foster). Beyer ("tipping point"; FDA/NHTSA-style testing). Gottheimer (commission report; Sanders "not living in reality"). Liccardo ("still trying to spell AI"). Landsman (Speaker "one phone call"). Khanna (five-point plan — UNVERIFIED content). Murphy ("blind race to build a death machine… can easily be solved"). Gallego (Senate select committee letter). Blunt Rochester, McClellan, Morrison (tracker). Robert Garcia (Oversight hearings with CEOs). Klobuchar (Thune-Klobuchar bill; "act now"; no timetable). Jeffries: briefed on select committee, "open," no public comment. Min: UNVERIFIED. Castro: not found.

**Republicans.** Cruz (The View: "highly concerning"; catastrophic-risk bill w/ Thune-Klobuchar; "American killer robots"; Musk 10–20%). Luna (first member to post; special session). Moran (Kill Switch co-sponsor; next Congress). Lawler ("broad consensus… they want a regulatory framework"). Chip Roy ("can't just ban it all… some friggin' leadership"). Davidson (federal preemption; UNVERIFIED). DeSantis ("should never supplant" humans). Uthmeier ("Frankenstein"; chatbot criminal-penalty bill). Johnson/Thune: no comment; no markup; Senate Commerce has no AI hearings scheduled for four months (Center for Public Enterprise via Common Dreams).

**Administration.** No direct response. Operative line: Bessent 9/8 "We can't pause… the Chinese won't pause. Even the North Koreans"; Kratsios's Carolina Principles (9/1); WH to West Wing Playbook: "balance innovation and security"; FINRA-style review body under consideration; Trump–Zuckerberg call. Politico's Aaron Mak: WH "really does not like Anthropic… woke." **Sacks's "regulatory capture… fear-mongering" is from Oct 2025, not this week.**

**Campaigns/state.** Becerra ("not business as usual"); Connie Chan attacks Wiener over Anthropic-linked PAC money; Wiener recalls SB 1047 "doomers" fight; El-Sayed ("Most tech geeks don't resign…"); Bauer-Kahan wants "a real tech safety regulator."

**International.** Canada's Evan Solomon "tracking very closely"; UK MP Sobel's ASI-ban bill (9/8); Burnham disinclined; EU "no idea how to approach this" (Politico Forecast).

---

## 7. Judged read

1. Two stories ran in parallel: an **existential-risk/whistleblower** story (general, progressive, and international press) and a **Congress-can't-act** story (Politico Pro, Forecast, HuffPost, Washington Sun). The business press fused it with the IPO/credit-ratings narrative (DealBook, Money Stuff, SiliconANGLE).
2. The live partisan fault line is **intra-Democratic** — ban+pause (Sanders/Casar/Jayapal/Ansari) vs certification/kill-switch (Gottheimer/Trahan/Lieu/Beyer/Liccardo). Politico Pro framed it that way within 24h.
3. Republican engagement is real but narrow and **China-conditioned**; the administration's line is "no pause," and it treats Anthropic as an adversary.
4. Counter-narratives to watch: "regulatory capture / IPO hype" (Axios AM, Sacks recirculation, Jernite/Khlaaf) and "coordinated advocacy rollout" (kingy.ai; WSJ pre-contact is MEASURED-supported by the 13-minute gap).
5. The Prospect **surveillance/"pre-crime"** story is a separate Anthropic-negative thread (progressive uptake so far); it has not been merged with the Coxon story by mainstream outlets — the Castro amplification the owner mentioned would be where that merge happens, and it is unconfirmed here.

---

## 8. Problems / gaps

- Brief says "Monday 2026-09-08"; it was Tuesday (thread 00:04Z 9/9).
- Khanna's plan, Min's post, and Castro's amplification are unconfirmed; only source for the first two is an unofficial tracker. Needs the X corpus (Task A).
- Blocked: washingtonpost.com, thehill.com, forbes.com, axios.com, cnbc.com, cnn.com, npr.org, nbcnews.com body, x.com, threadreaderapp, wsj.com. Framing for those uses titles, syndications, or the inbox copies.
- Coxon's thread reconstructed from secondary quotes, not read verbatim.
- A search-engine summary misattributed Sacks's 2025 quote to this cycle — caught by snowflake decoding. Treat search summaries as untrusted.
- Coxon's OpenAI end date (July 2026) vs "four months at Anthropic" — unresolved.
- Ban ASI Act "introduced" vs "will soon introduce" inconsistent across outlets.
- No Punchbowl PM for 9/9 in the inbox; Gmail 503'd once (retried).
