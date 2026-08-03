# GreasyFork listing description

Not part of the script - this is the text meant for the GreasyFork "Additional info" / description field when publishing, kept separate so it can be edited without touching the script or the version changelog.

IMPORTANT: set the Additional info format toggle to **Markdown** (not HTML) on GreasyFork, or the `**bold**` and `###` headings below render as literal characters.

---

**BUSTR helps you win the busting game before you ever click a prisoner.** It shows you how many jail busts you can safely make right now, and which prisoners are the easiest to bust, so your nerve goes into busts that actually land instead of landing you in jail.

### What it does
- Reads only your own Torn data (level and perks) plus the jail page already open in front of you. It never touches anyone else's data.
- Adds a hardness score and a live success percentage to every prisoner on the jail page, so your real odds are right there at a glance.
- Tracks your bust penalty, the hidden cooldown that builds up as you bust, and estimates how many busts you have left before your success rate drops off.
- Can learn from your own results over time to fine-tune its predictions to you. This self-calibration is fully passive and reads only the bust-result text Torn already shows you.
- Puts its settings button in Torn's sidebar right under TornTools, styled to look like a native row.

### Your privacy and your account come first
- BUSTR never clicks, submits, or automates anything for you. It only reads what is already on the page and shows you numbers and colours. The full statement lives in the COMPLIANCE NOTE at the top of the script, and it is a hard rule.
- Your API key never leaves your device. It is stored locally and used only for Torn's own official API. It is never uploaded anywhere, including when cloud sync is on.
- By default everything BUSTR stores stays on your device, through your userscript manager or localStorage on PDA. The only exception is the optional cloud sync below, which is off unless you turn it on.
- Optional cloud sync (opt-in, off by default): you can choose to back up your bust history so it follows you across devices. It asks for explicit consent the first time you enable it, and uploads your bust history along with your bust perks and level (the perks and level help improve BUSTR's model) - never your API key, name, or faction. It can be turned off and its cloud copy deleted at any time from the settings panel. Leave it off and BUSTR is fully local, exactly as before. When it is on it is deliberately lightweight: a whole busting session is saved in a single upload and it only checks for changes from your other devices about once an hour, so it adds no noticeable overhead.

### Performance
The refresh rate in Settings (default 30 seconds, down to a 15 second floor) only changes how smoothly the on-screen countdown updates. It does not change how often BUSTR calls the Torn API. Those calls are throttled separately to at most once every 35 seconds on the jail page, and once every 30 minutes elsewhere. BUSTR also pauses completely whenever its tab is in the background, so it does nothing while you are not looking at it. The result is negligible CPU and battery use, even on lower-end devices.

### Helping improve BUSTR
The settings panel has an optional "Copy debug export" button. It is opt-in and one-way, with no import. It copies a JSON snapshot of your level, settings, detected perks, current penalty, calibration, and logged bust history to your clipboard, so you can share it with the maintainer if you want to help improve the model. It never includes your API key, Torn username, ID, or faction, because the script never reads or stores any of those.

### Requirements
A Torn API key with the `basic`, `perks`, and `log` selections, which is your level, your bust perks, and your own bust history. Nothing else. You do not need to hand over a Full Access key: the settings panel has a **Create a key for BUSTR** button that opens Torn's API page with exactly those three boxes pre-ticked and nothing else, so the key it makes cannot touch your money, your mail, or your faction. Generate it there, paste it back in. It is stored on your device only and sent nowhere except Torn's own API.

### How this differs from the original BUSTR
This build began as Adobi and Ironhydedragon's original BUSTR (forked at v1.0.11) and has grown well past a simple bugfix branch. Alongside their hardness score and penalty budget tracker, it adds a full per-target success prediction, built from the community Advanced Jail Bust Guide and then fitted and cross-validated against real logged bust outcomes: penalty is weighted at the strength the data actually shows, and the displayed odds are calibrated so they mean what they say. It will never show you 100%, because in the real outcome data even the best-looking targets fail sometimes, and an honest 81% beats a flattering 100%. Add self-calibration that keeps learning from your own results, perk-aware calibration, a proper in-page settings panel, and a dedicated nav button with your live numbers on both desktop and PDA. In short, this one also tells you your odds, not just your hardness and budget numbers.

### Credits
**This is a fork of BUSTR v1.0.11 by Adobi and Ironhydedragon, published separately with their blessing.** The original is still maintained and worth a look if you want the lighter version: search Greasy Fork for "BUSTR: Busting Reminder + PDA".

Everything here is built on their foundation. The hardness score, the penalty budget model and the jail list integration are theirs. This build adds the per-target success prediction and its calibration against real outcome data, self-calibration, reliability and storage hardening, the settings panel, and the PDA nav integration, by The_Baron [1467784].

Credit also to RussianRob and Nosy, whose corrected penalty decay curve landed in the original's v1.1.0 and turns out to match the one derived here independently.

MIT licensed, same as the original.
