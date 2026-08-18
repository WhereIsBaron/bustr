# BUSTR forum post

Paste-ready for the Torn forums. Mirrors the FLIPR post's structure. Fill in the install link before posting.

Keep the credit to Adobi & Ironhydedragon at the top and the fork version (v1.0.11) stated: that was IronHydeDragon's one specific request when he gave his blessing.

---

CURRENT VERSION: BUSTR v2.21.1

[INSTALL - BUSTR: JAIL BUST ASSISTANT](https://greasyfork.org/en/scripts/585973-bustr-jail-bust-assistant-pda-baron)

CURRENTLY SUPPORTS PDA ✔

A fork of **BUSTR v1.0.11** by **Adobi & Ironhydedragon**, posted with their blessing. They built the original hardness score and penalty tracker; this build keeps those and adds a success % model on top. Credit where it's due, and thanks to finny for the go-ahead.

---

You click Bust, you get jailed, and you never really knew the odds. The original BUSTR told you how many busts you had left. This one also tells you your chance on each individual prisoner, and the number is fitted against real bust outcomes rather than guessed.

Small settings panel, its own button in the nav bar with your live numbers on it. Works on desktop and on the Torn PDA.

**What it does**

- Success % on every prisoner in the jail list, next to their hardness score.
- Hardness score and easiest-first sorting, from the original BUSTR.
- Bust budget - tracks Torn's hidden penalty and estimates how many busts you have left before failure gets likely.
- Live penalty % on the nav button, coloured green/orange/red at a glance.
- Learns from your own results over time, if you leave self-calibration on.
- Every setting has a "?" that explains what it actually does.
- One-click scoped API key - no Full Access key needed.
- Optional Quick Bust / Quick Bail (off by default): relabels your own bust/bail link so your single click skips Torn's "are you sure?" step.
- Optional Easy Bust / Easy Bail (off by default, behind a consent prompt): a one-tap button on the jail header that sends one request for the single best shown target - bust picks the highest odds, bail the cheapest. Strictly one tap = one request; see the rules note below.
- In-place jail list refresh that reloads just the captive list, no full page reload.

**Why the numbers are different**

The success model is built from the community Advanced Jail Bust Guide, then fitted and cross-validated against real logged bust outcomes: first 81 of my own, and since refined against 1,200+ pooled outcomes from other players running the script. Two things came out of that:

- Penalty hurts about twice as much as the guide's formula says. Confirmed on two separate batches of outcomes that agreed independently.
- **It will never show you 100%.** In the pooled outcome data even the best-looking targets succeed only around two-thirds of the time. So the displayed range is roughly 27% to 67%, because an honest 67% is worth more than a flattering 100%. If a number looks lower than you expected, that's the point.

**Not a bot, and within the rules**

BUSTR never automates: no loops, no timers, no walking the target list, and it never acts on its own. By default it is read-only - it reads your own official API data (with a key you create yourself), reads the jail page already in front of you, shows its own numbers in its own panel, and logs outcomes only by watching clicks you make. It also has opt-in helpers, off by default, that act only when you tell them to: Quick Bust relabels your own click to skip Torn's confirm step, and Easy Bust (behind a one-time consent prompt) sends one bust request for one target each time you tap its button. Both stay strictly one deliberate tap = one request, to the same jail page - never a loop, never more than one per tap. You are always the one deciding to act.

---

**API Terms of Service**

Your API key never leaves your device: it is used only for Torn's own API. By default everything BUSTR stores stays in your own browser. There is one optional extra, cloud sync, which is off unless you turn it on (see below).

(The Torn forum editor is HTML-based, not BBCode. Paste the table below via its "Source Code" `</>` button, not the normal editor - otherwise the whitespace collapses. If the editor strips `<table>`, wrap the plain ASCII table in `<pre>...</pre>` instead.)

<table style="border-collapse: collapse;">
<tbody>
<tr>
<td style="border:1px solid #888; padding:4px 8px;"><strong>Data Storage</strong></td>
<td style="border:1px solid #888; padding:4px 8px;"><strong>Data Sharing</strong></td>
<td style="border:1px solid #888; padding:4px 8px;"><strong>Purpose of Use</strong></td>
<td style="border:1px solid #888; padding:4px 8px;"><strong>Key Storage &amp; Sharing</strong></td>
<td style="border:1px solid #888; padding:4px 8px;"><strong>Key Access Level</strong></td>
</tr>
<tr>
<td style="border:1px solid #888; padding:4px 8px;">Locally by default; if you turn on cloud sync, your bust history plus prediction context (perks, level, calibration, BUSTR settings, version) are stored in the cloud</td>
<td style="border:1px solid #888; padding:4px 8px;">Nobody by default; if you turn on cloud sync, that data is stored by the maintainer to improve the model</td>
<td style="border:1px solid #888; padding:4px 8px;">Assistive use, plus improving BUSTR and restoring your history across your devices</td>
<td style="border:1px solid #888; padding:4px 8px;">Stored locally; never shared</td>
<td style="border:1px solid #888; padding:4px 8px;">Custom (see below)</td>
</tr>
</tbody>
</table>

(Cloud sync is opt-in and off by default; see the "Optional cloud sync" note below.)

**Optional cloud sync (off by default):** BUSTR can optionally back up your bust history so it follows you across your devices - desktop and Torn PDA both, so your phone and computer share one history. It is opt-in, defaults to off, and asks for explicit consent the first time you switch it on. When it is on, your bust history is stored in the maintainer's database, keyed to your Torn player ID, along with the context behind your predictions - your bust perks, level, calibration, BUSTR settings and script version - all so the success model can be improved. Your API key is never uploaded, and your name, ID, and faction are never stored. You can turn it off and delete your cloud copy at any time from the settings panel. Leave it off and BUSTR behaves exactly as before, fully local. When it is on it is deliberately lightweight - a whole busting session saves as a single upload and it only checks your other devices about once an hour - so it adds no noticeable overhead.

Selections used: `user` -> `basic` (your level), `perks` (your bust perks), `log` (your own bust history). Nothing else is requested. **You do not need to give BUSTR a Full Access key** - use the custom key link below, or the "Create a key for BUSTR" button inside the settings panel, which opens the same thing with the boxes already ticked:

[ Custom BUSTR API KEY ]

https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=BUSTR&user=basic,log,perks

---

**Install**

Desktop: install Tampermonkey or Violentmonkey, then open https://greasyfork.org/en/scripts/585973-bustr-jail-bust-assistant-pda-baron and click Install.

Torn PDA: Settings > User scripts > add the same link. If the PDA's own key doesn't work, the settings panel has an API key box you can paste your own into - it takes priority.

**Bugs and feedback**

Settings has a "Copy debug export" button - it copies a snapshot with your API key stripped out (source and length only, never the key itself). Send it, or any suggestions, to The_Baron [1467784].

Free, open source, MIT licensed. Original by Adobi & Ironhydedragon. Happy busting.
