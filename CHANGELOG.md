# BUSTR Changelog

Patch notes for BUSTR, a jail-busting helper userscript for Torn. Original script by Adobi & Ironhydedragon (MIT licensed). Entries below cover this contribution branch, proposed by The_Baron [1467784].

---

## v2.21.1
- [NEW] **Optional Easy Bust / Easy Bail - opt-in, default OFF, behind a consent prompt.** Turn either on in Settings and BUSTR adds a one-tap button to the jail list header: tapping it sends one bust (or bail) request for the single best target currently shown - Easy Bust picks the highest success %, Easy Bail picks the cheapest. This goes a step past Quick actions: where Quick Bust only relabels your own click, Easy Bust has BUSTR send the request itself. It stays strictly **one tap = one request**, to the same jail page, with no looping, no timer, and no auto-repeat - the button does nothing until you tap it again, and you choose whether and when to tap. BUSTR only chooses which shown target, never when to act.
- [CHANGED] **The jail list refresh button now sits in a small BUSTR bar above the captive list, next to the Easy actions**, instead of tucked into the list header. The bar shows on the jail page with the refresh control (the ↻), and the Easy Bust / Easy Bail buttons join it when you turn them on. On a successful action the bar names who it hit, e.g. "Woodwinds was busted."
- [NOTE] This is the same one-tap-one-request action the ReTorn extension ships, which a Torn officer reviewed and confirmed stays within Torn's "one click, one request, same page" rule. It is still off by default and asks for a one-time confirmation before it can be enabled. The compliance charter at the top of the script is rewritten to match: the red line is now **automation** (looping, timers, acting without a fresh press, or more than one request per tap), not the act of sending a request you personally triggered.

## v2.20.2
- [CHANGED] **The Quick Bust / Quick Bail indicator is now honestly described: it is the green highlight on the button, not a "Q".** The code carried a leftover "Q" badge (copied from how TornTools marks its own quick actions) that was positioned off the icon corner and almost always clipped out of view, so nobody actually saw it - only the green button highlight. That dead badge is removed; the green highlight (plus a subtle icon tint) is the one, real indicator, and the Settings help now says so.
- [NOTE] **If you run TornTools, turn its own Quick Bust off to use BUSTR's - the two act on the same bust/bail link and conflict.** Earlier notes claimed BUSTR "won't fight" another script doing the same; in practice running both together does conflict, so only one should be on. The Settings help and the v2.18.x notes are corrected to match.

## v2.20.1
- [INTERNAL] **The script now supports auto-updates for GitHub installs.** It declares `@updateURL`/`@downloadURL` pointing at a stable `release` branch, so a copy installed from GitHub updates itself to vetted releases through your userscript manager. The `main` branch auto-commits work in progress and is deliberately NOT the update source, so half-finished changes never reach anyone. No behaviour change; GreasyFork installs continue to update through GreasyFork as before.

## v2.20.0
- [CHANGED] **Success % is now better calibrated at the top end, using real pooled outcomes across players.** The model ranks targets correctly but was over-promising on its best-looking ones: targets shown around 81% were actually succeeding closer to 65%. That over-confidence was baked into a "shrink" constant fitted long ago on just 81 busts from a single player. Refitting it against the first proper cross-user dataset (1224 fully reconstructable outcomes from 26 players) shows the numbers needed to be pulled in harder. The high end now reads more like the mid-60s where the data actually lands, and the very low predictions come up a little too. On that data this cut the model's Brier error from 0.246 - which was fractionally *worse* than just guessing the average - to 0.235, and it passes leave-one-out cross-validation (in-sample and held-out scores are essentially identical, so it is fitting a real curve, not noise). If you bust a lot, your success % will look slightly more conservative and match your real results more closely.
- [CHANGED] **The green/orange/red colours on each target are re-centred to match the new range, so they stay meaningful.** Because the honest range is now narrower (about 27%-67%), the old thresholds left green almost unreachable and red almost never shown. Green now means a clearly better-than-average target and red a clearly worse one, anchored to the real average success rate; on the pooled data the three colours line up with roughly 65% / 53% / 26% actual success. If you had already customised these thresholds in Settings, your choices are kept; only the defaults moved.
- [NOTE] This only changes how the raw score is presented, not the ranking of targets or anything about penalty. The displayed range is now roughly 27%-67% (it was about 16%-81%); the endpoints are honest about what the pooled data delivers. Follows directly from v2.16.0's penalty-saturation fix and the v2.15.1 enrichment that made outcomes reconstructable - the "improve BUSTR from shared data" loop the cloud-sync consent promises. The constants stay fixed for everyone, not fitted per player, and will be refined further as more data accumulates.

## v2.19.0
- [CHANGED] **The Jail nav badge is decluttered: by default it now shows just your busts-left count plus your penalty %, instead of four numbers at once.** It used to show the raw penalty score, your safe threshold, the bust count, and the penalty percentage all together (e.g. "1285 / 1633 : 2" with "104%"), which was a lot to read at a glance on both desktop and PDA. Now it leads with the two numbers that matter: how many more busts you can safely make (colour-coded by budget), and your penalty %. The raw score / threshold prefix is what gets tucked away. Nothing is lost: the full breakdown is one hover (or tap, via the mobile detail popup) away, and it is still in the settings status line. A new "Compact nav badge" toggle in Settings (default on) restores the full always-on readout if you prefer it.
- [NEW] **The penalty % is now colour-coded by severity, the inverse of the success-chance colours.** Low penalty shows green, rising through amber to red, and once you go over 100% it turns a heavier, brighter red with a glow so it reads as clearly more serious than a high-but-under-100% penalty. This gives you an at-a-glance sense of how cooked you are without reading the number.

