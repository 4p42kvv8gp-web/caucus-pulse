# Anthropic researcher resignation — the caucus corpus (Task C)

Generated 2026-09-10T07:20:43.578Z from `data/archive/2026-09-07..10.jsonl`, `data/authors.json`, `data/topics/*.json`, `data/stories.json`, `data/rollups/topic-days.json`. Machine-readable twin: `caucus.json` (same directory). Every number below is MEASURED from those files unless marked JUDGED or UNVERIFIED.

## Headline numbers (MEASURED)

- **Core posts: 34** (23 originals — 19 quotes, 4 tweets — and 11 retweets) from **26 accounts / 21 members**; 33 of them on the Tuesday ET day, 1 on Monday night (Lieu).
- **Share of Tuesday 2026-09-09:** 33 / 625 caucus posts = **5.3%**; 22 / 532 originals = 4.1%; 21 / 186 members who posted that day = 11.3%.
- **Caucuses touched:** capac, cbc, chc, leadership, newdem, progressive — by posts: progressive 24 · capac 11 · newdem 11 · leadership 5 · chc 5 · (none) 4 · cbc 1 (members overlap; a member counts in every caucus tagged).
- **Leading framing (JUDGED):** primary — regulation-plan 13 · existential-risk 10 · hearings-oversight 10 · surveillance-pre-crime 1; originals only — regulation-plan 11 · hearings-oversight 7 · existential-risk 5; any mention — regulation-plan 19 · existential-risk 19 · hearings-oversight 11 · other 5 · surveillance-pre-crime 1 · labor-economy 1.
- **Classifier coverage:** 33 / 34 classified, 1 unclassified, 0 without a topics file; topic sets: tech 25 · tech/ai-policy 3 · congress-politics + tech 2 · unclassified 1 · democracy + tech 1 · climate + foreign-policy/middle-east + tech/ai-policy 1 · congress-politics/house-floor + tech/ai-policy 1. Only 5 carry `tech/ai-policy`; 28 are bare `tech`. **No emerging cluster, no stories.json candidate, no context.json hit, no line in reports/2026-09-09.md.**
- Plus 8 adjacent same-cycle AI posts (6 originals; other 3 · labor-economy 3 · regulation-plan 2) and 3 precursor posts from Sun/Mon about the model-breakout background.

## Core posts (34) — every post clearly about the story, ET order

Engagement is `metricsAtCapture` at the 2026-09-10 05:26–05:59Z capture; retweet rows show the original's retweet count only. `[inferred]` marks a post tied to the story by timing and wording rather than an explicit reference. Text is the archive's 280-char capture (11 of the 23 originals are cut mid-sentence).

