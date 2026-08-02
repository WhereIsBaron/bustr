# BUSTR pick-up roadmap

Read this first in a new session to resume with full context. Detailed version history lives in `CHANGELOG.md`; this file is just the "what's next" snapshot.

## Current state
> **Check `bustr.user.js`'s own `@version` before trusting any version written here.**
> This line said v2.10.0 while the file was already 2.12.2 (caught 2026-07-21). The same
> drift has hit `flipr\ROADMAP.md` and the memory index; concurrent sessions edit these
> files and a version quoted from a document has been wrong every time it was checked.

- Script: `bustr.user.js`, **v2.13.0** as of 2026-08-02, name `BUSTR: Jail Bust Assistant + PDA (Baron)` (renamed in v2.9.7; "Busting Reminder" no longer described what it does). The `(Baron)` suffix is deliberate: it keeps this fork from colliding with the original authors' script on GreasyFork. Published at `greasyfork.org/en/scripts/585215` (listing still on 2.7.19 - upload pending). Forked from upstream v1.0.11; standalone publication has IronHydeDragon's blessing (Discord, 2026-07-19), he asked that the fork version be stated.
- Location: `C:\Users\dell\Desktop\!. Torn Scripts\bustr\` (moved here from `C:\Users\dell\Desktop\bustr\`; that old folder is stale and safe to delete).
- Files: `bustr.user.js` (the script), `CHANGELOG.md` (full patch notes, not embedded in the script), `CHANGELOG_DISCORD.txt` (hard-wrapped copy for pasting into Discord, regenerate after every `CHANGELOG.md` change), `GREASYFORK_LISTING.md` (publish-ready description text for GreasyFork, separate from both), `FORUM_POST.md` (paste-ready Torn forum post). Cloud backend lives under `cloud/` (`SETUP.md`, `CLIENT_INTEGRATION.md`, the Netlify function, Firestore rules).
- All prior work verified via `node --check` plus a jsdom regression suite kept in the scratchpad directory (not part of the project folder).

### Cloud sync (new in v2.13.0)
- Optional, **opt-in, default OFF** cross-device sync of bust history. Backend is Firebase (Firestore + custom-token auth) fronted by a Netlify function; client wiring is the `CloudSync` engine in `bustr.user.js`. Full spec in `cloud/CLIENT_INTEGRATION.md`; backend setup in `cloud/SETUP.md`.
- The API key is **never uploaded** - it goes only to Torn's own API and, once, to the verification function (which uses it to confirm player identity, then discards it; never stored server-side). The only server secret is the Firebase service-account JSON, held solely in Netlify env var `FIREBASE_SERVICE_ACCOUNT`.
- Backend passed its private 5-step test (verify -> sign in -> write -> read -> cross-user isolation denied). Client code is written and passes `node --check`, ASCII-clean, no auth leak into the debug export. **Live on-torn.com behaviour is NOT yet tested** - see next steps.

## Open / next steps
1. **Live-test cloud sync on torn.com** (the one thing blocking cloud sync from being considered done). Per `cloud/CLIENT_INTEGRATION.md`'s test checklist: save a key, enable sync -> consent modal shows, make a bust and confirm it logs and the Firestore doc updates, reload and confirm history restores, toggle sync off and confirm the cloud doc is deleted. On a manager without `GM_xmlhttpRequest` (e.g. some PDA setups) the whole Cloud sync section should be inert (checkbox disabled, status "unavailable"). Cannot be run from a code session - needs a real browser.
2. **Before cloud sync goes PUBLIC, fix the disclosure + CORS** (hard gate, do not ship public without these):
   - `GREASYFORK_LISTING.md` and `FORUM_POST.md` privacy/ToS copy updated for opt-in cloud sync (done 2026-08-02 - re-verify the wording still matches shipped behaviour).
   - Tighten the Netlify function CORS from `Access-Control-Allow-Origin: '*'` to the Torn origin(s). Marked with a TODO comment in `cloud/netlify/functions/bustr-auth.js` (line ~26). This is the backend session's item.
3. **Contribute the two confirmed bugs back to the original author's live v1.12 script.** Both are reproducible and independently confirmed against real data: the `calcPenaltyThreshold` off-by-one (`i < length - longestSequence` should be `i <= length - longestSequence`) and missing history pruning (ancient bust clusters can skew the threshold). Not yet started as an actual PR/message to Adobi & Ironhydedragon.
4. **Publish the Baron fork on GreasyFork**, using `GREASYFORK_LISTING.md` as the description, and post `FORUM_POST.md` to the Torn forums (fill the `[ INSTALL LINK ]` / `[ INSTALL - ... ]` placeholders first). Not yet done. Listing on GreasyFork is still stuck at 2.7.19 - upload the current build.
5. **Keep syncing with IronHydeDragon** (one of the original co-authors, in direct contact over Discord/Torn) about the contribution. He's already seen the changelog and asked about the success % model's accuracy; that's been answered but not yet followed up on.
6. Confirm the **current** build is stable across a normal play session (sidebar placement, nav badge, no stray floating gear anywhere) before considering the fork "release ready." Written against 2.7.18; the build has moved on several times since, so re-check rather than assuming this was ever signed off.

## Key constraints to keep honoring
- Compliance: BUSTR is strictly read-only/assistive. Never automate a game action, simulate a click, or dispatch synthetic events. Documented in a COMPLIANCE NOTE block at the top of `bustr.user.js`; do not remove it.
- Original `@author` line (`Adobi & Ironhydedragon`) stays untouched. Contributions are credited as a second `@author` line for `The_Baron [1467784]`, matching the style the original script already uses for RussianRob.
- No em dashes anywhere, in chat or in files, full stop. Hyphen clause-joins are tolerated in dev-facing writing (changelog, code comments) but avoid them in player-facing copy if any is ever added.
- Every substantive script change gets a version bump (`@version` header + the `SCRIPT_VERSION` constant, keep them in sync) and a `CHANGELOG.md` entry, then regenerate `CHANGELOG_DISCORD.txt`.
- Cloud sync rules that must never be broken: (a) the API key stays on the user's device - it may go only to Torn's API and once to the verification function, never stored server-side; (b) cloud sync is opt-in, default OFF, with explicit consent before the first enable; (c) the Firebase service-account JSON is the only secret and lives ONLY in the Netlify env var `FIREBASE_SERVICE_ACCOUNT` - never committed, never in the client, never pasted into chat; (d) the debug export must never contain the API key or the cloud auth session (`CLOUD_AUTH_KEY` is stored outside `state` deliberately).
- Full memory context (math validation history, UI placement history, authorship rules, etc.) is already in the persistent memory store for this project and should load automatically in a new session.