## v2.18.1
- [FIX] **Quick bust/bail is now reliable, and BUSTR's own jail refresh no longer breaks it.** Torn's jail list is React-rendered and rebuilds each bust/bail link constantly (on every refresh, filter change, or tick), which wiped the no-confirm marker written onto the link ahead of time - so the confirmation page came back intermittently, and always right after using BUSTR's refresh. Quick bust/bail now points your click at Torn's no-confirm link **at the moment you click it** (a capture-phase handler that runs before Torn's own click logic), so it can't be undone by a re-render and survives refreshes. It stays idempotent and never strips anyone else's marker, but do not run it alongside TornTools' own Quick Bust: the two act on the same link and conflict, so turn TornTools' Quick Bust off to use BUSTR's. Still your own click, one request - no automation.

## v2.18.0
- [NEW] **Optional Quick Bust / Quick Bail - opt-in, default OFF.** Turn either on in Settings and BUSTR sends your own click straight to Torn's no-confirmation variant of its bust/bail link, skipping the "are you sure?" step. A green highlight marks every button it applies to. BUSTR never clicks, fetches, or loops - you still press every button yourself, one click per bust, which is exactly Torn's stated rule (the same mechanism the long-standing TornTools extension uses). Leave it off to keep Torn's confirmation. **If you also run TornTools, turn its own Quick Bust off to use this.**
- [NEW] **Jail list refresh button.** A refresh control on the jail list header reloads just the captive list in place - no full page reload - by nudging Torn's own hash-based list loader, then BUSTR re-decorates the fresh rows with your odds overlay. It only reads the list you're already viewing; it never touches a bust/bail control.
- [NOTE] The compliance charter at the top of the script is restated to match: the red line is that BUSTR never performs a game action for you. Relabelling the target of your own click, and refreshing a list you're viewing, both stay on the safe side of it.

## v2.17.1
- [CHANGED] **BUSTR now makes API calls only on the jail page - none anywhere else on Torn.** It was quietly fetching your bust log once on every page you opened, which added up against your API log allowance over a browsing session. But your bust log can only change when you bust, and that only happens on the jail page - so off it the cached log plus simple time-decay already give the correct penalty with no request needed. The bust-budget badge still shows and decays on every page exactly as before; it is just painted from cache now. On the jail page, fetches are unchanged (at most once every 35 seconds). Thanks to mavri [2402357] for spotting the wasted log calls.

## v2.17.0
- [CHANGED] **Your success % now reflects your own bust perks by default, so it is tailored to you.** Previously BUSTR assumed everyone was fully perked until self-calibration had learned from 100+ of your own busts - which meant an under-perked player was shown the same (over-optimistic) odds as a maxed one. Perk-based calibration is now on by default: it reads the bust perks on your account and scales the success number accordingly, so a player with fewer perks correctly sees lower odds and a fully-perked player is unchanged. Validated against real pooled outcomes across players (it improves accuracy most at low and mid penalty), and self-calibration still takes over once it has enough of your own results. You can turn it off in Settings to use the plain baseline. Existing users get it switched on once; if you then turn it off, it stays off.
- [NOTE] It only adjusts the **success %**, never your penalty. Letting perks also scale the penalty calculation was deliberately NOT done - that path puts calibration in a denominator and is the same coupling that caused a past feedback-loop bug, and it was not validated. Each player's numbers adjust to their own level, perks, and learned results independently; one player's perks never change another player's readings.

## v2.16.0
- [CHANGED] **Success % is now realistic at high penalty, instead of collapsing to ~16%.** The model used to subtract penalty without limit, so once your penalty climbed past ~100% almost every target showed the ~16% floor - even though those busts really succeed around 40-55%. This is the first change driven by real pooled outcome data across players: penalty's effect now saturates around 95% penalty (it still bites hard up to there, so low and mid penalty are unchanged). On the data this was fitted against, it cut the model's Brier error from 0.30 - which was worse than just guessing the average - to about 0.23, validated by leave-one-out cross-validation and stable with or without the single heaviest-penalty player. If you bust at high penalty, your numbers will look believable now.
- [NOTE] This also lets **self-calibration work at high penalty again**. Before, a heavy high-penalty player's self-calibration would max out and still be stuck at 16%, because the flooring came from the penalty term, which self-calibration cannot adjust. With penalty saturating, self-calibration can once again reflect your real success. The saturation point (95%) is a first data-driven estimate and will be refined as more outcome data accumulates.

## v2.15.2
- [CHANGED] **Cloud sync now works on Torn PDA, not just desktop - so your bust history syncs across your phone and your computer.** It was always gated on the app providing cross-origin request support (`GM_xmlhttpRequest`), which recent Torn PDA versions now do natively; the old "desktop only" label was simply out of date. Enable it on both and they merge to the same history, tied to your Torn ID. If an app or manager still lacks the support, the option shows as unavailable rather than failing silently. (No change to how sync works where it already worked.)

## v2.15.1
- [INTERNAL] **Cloud sync now captures the full model-relevant picture, so the success model can actually be improved from real cross-user data.** Analysing synced outcomes showed the model over-predicts at low penalty and badly under-predicts at high penalty (many busts shown ~16% actually succeed ~70%), but the fix could not be validated because the stored data was missing pieces. Two enrichments fix that: (1) each logged outcome now also records the **level and skill-calibration** used for its prediction (`lvl`, `cal`), making every prediction exactly reconstructable; (2) for opted-in cloud users the synced snapshot now also includes your **script version, effective and self calibration, PDA flag, and the prediction-affecting settings** (perk calibration, self-calibration, any manual calibration override, play style) - the useful parts of the debug export, never the diagnostic/DOM parts and never your API key, name, ID, or faction.
- [PRIVACY] The consent prompt, settings help, and listing/forum disclosures are updated to name exactly what is stored. This changes nothing about how predictions work on your device; it only lets the shared model learn. Turning sync off still deletes your cloud copy. See ROADMAP for the recalibration plan this unblocks.

## v2.15.0
- [FIX] **BUSTR no longer makes your browser offer to autofill a password in Torn's text boxes.** The settings panel's API-key field was a `type="password"` input, which made the browser's built-in password manager pop up its "Manage passwords" prompt and try to autofill nearby boxes (like the chat search) - it stopped only when BUSTR was disabled. The field now masks your key without being a password field, and tells third-party managers (LastPass, 1Password, Bitwarden, Dashlane) to skip it.
- [CHANGED] **Torn PDA no longer looks like it wants your API key twice.** On PDA the app already injects your key at install, so when that key is working BUSTR now just shows "API key is saved." (the same as a saved desktop key) instead of a second key box. If the injected key is missing, the wrong length, or being rejected by Torn, the entry stays open so you can fix it; and there's an opt-in "Use your own key instead" link if you ever want to override the PDA key with your own.

## v2.14.0
- [CHANGED] **Cloud sync now also backs up your bust perks and level, not just your bust history.** For opted-in users, each sync stores a snapshot of your detected bust perks and your level alongside the outcome log, so BUSTR's success model can be studied and improved against real perk-and-outcome data across users. As before this is opt-in and off by default, tied to your verified Torn ID, and deleted when you switch sync off.
- [PRIVACY] The consent prompt, settings help, and listing/forum disclosures are updated to say exactly this: what IS stored is your bust stats, your bust perks, and your level; what is NEVER stored is your API key, name, ID, or faction. The perk calibration you see is still computed locally - uploading perks only lets the shared model learn from them. If you had sync on before, your perks and level are added on the next sync; nothing else changes.

## v2.13.3
- [INTERNAL] **Cloud sync is much lighter on the database, so it scales to many more users on the free tier.** Uploads now coalesce a whole busting flurry into a single write (the timer resets on each bust and flushes once you pause) instead of writing after every bust, and the once-per-load cloud pull is now capped at once per hour per device instead of once every five minutes. Enabling sync still pulls immediately so a new device restores your history right away, and nothing is lost - anything not yet uploaded is caught by the next upload or the next hourly sync. Also de-duplicated the internal Firestore request code.

## v2.13.2
- [FIX] **Removes synthetic test rows from your logged history.** The private cloud test wrote a couple of placeholder "bust" rows (tagged with an internal note field that no real bust ever has) into the stored log. On load, BUSTR now strips any such non-genuine rows, and the cloud-sync merge refuses to re-add them, so they disappear from your sample count and success-rate stats and get cleaned out of the cloud copy on the next sync. Genuine busts - including older ones recorded before model versioning - are untouched. The success-percentage fit was never affected (it already only uses rows stamped with the current model version), so predictions do not change.

## v2.13.1
- [INTERNAL] **Cloud sync now makes far fewer database calls.** Two changes, no visible difference: (1) on page load it pulls from the cloud at most once every 5 minutes per device instead of on every single Torn page navigation; (2) a pull that finds the cloud already up to date no longer writes an identical copy straight back - it stays a pure read. New busts still upload within a few seconds as before. This keeps a busy play session well inside the free-tier quotas and cuts needless traffic.

## v2.13.0
- [NEW] **Optional cloud sync for your bust history - opt-in, default OFF.** Turn it on in Settings and your outcome log is backed up to a database and merged across your devices, keyed to your verified Torn ID, so your history and self-calibration follow you between desktop installs. It never performs a game action - it only stores the numbers BUSTR already logs - so the read-only compliance stance is unchanged.
- [PRIVACY] Only bust stats are stored (hardness, penalty, outcome, timestamp). **Your API key is never uploaded** and never leaves the device; it's used once to verify your Torn ID, via a server function that mints a scoped access token. Each user can only ever read their own data (enforced server-side). Enabling shows an explicit consent prompt first; turning it off deletes your cloud copy. Aggregate stats help improve the model.
- [NOTE] **Desktop only for now.** Sync uses the userscript manager's cross-origin request permission (`GM_xmlhttpRequest`) to satisfy Torn's content-security policy; on PDA/mobile shims that lack it, the whole section is simply inactive. Everything else in BUSTR works there as before.
- [INTERNAL] The auth session (refresh token, uid) is stored separately from BUSTR's normal state, so it can never appear in a debug export. The debug export continues to exclude your API key.

## v2.12.6
- [FIX] On mobile, the "?" help pop-ups could not be read in full - the description docked to the bottom of the screen, where the mobile browser's toolbar covered its lower half and its scroll area, so long descriptions were cut off with no way to reach the rest (reported on Firefox Android). The help card is now centred on mobile instead of bottom-docked, so the browser toolbar can't clip it, and it scrolls internally with momentum. The header (with the close button) is now sticky, so you can always dismiss the card no matter how far you've scrolled.

## v2.12.5
Reworks what BUSTR does off the jail page, so each mode behaves as its description promises.

- [FIX] **Major performance fix: the bust-detection observer now runs only on the jail page.** BUSTR watches the whole document for the "You busted ... out of jail" text so it can update your penalty instantly. That observer fires its callback on *every* DOM change anywhere on the site, and it was armed on every page at startup regardless of location or scope. On churn-heavy pages like the item market it fired continuously - for a bust that can only ever happen on the jail page - which is what caused the reported loading and lag on the item market and elsewhere. It is now armed only on the jail page and torn down everywhere else, in **both** modes.
- [CHANGED] **The jail-page scan and passive bust-click capture are now gated to the jail page too.** Combined with the observer fix, this means: in **"always"** mode, off the jail page only the penalty display stays live (the nav badge shows and decays while you do other things) and nothing scans or observes; on the jail page everything runs. That matches the intent of "always" - keep the budget visible everywhere, but only do the heavy work where busting happens.
- [FIX] **"Jail page only" mode is now genuinely idle off the jail page, from the moment the page loads.** Previously, even in jail-only mode the startup still fetched your log and recomputed on non-jail pages; only the recurring tick respected the scope. Now, off the jail page in jail-only mode, the only thing present is the settings button - no fetch, no recompute, no scan, no observer. Visiting the jail page brings it fully to life: penalty first, then the jail-list scan.

## v2.12.4
- [FIX] "Jail page only" now takes effect the moment a page loads, instead of up to a full refresh interval (30-60s) later. The suppression that hides the nav badge and page colouring off the jail page was only applied inside the interval tick, and that timer does not fire until one interval after load. So on every non-jail page, BUSTR's badge and colours showed for 30-60 seconds before being hidden - which read as "jail-only isn't working, it still shows on other pages." The scope is now applied at startup as well as on each tick.
- [NOTE] The BUSTR settings button in the sidebar is still shown on all pages in jail-only mode, by design: it is how you reach settings to change the mode back, and jail-only is documented as hiding the nav badge and colour, not the settings entry. If hiding that too is wanted, it needs a deliberate decision about how settings stay reachable off the jail page.

## v2.12.3
- [FIX] **BUSTR failed to load entirely on Torn PDA.** Nothing rendered at all - no nav button, no badge, no hardness column, no settings panel - and it was completely silent, because the failure was a *parse* error: the script never ran, so none of its nine error handlers existed to report anything. Diagnosed with a throwaway on-screen probe after the environment checked out clean (`visualViewport`, `GM_*`, `localStorage` and the DOM were all fine on PDA, disproving the obvious suspects). Two causes, both now removed:
  - **Curly apostrophes (U+2019) inside single-quoted strings.** Four help-text strings contained `prisoner’s` / `Torn’s`. That is valid JavaScript as written, but anything in the Greasy Fork to PDA transfer that normalises a curly quote to a straight one turns it into `'prisoner's ...'`, which closes the string early and destroys the parse of the whole file. All non-ASCII is gone: the file is now pure ASCII, with apostrophes escaped and the help-panel close glyph written as `&times;`.
  - **The `###PDA-APIKEY###` token appeared twice** - once as the real declaration, once inside a comment describing it. PDA substitutes *every* occurrence, so the injected key was also being pasted into that comment. Harmless in isolation, but it put an unpredictable substitution in a second place for no reason. The comment no longer contains the literal token.
- [NOTE] Two throwaway diagnostics were used to find this and are kept in the project folder, not shipped: `bustr.probe.user.js` (prints environment facts and hooks `console.error`, since PDA has no reachable console) and `bustr.debug.user.js` (wraps the module body to catch and display module-level throws). The probe's key insight was that *no* `console.error` was captured, which is what proved the failure was at parse time rather than inside any function.

## v2.12.2
- [FIX] Reverts v2.12.1. The "Create a key for BUSTR" link is back to `#tab=api?step=addNewKey&...` with a **question mark** before `step`, which is the form that actually works. v2.12.1 changed it to `&step=` on the strength of a secondary source and broke it. Everything after the `#` is a single fragment string, and Torn's handler splits it on `?` to separate the tab name from that tab's parameters; with `&`, the tab value swallows the whole rest of the string, `step` is never found, and the user lands on a bare API page with nothing pre-ticked. The code now carries a warning not to "correct" the separator again.

## v2.12.1
- [FIX] The "Create a key for BUSTR" link used `?step=addNewKey` after the `#tab=api` fragment; it now uses `&step=addNewKey`, matching the separator used by a live, confirmed-working key link. Both spellings circulate in the wild, and the wrong one fails silently: the user lands on the API page with nothing pre-ticked, sees an ordinary key form, and most likely falls back to creating a Full Access key - defeating the entire point of the feature.

## v2.12.0
- [NEW] **"Create a key for BUSTR" button, and BUSTR no longer asks for a Full Access key.** The settings panel now links to Torn's API page with exactly the three selections this script reads already ticked (`basic`, `log`, `perks` - your level, your bust history, your bust perks) and nothing else. One click, generate, paste back.
- [CHANGED] **This is a security improvement, not just convenience.** Every previous version told users to hand over a Full Access key, which grants money, mail, events and faction controls to a script that reads three things. A key scoped to those three cannot touch any of it, which meaningfully limits the damage if a key is ever leaked from local storage. All the panel text, error hints, listing and forum copy have been updated accordingly.
- [NOTE] The selection list is a single constant shared by the link and the documentation, and it is verified to match the script's actual API calls exactly. If a future change adds a selection to a fetch, it must be added there too or new users will get a key that silently cannot serve it.

## v2.11.2
- [NEW] **"Reset settings only" and "Clear outcome log" now need two taps**, matching "Erase all BUSTR data". Both are irreversible, and clearing the outcome log destroys exactly the same logged bust history the full erase does, which is the data self-calibration is built from and can represent months of play.
- [CHANGED] The two-tap confirm is now one shared helper rather than logic copied per button, so the three cannot drift apart and any destructive button added later is safe by construction instead of by remembering. "Clear saved key" is deliberately left as a single tap: re-pasting a key is trivial and it is the recovery path when a key is wrong, so slowing it down would obstruct exactly the moment someone is trying to fix something.

## v2.11.1
- [FIX] **Critical, and the reason v2.11.0 should not be used: the `?` buttons on "Reset settings only" and "Erase all BUSTR data" triggered those buttons.** The chip was placed inside the `<button>` element, so tapping it clicked the button. Tapping `?` on Reset genuinely reset every setting, and tapping `?` on Erase would have deleted your saved API key and your entire logged bust history, irreversibly. Fixed three ways: the chips now sit **beside** the buttons rather than inside them; the panel's click handler moved to the **capture phase**, so a chip is intercepted before any control can react to it (in the bubble phase it sat on an ancestor, so the button's own handler ran first and the existing `stopPropagation()` was useless); and no chip is nested inside an interactive element anywhere in the panel.
- [NEW] **"Erase all BUSTR data" now needs two taps.** It changes to "Tap again to erase everything" and only wipes on a second tap within four seconds. Erasing is irreversible and takes the outcome log with it, which can be months of logged busts, and on PDA these buttons are finger-sized and adjacent. This guard should have been there from the start, independently of the bug above.

