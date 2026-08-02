# BUSTR pick-up roadmap

Read this first in a new session to resume with full context. Detailed version history lives in `CHANGELOG.md`; this file is just the "what's next" snapshot.

## Current state
> **Check `bustr.user.js`'s own `@version` before trusting any version written here.**
> This line said v2.10.0 while the file was already 2.12.2 (caught 2026-07-21). The same
> drift has hit `flipr\ROADMAP.md` and the memory index; concurrent sessions edit these
> files and a version quoted from a document has been wrong every time it was checked.

- Script: `bustr.user.js`, **v2.12.2** as of 2026-07-21, name `BUSTR: Jail Bust Assistant + PDA (Baron)` (renamed in v2.9.7; "Busting Reminder" no longer described what it does). The `(Baron)` suffix is deliberate: it keeps this fork from colliding with the original authors' script on GreasyFork. Published at `greasyfork.org/en/scripts/585215` (listing still on 2.7.19 - upload pending). Forked from upstream v1.0.11; standalone publication has IronHydeDragon's blessing (Discord, 2026-07-19), he asked that the fork version be stated.
- Location: `C:\Users\dell\Desktop\!. Torn Scripts\bustr\` (moved here from `C:\Users\dell\Desktop\bustr\`; that old folder is stale and safe to delete).
- Files: `bustr.user.js` (the script), `CHANGELOG.md` (full patch notes, not embedded in the script), `CHANGELOG_DISCORD.txt` (hard-wrapped copy for pasting into Discord, regenerate after every `CHANGELOG.md` change), `GREASYFORK_LISTING.md` (publish-ready description text for GreasyFork, separate from both).
- All prior work verified via `node --check` plus a jsdom regression suite kept in the scratchpad directory (not part of the project folder).

## Open / next steps
1. **Contribute the two confirmed bugs back to the original author's live v1.12 script.** Both are reproducible and independently confirmed against real data: the `calcPenaltyThreshold` off-by-one (`i < length - longestSequence` should be `i <= length - longestSequence`) and missing history pruning (ancient bust clusters can skew the threshold). Not yet started as an actual PR/message to Adobi & Ironhydedragon.
2. **Publish the Baron fork on GreasyFork**, using `GREASYFORK_LISTING.md` as the description. Not yet done.
3. **Keep syncing with IronHydeDragon** (one of the original co-authors, in direct contact over Discord/Torn) about the contribution. He's already seen the changelog and asked about the success % model's accuracy; that's been answered but not yet followed up on.
4. Confirm the **current** build is stable across a normal play session (sidebar placement, nav badge, no stray floating gear anywhere) before considering the fork "release ready." Written against 2.7.18; the build has moved on several times since, so re-check rather than assuming this was ever signed off.

## Key constraints to keep honoring
- Compliance: BUSTR is strictly read-only/assistive. Never automate a game action, simulate a click, or dispatch synthetic events. Documented in a COMPLIANCE NOTE block at the top of `bustr.user.js`; do not remove it.
- Original `@author` line (`Adobi & Ironhydedragon`) stays untouched. Contributions are credited as a second `@author` line for `The_Baron [1467784]`, matching the style the original script already uses for RussianRob.
- No em dashes anywhere, in chat or in files, full stop. Hyphen clause-joins are tolerated in dev-facing writing (changelog, code comments) but avoid them in player-facing copy if any is ever added.
- Every substantive script change gets a version bump (`@version` header + the `SCRIPT_VERSION` constant, keep them in sync) and a `CHANGELOG.md` entry, then regenerate `CHANGELOG_DISCORD.txt`.
- Full memory context (math validation history, UI placement history, authorship rules, etc.) is already in the persistent memory store for this project and should load automatically in a new session.
