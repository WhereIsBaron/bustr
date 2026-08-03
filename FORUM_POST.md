# BUSTR forum post

Paste-ready for the Torn forums. Mirrors the FLIPR post's structure. Fill in the install link before posting.

Keep the credit to Adobi & Ironhydedragon at the top and the fork version (v1.0.11) stated: that was IronHydeDragon's one specific request when he gave his blessing.

---

CURRENT VERSION: BUSTR v2.14.0

[ INSTALL - BUSTR: JAIL BUST ASSISTANT ]

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

**Why the numbers are different**

The success model is built from the community Advanced Jail Bust Guide, then fitted and cross-validated against 81 of my own logged bust outcomes. Two things came out of that:

- Penalty hurts about twice as much as the guide's formula says. Confirmed on two separate batches of outcomes that agreed independently.
- **It will never show you 100%.** In the real data, targets shown 99% succeeded 85% of the time. So the displayed range is roughly 16% to 81%, because an honest 81% is worth more than a flattering 100%. If a number looks lower than you expected, that's the point.

**Read-only, fully within the rules**

BUSTR never clicks, submits, or automates anything for you. It reads your own official API data (with a key you create yourself), reads the jail page already in front of you, and displays its own numbers in its own panel. It logs outcomes only by watching clicks you make. Nothing is busted for you, ever.

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
<td style="border:1px solid #888; padding:4px 8px;">Locally by default; if you turn on cloud sync, your bust history plus your bust perks and level are stored in the cloud</td>
<td style="border:1px solid #888; padding:4px 8px;">Nobody by default; if you turn on cloud sync, your bust history, bust perks, and level are stored by the maintainer</td>
<td style="border:1px solid #888; padding:4px 8px;">Assistive use, plus improving BUSTR and restoring your history across your devices</td>
<td style="border:1px solid #888; padding:4px 8px;">Stored locally; never shared</td>
<td style="border:1px solid #888; padding:4px 8px;">Custom (see below)</td>
</tr>
</tbody>
</table>

(Cloud sync is opt-in and off by default; see the "Optional cloud sync" note below.)

**Optional cloud sync (off by default):** BUSTR can optionally back up your bust history so it follows you across devices. It is opt-in, defaults to off, and asks for explicit consent the first time you switch it on. When it is on, your bust history, your bust perks, and your level are stored in the maintainer's database, keyed to your Torn player ID - the perks and level help improve BUSTR's success model. Your API key is never uploaded, and your name, ID, and faction are never stored. You can turn it off and delete your cloud copy at any time from the settings panel. Leave it off and BUSTR behaves exactly as before, fully local. When it is on it is deliberately lightweight - a whole busting session saves as a single upload and it only checks your other devices about once an hour - so it adds no noticeable overhead.

Selections used: `user` -> `basic` (your level), `perks` (your bust perks), `log` (your own bust history). Nothing else is requested. **You do not need to give BUSTR a Full Access key** - use the custom key link below, or the "Create a key for BUSTR" button inside the settings panel, which opens the same thing with the boxes already ticked:

[ Custom BUSTR API KEY ]

https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=BUSTR&user=basic,log,perks

---

**Install**

Desktop: install Tampermonkey or Violentmonkey, then open [ INSTALL LINK ] and click Install.

Torn PDA: Settings > User scripts > add the same link. If the PDA's own key doesn't work, the settings panel has an API key box you can paste your own into - it takes priority.

**Bugs and feedback**

Settings has a "Copy debug export" button - it copies a snapshot with your API key stripped out (source and length only, never the key itself). Send it, or any suggestions, to The_Baron [1467784].

Free, open source, MIT licensed. Original by Adobi & Ironhydedragon. Happy busting.