## v2.11.0
Settings panel rework, aimed at making the script approachable to someone installing it for the first time.

- [NEW] **Every setting now has a `?` button** that opens an explanation in a card beside the panel (docked to the bottom on phone and PDA widths, where there is no room alongside). Twenty explanations in total, covering every control.
- [CHANGED] **The permanent small print under each setting is gone.** All of it moved behind those `?` buttons. The panel now reads as a list of controls rather than an essay, and the explanations got longer and more useful in the process, since they no longer have to be short enough to skim past.
- [CHANGED] Bust budget explanations rewritten properly. "Custom threshold" now says what a penalty ceiling actually is and that leaving it at 0 lets BUSTR derive it from your own bust history; "Refresh rate" now makes clear it only redraws the numbers and does **not** change how often the Torn API is called.
- [CHANGED] **The API key section is stateful.** Once a key is saved it simply reads "API key is saved." and offers one Clear button; the paste field and Save button are hidden until there is no key. Previously both stayed on screen permanently, inviting you to re-enter a key that was already working.
- [FIX] **Removed the "Re-enter API key" button**, which did the same thing as "Clear saved key" (delete the stored key) but with a page reload. Having both in one panel implied one of them did something else. "Reset settings to defaults" is renamed **"Reset settings only"** and "Clear all BUSTR data" to **"Erase all BUSTR data"**, so it is obvious at a glance that one keeps your key and history and the other does not.