| # | ET | account (member) | acct | caucuses | type | framing | classifier | likes / RT / replies / quotes | text | source |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 09-08 22:56 | @tedlieu (Ted Lieu) | personal | progressive, capac, leadership | quote of 2097474365163999402 | regulation-plan [inferred] | tech | 8007 / 1437 / 283 / 32 | Below is exhibit number 739 for why we need to pass the bipartisan AI Kill Switch Bill asap. https://t.co/i8C1FhruXe | `data/archive/2026-09-08.jsonl:170` |
| 2 | 09-09 01:27 | @RubenGallego (Ruben Gallego, Sen.) | personal | — | retweet of @hadip | existential-risk | tech | (orig: 22 RT) | RT @hadip: Wild statement from Anthropic’s leader in charge of keeping AI safe: more than 10% chance it kills everybody within 10 years. 🤯 | `data/archive/2026-09-09.jsonl:472` |
| 3 | 09-09 07:01 | @RepLoriTrahan (Lori Trahan) | official | progressive, newdem, chc, leadership | quote of 2097476196791709843 | regulation-plan (+existential-risk, hearings-oversight) | UNCLASSIFIED | 897 / 110 / 83 / 11 | The call is coming from inside the house. Safety researchers are resigning, powerful AI models are breaking out of their labs, and companies are racing ahead anyway. It's past time for Congress to get off the sidelines and do its job. We can start with my bipartisan FRONTIER https://t.co/P32aesPI8V | `data/archive/2026-09-09.jsonl:474` |
| 4 | 09-09 09:12 | @DaveMinCA (Dave Min) | personal | progressive, capac | retweet of @yashar | existential-risk | tech | (orig: 2398 RT) | RT @yashar: Earlier today, AI researcher Jacob Coxon, who spent the past three years working at OpenAI and Anthropic, publicly resigned fro… | `data/archive/2026-09-09.jsonl:489` |
| 5 | 09-09 09:12 | @DaveMinCA (Dave Min) | personal | progressive, capac | retweet of @hilbertspaess | existential-risk | tech | (orig: 141266 RT) | RT @hilbertspaess: I resigned from Anthropic today. I spent the last three years doing pretraining research at both OpenAI and Anthropic. N… | `data/archive/2026-09-09.jsonl:490` |
| 6 | 09-09 09:15 | @PatRyanUC (Patrick Ryan) | personal | newdem | quote of 2097476196791709843 | hearings-oversight (+other) | tech, congress-politics | 961 / 209 / 77 / 17 | 1) We need emergency hearings on pacing the frontier – NOW!! 2) This November, we need to elect leaders willing to stand up to AI oligarchs and fight for the American people.  Trump wants to let billionaires who only care about ego &amp; profit run our country.  We will stop them. https://t.co/4iF0MbcyU4 | `data/archive/2026-09-09.jsonl:491` |
| 7 | 09-09 09:32 | @JoaquinCastrotx (Joaquin Castro) | official | progressive, newdem, chc | retweet of @MorePerfectUS | surveillance-pre-crime | tech, democracy | (orig: 2833 RT) | RT @MorePerfectUS: Anthropic Is building a surveillance system to monitor activists using a “pre-crime” approach that tries to predict inci… | `data/archive/2026-09-09.jsonl:498` |
| 8 | 09-09 09:55 | @RepCasar (Greg Casar) | official | progressive, chc | quote of 2097476196791709843 | hearings-oversight (+regulation-plan, existential-risk) | tech | 6991 / 1033 / 481 / 54 | An Anthropic researcher just quit, warning they're racing to superintelligence. An employee still there agreed, and put the odds of AI killing all humans above 10%. This is an emergency. Congress must convene hearings and pass my and Bernie’s superintelligence ban. https://t.co/pztLNoY1yk | `data/archive/2026-09-09.jsonl:513` |
| 9 | 09-09 10:12 | @DaveMinCA (Dave Min) | personal | progressive, capac | tweet | existential-risk | tech/ai-policy, foreign-policy/middle-east, climate | 1 / 2 / 0 / 0 | Waking up to see news that: - AI estimated to pose 10% chance of killing all humanity in next 10 years - Iran launched new wave of missiles at US bases and is "surging" construction of nuclear weapons - Orange County hitting 100+ degrees today. https://t.co/LyXPfaNKGt | `data/archive/2026-09-09.jsonl:531` |
| 10 | 09-09 10:15 | @CongressMin (Dave Min) | official | progressive, capac | tweet | regulation-plan (+other) [inferred] | tech/ai-policy | 134 / 27 / 53 / 5 | If we had a government that was actually even a tiny bit concerned about its citizens, it would be actively be pushing forward a framework to try to protect us against the risks of AI.  Instead, Trump is focused on picking out the wallpaper and lighting fixtures for his illegal | `data/archive/2026-09-09.jsonl:537` |
| 11 | 09-09 10:15 | @RepDeluzio (Christopher R. Deluzio) | official | progressive | quote of 2097497037956891126 | existential-risk (+regulation-plan) | tech/ai-policy | 632 / 118 / 94 / 10 | For those still burying their heads in the sand about the risks of superintelligence to humanity: wake up! We need to pump the brakes and get national action on superintelligence. This is an emergency and our government should act like it. https://t.co/F0Leu7iBqw | `data/archive/2026-09-09.jsonl:538` |
| 12 | 09-09 10:34 | @RepJayapal (Pramila Jayapal) | official | progressive, capac | quote of 2097476196791709843 | existential-risk (+regulation-plan) | tech/ai-policy | 546 / 99 / 143 / 15 | Researchers for AI companies are sounding the alarm about rapid development of superintelligent systems that could hack anything and “kill us all.” These AI companies are out of control and a serious threat to our future. We need to shut down their dangerous models and push out https://t.co/vqEqgVHb3X | `data/archive/2026-09-09.jsonl:546` |
| 13 | 09-09 11:59 | @tedlieu (Ted Lieu) | personal | progressive, capac, leadership | retweet of @tedlieu | regulation-plan [inferred] | tech | (orig: 1438 RT) | RT @tedlieu: Below is exhibit number 739 for why we need to pass the bipartisan AI Kill Switch Bill asap. | `data/archive/2026-09-09.jsonl:616` |
| 14 | 09-09 12:18 | @RepYassAnsari (Yassamin Ansari) | official | progressive | quote of 2097476196791709843 | existential-risk (+other) | tech | 2130 / 396 / 289 / 31 | This is absolutely terrifying. Jacob Coxon and Evan Hubinger, top researchers at Anthropic and formerly OpenAI, said these companies are creating technology that could "kill us all by the end of the decade." These revelations prove multi-billion dollar corporations are putting https://t.co/E05fBAHjxu | `data/archive/2026-09-09.jsonl:30` |
| 15 | 09-09 12:48 | @RepDonBeyer (Donald S. Beyer, Jr.) | official | progressive, newdem | quote of 2097476196791709843 | regulation-plan | tech | 734 / 144 / 93 / 17 | I have been working for years to educate my colleagues in Congress about AI, including potential systemic and civilizational risks. Conversations about responses are happening here, and bills are being written to address these risks (I have introduced several myself and am https://t.co/tsFCvGp3ft | `data/archive/2026-09-09.jsonl:55` |
| 16 | 09-09 12:53 | @RepTedLieu (Ted Lieu) | official | progressive, capac, leadership | quote of 2097476196791709843 | regulation-plan | tech | 1276 / 177 / 126 / 9 | Republican leadership should take up the bipartisan AI Kill Switch Bill NOW. https://t.co/YjK5TRd5Ws | `data/archive/2026-09-09.jsonl:59` |
| 17 | 09-09 13:18 | @yassaminansari (Yassamin Ansari) | personal | progressive | retweet of @RepYassAnsari | existential-risk (+other) | tech | (orig: 402 RT) | RT @RepYassAnsari: This is absolutely terrifying. Jacob Coxon and Evan Hubinger, top researchers at Anthropic and formerly OpenAI, said the… | `data/archive/2026-09-09.jsonl:622` |
| 18 | 09-09 13:26 | @yassaminansari (Yassamin Ansari) | personal | progressive | retweet of @hadip | existential-risk | tech | (orig: 22 RT) | RT @hadip: Wild statement from Anthropic’s leader in charge of keeping AI safe: more than 10% chance it kills everybody within 10 years. 🤯 | `data/archive/2026-09-09.jsonl:623` |
| 19 | 09-09 13:44 | @RepMcClellan (Jennifer L. McClellan) | official | progressive, newdem, cbc | quote of 2097476196791709843 | hearings-oversight (+existential-risk) | tech | 0 / 0 / 2 / 0 | This is deeply alarming.  It’s past time we demand greater government oversight of AI before the quest for profit ends humanity. https://t.co/UAzsvW2ItR | `data/archive/2026-09-09.jsonl:94` |
| 20 | 09-09 14:01 | @tedlieu (Ted Lieu) | personal | progressive, capac, leadership | retweet of @politico | hearings-oversight | tech | (orig: 245 RT) | RT @politico: Lawmakers urge Congress to act after AI researcher’s dire warning https://t.co/bL4lQAJVNe | `data/archive/2026-09-09.jsonl:110` |
| 21 | 09-09 14:28 | @RoKhanna (Ro Khanna) | personal | progressive, capac | quote of 2097476203863224394 | regulation-plan (+existential-risk) | tech | 2225 / 570 / 324 / 79 | Anthropic's alignment lead says there’s a 10% chance of AI causing human extinction. The problem is not just misuse, but lack of control. Bluntly, our government has been asleep and is out of touch. Here are 5 things we must do:  ✅ Establish a federal agency like we have for https://t.co/GuwTaTfixf https://t.co/BqdFPmDqa7 | `data/archive/2026-09-09.jsonl:137` |
| 22 | 09-09 16:40 | @KellyMorrisonMN (Kelly Morrison) | official | newdem | quote of 2097476196791709843 | hearings-oversight (+regulation-plan, existential-risk) | tech/ai-policy, congress-politics/house-floor | 212 / 25 / 46 / 4 | The call is coming from inside the house. AI researchers themselves are warning of an existential threat to humanity. Congress can’t wait. Mike Johnson needs to cancel recess so we can get to work immediately – hearings, investigations, and comprehensive regulation. https://t.co/9ovsX3V3SA | `data/archive/2026-09-09.jsonl:269` |
| 23 | 09-09 16:56 | @RepBillFoster (Bill Foster) | official | newdem | quote of 2097476196791709843 | regulation-plan (+existential-risk) | tech | 754 / 77 / 106 / 24 | Anyone who has read METR's Technical Report on the OpenAI/Hugging Face incident will understand that software-only controls will not be sufficient to contain superhuman AI. Any continuing work on adversarial superhuman intelligence must rely on the physical containment methods https://t.co/QdZOVU6FXi | `data/archive/2026-09-09.jsonl:294` |
| 24 | 09-09 16:58 | @RepGregLandsman (Greg Landsman) | official | newdem | quote of 2097476196791709843 | regulation-plan | tech | 110 / 9 / 28 / 2 | Another AI wakeup call for Congress… We need to pass safeguards and protect our communities. https://t.co/NkLkUomaUx | `data/archive/2026-09-09.jsonl:296` |
| 25 | 09-09 16:58 | @RepBeccaB (Becca Balint) | official | progressive | quote of 2097497037956891126 | existential-risk (+regulation-plan) | tech | 173 / 27 / 30 / 1 | The time for burying our heads in the sand is over. If the people working directly on these technologies are saying this, it’s time to pump the brakes. We can’t let these massive AI companies literally gamble with the future of humanity. https://t.co/O6lGmg793U | `data/archive/2026-09-09.jsonl:297` |
| 26 | 09-09 17:12 | @RepChuyGarcia (Jesús G. "Chuy" García) | official | progressive, chc | quote of 2097476196791709843 | regulation-plan (+labor-economy, existential-risk) | tech | 122 / 18 / 10 / 1 | The unchecked development of AI by reckless, for-profit corporations and Big Tech oligarchs threatens our economy, democracy, and humanity itself. Congress must act to ban AI superintelligence, pause data center construction and advanced AI development, mandate independent https://t.co/YhIzyJdNQs | `data/archive/2026-09-09.jsonl:310` |
| 27 | 09-09 18:02 | @Rep_Magaziner (Seth Magaziner) | official | newdem | tweet | regulation-plan | tech | 22 / 5 / 4 / 1 | Everyone is talking about AI insiders saying their technology is a threat to humanity. Here is what Congress can do about it. https://t.co/sTFvQ2WVmq | `data/archive/2026-09-09.jsonl:351` |
| 28 | 09-09 18:50 | @SenRubenGallego (Ruben Gallego, Sen.) | official | — | quote of 2097476203863224394 | hearings-oversight (+existential-risk) | tech | 568 / 105 / 85 / 7 | Mitigating the risk of extinction from AI should be a global priority on par with pandemics and nuclear war. That's why I'm urging Senate leadership to move immediately to establish a bipartisan Senate Select Committee on Artificial Intelligence. We can’t wait for a https://t.co/4nnm1JXeLZ | `data/archive/2026-09-09.jsonl:375` |
| 29 | 09-09 18:55 | @RubenGallego (Ruben Gallego, Sen.) | personal | — | retweet of @SenRubenGallego | hearings-oversight (+existential-risk) | tech | (orig: 108 RT) | RT @SenRubenGallego: Mitigating the risk of extinction from AI should be a global priority on par with pandemics and nuclear war. That's w… | `data/archive/2026-09-09.jsonl:611` |
| 30 | 09-09 18:57 | @RubenGallego (Ruben Gallego, Sen.) | personal | — | retweet of @igorbobic | hearings-oversight | tech | (orig: 23 RT) | RT @igorbobic: News: Democrats are gearing up for action on AI  Rep. Robert Garcia, top Dem on the House Oversight, says investigations wi… | `data/archive/2026-09-09.jsonl:380` |
| 31 | 09-09 18:59 | @repdeliaramirez (Delia C. Ramirez) | official | progressive, chc | quote of 2097476196791709843 | hearings-oversight (+other) | tech | 116 / 26 / 25 / 3 | Employees are sounding the alarms: Big Tech doesn't care about protecting us from AI as long as they profit.    AI tools are being recklessly accelerated by big tech without guardrails, oversight, or accountability.   We must demand Congressional oversight and action to protect https://t.co/tfB4zzidCh | `data/archive/2026-09-09.jsonl:383` |
| 32 | 09-09 19:45 | @RepSaraJacobs (Sara Jacobs) | official | progressive, newdem | tweet | regulation-plan [inferred] | tech | 123 / 10 / 28 / 2 | We don’t have time to wait. The massive threats posed by AI are here and now, and Congress needs to act. https://t.co/AEh3WcXJII | `data/archive/2026-09-09.jsonl:405` |
| 33 | 09-09 19:53 | @SethMagaziner (Seth Magaziner) | personal | newdem | retweet of @Rep_Magaziner | regulation-plan | tech | (orig: 5 RT) | RT @Rep_Magaziner: Everyone is talking about AI insiders saying their technology is a threat to humanity. Here is what Congress can do abou… | `data/archive/2026-09-09.jsonl:620` |
| 34 | 09-09 23:22 | @RoKhanna (Ro Khanna) | personal | progressive, capac | quote of 2097754129489596612 | hearings-oversight (+regulation-plan) | tech, congress-politics | 236 / 54 / 34 / 10 | Speaker Mike Johnson has a moral and practical duty to keep Congress in session until we have taken meaningful action to regulate AI. When members of the House and Senate return to Washington next week, they should fully investigate the threat — and they should not leave DC until https://t.co/mfCSjPceqV | `data/archive/2026-09-09.jsonl:458` |

## Adjacent same-cycle AI posts (8) — not about the story, listed so the boundary is visible

| # | ET | account (member) | acct | caucuses | type | framing | classifier | likes / RT / replies / quotes | text | source |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 09-09 10:03 | @RepJoshG (Josh Gottheimer) | official | newdem | tweet | regulation-plan | tech | 14 / 0 / 3 / 1 | AI agents are running loose in our networks. Right now, it’s becoming harder to see them, verify who built them, or shut them off. That's a five-alarm security risk. That's why I introduced the bipartisan Stop Rogue AI Act with @RepMikeLawler to put people back in the driver's | `data/archive/2026-09-09.jsonl:523` |
| 2 | 09-09 10:09 | @RepCuellar (Henry Cuellar) | official | newdem, chc | tweet | other | tech/ai-policy | 18 / 3 / 3 / 0 | I was honored to participate in the International Catholic Legislators Network’s annual meeting in Rome, where I met with Pope Leo XIV alongside my daughter, Catherine, and heard his address on the challenges and opportunities presented by artificial intelligence. Pope Leo XIV https://t.co/l8VqtVFMqA | `data/archive/2026-09-09.jsonl:526` |
| 3 | 09-09 15:48 | @SarahEMcBride (Sarah McBride) | personal | progressive | retweet of @tracewoodgrains | other | tech | (orig: 9 RT) | RT @tracewoodgrains: On @TheArgumentMag, @SarahEMcBride shares her thoughts on AI: likely the most significant transformation of society si… | `data/archive/2026-09-09.jsonl:215` |
| 4 | 09-09 16:30 | @BennieGThompson (Bennie G. Thompson) | official | cbc | tweet | labor-economy | tech/ai-policy, climate | 32 / 9 / 5 / 1 | Data centers are being promoted as a source of economic growth, but that growth comes with important questions.  How will they affect our water supply, electricity costs, air quality, and quality of life?  People deserve to know what is coming into their communities and how it https://t.co/b0UZarFKCX | `data/archive/2026-09-09.jsonl:258` |
| 5 | 09-09 17:27 | @RepLoriTrahan (Lori Trahan) | official | progressive, newdem, chc, leadership | quote of 2097756596080168991 | labor-economy | tech, economy | 5 / 0 / 7 / 0 | This is a big win for Massachusetts families!   @MassGovernor just signed an executive order declaring that no data center can be built without local approval, and the tech companies pay for their own energy instead of passing the buck to residents.   Now, Congress should pass https://t.co/Jxj1rWRAHe | `data/archive/2026-09-09.jsonl:324` |
| 6 | 09-09 18:25 | @RepSuhas (Suhas Subramanyam) | official | newdem, capac | tweet | labor-economy | [] | 7 / 1 / 3 / 0 | Data centers should not be built on the backs of communities and their utility bills.  We need a real national plan that gives Americans a voice. https://t.co/Wrh9e7qGDk | `data/archive/2026-09-09.jsonl:364` |
| 7 | 09-09 21:07 | @yassaminansari (Yassamin Ansari) | personal | progressive | retweet of @AlexBores | other [unverified] | tech | (orig: 65 RT) | RT @AlexBores: Never thought I'd live to see the day when OpenAI gov affairs claims to have supported all the bills they lobbied against.… | `data/archive/2026-09-09.jsonl:432` |
| 8 | 09-10 01:23 | @tedlieu (Ted Lieu) | personal | progressive, capac, leadership | quote of 2097852614486511626 | regulation-plan [unverified] | NO-TOPICS-FILE | 7 / 2 / 1 / 0 | Dear @WhiteHouse and AI companies: California is the 4th largest economy in the world. I’m happy to let CA dictate AI laws that AI companies will obey. Or you can work with Dems in DC to set strong national standards. The trump Administration’s do nothing approach has failed. https://t.co/qXamVIb2LH | `data/archive/2026-09-10.jsonl:3` |

## Precursors (3) — before the story broke, the breakout background

| # | ET | account (member) | acct | caucuses | type | framing | classifier | likes / RT / replies / quotes | text | source |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 09-07 11:02 | @PatRyanUC (Patrick Ryan) | personal | newdem | quote of 2095853824934330386 | hearings-oversight | tech | 304 / 50 / 13 / 6 | When I wrote a letter with @GregCasar to OpenAI last month (post Hugging Face), we asked whether other similar incidents had occurred.  They refused to tell us. Then this comes out.  The House Democratic Majority arrives in January.  I look forward to the public hearings. https://t.co/TNr8N1AKbf | `data/archive/2026-09-07.jsonl:132` |
| 2 | 09-07 20:37 | @tedlieu (Ted Lieu) | personal | progressive, capac, leadership | quote of 2096896288201564481 | regulation-plan | tech/ai-policy | 2978 / 766 / 102 / 17 | Society has a long-standing solution for machines that pose catastrophic risks. It’s called a kill switch. Look it up. They are everywhere. AI advanced models should not be exempt.   Time for Congress to pass the bipartisan AI Kill Switch Act by Rep Nathaniel Moran and me. https://t.co/ico80SftMH | `data/archive/2026-09-07.jsonl:422` |
| 3 | 09-08 15:41 | @tedlieu (Ted Lieu) | personal | progressive, capac, leadership | retweet of @tedlieu | regulation-plan | tech/ai-policy | (orig: 766 RT) | RT @tedlieu: Society has a long-standing solution for machines that pose catastrophic risks. It’s called a kill switch. Look it up. They a… | `data/archive/2026-09-08.jsonl:515` |

## Posts by hour, Tuesday 2026-09-09 ET (MEASURED)

| ET hour | core posts | core originals | all caucus posts that hour |
|---|---|---|---|
| 00:00 | 0 | 0 | 2 |
| 01:00 | 1 | 0 | 11 |
| 06:00 | 0 | 0 | 2 |
| 07:00 | 1 | 1 | 2 |
| 08:00 | 0 | 0 | 10 |
| 09:00 | 5 | 2 | 34 |
| 10:00 | 4 | 4 | 45 |
| 11:00 | 1 | 0 | 42 |
| 12:00 | 3 | 3 | 54 |
| 13:00 | 3 | 1 | 52 |
| 14:00 | 2 | 1 | 58 |
| 15:00 | 0 | 0 | 62 |
| 16:00 | 4 | 4 | 77 |
| 17:00 | 1 | 1 | 50 |
| 18:00 | 5 | 3 | 37 |
| 19:00 | 2 | 1 | 30 |
| 20:00 | 0 | 0 | 20 |
| 21:00 | 0 | 0 | 17 |
| 22:00 | 0 | 0 | 9 |
| 23:00 | 1 | 1 | 11 |

Monday 2026-09-08 ET: 1 core post at 22:56 (Lieu). Wednesday 2026-09-10 ET (6 posts captured so far): 0 core, 1 adjacent (Lieu, 01:23).

## By caucus (MEASURED; members overlap)

| caucus | posts | originals | accounts | members | who |
|---|---|---|---|---|---|
| progressive | 24 | 17 | 18 | 15 | Ted Lieu, Lori Trahan, Dave Min, Joaquin Castro, Greg Casar, Christopher R. Deluzio, Pramila Jayapal, Yassamin Ansari, Donald S. Beyer, Jr., Jennifer L. McClellan, Ro Khanna, Becca Balint, Jesús G. "Chuy" García, Delia C. Ramirez, Sara Jacobs |
| capac | 11 | 7 | 6 | 4 | Ted Lieu, Dave Min, Pramila Jayapal, Ro Khanna |
| newdem | 11 | 9 | 11 | 10 | Lori Trahan, Patrick Ryan, Joaquin Castro, Donald S. Beyer, Jr., Jennifer L. McClellan, Kelly Morrison, Bill Foster, Greg Landsman, Seth Magaziner, Sara Jacobs |
| leadership | 5 | 3 | 3 | 2 | Ted Lieu, Lori Trahan |
| chc | 5 | 4 | 5 | 5 | Lori Trahan, Joaquin Castro, Greg Casar, Jesús G. "Chuy" García, Delia C. Ramirez |
| (none) | 4 | 1 | 2 | 1 | Ruben Gallego |
| cbc | 1 | 1 | 1 | 1 | Jennifer L. McClellan |

Account type: official 19 · personal 15. Chamber: house 30 · senate 4. Members (21): Becca Balint; Bill Foster; Christopher R. Deluzio; Dave Min; Delia C. Ramirez; Donald S. Beyer, Jr.; Greg Casar; Greg Landsman; Jennifer L. McClellan; Jesús G. "Chuy" García; Joaquin Castro; Kelly Morrison; Lori Trahan; Patrick Ryan; Pramila Jayapal; Ro Khanna; Ruben Gallego; Sara Jacobs; Seth Magaziner; Ted Lieu; Yassamin Ansari.

## Framing (JUDGED)

| framing | primary (all) | primary (originals) | any mention (all) | any mention (originals) |
|---|---|---|---|---|
| existential-risk | 10 | 5 | 19 | 13 |
| hearings-oversight | 10 | 7 | 11 | 8 |
| regulation-plan | 13 | 11 | 19 | 17 |
| surveillance-pre-crime | 1 | 0 | 1 | 0 |
| labor-economy | 0 | 0 | 1 | 1 |
| other | 0 | 0 | 5 | 4 |

regulation-plan leads by primary framing (13 of 34 posts; 11 of 23 originals), hearings-oversight and existential-risk are close behind; but existential-risk is the most-mentioned framing when secondaries count (19 of 34) — the caucus quotes the warning and pivots to a remedy in the same post. surveillance-pre-crime is one retweet (Castro); labor-economy appears only as a secondary (García).

Shape of the day (JUDGED):
- Volume is concentrated in one ET day: every core post but Lieu's Monday-night kill-switch post lands on 2026-09-09, from 01:27 ET (Gallego RT) to 23:22 ET (Khanna).
- Two bursts: 09:00-10:59 ET (9 posts, 6 originals: Dave Min, Patrick Ryan, Joaquin Castro, Greg Casar, Christopher R. Deluzio, Pramila Jayapal) and 16:00-19:59 ET (12 posts, 9 originals: Kelly Morrison, Bill Foster, Greg Landsman, Becca Balint, Jesús G. "Chuy" García, Seth Magaziner, Ruben Gallego, Delia C. Ramirez, Sara Jacobs); the 11:00-14:59 block is 9 posts (Ted Lieu, Yassamin Ansari, Donald S. Beyer, Jr., Jennifer L. McClellan, Ro Khanna), then nothing from 15:00 until Morrison at 16:40, and Khanna alone after 20:00.
- Progressive Caucus members carry most of the originals; New Dems are the second block and supply the institutional/technical voices (Beyer, Foster, Landsman, Morrison, Ryan). CBC is one post (McClellan, 0 likes at capture). No dedicated CAPAC or leadership-only voice beyond members who also hold progressive tags.
- The remedy menu is fragmented: Casar/Sanders superintelligence ban, Lieu/Moran AI Kill Switch, Trahan FRONTIER bill, Khanna 5-point plan + federal agency, Gallego Senate select committee, Morrison cancel recess, Foster physical containment, García ban + data-center pause, Ryan emergency hearings. No bill name or plan is echoed by a second member anywhere in the corpus; the only cross-member sharing is language (next bullet).
- Shared language that does cross members: "the call is coming from inside the house" (Trahan 07:01 ET, Morrison 16:40 ET); "pump the brakes" (Deluzio, Balint); "burying heads in the sand" (Deluzio, Balint — both quoting the same source 2097497037956891126); "gamble/gambling" (Balint echoing Coxon).
- Engagement is top-heavy: @tedlieu 8,007 likes and @RepCasar 6,991 likes hold 53% of the originals' engagement; @RoKhanna 2,225, @RepYassAnsari 2,130, @RepTedLieu 1,276, @PatRyanUC 961, @RepLoriTrahan 897, @RepDonBeyer 734 form the second tier. 9 of 23 originals are under 200 likes at capture (@DaveMinCA 1, @CongressMin 134, @RepMcClellan 0, @RepGregLandsman 110, @RepBeccaB 173, @RepChuyGarcia 122, @Rep_Magaziner 22, @repdeliaramirez 116, @RepSaraJacobs 123).
- The surveillance/"pre-crime" angle the owner flagged reached the corpus once (Castro RT of @MorePerfectUS at 09:32 ET) and did not spread inside the caucus, though x-search.json shows it as the second-largest retweet wave in the wider stream.

Four core posts (Lieu's exhibit-739 post and its self-RT, Min's official post, Jacobs) are linked by timing/wording rather than an explicit reference; removing them leaves 30 core posts / 20 originals and does not change the leading framing.

## What the caucus quoted or retweeted (MEASURED counts; identities as noted)

| source id | count | who / what | posted (UTC) |
|---|---|---|---|
| 2097476196791709843 | 14 | @hilbertspaess (Jacob Coxon) — resignation post | 2026-09-09T00:04:29.195Z |
| 2097556042573816094 | 2 | @hadip — "Wild statement from Anthropic's leader in charge of keeping AI safe: more than 10% chance it kills everybody within 10 years" | 2026-09-09T05:21:45.913Z |
| 2097497037956891126 | 2 | UNVERIFIED — posted 2026-09-09T01:27Z; non-English quotes of it in x-search.json describe Hubinger confirming Coxon | 2026-09-09T01:27:18.116Z |
| 2097476203863224394 | 2 | UNVERIFIED — 1.7s after Coxon's post; quoted by Khanna and Gallego as the Hubinger >10% line | 2026-09-09T00:04:30.881Z |
| 2097474365163999402 | 1 | UNVERIFIED — posted 2026-09-08T23:57:12Z, 7 min before Coxon; quoted by @tedlieu as "exhibit number 739" | 2026-09-08T23:57:12.501Z |
| 2097542341670359082 | 1 | @yashar — news summary of the resignation | 2026-09-09T04:27:19.363Z |
| 2097675318978842764 | 1 | @MorePerfectUS — Anthropic "pre-crime" activist-surveillance story | 2026-09-09T13:15:43.624Z |
| 2097519390480891976 | 1 | caucus post by @tedlieu (in this file) | 2026-09-09T02:56:07.000Z |
| 2097721236839162155 | 1 | caucus post by @RepYassAnsari (in this file) | 2026-09-09T16:18:11.000Z |
| 2097684240356049178 | 1 | @politico — "Lawmakers urge Congress to act after AI researcher's dire warning" | 2026-09-09T13:51:10.646Z |
| 2097820074568454156 | 1 | caucus post by @SenRubenGallego (in this file) | 2026-09-09T22:50:56.000Z |
| 2097818430032257216 | 1 | @igorbobic — "Democrats are gearing up for action on AI" (Robert Garcia / Oversight investigations) | 2026-09-09T22:44:23.958Z |
| 2097807998429130876 | 1 | caucus post by @Rep_Magaziner (in this file) | 2026-09-09T22:02:56.000Z |
| 2097754129489596612 | 1 | caucus post by @RoKhanna (in this file) | 2026-09-09T18:28:53.000Z |

Top originals by engagement at capture: @tedlieu 8007 likes / 1437 RTs (regulation-plan); @RepCasar 6991 likes / 1033 RTs (hearings-oversight); @RoKhanna 2225 likes / 570 RTs (regulation-plan); @RepYassAnsari 2130 likes / 396 RTs (existential-risk); @RepTedLieu 1276 likes / 177 RTs (regulation-plan); @PatRyanUC 961 likes / 209 RTs (hearings-oversight); @RepLoriTrahan 897 likes / 110 RTs (regulation-plan); @RepDonBeyer 734 likes / 144 RTs (regulation-plan). Sum over the 23 originals: 34,427 likes+RTs+replies+quotes.

## What the pipeline saw (MEASURED)

- `data/topics` tech assignments per day: 09-07: 4 tech (1 ai-policy) of 439 · 09-08: 8 tech (1 ai-policy) of 528 · 09-09: 40 tech (7 ai-policy) of 624. The 09-09 jump (8 → 40) is the story, but it never left the `tech` macro.
- `data/rollups/topic-days.json` 2026-09-09, all caucuses: tech ranks 8 of 15 macros (26 posts + 10 RTs, 25 members) behind economy 92, congress-politics 81, democracy 65.
- reports/2026-09-09.md: Technology absent from the all-caucus top 3 (economy 102, congress-politics 84, democracy 67); appears only as CAPAC #3 "Technology — 6 posts + 4 RTs, 4 members, 0 engagement" (line 43). No developing-story line for the story.
- `data/stories.json` (125 candidates, generated 2026-09-10T06:26:35.672Z): NONE — no candidate key/label/alias in data/stories.json mentions Anthropic/Coxon/Hubinger/superintelligence/AI safety/existential/kill switch/frontier (only false positive: bridge-naming-honorary-designations (sample text matches "anthropist" — not this story)). Nearest candidates: `data-centers` (21 posts, 19 members, 2026-08-20→2026-09-09), `surveillance-privacy` (6 posts, 6 members, 2026-08-21→2026-09-04).
- `data/topics/2026-09-09.json` emerging clusters: NONE about the story — the 25 emerging labels on 2026-09-09 are 9/11 remembrance, Smithsonian, agriculture, data-centers-utility-costs, etc. (data/topics/2026-09-09.json emerging[])
- `data/context.json` and `data/incidents.json`: 0 hits.
- Sanity sweep for archive posts quoting/retweeting a curated post that were not themselves curated: none.

## UNVERIFIED

- What 2097474365163999402 (quoted by @tedlieu as "exhibit number 739", posted 7 minutes before Coxon's post) shows — not in the corpus, no lookup bought.
- Whether 2097476203863224394 is the second post of Coxon's thread carrying Hubinger's odds (Khanna and Gallego quote it as such; 1.7s after the first post).
- Author of 2097497037956891126 (quoted by Deluzio and Balint); x-search.json non-English quotes describe it as Hubinger confirming Coxon.
- The full text of 11 truncated core originals (@RepLoriTrahan, @CongressMin, @RepJayapal, @RepYassAnsari, @RepDonBeyer, @RoKhanna, @RepBillFoster, @RepChuyGarcia, @SenRubenGallego, @repdeliaramirez, @RoKhanna): the archive stores the 280-char capture only, so Khanna's points 2-5, Trahan's bill name, García's remaining demands, Beyer's bill list and Foster's containment methods are cut.
- Links in Magaziner's and Jacobs' posts ("here is what Congress can do") — unread; the linked content is what would confirm their framing.
- Whether @AlexBores' post and @tedlieu's 09-10 CA-standards post are responses to this story or to a separate OpenAI/White House development.

## Problems for the intelligence layer

1. Classifier granularity: 28 of 34 core posts got bare "tech" with a null subtopic although config/taxonomy.yaml has tech/ai-policy; only 5 got tech/ai-policy. The story is therefore indistinguishable in data/topics from Gottheimer's AI LABS Act or data-center posts.
2. Classifier miss: 2097641446983528943 (@RepLoriTrahan, 897 likes, quotes Coxon, names her FRONTIER bill) is the only unclassified post of 2026-09-09 (data/topics/2026-09-09.json unclassified[0]).
3. Inconsistent subtopic use: @RepCuellar's Pope Leo post got tech/ai-policy while Casar, Khanna, Ansari, Beyer, Lieu, Foster, García got bare tech.
4. No story surfaced: because every post fit an existing macro, none went to emerging clusters, so data/stories.json has no candidate, data/context.json was never searched for it, and reports/2026-09-09.md does not mention it (tech ranks 8th of 15 macros for the day in data/rollups/topic-days.json: 26 posts + 10 RTs, 25 members). The "emerging = fits nothing" rule cannot see a burst inside an existing macro.
5. Engagement in derived layers is 0 for 2026-09-09 (report and rollup) because the 24h metrics re-read has not run; metricsAtCapture is available in the archive but retweet rows carry the original's counts (e.g. 141,266 on Min's RT of Coxon), so any naive sum is wrong.
6. Capture timing: every 2026-09-09 post has capturedAt 2026-09-10T05:26-05:59Z (backfill), i.e. the corpus had none of Tuesday's posts until ~01:30 ET Wednesday; a live narrative layer would have been blind through the whole day.
7. Roster: the list includes Senate accounts (Gallego, status=senate); "House Democrats" counts should filter on status.
8. Account duplication: 5 members post from two listed accounts each (Ted Lieu, Ruben Gallego, Dave Min, Yassamin Ansari, Seth Magaziner), so 26 accounts are 21 members; 4 of the 11 retweets are a member re-posting his or her own other account (@tedlieu, @yassaminansari, @RubenGallego, @SethMagaziner). authors.json also spells the same member two ways ("Senator Ruben Gallego" / "Ruben Gallego"), which breaks a naive member dedupe.
9. Truncation: 280-char capture without note_tweet expansion cuts 11 of 23 core originals mid-sentence, including the plan posts the owner would most want to read (Khanna's 5 points).
10. Neighboring candidate not merged: stories.json has a surveillance-privacy gap candidate (6 posts, 08-21..09-04) that Castro's pre-crime RT would extend; the classifier filed the RT as tech + democracy instead.