## v2.10.0
Model calibration release, built on 81 logged outcomes across two fully independent batches. This resolves the follow-up left open since v2.8.0.

- [CHANGED] **Predictions are now calibrated: the displayed success % spans roughly 16% to 81% instead of 1% to 100%.** The linear model discriminates correctly (higher predictions genuinely succeed more often) but was overconfident in both directions - pooled over 81 real outcomes, targets shown 99% succeeded 85% of the time, shown 83% succeeded 68%, shown 7% succeeded 29%. The raw score is now pulled toward a 45% centre (`shown = 45 + 0.65 × (raw − 45)`). **The script will never show 100% again, deliberately** - the best-looking targets in the data succeed ~85% of the time, and 100% was a promise the data shows it could not keep. Brier improves 0.2164 → 0.1970 in-sample and, critically, 0.2164 → 0.2018 under leave-one-out cross-validation - the exact test the v2.8.0 raised-floor experiment failed. Constants are fixed, not fitted per player; free parameters at this sample size buy noise.
- [VALIDATED] `PENALTY_WEIGHT = 2.0` confirmed against a second, disjoint batch: batch 1 (n=38) fits 1.95, batch 2 (n=43) fits 2.25, pooled 2.15. Two independent datasets bracketing the shipped value; left unchanged.
- [FIX] Saved settings are pruned of `highPenaltyCaution` and `ignorePerks`, which nothing has read since v2.8.0. They rode along in stored state and diagnostic exports, implying features that no longer exist. (`ignorePerks` is still read once, by the migration that converts it to `usePerkCalibration`, before being dropped.)

## v2.9.7
- [CHANGED] Renamed to **BUSTR: Jail Bust Assistant + PDA (Baron)**. "Busting Reminder" described the original script, which reminded you how many busts you had left; this build also predicts your success odds on every individual target, weights penalty against real logged outcomes, and calibrates to your own results, so "reminder" undersold it. "Assistant" is deliberately broad so the name doesn't go stale again. The `(Baron)` suffix stays for the same reason it was added in v2.7.10: it keeps this fork from colliding with the original authors' script on GreasyFork.
- [CHANGED] Refreshed the `@description`, which still read "Guess how many busts you can do without getting jailed" and predated the success-% model entirely.
- [CHANGED] Corrected the contributor `@author` line: it credited "high-penalty caution", which v2.8.0 removed, and omitted the penalty weighting that replaced it.

## v2.9.6
- [CHANGED] Smaller type in the PDA nav badge (bust count 9px, penalty % 8px, tighter line height) so the two rows and the BUSTR label share one nav slot without crowding each other. Sizes are stated in px rather than em so they can't inherit something unexpected from Torn's own nav styling.

## v2.9.5
- [FIX] Another go at the overlapping PDA badge, this time addressing something the previous attempts missed: **flex only lays out in-flow children**, so a single positioned child is enough to break the stack - and there are two candidates in that column, not one. v2.9.3 and v2.9.4 forced only the badge into flow, leaving Torn's own nav link free to sit on top of it, which is what kept hiding the %. Every direct child of the column is now forced into normal flow. The whole column is BUSTR's own clone, so nothing inside it needs to be positioned.
- [NEW] `badgeState` in the diagnostic export now also reports the computed style of the badge's **holder** and of the **link**, not just the badge. Both children have to be in flow for the stack to work, so reporting only one of them left the actual culprit invisible.

## v2.9.4
- [CHANGED] The badge inside BUSTR's nav column is now styled outright instead of being layered on top of Torn's `mobileAmount` class. Previous attempts overrode that class one property at a time, but it brings both absolute positioning *and* font sizing that can't be seen or predicted from outside, so each override was a guess. Inside BUSTR's own column - which is entirely ours - the badge now states its own position, size, and layout, and neutralises every inherited positioning property. If the column can't be created, the badge stays in `#nav-jail` and Torn's own positioning is left completely alone.
- [NEW] The diagnostic export carries `badgeState`: where the badge actually lives, whether the column styling reached it, what the browser *computed* for position/display/font-size, its measured dimensions, and the literal text in the % span. Layout facts only. A `pctText` of `"#"` means the stats renderer never reached it; a real number there while nothing shows on screen means it's a layout problem instead - two different bugs that look identical from a screenshot.

## v2.9.3
- [FIX] The PDA badge no longer overlaps the BUSTR label, and the penalty % is visible again. Both had the same cause: the badge carries Torn's `mobileAmount` class, which positions it **absolutely**. That's correct for the single digit Torn uses it for, but BUSTR's badge is two rows, and being out of flow it simply sat on top of the label - so the % wasn't missing, it was hidden underneath. The badge is now in normal flow inside a column-flex holder, giving the count, the % and the label each their own space: count on top, % beneath it, label below that.

## v2.9.2
- [FIX] The PDA nav badge no longer breaks its "%" onto a line of its own. It now reads as two centred rows: the available-bust count, with the penalty % together beneath it. The % line is a flex item, which blockifies it whatever its display value, so in a narrow nav slot the "%" character wrapped away from its own number - it's pinned with `white-space: nowrap` now.

## v2.9.1
- [FIX] The PDA nav badge is coloured red/orange/green by available busts again, matching the desktop sidebar badge. The colour is carried by a `--color` variable that a body class drives, but the rule reading it only covered `#nav-jail` and `#bustr-context`. Since v2.8.5 the badge lives in BUSTR's own nav column instead, which that selector never reached, so the numbers rendered uncoloured. The column is a clone of the Jail cell and therefore already carries `swiper-slide`, so the existing mobile colour rule was setting `--color` on it all along; it just needed to be read.

## v2.9.0
- [FIX] **The API key is now sanitized before use, which is the root cause of the PDA "Incorrect key" failure.** A Torn key is exactly 16 alphanumeric characters. A real PDA export measured the saved key at **17** and PDA's injected key at **18** - both malformed, so Torn rejected both. Two separate causes, and neither is visible on screen:
  - PDA's `###PDA-APIKEY###` substitution can land the key **wrapped in quotes**, so what arrives is `"abc..."` (18) rather than `abc...` (16).
  - A key pasted on a phone routinely carries an invisible character (zero-width space, non-breaking space). `String.trim()` does **not** remove those.
  Torn answers a malformed key with `Incorrect key`, which reads as "your key is wrong" while the key on screen is visibly, correctly right. That is the most misleading failure this script can produce. Anything non-alphanumeric is now stripped from the key on both read and save, so a key that is right stays right. Existing saved keys are sanitized on read; there's no need to re-enter one.
- [NEW] The settings panel calls out a wrong-length key explicitly ("it is 17 characters, but a Torn key is 16"), rather than leaving Torn's misleading "Incorrect key" as the only clue.
- [NEW] The diagnostic export reports `apiKey.looksValid`, `expectedLength`, and **raw vs sanitized** lengths for both sources. A raw length above the sanitized one means the key arrived carrying characters that aren't part of it - which is the entire diagnosis, and is invisible any other way.

## v2.8.9
- [FIX] **A failing API key could take the entire interface down.** The bootstrap created the settings trigger and nav column *after* `await loadController()`, so any rejection from that call aborted everything below it: no settings button, no nav column, no refresh loop, no jail rendering. That is the worst possible failure mode, because the settings panel is where the API key gets fixed - so a bad key removed the only means of fixing it. The UI is now built before any network call and can never sit behind one, and the initial load is wrapped so it cannot abort init even if its own error handling fails. Surfaced by v2.8.8, which gave `getApiKey()` a new way to throw, but the fragility was always there.
- [FIX] `loadController` no longer resolves the API key on a bare line above its own `try`, where anything thrown escaped the function and rejected the caller.
- [FIX] **A blank injected key is now treated as no key at all, rather than as an empty one.** `isPDA()` only checks that the `###...###` token was substituted, and an empty string satisfies that - so when the PDA app injects nothing (no key configured, or a failed substitution), BUSTR called Torn with `key=` and got back `Incorrect key`. That reads as "your key is wrong" when the truth is "no key ever arrived", which sends you off checking a key that was fine all along. BUSTR now skips the pointless call and says so.
- [NEW] The settings panel distinguishes the two cases explicitly, including "the PDA app injected an EMPTY key".
- [NEW] The diagnostic export carries `apiKey`: the key's **source and length only, never the key itself**. Length 0 from a substituted token means an empty PDA injection; a full-length key that Torn still rejects means a genuinely bad key. Identical symptoms, completely different fixes.

## v2.8.8
- [FIX] **On PDA, your own API key was being ignored entirely.** `getApiKey()` returned the PDA-injected key unconditionally and never looked at a stored key, so there was no way to supply your own: entering a correct Full Access key changed nothing, because nothing read it. If the key configured in the PDA app is wrong or too limited, BUSTR fetched no bust log, and every penalty silently read 0%. Confirmed from a real PDA export reporting `Torn API 2: Incorrect key` against the injected key while the same account worked fine on desktop. A key you set explicitly now takes priority everywhere, PDA included, and falls back to PDA's injected key only when you haven't set one. Leading/trailing whitespace is trimmed, since a key pasted on mobile usually carries some.
- [NEW] An **API key** section in the settings panel: paste a key to override, or clear it to fall back to PDA's. Needed because the key entry form only ever appears when there is no key at all, which on PDA is never - the injected key always filled the slot, so the form (and the "Re-enter API key" button) could not help. The panel reports which key is in play without ever putting the key itself in the DOM.
- [FIX] Saving a key now releases the `fatalKeyError` latch. It's set once Torn rejects a key and it stops all further API calls, so entering a *correct* key would still have fetched nothing until a full page reload - looking exactly like the new key being wrong too.
- [FIX] A failed "Force update level/perks" now reports into the panel instead of only the console.
- [NOTE] PDA's injected key is no longer copied into storage on startup. Storing it made it indistinguishable from a key you chose, which would permanently shadow the new override.

## v2.8.7
- [FIX] A failed API call no longer records itself as a successful fetch. `setLastFetchTimestampMs()` ran the moment the JSON parsed, *before* the error and no-log checks, so a Torn error response advanced the "last fetched" timestamp anyway. That throttled the retry as though fresh data had just landed, and made a diagnostic export show a recent successful fetch sitting next to an empty history - which reads as "stale" when the truth is "the key is failing". The timestamp is now stamped only once the response is known-good.
- [NEW] API failures are recorded and shown, instead of only being written to a console nobody sees on PDA. A new `lastApiError` (what failed, Torn's error code, the message, when) appears in the settings panel as a visible notice and is carried in the diagnostic export, along with `fatalKeyError`. This matters because the previous symptom of a rejected key was simply a penalty of **0%** - indistinguishable from genuinely having no penalty, and the more dangerous of the two to get wrong, since 0% reads as "clear to bust".
- [NEW] The panel names the likely cause for Torn error codes 2 and 16: BUSTR depends on the `log` selection, which Torn only grants on a **Full Access** key. A Limited or Minimal key fetches no bust history at all, so every penalty figure silently reads 0. On PDA the key in use is the one set in the PDA app itself, not the one entered in the panel.

## v2.8.6
- [FIX] The nav badge no longer sits showing its literal `#` placeholders when you have no bust history yet. `recalcLocally` and `recalcPenaltyScoreOnly` both return early on an empty `timestampsArray`, and the call that paints the badge sits *after* that return - so on a fresh install, or before the first API fetch lands, the badge was never written to at all. It now paints zeroes in that state, which are accurate, and are replaced the moment real history arrives. This was a long-standing bug that predates the PDA nav-column work; it was simply easier to notice once the badge had a column of its own.
- [NEW] The settings panel status line now leads with the script version (`BUSTR v2.8.6 · Lvl 100 · ...`). That line is what gets read back in bug reports, and which build produced the numbers is the first thing worth knowing.

## v2.8.5
- [NEW] On PDA/mobile, BUSTR takes its own column in the nav bar, right of Jail, and the bust count / penalty % badge moves into it so the two sit together. The element cloned is Jail's nav **cell** (`#nav-jail`'s parent), inserted after that cell, which is what makes the clone a real column. v2.8.1-v2.8.3 all failed because they treated `#nav-jail` itself as the slot; it isn't, it lives inside one.
- [CHANGED] That placement is **verified at runtime rather than assumed**, since the mobile nav can't be inspected remotely and guessing at it produced three bad layouts. It engages only if Jail's candidate cell contains exactly one `#nav-*` item (so it is Jail's alone) and its parent contains several (so it really is a bar of sibling cells). If either check fails - notably if `#nav-jail`'s parent turns out to BE the nav bar, where cloning would duplicate the navigation - it does nothing and the previous placement applies unchanged. Worst case is therefore the old layout, never a broken one.
- [FIX] The badge is **moved** into the new column rather than rebuilt there, so it keeps the numbers it already has. Rebuilding it on the tick-driven path is what left v2.8.3 showing literal `#` placeholders.
- [FIX] The cloned column has ids stripped from its entire subtree, not just its root. Cloning Jail's cell copies a nested `#nav-jail`, and leaving that id in place would put a duplicate in the document for Torn's own scripts (and BUSTR's own lookups) to trip over. Any copy of Torn's native count badge is dropped from the clone too.
- [NEW] The diagnostic export now includes `navStructure`: the tag/id/class/child-count chain around `#nav-jail`, plus whether the nav-column placement engaged. Only structural shape, never text or hrefs, so it carries no account data - consistent with the rest of the export. This exists so a mobile layout report can be diagnosed from facts instead of inferred from screenshots.

## v2.8.4
- [REVERT] Reverted the PDA nav experiments from v2.8.1 through v2.8.3. All three tried to place the BUSTR button relative to `#nav-jail` on the assumption that it is the mobile nav slot. It isn't: `#nav-jail`'s parent is a per-item cell, not the nav bar, which is why inserting a sibling of it stacked BUSTR *under* Jail (v2.8.1/v2.8.3) and why laying its children out in a row overflowed into the neighbouring buttons (v2.8.2). v2.8.3 also pushed the Jail icon out of vertical alignment with the rest of the bar. The button is back on its previous placement path until the real mobile nav structure is confirmed rather than inferred.
- [FIX] The PDA badge no longer shows its literal `#` placeholders after a page load. v2.8.3 moved badge creation onto the settings-trigger tick, which can be a full refresh interval away, and a badge that doesn't exist yet can't be filled in by the stats renderer. It's created during init again.
- [KEPT] The one genuine improvement from that run survives: the penalty % sits beside the bust count on a single line rather than stacking under it and wrapping its "%" onto a third. That stacking was what made the badge taller than Torn's native nav badges and pushed it into the top edge of the bar.

## v2.8.3
- [CHANGED] On PDA/mobile, BUSTR now has its **own column** in the nav bar, immediately right of Jail, with the bust count and penalty % sitting inside it as its own badge. It's a clone of the Jail slot, so it's a real nav button: same width, same styling, its own space in the bar. The Jail slot is left untouched.
- [FIX] The badge and button no longer overlap the neighbouring nav buttons. v2.8.2 placed them either side of the Jail icon *inside* the Jail slot, but that slot has a fixed width, so both overflowed it - the badge landed on top of NEWS and the button on top of HOSPITAL. Nothing shares Jail's slot any more, so there is nothing to overflow.
- [FIX] BUSTR's column strips any copy of Torn's native count badge inherited from the clone, so it shows BUSTR's own numbers rather than a frozen snapshot of Jail's.

## v2.8.2
- [CHANGED] On PDA/mobile the Jail nav entry is now laid out as a row: the bust count and penalty % sit to the **left** of the Jail icon, and the BUSTR button sits to the **right** of it, so they flank the icon instead of stacking above and below it. Nothing renders under the Jail button any more.
- [FIX] The penalty % now sits beside the bust count rather than under it, and no longer wraps its "%" onto a third line. The badge is laid out inline; previously the % line was a block element, which stacked it.
- [FIX] The PDA badge no longer clips against the top of the nav bar. Root cause: the badge carries Torn's own `mobileAmount` class, which positions it absolutely ABOVE the icon. v2.8.1 tried to nudge it down with a transform, which only treated the symptom. Its position is now reset to static so it joins the row's normal flow, which removes the overlap entirely rather than shifting it.
- [FIX] The BUSTR button on PDA is now anchored to the jail LINK rather than to `#nav-jail`, and clones the link rather than the row. `#nav-jail` is not the nav slot on mobile (the link lives inside it), which is why both earlier attempts - appending into a container found by walking up from it (pre-2.8.1), then inserting as its sibling (2.8.1) - landed the button under the icon instead of beside it. A clone of the link, inserted as the link's sibling, lays out alongside it.

## v2.8.1
- [FIX] On PDA/mobile the BUSTR settings button now takes its own slot in the navigation bar, next to Jail, instead of rendering as a stretched pill underneath the Jail icon. The placement logic walked *up* from `#nav-jail` to find a container (`closest('ul')`, else the parent), which lands on the row list in the desktop sidebar but on PDA landed on a container that isn't the nav bar itself, so the button filled it. It's now inserted as `#nav-jail`'s immediate sibling. Since the button is already a clone of `#nav-jail`, being its sibling means it inherits the exact same layout and sizing as every other slot, so it can't stretch. Desktop sidebar placement (next to TornTools) is unchanged.
- [FIX] The PDA/mobile jail badge is no longer clipped against the top edge of the nav bar. Nudged down with a transform rather than by overriding top/position, since the badge carries Torn's own class and therefore Torn's own positioning, which this script doesn't control. Also tightened its line spacing now that it carries two lines.
- [NOTE] The penalty `%` on the PDA badge arrived in v2.7.20; if you're coming from v2.7.19 or earlier, this is the first build where you'll see it there.

## v2.8.0
Success-model rework, driven by cross-validation against real logged outcomes. The headline: penalty was under-weighted, and self-calibration was overfitting to cover for it.

- [CHANGED] **Penalty is now counted at 2x face value** (`PENALTY_WEIGHT`). The guide's formula subtracts penalty at face value, which measurably under-weights it. Fitted against 38 clean logged outcomes the optimum is sharp and sits at 2.0 (weight 1.5 scores Brier 0.244, weight 2.0 scores 0.141, weight 2.5 scores 0.222). Cross-checked by letting a grid search choose both the skill calibration and this weight freely: it independently lands on calibration 1.00 (the perk-derived value) and weight 1.95, which is this model. That agreement is the main evidence the shape is right rather than merely tuned.
- [REMOVED] **High-penalty caution**, along with its learned weight and its settings toggle. It was wrong in both directions at once: inert in the 40-100% penalty band where plenty of real failures happen, and above the threshold its learned weight (fitted as high as 8) crushed every target to the 1% floor even though those attempts really succeed about 27% of the time. The always-on 2x multiplier replaces it.
- [CHANGED] **Self-calibration is now guardrailed, because it was making predictions worse.** Leave-one-out cross-validation on real data showed fitting the calibration scored worse out-of-sample (Brier 0.148) than not fitting at all and simply using the perk-derived value (0.141), and fitting more free parameters was worse still (0.164). It was fitting noise. Its search range is now 0.6 to 1.4 (was 0.3 to 1.5) so it can never again collapse onto a pathological value, and it needs 100 samples before it engages (was 15, which was far too few). Calibration only scales the hardness term, so it can never explain penalty-driven failures, and the old floor let it "explain" them anyway by making hardness brutal. That was the root cause of the v2.7.19 blowup.
- [FIX] **Outcomes are now stamped with a model version, and pre-v2.7.19 entries are excluded from the fit.** Attempts logged before the v2.7.19 penalty decoupling froze a penalty% computed with the self-calibrated skill in its denominator, so their stored `pen` is inflated (a real export showed 300% where the true figure was 90%). Fitting against those would re-derive the calibration from corrupted penalties and reintroduce the exact bug v2.7.19 fixed. They are still shown in your history and stats, they just can't vote on the number.
- [NOTE] A raised success floor was tested and rejected. Fitting the floor as a free parameter looked good in-sample (best value 25%, Brier 0.136) but collapsed under cross-validation (0.173, no better than the model it replaced). Real attempts at the bottom of the range do succeed more often than the model predicts, so a saturating curve is likely the right long-term answer, but it needs more data than one player's log to justify. The floor stays at 1%.

## v2.7.20
- [CHANGED] The PDA / mobile always-visible jail badge now also shows your current penalty as a `%`, matching the desktop sidebar badge. Previously the mobile badge showed only the available-bust count (the standalone "0"), and the penalty % was reachable on PDA only by opening the tap context menu. The available-bust count still shows exactly as before, now with the % on a second smaller line beneath it.

## v2.7.19
- [FIX] Decoupled the success-model penalty from self-calibration, fixing a feedback loop that could floor every on-screen success% at 1%. The per-bust penalty is computed as `PENALTY_PCT_ANCHOR / (level * calibration)`, and it was reading the self-calibrated skill value. When self-calibration floored to 0.3 to explain failures on hard targets, that same 0.3 tripled per-bust penalty (from ~10% to ~35%), pushing accumulated penalty past 300% and dragging every target's predicted success down to the 1% floor regardless of hardness. A real user's export showed the model reporting 1% while they were actually succeeding ~40% of the time, including ~50% on easy targets. The penalty term now uses the perk-derived calibration (or a manual override, if set), never the auto-fitted self-cal value, since that value is a correction to the hardness/skill term and not a measurement of true skill. The hardness/skill term of the success formula is unchanged and still uses self-calibration as before. Note: outcomes logged before this fix retain their inflated `pen` values; the model self-corrects going forward as new attempts are logged.

## v2.7.18
- [CHANGED] Removed the floating gear fallback trigger entirely. It used the old ⚙ emoji and was never updated when the sidebar icon changed, and it was reported showing up on the Attacking page, which renders without the normal left sidebar. Settings are now only ever reachable from the sidebar entry; on pages without a sidebar, there's simply no trigger shown rather than a separate floating button.

## v2.7.17
- [CHANGED] Self-calibration now retains up to 500 logged attempts instead of 200 before the oldest start getting dropped, giving the fit more real data to work with over time. (Note: `RECENT_HISTORY_WINDOW_DAYS`, the 30-day budget-calc window, is unrelated to self-calibration - that's a separate pipeline based on Torn's own bust log, not on logged outcomes.)

## v2.7.16
- [CHANGED] Success % can show 100% again (was capped at 99% since v2.4.0). A "99% shown, still failed" outcome isn't meaningfully different from a "100% shown, still failed" one, so the cap was never a real fix for overconfidence - it just avoided the optics of the word "100%". Self-calibration and high-penalty caution (both added after the cap) are the actual fix, since they correct the underlying prediction rather than just its display ceiling. Floor stays at 1%.

## v2.7.15
- [NEW] The nav badge (next to Jail in the sidebar) now shows your current penalty as a % on a second, smaller line below the existing busts/threshold numbers, so it fits without crowding the sidebar. Same underlying number already shown in the settings panel status line.

## v2.7.14
- [CHANGED] Added a second `@author` line crediting The_Baron [1467784]'s contributions, matching the same style the original script already uses for RussianRob. Original `Adobi & Ironhydedragon` credit unchanged.

## v2.7.13
- [FIX] The "#/#:#" nav badge placeholder was visible for a full network round-trip on every single page change, not just first install. Torn reloads the script on every navigation, and the badge only got filled in with real numbers once the fresh API fetch completed - even though the previous page's numbers were already sitting in storage the whole time. Now paints whatever's already cached immediately, before waiting on the network.

## v2.7.12
- [FIX] Sidebar button placement was actually broken by a TornTools update that moved its settings pill out of the main navigation list into a separate container - BUSTR's anchor search only ever looked inside that main list, so it never found TornTools' pill at all and fell back to landing at the end of the nav list instead, which happened to look like it was sitting just above TornTools. Now searches for TornTools' pill regardless of which container it lives in. (v2.7.11's fix was real but addressed a different, secondary issue - this is the actual root cause.)

## v2.7.11
- [FIX] Sidebar settings button could drift out of place over time (reported: ended up right before TornTools' entry instead of right after it). Torn's sidebar can re-render and reorder itself, and since the button is a manually-injected element outside that rendering, it stayed behind when its neighbor moved. It now re-checks and re-anchors itself next to TornTools on every refresh tick instead of only placing itself once.

## v2.7.10
- [CHANGED] Renamed to "BUSTR: Busting Reminder + PDA (Baron)" so it can be installed and tested side by side with the original author's script without a name collision. Original `@author` credit unchanged.

## v2.7.9
- [NEW] Debug export now also includes storage platform info (GM vs. localStorage/PDA), API cache-freshness timestamps, and every tunable constant behind the success %/penalty model - so a report can be fully understood without checking out the exact script version that produced it.

## v2.7.8
- [CHANGED] Removed Import entirely - there was no real use case for it, since settings are changed directly in the panel. Export is now a one-way "debug export" meant to be shared with the script maintainer: it includes your level, settings, detected perks, current penalty, calibration values, and full bust history, stamped with the script version and export time. Still never includes your API key or any account-identifying info (username, ID, faction).

## v2.7.7
- [CHANGED] Export/Import now covers only your bust/outcome history, not your settings. Importing a backup no longer overwrites your current settings - it only restores logged bust attempts.

## v2.7.6
- Moved this changelog out of the script file and into a standalone `CHANGELOG.md`, so the script itself stays focused on code. No behavior changes.

## v2.7.5
- [NEW] Replaced the gear icon with an open-padlock icon that automatically matches your theme (dark mode or not).

## v2.7.4
- [FIX] Sidebar button was rendering with a transparent/invisible background. It now has a proper subtle background like the rest of the sidebar.

## v2.7.3
- [FIX] Sidebar button occasionally picked up a green "active page" highlight it shouldn't have. It now renders identical to the other sidebar rows.

## v2.7.2
- [INTERNAL] Hardened sidebar button placement against Torn's real page structure. No visible change, just more reliable.

## v2.7.1
- [FIX] Self-calibration and high-penalty-weight learning weren't applying to your existing bust history until you logged a brand new bust. They now apply immediately on page load.

## v2.7.0
- [NEW] The script now learns your personal "high penalty" sensitivity from your own bust history instead of using a fixed guess.
- [CHANGED] Perk-based calibration is now opt-in (previously on by default).
- [NEW] Settings panel now shows exactly how many percentage points perk calibration is adding or removing from your success % numbers.

## v2.6.1
- [FIX] Settings (self-calibration, high-penalty caution, play style) could appear to revert or "un-check" themselves when switching between multiple open Torn tabs. Settings now stay in sync across tabs.

## v2.6.0
- [FIX] Hardness/success % could get stuck showing `#####` / `--%` on jail pages with exactly one entry.
- [IMPROVED] Settings panel reorganized into labeled sections so it's clear what each toggle actually affects.

## v2.5.2
- [FIX] Self-calibration could be skewed by a run of failures that all happened during a high-penalty period, producing a bad prediction curve. It now filters those out before learning.
- Confirmed the script's success/fail/jailed detection matches Torn's real in-game messages.

## v2.5.1
- [NEW] Bust history now distinguishes "failed the bust" from "failed and got jailed" instead of lumping both together.

## v2.5.0
- [NEW] Added an opt-in "high-penalty caution" setting that predicts more conservatively once your penalty gets very high, based on real logged failures at high penalty.

## v2.4.1
- [FIX] Available-bust calculations could go deeply negative once old history entries aged out.
- [CHANGED] Self-calibration is now on by default.
- [CHANGED] Bust history used for calibration is now limited to the most recent 30 days.

## v2.4.0
- [CHANGED] Success % display is now capped to a 1-99% range instead of 0-100%, since showing 100% implied a guarantee that doesn't exist.
- [NEW] Added Export/Import for settings and bust history (never includes your API key).
- [FIX] Sidebar button no longer inherits a stray highlight color from the row it's cloned from.

## v2.3.2
- [FIX] Settings button sometimes fell back to a floating icon instead of docking into the sidebar.

## v2.3.1
- [INTERNAL] Re-verified all success %/penalty formula constants against their source material. No behavior changes.

## v2.3.0
- [NEW] Hardness display and "sort easiest first" are now independent toggles.
- [NEW] Settings button now docks into Torn's sidebar next to TornTools.
- [NEW] "Jail page only" mode that keeps the script fully idle everywhere else.
- [NEW] Option to ignore perk-based calibration.
- [NEW] Manual "force update" button for level/perk data.
- [IMPROVED] Script now pauses entirely in background tabs to save CPU/network.

## v2.2.0
- [NEW] Self-calibration: the script learns from your own logged bust outcomes to personalize its predictions.
- [NEW] Live-ticking success % as time passes.
- [NEW] Proper offense/defense/nerve perk classification.
- [NEW] Optional "max count" play style for volume grinding.

## v2.1.0
- [FIX] Penalty decay curve was decaying too fast, making the script overconfident about available busts.
- [FIX] Success % slope constant corrected to match the source guide's actual data.
- [NEW] Perk-based calibration and a settings panel.
- [NEW] Sidebar settings button.

## v1.0.11 (baseline)
- Original script by Adobi & Ironhydedragon.
- Hardened for reliability/security: isolated key storage, fetch timeouts and response validation, safer DOM handling. No functional/behavior changes.
