// ==UserScript==
// @name         BUSTR: Jail Bust Assistant + PDA (Baron)
// @namespace    http://torn.city.com.dot.com.com
// @version      2.23.1
// @description  Shows your success odds on every jailed target, and how many busts you can make before failure gets likely
// @updateURL    https://raw.githubusercontent.com/WhereIsBaron/bustr/release/bustr.user.js
// @downloadURL  https://raw.githubusercontent.com/WhereIsBaron/bustr/release/bustr.user.js
// @author       Adobi & Ironhydedragon
// @author       The_Baron [1467784] - added bust success % prediction, penalty weighting fitted to real outcomes, self-calibration from logged outcomes, a full settings panel, and reliability/storage hardening
// @match        https://www.torn.com/*
// @license      MIT
// @run-at       document-end
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @connect      bustr-jail-bust-assistant.netlify.app
// @connect      identitytoolkit.googleapis.com
// @connect      securetoken.googleapis.com
// @connect      firestore.googleapis.com
// ==/UserScript==

// Security/reliability-hardened build. See CHANGELOG.md for version history.
//
// ---------------------------------------------------------------------------
// COMPLIANCE NOTE (read before adding anything new):
// This is an assistant, not a bot. It fetches your OWN Torn API data, reads
// what's already on the page, and displays numbers and colours. The RED LINE is
// AUTOMATION: BUSTR never acts without a deliberate per-action human press, never
// loops or auto-repeats, never fires more than one request per tap, and never
// walks the target list on its own. Every request it makes is one you triggered,
// to a page you're already on. Self-calibration only passively watches the
// PLAYER's own clicks to log outcomes.
//
// Refresh is on the SAFE side of that line: it reloads the jail list you're
// viewing via Torn's OWN hash-based list loader (one press = one refresh) - a
// read of a page you're on, touching no bust/bail control.
//
// Quick Bust / Quick Bail (opt-in, off by default) only relabel Torn's OWN
// bust/bail link (step=breakout -> step=breakout1, the no-confirm variant) so
// YOUR click lands on it directly - BUSTR sends nothing. One click = one request,
// the same mechanism TornTools has shipped for years.
//
// Easy Bust / Easy Bail (opt-in, off by default, consent-gated) go a step
// further: one tap sends ONE bust/bail request for the best shown target, to the
// same jailview.php page. Still one tap = one request: no loop, timer, auto-repeat
// or queue - the button does nothing until you tap again, and you choose whether
// and when. BUSTR chooses only WHICH shown target, never WHEN. (On a failed bust
// where the captive is still jailed, the "which" it offers next is that same
// captive, so a fresh tap retries them until busted or freed - still one tap, one
// request; never a self-fire.) This is the same one-tap-one-request action ReTorn
// ships, confirmed within Torn's 1-click-1-request / same-page rule by a Torn
// officer (2026-08-18). What must NEVER be added is the automation above: a timer
// or loop firing without a fresh press, multiple requests per tap, or the script
// deciding on its own to act - that's where "assist tool" becomes "bot".
// ---------------------------------------------------------------------------

(() => {
  'use strict';

  ////////////////////////////////////////////////////////////////////////////
  ////  CONFIG / CONSTANTS
  ////////////////////////////////////////////////////////////////////////////

  const DEBUG = false; // true re-enables console logs
  const SCRIPT_VERSION = '2.23.1'; // keep in sync with @version above

  // Penalty model (documented in-game mechanic): each bust adds a penalty decaying
  // hyperbolically as P0/(1+c*t) - half gone at 10h, zero past 72h. PENALTY_PER_BUST
  // is a proxy unit (P0); its absolute value cancels out of the available-busts maths,
  // only the curve shape and 72h window matter. Validated against the "Advanced Jail
  // Bust Guide" (Nosy): tracks two real testers to within ~1%, and fixes BUSTR's
  // original exponential form (128/2^(t/7.2)) that a forum audit flagged.
  const PENALTY_PER_BUST = 128;
  const PENALTY_WINDOW_HOURS = 72;
  const PENALTY_DECAY_C = 0.1; // per hour -> half gone at 10h
  // Torn's log API returns your most recent busts regardless of age, so a light
  // buster's "last 100" can span years. Busts past PENALTY_WINDOW_HOURS score 0, but
  // calcPenaltyThreshold's streak search has no cutoff and could lock onto an ancient
  // low-level burst - prune to this window before anything sees the array.
  const RECENT_HISTORY_WINDOW_DAYS = 30;

  // --- Success-chance model (reverse-engineered from the community busting guide) ---
  // Per-target odds: success% = A - (B*60/skill)*hardness - penalty%, clamped 0..100,
  // skill = level * skillCalibration. Level/perks read from the Torn API once a day.
  // skillCalibration scales your detected bust-skill bonus against the fully-perked
  // buster the constants were fit on (faction 50% + all LAW courses 65% = 115%);
  // matching 115% = 1.0, less is proportional. The perk-to-skill mapping isn't
  // published, so it's a grounded estimate self-calibration eventually replaces.
  const SHOW_SUCCESS_CHANCE = true;
  const SHOW_SETTINGS_PANEL = true;        // floating settings panel on the jail page
  const PLAYER_INFO_TTL_MS = 24 * 60 * 60 * 1000; // re-read level/perks at most daily
  const PLAYER_LEVEL_FALLBACK = 100;       // used only until the API fills it in
  const SKILL_CALIBRATION_OVERRIDE = null; // number forces it; null = auto from perks
  const FULL_BUST_SKILL_BONUS = 115;       // full stack: faction 50% + education 65%
  const CAL_CEILING = 1.0;                 // auto-cal clamp ceiling
  const CAL_FLOOR = 0.4;                   // clamp floor
  const CAL_NO_PERKS = 0.85;               // fallback when the API returns no bust perks
  // Guide formula: success% = A - B*(difficulty/skill) - penalty, difficulty =
  // level*(minutes+180) = our hardness (in hours) * 60, i.e. SUCCESS_B*60/skill*hardness.
  const SUCCESS_A = 266.6;           // guide constant (level/perk independent)
  // Guide TEXT says b=0.427, but its own no-penalty scatter plot (~100% at
  // difficulty/skill ~580, ~0% at ~950) solves to ~0.28 against a=266.6; 0.427 is an
  // apparent error in the text, so this is fit to the plotted data.
  const SUCCESS_B = 0.28;            // chart-derived slope (per minute)
  const PENALTY_PCT_ANCHOR = 1037;   // P0% * level; L61 tester's ~17% fresh = 1037/61
  // Colour thresholds for the per-target %. Re-centred in v2.20.0 for the calibrated
  // display range: the shrink refit (PRED_SHRINK_K 0.65 -> 0.40) compressed the shown
  // range from ~16-81% to ~27-67%, so the old 66/33 bands left green glued to the 67%
  // ceiling and red (below 33) almost unreachable. Anchored now to the real pooled base
  // rate (~58% success): green = clearly better-than-average odds, red = clearly worse.
  // On 1225 pooled outcomes these split the data green/orange/red with actual success
  // ~65% / ~53% / ~26% - cleanly ordered and all three bands populated. Existing users
  // still on the old defaults are moved once by a migration (see loadGlobalBustrState).
  const SC_GREEN_AT = 60;
  const SC_RED_BELOW = 40;

  // Colour thresholds for the nav-badge PENALTY % (inverse sense: higher is worse).
  // Below ORANGE = green, [ORANGE, RED) = amber, [RED, 100] = red, over 100 = critical.
  const PEN_ORANGE_AT = 50;
  const PEN_RED_AT = 85;

  // --- Penalty weighting (v2.8.0: replaces the old high-penalty guardrail) ---
  // The guide's additive penalty under-weights it ~2x vs logged outcomes. A single
  // always-on multiplier replaces the old excess-only guardrail. Fitted at 2.0 (Brier
  // 0.141 vs 0.244/0.222 either side), and an unconstrained grid independently lands on
  // cal 1.00 + weight 1.95 - agreement the shape is right, not just tuned.
  // Re-validated v2.10.0 on a disjoint batch: batch1 W=1.95, batch2 W=2.25, pooled 2.15.
  // Two datasets bracketing 2.0; the pooled gain over 2.0 is ~0.007 Brier (noise). Don't chase it.
  const PENALTY_WEIGHT = 2.0;

  // Penalty SATURATION (v2.16.0). The linear -W*penalty term keeps subtracting without
  // bound, flooring high-penalty predictions; but cross-user data shows 130-230% penalty
  // busts really succeed ~40-55% (the effect plateaus). Capping the penalty% fed to the
  // term restores calibration - LOO picked ~91-97%, shipped 95%, LOO Brier ~0.23. Also
  // frees self-cal to work at high penalty again. Refine as more lvl/cal-stamped data lands.
  const PENALTY_SATURATION_PCT = 95;

  // --- Prediction calibration shrink (v2.10.0, refit v2.20.0) ---
  // The linear model orders targets correctly but is overconfident both ways, so after
  // clamping we pull the score toward a centre: shown = CENTER + K*(raw - CENTER).
  // Refit on 1224 pooled cross-user outcomes (the original K=0.65 from one player was too
  // weak - its top bucket shown ~81% really hit ~65%). Grid search lands K~0.40, CENTER~45
  // (Brier 0.2455 -> 0.2350, now beating base rate), giving a displayed range of ~27-67%.
  // PASSES leave-one-out (in-sample and held-out essentially identical). Constants stay
  // FIXED, not per-player: free parameters buy noise (the v2.8.0 lesson). Refine as data grows.
  const PRED_SHRINK_K = 0.40;    // fraction of raw spread that survives (was 0.65; refit v2.20.0)
  const PRED_SHRINK_CENTER = 45; // %, the pivot predictions are pulled toward

  // --- Cal-aware success lift (v2.22.2) ---
  // The shrink is a single global reshape and can't fix a skill-DEPENDENT bias:
  // segmenting pooled outcomes by cal showed low-cal players over-promised and high-cal
  // UNDER-sold by ~16 points (the harmful direction - a strong buster shown ~50% who
  // really wins ~66% skips busts). This shifts the post-shrink prediction by how far the
  // player's cal sits above a perkless pivot. End-to-end refit cut pooled Brier 0.224 ->
  // 0.211 and cohort spread 27 -> 17 pts, high end +16 -> +4. Symmetric form kept (a
  // lift-only variant made the low end worse).
  // IDENTIFIABILITY: the "+success chance" perk and busting-skill perks are collinear, so
  // this credits total perk-derived skill via cal, not the success perk alone. Fit on only
  // 17 users, so K is the conservative knee; refine as per-user data accumulates.
  const SUCCESS_LIFT_K = 18;        // points of lift per 1.0 of cal above the pivot
  const SUCCESS_LIFT_PIVOT = 0.85;  // no-lift point; matches CAL_NO_PERKS

  // --- Self-calibration (learns YOUR real success curve from logged outcomes) ---
  // Passive only: built from the player's own clicks and Torn's rendered result text.
  // Never simulates input. See the COMPLIANCE NOTE.
  const OUTCOME_LOG_MAX = 500;           // cap on stored attempts (oldest dropped). A count
  // cap, not day-based: it's what really limits self-cal's history, grows forward only from when
  // self-cal was enabled, and can't be backfilled from Torn's log (which lacks the prediction).
  //
  // Bounds are deliberately tight - the lesson of v2.7.19/v2.8.0, where LOO showed
  // self-cal HURTING at small samples (fitting scored worse out-of-sample than the
  // perk-derived value: it fit noise). And since cal only scales hardness, a low floor
  // let it "explain" penalty-caused failures by making hardness brutal. So: floor/ceiling
  // near the plausible perk range, and a sample count high enough to react to a real curve.
  const SELF_CAL_MIN_SAMPLES = 100;     // don't trust a smaller fit (was 15: overfit)
  const SELF_CAL_FLOOR = 0.6;           // fitted-cal clamp floor (was 0.3: allowed a pathological collapse)
  const SELF_CAL_CEILING = 1.7;         // raised from 1.4 (v2.22.2): with the cal-aware lift a proven strong buster fits above 1.4, and the old ceiling clipped it. Still a plausible perk range.
  const SELF_CAL_STEP = 0.02;           // grid-search resolution
  const PENDING_ATTEMPT_TIMEOUT_MS = 20 * 1000; // discard a click if no result follows in time

  // --- Scoped API key creation ---
  // A pre-filled "create key" link hands new users a key request with exactly the
  // selections this script uses ticked - the COMPLETE set: `basic` (level), `perks`
  // (bust perks), `log` (bust history, log=5360). Keep in sync with fetchBustsData/
  // fetchProfileData, and prefer this minimal scope over a Full Access key to limit the
  // blast radius if a key leaks from local storage.
  // SEPARATOR: "?" after "#tab=api", then "&" between params - #tab=api?step=addNewKey&...
  // Not a typo: Torn splits the fragment on "?". "&step=" makes the tab swallow the rest
  // and nothing pre-ticks (verified broken in v2.12.1). Do not "correct" it.
  const API_KEY_SELECTIONS = 'basic,log,perks';
  const API_KEY_CREATE_URL =
    'https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=BUSTR&user=' + API_KEY_SELECTIONS;

  // Stamped on every outcome from v2.8.0 on. Pre-v2.7.19 entries froze an inflated
  // penalty% (self-cal skill in the denominator - a real export showed 300% for a true
  // 90%), so unstamped legacy entries are kept for history/stats but excluded from the
  // fit; feeding them back would reintroduce the v2.7.19 bug.
  const OUTCOME_MODEL_VERSION = 2;

  // --- Play style (display-only: shifts colour thresholds, never acts for you) ---
  // 'safety' uses the panel thresholds as-is. 'maxcount' is an opt-in preset for volume
  // grinders: since regen climbs with penalty, deliberately playing the orange zone
  // maximizes daily bust count at the cost of more fails. Colour only; never busts.
  const PLAYSTYLE_MAXCOUNT_BUST_OFFSET = -3;    // redLimit shifts 3 lower
  const PLAYSTYLE_MAXCOUNT_SUCCESS_OFFSET = -20; // success colour bands shift 20pts lower

  // Timing
  const DEFAULT_REFRESH_SECONDS = 30;        // tick cadence (local recompute runs every tick)
  const JAIL_MIN_FETCH_GAP_MS = 35 * 1000;   // min gap between jail-page API fetches (dodges Torn's ~30s cache)
  const FETCH_TIMEOUT_MS = 10000;

  // Storage keys
  const STATE_KEY = 'globalBustrState';
  const API_KEY_NAME = 'bustrApiKey';
  const LEGACY_API_KEY_NAME = 'bustrApiKey'; // same name, but in localStorage pre-v2

  // --- Cloud sync (optional, off by default). These three values are public by design
  // and safe to ship; the only real secret (the Firebase service account) lives
  // server-side in the Netlify function, never here. ---
  const CLOUD_FUNCTION_URL = 'https://bustr-jail-bust-assistant.netlify.app/.netlify/functions/bustr-auth';
  const CLOUD_FIREBASE_API_KEY = 'AIzaSyCw5UQGI-N1pEJZ7xg3OvO_elaTLQfeDYg';
  const CLOUD_PROJECT_ID = 'bustr---jail-bust-assistant';
  const CLOUD_AUTH_KEY = 'bustrCloudAuth'; // kept OUT of state so it never lands in a debug export
  const CLOUD_PULL_KEY = 'bustrCloudLastPull'; // device-local timestamp of the last pull (not synced)
  const CLOUD_PULL_MIN_INTERVAL_MS = 60 * 60 * 1000; // re-pull at most hourly per device (enabling sync still pulls immediately)
  const CLOUD_PUSH_DEBOUNCE_MS = 90 * 1000; // coalesce a busting flurry into one write (timer resets per bust; flushes when you pause)

  const log = (...args) => { if (DEBUG) console.log('[BUSTR]', ...args); };

  log('BUSTR v2 loaded');

  ////////////////////////////////////////////////////////////////////////////
  ////  ENVIRONMENT DETECTION
  ////////////////////////////////////////////////////////////////////////////

  const PDA_API_KEY = '###PDA-APIKEY###';
  function isPDA() {
    // PDA replaces the token above at runtime, so the ### wrapper is gone on PDA
    return !/^(###).+(###)$/.test(PDA_API_KEY);
  }

  // GM functions exist in Tampermonkey/Violentmonkey. On PDA they only exist via a
  // shim and don't persist reliably, so we force localStorage there.
  const hasGM =
    typeof GM_setValue !== 'undefined' &&
    typeof GM_getValue !== 'undefined' &&
    typeof GM_deleteValue !== 'undefined';
  const useGM = hasGM && !isPDA();

  ////////////////////////////////////////////////////////////////////////////
  ////  STORAGE ABSTRACTION (isolated when possible, localStorage fallback)
  ////////////////////////////////////////////////////////////////////////////

  function safeParse(raw, fallback) {
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }

  const Store = {
    set(key, value) {
      const serialized = JSON.stringify(value);
      if (useGM) { GM_setValue(key, serialized); return; }
      localStorage.setItem(key, serialized);
    },
    get(key) {
      if (useGM) {
        const raw = GM_getValue(key);
        return raw === undefined ? undefined : safeParse(raw, undefined);
      }
      const raw = localStorage.getItem(key);
      return raw === null ? undefined : safeParse(raw, undefined);
    },
    remove(key) {
      if (useGM) { GM_deleteValue(key); return; }
      localStorage.removeItem(key);
    },
  };

  // One-time migration of anything left in localStorage by v1, then wipe the
  // page-readable copy so other scripts on torn.com can't read your key.
  function migrateFromLegacyStorage() {
    if (!useGM) return; // nothing to migrate into
    try {
      if (Store.get(API_KEY_NAME) === undefined) {
        const legacyKey = localStorage.getItem(LEGACY_API_KEY_NAME);
        if (legacyKey !== null) {
          Store.set(API_KEY_NAME, safeParse(legacyKey, legacyKey));
        }
      }
      if (Store.get(STATE_KEY) === undefined) {
        const legacyState = localStorage.getItem(STATE_KEY);
        if (legacyState !== null) {
          Store.set(STATE_KEY, safeParse(legacyState, undefined));
        }
      }
      // Remove the old page-readable copies regardless
      localStorage.removeItem(LEGACY_API_KEY_NAME);
      localStorage.removeItem(STATE_KEY);
    } catch (err) {
      console.error('[BUSTR] migration failed', err);
    }
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  COLORS
  ////////////////////////////////////////////////////////////////////////////

  const greenApple = '#85b200';
  const orangeFulvous = '#d08000';
  const orangeAmber = '#ffbf00';
  const redFlame = '#e64d1a';
  const redMelon = '#ffa8a8';

  ////////////////////////////////////////////////////////////////////////////
  ////  STATE (default shape)
  ////////////////////////////////////////////////////////////////////////////

  function defaultState() {
    return {
      userSettings: {
        reminderLimits: {
          redLimit: 0,   // red at this number and under
          greenLimit: 3, // green at this number and over
        },
        statsRefreshRate: DEFAULT_REFRESH_SECONDS, // seconds (local recompute)
        customPenaltyThreshold: 0, // 0 = use the prediction algorithm
        showHardnessScore: true,   // hardness number visible
        sortByHardness: true,      // independent: easiest-first sort (can be on/off regardless of the above)
        quickBust: false,          // opt-in: relabel Torn's OWN bust link to no-confirm (step=breakout1); never clicks for you. See COMPLIANCE NOTE.
        quickBail: false,          // opt-in: same for the bail link (buy -> buy1)
        easyBust: false,           // opt-in (consent-gated): header button, 1 tap = 1 bust request for the best shown target. See COMPLIANCE NOTE.
        easyBail: false,           // opt-in (consent-gated): same, bails the cheapest shown inmate.
        easyActionsConsented: false, // true once the Easy actions consent prompt is accepted (covers both)
        showSuccessChance: SHOW_SUCCESS_CHANCE, // per-target % visible
        skillCalibrationOverride: SKILL_CALIBRATION_OVERRIDE, // null = auto from perks
        successGreenAt: SC_GREEN_AT,   // % at/above which a target is green
        successRedBelow: SC_RED_BELOW, // % below which a target is red
        selfCalibrationEnabled: true, // use learned-from-outcomes cal once enough samples exist (default on: passive-only, see COMPLIANCE NOTE)
        playStyle: 'safety',           // 'safety' | 'maxcount' (display-only thresholds, see PLAYSTYLE_* constants)
        activeScope: 'always',         // 'always' | 'jailOnly' - suppresses nav badge/colours + background fetch off the jail page
        navBadgeDetail: 'simple',      // 'simple' = badge shows only busts-left (default); 'full' = score/threshold : busts + penalty %. Full breakdown always in hover tooltip.
        usePerkCalibration: true,      // ON by default (v2.17.0): scales the success/skill term by detected perks. Self-cal overrides once it has samples; penalty term stays on baseline (see getPenaltySkillCalibration).
        perkCalDefaultApplied: true,   // marks the v2.17.0 perk-cal-default migration ran (see loadGlobalBustrState); new installs start applied so a manual opt-out isn't re-flipped.
        cloudSyncEnabled: false,       // off by default; opt-in cloud backup of outcomeLog, behind a consent prompt (see CloudSync)
      },
      penaltyScore: 0,
      penaltyThreshold: 0,
      availableBusts: 0,
      timestampsArray: [],
      lastFetchTimestampMs: 0,
      renderedView: undefined,
      playerLevel: PLAYER_LEVEL_FALLBACK, // overwritten from the API once fetched
      bustPerks: [],                      // bust-related perk strings detected from the API
      lastProfileFetchMs: 0,              // when level/perks were last pulled from the API
      lastApiError: null,                 // {what, message, code, at} of the last failed API call, or null if the last one succeeded
      outcomeLog: [],                     // logged bust attempts: {h, pred, pen, success, jailed, lvl, cal, ts, m}, capped at OUTCOME_LOG_MAX
      selfCalibrationValue: null,         // last fitted calibration from outcomeLog, or null if not enough samples
    };
  }

  let GLOBAL_BUSTR_STATE = defaultState();

  // Live mirror of the player's level used by the success model. Defaults to the
  // fallback, gets replaced by the API value, persists across loads via state.
  let playerLevel = PLAYER_LEVEL_FALLBACK;
  function getPlayerLevel() { return playerLevel; }
  function setPlayerLevel(level) {
    if (typeof level === 'number' && level > 0) {
      playerLevel = level;
      setGlobalBustrState({ playerLevel: level });
    }
  }

  // Effective skill calibration, in priority order:
  //   1. manual override (settings panel) - always wins if set
  //   2. self-calibration fitted from your own logged outcomes, once enabled
  //      and OUTCOME_LOG_MAX-capped log has SELF_CAL_MIN_SAMPLES+ entries
  //   3. perk-derived estimate (see profileController)
  let skillCalibration = CAL_CEILING;
  function getSkillCalibration() {
    const override = getUserSettings().skillCalibrationOverride;
    if (typeof override === 'number' && override > 0) return override;

    const settings = getUserSettings();
    if (settings.selfCalibrationEnabled) {
      const state = getGlobalBustrState();
      const log = state.outcomeLog || [];
      if (log.length >= SELF_CAL_MIN_SAMPLES && typeof state.selfCalibrationValue === 'number') {
        return state.selfCalibrationValue;
      }
    }
    return skillCalibration;
  }

  // Skill calibration for the PENALTY term (penaltyPctAt). Penalty puts calibration in
  // the DENOMINATOR (p0 = PENALTY_PCT_ANCHOR/(level*cal)), so an auto-fitted value here
  // couples two things that must stay independent - the v2.7.19 feedback loop, where a
  // 0.3 self-cal floor tripled per-bust penalty and floored every success% at 1. Excludes
  // self-cal (always) and, since v2.17.0, the perk estimate too (perk-cal was validated
  // only for the success term). Penalty uses the neutral baseline; a manual override still wins.
  function getPenaltySkillCalibration() {
    const override = getUserSettings().skillCalibrationOverride;
    if (typeof override === 'number' && override > 0) return override;
    return CAL_CEILING;
  }

  function successChanceEnabled() {
    return getUserSettings().showSuccessChance !== false;
  }

  // Play-style modifiers (display-only - see COMPLIANCE NOTE). 'maxcount' shifts
  // the colour thresholds without touching the user's saved base settings, so
  // switching playStyle back and forth never clobbers their custom limits.
  function getEffectiveReminderLimits() {
    const settings = getUserSettings();
    const base = settings.reminderLimits;
    const redLimit = typeof base.redLimit === 'number' ? base.redLimit : 0;
    const greenLimit = typeof base.greenLimit === 'number' ? base.greenLimit : 3;
    if (settings.playStyle === 'maxcount') {
      return { redLimit: redLimit + PLAYSTYLE_MAXCOUNT_BUST_OFFSET, greenLimit };
    }
    return { redLimit, greenLimit };
  }

  function getEffectiveSuccessThresholds() {
    const settings = getUserSettings();
    const greenAt = typeof settings.successGreenAt === 'number' ? settings.successGreenAt : SC_GREEN_AT;
    const redBelow = typeof settings.successRedBelow === 'number' ? settings.successRedBelow : SC_RED_BELOW;
    if (settings.playStyle === 'maxcount') {
      return {
        greenAt: Math.max(0, greenAt + PLAYSTYLE_MAXCOUNT_SUCCESS_OFFSET),
        redBelow: Math.max(0, redBelow + PLAYSTYLE_MAXCOUNT_SUCCESS_OFFSET),
      };
    }
    return { greenAt, redBelow };
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  GETTERS / SETTERS  (each setter writes once)
  ////////////////////////////////////////////////////////////////////////////

  function setGlobalBustrState(newState) {
    GLOBAL_BUSTR_STATE = { ...GLOBAL_BUSTR_STATE, ...newState };
    Store.set(STATE_KEY, GLOBAL_BUSTR_STATE);
  }
  function getGlobalBustrState() {
    return GLOBAL_BUSTR_STATE;
  }
  function loadGlobalBustrState() {
    const loaded = Store.get(STATE_KEY);
    if (loaded === undefined) return false;
    GLOBAL_BUSTR_STATE = { ...GLOBAL_BUSTR_STATE, ...loaded };
    // Backfill any newly-added settings fields for users with older saved state
    const defaults = defaultState().userSettings;
    const savedSettings = (loaded && loaded.userSettings) || {};
    GLOBAL_BUSTR_STATE.userSettings = {
      ...defaults,
      ...savedSettings,
      reminderLimits: { ...defaults.reminderLimits, ...(savedSettings.reminderLimits || {}) },
    };
    // Migration: usePerkCalibration replaced the inverted ignorePerks setting. Preserve
    // what an old ignorePerks user was getting instead of resetting to the new default.
    if (typeof savedSettings.usePerkCalibration !== 'boolean' && typeof savedSettings.ignorePerks === 'boolean') {
      GLOBAL_BUSTR_STATE.userSettings.usePerkCalibration = !savedSettings.ignorePerks;
    }
    // Prune dead keys AFTER that migration (its one legitimate reader of ignorePerks).
    // highPenaltyCaution died with the v2.8.0 guardrail; else both linger in state/exports.
    delete GLOBAL_BUSTR_STATE.userSettings.ignorePerks;
    delete GLOBAL_BUSTR_STATE.userSettings.highPenaltyCaution;
    // Migration: perk-cal became ON by default in v2.17.0. Turn it on ONCE for existing
    // users, flag-tracked so a later opt-out sticks. Success term only; penalty stays baseline.
    if (GLOBAL_BUSTR_STATE.userSettings.perkCalDefaultApplied !== true) {
      GLOBAL_BUSTR_STATE.userSettings.usePerkCalibration = true;
      GLOBAL_BUSTR_STATE.userSettings.perkCalDefaultApplied = true;
    }
    // Migration: colour bands re-centred in v2.20.0 (see SC_GREEN_AT/SC_RED_BELOW). Move
    // users ONCE, only if still on the old 66/33 defaults; flag-tracked so it never re-runs.
    if (GLOBAL_BUSTR_STATE.userSettings.scBandsRecenteredV220 !== true) {
      const s = GLOBAL_BUSTR_STATE.userSettings;
      if (s.successGreenAt === 66 && s.successRedBelow === 33) {
        s.successGreenAt = SC_GREEN_AT;
        s.successRedBelow = SC_RED_BELOW;
      }
      s.scBandsRecenteredV220 = true;
    }
    return true;
  }
  function deleteGlobalBustrState() {
    GLOBAL_BUSTR_STATE = defaultState();
    Store.remove(STATE_KEY);
  }

  function getMyViewportWidthType() {
    if (!window.visualViewport) throw new Error('Visual viewport not loaded');
    return window.visualViewport.width > 1000 ? 'Desktop' : 'Mobile';
  }

  // Non-throwing wrapper for tick-loop callers (getMyViewportWidthType throws when
  // visualViewport is missing). Falls back to Desktop, the long-standing sidebar placement.
  function isMobileViewport() {
    try {
      return getMyViewportWidthType() !== 'Desktop';
    } catch (e) {
      return false;
    }
  }


  // Torn API keys are exactly 16 alphanumeric chars, so strip anything else - not
  // cosmetic. Two confirmed PDA cases: the injected key can arrive WRAPPED IN QUOTES
  // (measured 18), and a phone-pasted key can carry an invisible char that trim() misses.
  // Either way Torn answers "Incorrect key" while the on-screen key looks correct - the
  // most misleading failure this script can produce.
  const API_KEY_LENGTH = 16;
  function sanitizeApiKey(raw) {
    if (typeof raw !== 'string') return '';
    return raw.replace(/[^A-Za-z0-9]/g, '');
  }

  function setApiKey(apiKey) {
    Store.set(API_KEY_NAME, sanitizeApiKey(apiKey));
  }
  // A key the user set explicitly always wins, including on PDA. This used to return
  // PDA_API_KEY unconditionally on PDA, so you couldn't supply your own; if the injected
  // key was wrong, every penalty read 0% and the panel key was ignored (confirmed:
  // "Incorrect key" on PDA, fine on desktop).
  function getApiKey() {
    // Both sources sanitized on the way out (PDA can wrap in quotes; pasted keys carry
    // invisible chars) - neither visible to the user, both make Torn reject the key.
    const stored = sanitizeApiKey(Store.get(API_KEY_NAME));
    if (stored !== '') return stored;
    // A blank injected key counts as NO key: isPDA() only checks the token was
    // substituted, and '' satisfies that. Returning '' would call Torn with key= ->
    // "Incorrect key", misreading "no key arrived" as "wrong key".
    const injected = isPDA() ? sanitizeApiKey(PDA_API_KEY) : '';
    if (injected !== '') return injected;
    return undefined; // no usable key from either source
  }
  function deleteApiKey() {
    Store.remove(API_KEY_NAME);
  }

  function setUserSettings(newUserSettings) {
    setGlobalBustrState({ userSettings: newUserSettings });
  }
  function getUserSettings() {
    return getGlobalBustrState().userSettings;
  }

  function setRenderedView(newRenderedView) {
    setGlobalBustrState({ renderedView: newRenderedView });
  }
  function getRenderedView() {
    return getGlobalBustrState().renderedView;
  }

  function setTimestampsArray(newTimestampsArr) {
    setGlobalBustrState({ timestampsArray: newTimestampsArr });
  }
  function getTimestampsArray() {
    return getGlobalBustrState().timestampsArray;
  }

  function setLastFetchTimestampMs() {
    setGlobalBustrState({ lastFetchTimestampMs: Date.now() });
  }
  function getLastFetchTimestampMs() {
    return getGlobalBustrState().lastFetchTimestampMs;
  }

  function setPenaltyThreshold(newPenaltyThreshold) {
    setGlobalBustrState({ penaltyThreshold: newPenaltyThreshold });
  }
  function getPenaltyThreshold() {
    return getGlobalBustrState().penaltyThreshold;
  }

  function setPenaltyScore(newPenaltyScore) {
    setGlobalBustrState({ penaltyScore: newPenaltyScore });
  }
  function getPenaltyScore() {
    return getGlobalBustrState().penaltyScore;
  }

  function setAvailableBusts(newAvailableBusts) {
    setGlobalBustrState({ availableBusts: newAvailableBusts });
  }
  function getAvailableBusts() {
    return getGlobalBustrState().availableBusts;
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  CALCULATIONS
  ////////////////////////////////////////////////////////////////////////////

  function createTimestampsArray(data) {
    const cutoff = Date.now() / 1000 - RECENT_HISTORY_WINDOW_DAYS * 24 * 60 * 60;
    const timestamps = [];
    for (const entry in data.log) {
      const ts = data.log[entry].timestamp;
      if (ts >= cutoff) timestamps.push(ts);
    }
    return timestamps;
  }

  // Penalty contribution of a single bust that happened `hoursAgo` hours ago.
  // Hyperbolic decay with a hard cutoff at the 72h window (the "sudden jump" to
  // zero the guide observed at the end of recovery).
  function penaltyAt(hoursAgo) {
    if (hoursAgo < 0) hoursAgo = 0;
    if (hoursAgo > PENALTY_WINDOW_HOURS) return 0;
    return PENALTY_PER_BUST / (1 + PENALTY_DECAY_C * hoursAgo);
  }

  function calcPenaltyScore(timestampsArray) {
    const currentTime = Date.now() / 1000;
    let score = 0;
    for (const ts of timestampsArray) {
      const hours = (currentTime - ts) / 60 / 60;
      score += penaltyAt(hours);
    }
    return Math.floor(score);
  }

  function calcPenaltyThreshold(timestampsArray) {
    const settings = getUserSettings();
    if (settings.customPenaltyThreshold && typeof settings.customPenaltyThreshold === 'number') {
      return settings.customPenaltyThreshold;
    }
    if (!timestampsArray || timestampsArray.length === 0) return 0;

    const period = 24 * 60 * 60 * 3;
    let longestSequence = 0;
    let currentSequence = 1;
    let currentMin = timestampsArray[0];
    let currentMax = timestampsArray[0];

    for (let i = 1; i < timestampsArray.length; i++) {
      const TS = timestampsArray[i];
      if (currentMin - TS <= period && currentMax - TS <= period) {
        currentSequence++;
        currentMin = Math.min(currentMin, TS);
        currentMax = Math.max(currentMax, TS);
      } else {
        longestSequence = Math.max(longestSequence, currentSequence);
        currentSequence = 1;
        currentMin = TS;
        currentMax = TS;
      }
    }
    longestSequence = Math.max(longestSequence, currentSequence);

    // <= (not <): a window ending exactly at the last entry is valid. With strict <,
    // when the whole array IS the longest cluster (common after pruning, see
    // RECENT_HISTORY_WINDOW_DAYS) the loop never runs and returns 0, making
    // availableBusts deeply negative for anyone with penalty. Found on a real pruned export.
    let currentMaxScore = 0;
    for (let i = 0; i <= timestampsArray.length - longestSequence; i++) {
      let score = 0;
      const initialTimestamp = timestampsArray[i];
      for (let j = 0; j < longestSequence; j++) {
        const hours = (initialTimestamp - timestampsArray[i + j]) / 60 / 60;
        score += penaltyAt(hours);
      }
      currentMaxScore = Math.max(currentMaxScore, score);
    }
    return Math.floor(currentMaxScore);
  }

  function calcAvailableBusts(penaltyScore, penaltyThreshold) {
    return Math.floor((penaltyThreshold - penaltyScore) / PENALTY_PER_BUST);
  }

  function calcBustrStats(timestampsArray) {
    const penaltyScore = calcPenaltyScore(timestampsArray);
    const penaltyThreshold = calcPenaltyThreshold(timestampsArray);
    const availableBusts = calcAvailableBusts(penaltyScore, penaltyThreshold);
    const penaltyPct = Math.round(calcPenaltyPct(timestampsArray));
    return { penaltyScore, penaltyThreshold, availableBusts, penaltyPct };
  }

  function getLevelJailDurationInfo(playerEl) {
    const levelEl = playerEl.querySelector('.level');
    const durationEl = playerEl.querySelector('.time');
    if (!levelEl || !durationEl) return null;

    // textContent (not innerText): same regex result, but avoids a layout reflow -
    // runs once per jail row every tick now that rows live-update.
    const levelMatch = levelEl.textContent.match(/\d+/);
    if (!levelMatch) return null;
    const level = +levelMatch[0];

    const hoursMatch = durationEl.textContent.match(/\d+(?=h)/);
    const minsMatch = durationEl.textContent.match(/\d+(?=m)/);
    const hours = hoursMatch ? +hoursMatch[0] : 0;
    const mins = minsMatch ? +minsMatch[0] : 0;
    const durationInHours = hours + mins / 60;

    return [level, +durationInHours];
  }

  function calcHardnessScore(level, durationInHours) {
    return Math.floor(level * (durationInHours + 3));
  }

  // Penalty of a single bust expressed in real success-chance %, for the success
  // model (separate from the proxy units used by the budget heuristic above).
  function penaltyPctAt(hoursAgo) {
    if (hoursAgo < 0) hoursAgo = 0;
    if (hoursAgo > PENALTY_WINDOW_HOURS) return 0;
    const skill = getPlayerLevel() * getPenaltySkillCalibration();
    const p0 = PENALTY_PCT_ANCHOR / skill;
    return p0 / (1 + PENALTY_DECAY_C * hoursAgo);
  }

  // Your current total penalty in % (same for every target at a given moment).
  function calcPenaltyPct(timestampsArray) {
    if (!timestampsArray || timestampsArray.length === 0) return 0;
    const now = Date.now() / 1000;
    let pct = 0;
    for (const ts of timestampsArray) pct += penaltyPctAt((now - ts) / 3600);
    return pct;
  }

  // Same formula as calcSuccessChance but takes calibration as a param (unrounded), no
  // settings lookups - shared by the live display and the self-cal grid search so they
  // can't disagree. Penalty counts at PENALTY_WEIGHT (2x face value); see that constant.
  function calcSuccessChanceRaw(hardness, penaltyPct, calibration) {
    const skill = getPlayerLevel() * calibration;
    // Penalty's effect saturates: past PENALTY_SATURATION_PCT it stops biting harder
    // (see the constant). Below it the model is unchanged, preserving the low/mid range.
    const effectivePenalty = PENALTY_WEIGHT * Math.min(penaltyPct, PENALTY_SATURATION_PCT);
    const raw = SUCCESS_A - (SUCCESS_B * 60 / skill) * hardness - effectivePenalty;
    // Clamp to [1,100] FIRST, then shrink toward the centre (see PRED_SHRINK_K). Order
    // matters: the raw score can be hundreds above 100 for an easy target, and shrinking
    // first would leak that headroom back in, recreating the overconfidence. (A raised
    // FLOOR was tried and rejected - great in-sample 0.136, collapsed under LOO 0.173;
    // the shrink corrects both tails and survives cross-validation.)
    const clamped = Math.max(1, Math.min(100, raw));
    const shrunk = PRED_SHRINK_CENTER + PRED_SHRINK_K * (clamped - PRED_SHRINK_CENTER);
    // Cal-aware lift (v2.22.2): shift by how far skill sits above the perkless pivot (see
    // SUCCESS_LIFT_K) - a bias the global shrink can't fix. In the shared raw fn so the
    // self-cal grid re-fits cal under the SAME formula the display uses.
    const lift = SUCCESS_LIFT_K * (calibration - SUCCESS_LIFT_PIVOT);
    return Math.max(1, Math.min(100, shrunk + lift));
  }

  // Estimated odds of busting a target of the given hardness right now.
  function calcSuccessChance(hardness, penaltyPct) {
    return Math.round(calcSuccessChanceRaw(hardness, penaltyPct, getSkillCalibration()));
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  SELF-CALIBRATION (learns your real success curve from logged outcomes)
  ////////////////////////////////////////////////////////////////////////////
  // Passive: built only from clicks you make and Torn's rendered result text (see the
  // COMPLIANCE NOTE - nothing here simulates input).
  // Simplification: each attempt freezes the penalty% shown at click time, and re-fitting
  // only searches the calibration in the hardness/skill term (re-deriving penalty% per
  // candidate would need a full history snapshot per attempt). Penalty% moves the result
  // by a near-constant offset, so it barely affects the fit; the hardness slope dominates.

  // Only current-OUTCOME_MODEL_VERSION entries are eligible to fit; pre-v2.7.19 ones froze
  // an inflated penalty% (see OUTCOME_MODEL_VERSION). They still show in history/stats but
  // can't vote on the number.
  function fittableOutcomes(outcomeLog) {
    if (!Array.isArray(outcomeLog)) return [];
    return outcomeLog.filter((o) => o && o.m === OUTCOME_MODEL_VERSION);
  }

  // True for a genuine logged bust. Test rows (cloud/test/test.html) carry a `note` field
  // BUSTR never writes, so `note` marks a synthetic write; a numeric ts (the merge/sort
  // key) is also required. Legacy entries with no `m` stamp are still real and kept.
  function isRealOutcome(o) {
    return !!o && typeof o === 'object' && typeof o.ts === 'number' && !('note' in o);
  }

  // Grid-search the calibration best matching predicted vs actual outcomes; null if too
  // few eligible attempts. Fits over ALL penalty ranges (the old low-penalty-only
  // exclusion treated a symptom of under-weighted penalty, now fixed by PENALTY_WEIGHT).
  // Searches ONLY calibration, not the penalty weight: fitting both generalized worse
  // (LOO Brier 0.164 vs 0.148 vs 0.141 for fitting nothing) - extra freedom buys noise.
  function computeSelfCalibration(outcomeLog) {
    const usable = fittableOutcomes(outcomeLog);
    if (usable.length < SELF_CAL_MIN_SAMPLES) return null;
    let bestCal = null;
    let bestError = Infinity;
    for (let c = SELF_CAL_FLOOR; c <= SELF_CAL_CEILING + 1e-9; c += SELF_CAL_STEP) {
      let error = 0;
      for (const o of usable) {
        const predicted = calcSuccessChanceRaw(o.h, o.pen, c) / 100;
        const actual = o.success ? 1 : 0;
        const diff = predicted - actual;
        error += diff * diff;
      }
      if (error < bestError) {
        bestError = error;
        bestCal = c;
      }
    }
    return bestCal === null ? null : Math.round(bestCal * 100) / 100;
  }

  // Summary for the settings panel: sample count + how often predicted vs actual
  // success agreed, so the user can judge whether to trust/enable the fit.
  // `usable` is the count that can actually feed the fit (see fittableOutcomes).
  function selfCalibrationStats(outcomeLog) {
    if (!Array.isArray(outcomeLog) || outcomeLog.length === 0) return null;
    const n = outcomeLog.length;
    const successes = outcomeLog.filter((o) => o.success).length;
    const jailed = outcomeLog.filter((o) => o.jailed).length;
    const usable = fittableOutcomes(outcomeLog).length;
    return { n, successRatePct: Math.round((100 * successes) / n), jailed, usable };
  }

  // Where the API key came from and whether it looks like a key - source and length only,
  // never the key. Enough to tell an empty/failed PDA injection (length 0) from a real key
  // Torn rejects: identical symptoms otherwise, different fixes.
  function describeApiKey() {
    const storedRaw = Store.get(API_KEY_NAME);
    const overrideRawLen = (typeof storedRaw === 'string') ? storedRaw.length : 0;
    const overrideLen = sanitizeApiKey(storedRaw).length;
    const pdaRawLen = (typeof PDA_API_KEY === 'string' && isPDA()) ? PDA_API_KEY.length : 0;
    const pdaLen = isPDA() ? sanitizeApiKey(PDA_API_KEY).length : 0;
    let resolved;
    try { resolved = getApiKey(); } catch (e) { resolved = undefined; }
    const resolvedLength = typeof resolved === 'string' ? resolved.length : 0;
    return {
      source: overrideLen > 0 ? 'user override' : (pdaLen > 0 ? 'PDA injected' : 'none'),
      resolvedLength,
      expectedLength: API_KEY_LENGTH,
      looksValid: resolvedLength === API_KEY_LENGTH,
      // raw length > sanitized means the key arrived with junk chars (PDA quotes, a
      // pasted invisible char) - that gap is the diagnosis.
      overrideLength: overrideLen,
      overrideRawLength: overrideRawLen,
      pdaTokenSubstituted: isPDA(), // false = the ###...### placeholder is still literal (not running under PDA)
      pdaKeyLength: pdaLen,
      pdaKeyRawLength: pdaRawLen,
    };
  }

  // What the badge is ACTUALLY doing on screen (the PDA layout can't be inspected
  // remotely). Reports where it lives, whether column styling reached it, the computed
  // properties that decide overlap, and its size. Layout facts only, no personal data.
  function describeBadge() {
    const badge = document.querySelector('.bustr-mobile-badge');
    if (!badge) return null;
    const col = document.getElementById('bustr-sidebar-btn');
    const pctSpan = badge.querySelector('.bustr-stats__penaltyPct');
    const pctLine = badge.querySelector('.bustr-pct-line');
    const computed = (el) => {
      if (!el || typeof window.getComputedStyle !== 'function') return null;
      const s = window.getComputedStyle(el);
      return {
        position: s.position, display: s.display, fontSize: s.fontSize,
        visibility: s.visibility, overflow: s.overflow, whiteSpace: s.whiteSpace,
      };
    };
    const holder = badge.parentElement;
    const link = col ? col.querySelector('a') : null;
    return {
      inColumn: !!(col && col.contains(badge)),
      parentHasStackClass: !!(holder && holder.classList.contains('bustr-col-inner')),
      parentClass: holder ? String(holder.className || '') : null,
      badge: computed(badge),
      pctLine: computed(pctLine),
      // The holder must be flex, and BOTH children must be in flow (position: static),
      // or the stack overlaps - flex only lays out in-flow children.
      holder: computed(holder),
      link: computed(link),
      pctText: pctSpan ? pctSpan.textContent : null, // '#' here means the stats renderer never reached it
      badgeSize: { w: badge.offsetWidth, h: badge.offsetHeight },
      pctLineSize: pctLine ? { w: pctLine.offsetWidth, h: pctLine.offsetHeight } : null,
      holderSize: holder ? { w: holder.offsetWidth, h: holder.offsetHeight } : null,
      colSize: col ? { w: col.offsetWidth, h: col.offsetHeight } : null,
    };
  }

  // Shape of the nav around #nav-jail, walking up the ancestor chain. Included in
  // the diagnostic export because the mobile/PDA nav structure can't be inspected
  // remotely and guessing at it produced several bad layouts - this reports it
  // instead. Deliberately only tag/id/class/counts, never text or href: nothing here
  // can carry account data, in keeping with the rest of the export.
  function describeNavStructure() {
    const jail = document.querySelector('#nav-jail');
    if (!jail) return null;
    const describe = (el) => {
      if (!el || !el.tagName) return null;
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        // SVG elements expose className as an object, not a string - normalise.
        cls: (typeof el.className === 'string' && el.className) ? el.className : undefined,
        children: el.children.length,
        navItems: el.querySelectorAll('[id^="nav-"]').length,
      };
    };
    const chain = [];
    let node = jail;
    for (let i = 0; i < 4 && node; i++) {
      chain.push(describe(node));
      node = node.parentElement;
    }
    return {
      viewport: window.visualViewport ? Math.round(window.visualViewport.width) : null,
      link: describe(jail.querySelector('a')),
      chain, // [0] = #nav-jail, then each ancestor outward
      cellResolved: !!findMobileNavCell(jail), // did the nav-column placement engage?
    };
  }

  // Diagnostic snapshot for a maintainer: everything needed to reproduce a user's numbers
  // (version, level, settings, perks, penalty, cal fits, bust history) and nothing else -
  // no API key (stored separately, see getApiKey()), no username/ID/faction (never read).
  function buildDiagnosticExport() {
    const state = getGlobalBustrState();
    const outcomeLog = Array.isArray(state.outcomeLog) ? state.outcomeLog : [];
    return {
      scriptVersion: SCRIPT_VERSION,
      exportedAt: new Date().toISOString(),
      platform: { isPDA: isPDA(), useGM }, // which storage code path (GM vs localStorage) this user is on
      navStructure: describeNavStructure(), // shape of Torn's nav around #nav-jail (see describeNavStructure)
      badgeState: describeBadge(), // what the nav badge is actually doing on screen (see describeBadge)
      playerLevel: state.playerLevel,
      bustPerks: state.bustPerks || [],
      settings: getUserSettings(),
      skillCalibration: getSkillCalibration(),
      penalty: {
        currentPct: Math.round(calcPenaltyPct(getTimestampsArray()) * 10) / 10,
        score: state.penaltyScore,
        threshold: state.penaltyThreshold,
        availableBusts: state.availableBusts,
      },
      selfCalibrationValue: state.selfCalibrationValue,
      outcomeStats: selfCalibrationStats(outcomeLog),
      outcomeLog,
      timestampsArray: state.timestampsArray || [],
      cache: {
        lastProfileFetchMs: state.lastProfileFetchMs || 0, // when level/perks were last pulled
        lastFetchTimestampMs: state.lastFetchTimestampMs || 0, // when the bust-log API last SUCCEEDED
      },
      lastApiError: state.lastApiError || null, // why the last API call failed, or null if it succeeded
      fatalKeyError, // true once Torn rejected the key (code 2/16) and auto-refresh was paused
      apiKey: describeApiKey(), // SOURCE and LENGTH only - never the key itself (see describeApiKey)
      // Every model tunable, so a report from an older/newer build reads correctly
      // without checking out that exact version.
      modelConstants: {
        SUCCESS_A, SUCCESS_B,
        PENALTY_PER_BUST, PENALTY_WINDOW_HOURS, PENALTY_DECAY_C, PENALTY_PCT_ANCHOR, RECENT_HISTORY_WINDOW_DAYS,
        CAL_CEILING, CAL_FLOOR, CAL_NO_PERKS, FULL_BUST_SKILL_BONUS,
        PENALTY_WEIGHT, PENALTY_SATURATION_PCT, PRED_SHRINK_K, PRED_SHRINK_CENTER, OUTCOME_MODEL_VERSION,
        SELF_CAL_MIN_SAMPLES, SELF_CAL_FLOOR, SELF_CAL_CEILING, SELF_CAL_STEP, OUTCOME_LOG_MAX,
      },
    };
  }

  // In-memory only (not persisted): the bust attempt currently "in flight" between
  // a click on a bust link and Torn's result text appearing.
  let pendingAttempt = null;

  function recordPendingAttempt(hardness, predictedChance) {
    pendingAttempt = {
      hardness,
      predictedChance,
      penaltyPct: calcPenaltyPct(getTimestampsArray()),
      // Capture the exact model inputs so a logged outcome is reconstructable later
      // (raw/shown from h+pen+lvl+cal). Stored `pred` alone isn't enough - it mixes
      // pre/post-shrink and omits lvl/cal, blocking a rigorous leave-one-out refit.
      lvl: getPlayerLevel(),
      cal: getSkillCalibration(),
      ts: Date.now(),
    };
  }

  function takePendingAttempt() {
    if (!pendingAttempt) return null;
    if (Date.now() - pendingAttempt.ts > PENDING_ATTEMPT_TIMEOUT_MS) {
      pendingAttempt = null; // stale - the click didn't lead to a result we caught in time
      return null;
    }
    const attempt = pendingAttempt;
    pendingAttempt = null;
    return attempt;
  }

  // Attribute a bust result to the last captured click, log it, and re-fit. No-ops if no
  // recent click was captured. jailed is only meaningful when success is false (stored as
  // a plain boolean regardless, so downstream never special-cases null/undefined).
  function logOutcome(success, { jailed = false } = {}) {
    const attempt = takePendingAttempt();
    if (!attempt) return;
    const state = getGlobalBustrState();
    const outcomeLog = Array.isArray(state.outcomeLog) ? state.outcomeLog.slice() : [];
    outcomeLog.push({
      h: attempt.hardness,
      pred: attempt.predictedChance,
      pen: attempt.penaltyPct,
      success,
      jailed: success ? false : jailed,
      lvl: attempt.lvl, // level + calibration used for the prediction, so raw/shown are
      cal: attempt.cal, // exactly reconstructable for a future leave-one-out recalibration
      ts: Date.now(),
      m: OUTCOME_MODEL_VERSION, // marks this pen as recorded under the corrected penalty model
    });
    while (outcomeLog.length > OUTCOME_LOG_MAX) outcomeLog.shift();

    const fittedCalibration = computeSelfCalibration(outcomeLog);
    setGlobalBustrState({ outcomeLog, selfCalibrationValue: fittedCalibration });
    CloudSync.pushSoon(); // opt-in cloud backup; no-op unless enabled + signed in (see CloudSync)

    const outcomeLabel = success ? 'success' : (jailed ? 'failure (jailed)' : 'failure (clean)');
    console.log(`[BUSTR] Self-calibration: logged ${outcomeLabel} (hardness ${attempt.hardness}, predicted ${attempt.predictedChance}%) - ${outcomeLog.length} sample(s) recorded.`);
  }

  // Drop non-genuine rows (see isRealOutcome) - heals a log that picked up synthetic rows
  // from the cloud round-trip test so they never reach stats or get pushed back. Runs once
  // at load, no-op when clean; the fit is unaffected (fittableOutcomes admits only `m` rows).
  function sanitizeOutcomeLog() {
    const state = getGlobalBustrState();
    const logArr = Array.isArray(state.outcomeLog) ? state.outcomeLog : [];
    const clean = logArr.filter(isRealOutcome);
    if (clean.length !== logArr.length) {
      setGlobalBustrState({ outcomeLog: clean, selfCalibrationValue: computeSelfCalibration(clean) });
      console.log(`[BUSTR] Removed ${logArr.length - clean.length} non-genuine outcome row(s) from the log.`);
    }
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  CLOUD SYNC (opt-in, default OFF - see COMPLIANCE NOTE, this only stores data)
  ////////////////////////////////////////////////////////////////////////////
  // Backs up state.outcomeLog to Firestore, keyed to the player's verified Torn id, so
  // bust history follows them across devices. For opted-in users it also stores a
  // snapshot of the model-relevant context (profileSnapshot): perks, level, script
  // version, effective + self calibration, PDA flag, and prediction-affecting settings -
  // the useful parts of the debug export, minus anything diagnostic/DOM/key. This lets
  // the model be tuned against real cross-user data. Read-only assistant still: it only
  // stores read-only data it already has, never the API key, and never acts in-game.
  //
  // Every call goes through GM_xmlhttpRequest to sidestep torn.com's connect-src CSP
  // (plain fetch to these hosts is blocked on-page). Works on desktop managers and recent
  // PDA (native GM_xmlhttpRequest + @connect); where absent, hasGMXhr is false and the
  // feature no-ops - gated on capability, not desktop-vs-PDA.
  //
  // The API key is sent once to the verification function, never stored in the cloud. The
  // auth SESSION (refresh token, uid, playerId) lives under CLOUD_AUTH_KEY via Store,
  // OUT of GLOBAL_BUSTR_STATE so it can never reach the debug export.

  const hasGMXhr = typeof GM_xmlhttpRequest !== 'undefined';

  function gmRequest(method, url, { headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
      if (!hasGMXhr) { reject(new Error('cloud sync needs cross-origin request support (GM_xmlhttpRequest)')); return; }
      GM_xmlhttpRequest({
        method, url, headers, data: body, timeout: 20000,
        onload: (r) => resolve({ status: r.status, text: r.responseText }),
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('request timed out')),
      });
    });
  }

  // Firestore REST typed-value (de)serialisation. Firestore's REST API wraps every
  // value in a type tag ({ integerValue: "3" } etc.), so these convert to and from it.
  function toFsValue(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === 'string') return { stringValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
    if (typeof v === 'object') {
      const fields = {};
      for (const k of Object.keys(v)) fields[k] = toFsValue(v[k]);
      return { mapValue: { fields } };
    }
    return { stringValue: String(v) };
  }
  function fromFsValue(val) {
    if (!val || typeof val !== 'object') return undefined;
    if ('nullValue' in val) return null;
    if ('booleanValue' in val) return val.booleanValue;
    if ('integerValue' in val) return Number(val.integerValue);
    if ('doubleValue' in val) return Number(val.doubleValue);
    if ('stringValue' in val) return val.stringValue;
    if ('arrayValue' in val) return ((val.arrayValue && val.arrayValue.values) || []).map(fromFsValue);
    if ('mapValue' in val) {
      const out = {};
      const f = (val.mapValue && val.mapValue.fields) || {};
      for (const k of Object.keys(f)) out[k] = fromFsValue(f[k]);
      return out;
    }
    return undefined;
  }

  const CloudSync = (() => {
    let idToken = null;      // short-lived Firebase ID token, in memory only
    let idTokenExpiry = 0;
    let auth = null;         // { refreshToken, uid, playerId } - persisted under CLOUD_AUTH_KEY
    let pushTimer = null;
    let busy = false;

    const loadAuth = () => (auth = auth || Store.get(CLOUD_AUTH_KEY) || null);
    const saveAuth = (a) => { auth = a; if (a) Store.set(CLOUD_AUTH_KEY, a); else Store.remove(CLOUD_AUTH_KEY); };
    const docUrl = (uid) => `https://firestore.googleapis.com/v1/projects/${CLOUD_PROJECT_ID}/databases/(default)/documents/busts/${uid}`;

    // Exchange the Torn key for a verified identity (our function) then a Firebase
    // session. The key touches only the verification call and is never persisted here.
    async function signIn(apiKey) {
      const r1 = await gmRequest('POST', CLOUD_FUNCTION_URL, {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey }),
      });
      const d1 = JSON.parse(r1.text || '{}');
      if (r1.status !== 200) throw new Error(d1.error || ('auth failed (' + r1.status + ')'));
      const r2 = await gmRequest('POST',
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${CLOUD_FIREBASE_API_KEY}`,
        { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: d1.token, returnSecureToken: true }) });
      const d2 = JSON.parse(r2.text || '{}');
      if (r2.status !== 200) throw new Error((d2.error && d2.error.message) || 'firebase sign-in failed');
      idToken = d2.idToken;
      idTokenExpiry = Date.now() + (Number(d2.expiresIn || 3600) - 60) * 1000;
      saveAuth({ refreshToken: d2.refreshToken, uid: d1.uid, playerId: d1.playerId });
      return auth;
    }
    async function refresh() {
      const a = loadAuth();
      if (!a || !a.refreshToken) throw new Error('not signed in');
      const r = await gmRequest('POST',
        `https://securetoken.googleapis.com/v1/token?key=${CLOUD_FIREBASE_API_KEY}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(a.refreshToken) });
      const d = JSON.parse(r.text || '{}');
      if (r.status !== 200) throw new Error((d.error && d.error.message) || 'token refresh failed');
      idToken = d.id_token;
      idTokenExpiry = Date.now() + (Number(d.expires_in || 3600) - 60) * 1000;
      if (d.refresh_token) saveAuth({ ...a, refreshToken: d.refresh_token });
    }
    async function ensureToken() {
      if (idToken && Date.now() < idTokenExpiry) return idToken;
      await refresh();
      return idToken;
    }
    // One authenticated Firestore REST call. Centralises the token fetch and Bearer
    // header that all three verbs used to repeat; pass a body only for writes.
    async function fsRequest(method, url, body) {
      const headers = { Authorization: 'Bearer ' + (await ensureToken()) };
      const opts = { headers };
      if (body != null) { headers['Content-Type'] = 'application/json'; opts.body = body; }
      return gmRequest(method, url, opts);
    }
    async function fsGet(uid) {
      const r = await fsRequest('GET', docUrl(uid));
      if (r.status === 404) return null;
      if (r.status !== 200) throw new Error('read failed (' + r.status + ')');
      const fields = (JSON.parse(r.text || '{}').fields) || {};
      return fields.log ? fromFsValue(fields.log) : [];
    }
    // Patch the given fields onto the user's doc (plus a fresh updatedAt). updateMask
    // lists exactly the fields we set, so we never clobber anything we did not send.
    async function fsPatch(uid, fields) {
      const fsFields = { updatedAt: toFsValue(Date.now()) };
      const mask = ['updatedAt'];
      for (const k of Object.keys(fields)) { fsFields[k] = toFsValue(fields[k]); mask.push(k); }
      const q = mask.map((f) => 'updateMask.fieldPaths=' + f).join('&');
      const r = await fsRequest('PATCH', docUrl(uid) + '?' + q, JSON.stringify({ fields: fsFields }));
      if (r.status !== 200) throw new Error('write failed (' + r.status + ')');
    }
    async function fsDelete(uid) {
      const r = await fsRequest('DELETE', docUrl(uid));
      if (r.status !== 200 && r.status !== 404) throw new Error('delete failed (' + r.status + ')');
    }
    // Union by timestamp, sorted, capped - so two devices converge to the same log.
    function mergeLogs(a, b) {
      const seen = new Map();
      for (const o of [...(a || []), ...(b || [])]) if (isRealOutcome(o)) seen.set(o.ts, o);
      const out = [...seen.values()].sort((x, y) => x.ts - y.ts);
      while (out.length > OUTCOME_LOG_MAX) out.shift();
      return out;
    }
    const enabled = () => !!getUserSettings().cloudSyncEnabled;
    const signedIn = () => { const a = loadAuth(); return !!(a && a.refreshToken); };

    async function pullMerge() {
      const a = loadAuth(); if (!a) return;
      const cloud = await fsGet(a.uid);
      const localLog = getGlobalBustrState().outcomeLog || [];
      const merged = mergeLogs(localLog, cloud || []);
      if (merged.length !== localLog.length) {
        setGlobalBustrState({ outcomeLog: merged, selfCalibrationValue: computeSelfCalibration(merged) });
      }
      // Only write back when the cloud is missing entries we have; when it already holds
      // everything (common on load) this is a pure read (the old code wrote every load).
      if (merged.length !== (cloud ? cloud.length : 0)) await fsPatch(a.uid, { log: merged, ...profileSnapshot() });
    }
    // Per-user context backed up alongside the log (opt-in) so the shared model can be tuned
    // against real cross-user data: perks, level, script version, effective cal, and the
    // prediction-affecting settings. Never key/name/ID/faction. Local calibration unchanged.
    function profileSnapshot() {
      const s = getGlobalBustrState();
      const us = getUserSettings();
      return {
        perks: Array.isArray(s.bustPerks) ? s.bustPerks : [],
        level: getPlayerLevel() || 0,
        sv: SCRIPT_VERSION,                 // which build produced these numbers (pre/post-shrink etc.)
        cal: getSkillCalibration(),         // effective skill calibration currently in use
        selfCalVal: (typeof s.selfCalibrationValue === 'number' ? s.selfCalibrationValue : null),
        pda: isPDA(),                       // desktop vs PDA, for segmentation
        // Full settings snapshot (all non-sensitive). Prediction-affecting fields inform the
        // model; the rest let panel usage be studied so it can be pruned on evidence.
        settings: {
          // prediction-affecting (kept under their original names for continuity):
          perkCal: !!us.usePerkCalibration,
          selfCal: !!us.selfCalibrationEnabled,
          calOverride: (typeof us.skillCalibrationOverride === 'number' ? us.skillCalibrationOverride : null),
          playStyle: us.playStyle || null,
          // budget / colour band section:
          redLimit: us.reminderLimits ? us.reminderLimits.redLimit : null,
          greenLimit: us.reminderLimits ? us.reminderLimits.greenLimit : null,
          customPenaltyThreshold: (typeof us.customPenaltyThreshold === 'number' ? us.customPenaltyThreshold : null),
          statsRefreshRate: (typeof us.statsRefreshRate === 'number' ? us.statsRefreshRate : null),
          activeScope: us.activeScope || null,
          navBadgeDetail: us.navBadgeDetail || null,
          // jail-list display section:
          showHardnessScore: !!us.showHardnessScore,
          sortByHardness: !!us.sortByHardness,
          quickBust: !!us.quickBust,
          quickBail: !!us.quickBail,
          easyBust: !!us.easyBust,
          easyBail: !!us.easyBail,
          showSuccessChance: !!us.showSuccessChance,
          successGreenAt: (typeof us.successGreenAt === 'number' ? us.successGreenAt : null),
          successRedBelow: (typeof us.successRedBelow === 'number' ? us.successRedBelow : null),
        },
      };
    }
    async function push() { const a = loadAuth(); if (a) await fsPatch(a.uid, { log: getGlobalBustrState().outcomeLog || [], ...profileSnapshot() }); }
    function pushSoon() {
      if (!enabled() || !signedIn()) return;
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(() => push().catch((e) => log('cloud push failed', e)), CLOUD_PUSH_DEBOUNCE_MS);
    }
    function initFromLoad() {
      if (!enabled() || !signedIn() || !hasGMXhr) return;
      // Every Torn navigation re-runs the script, so cap pulls to once per
      // CLOUD_PULL_MIN_INTERVAL_MS per device (a backup only needs occasional convergence).
      // New busts still push immediately via pushSoon; this only throttles pulling.
      const last = Number(Store.get(CLOUD_PULL_KEY) || 0);
      if (Date.now() - last < CLOUD_PULL_MIN_INTERVAL_MS) return;
      pullMerge().then(() => Store.set(CLOUD_PULL_KEY, Date.now()))
                 .catch((e) => log('cloud pull failed', e));
    }
    async function enable() {
      const apiKey = getApiKey();
      if (!apiKey) throw new Error('Save your API key first, then enable sync.');
      if (busy) return;
      busy = true;
      try {
        if (!signedIn()) await signIn(apiKey);
        setUserSettings({ ...getUserSettings(), cloudSyncEnabled: true });
        await pullMerge();
        await push(); // guarantee the initial snapshot (log + perks + level) lands, even if the log did not change
      } finally { busy = false; }
    }
    async function disableAndDelete() {
      setUserSettings({ ...getUserSettings(), cloudSyncEnabled: false });
      const a = loadAuth();
      try { if (a) await fsDelete(a.uid); } finally { saveAuth(null); idToken = null; idTokenExpiry = 0; }
    }
    return {
      enable, disableAndDelete, initFromLoad, pushSoon, pullMerge, signedIn, enabled,
      get playerId() { const a = loadAuth(); return a ? a.playerId : null; },
    };
  })();

  ////////////////////////////////////////////////////////////////////////////
  ////  NETWORK
  ////////////////////////////////////////////////////////////////////////////

  // Persist why an API call failed, for the settings panel and diagnostic export. Torn
  // codes matter: 2 = bad key, 16 = "access level not high enough" - the PDA one, where a
  // key without `log` fetches no history so every penalty silently reads 0 (looks like "no
  // penalty", not an error). API_KEY_CREATE_URL hands a link pre-ticking the right scopes.
  function recordApiError(what, err) {
    const code = err && typeof err.tornCode === 'number' ? err.tornCode : null;
    setGlobalBustrState({
      lastApiError: {
        what,
        code,
        message: (err && err.message) ? String(err.message) : String(err),
        at: Date.now(),
      },
    });
  }

  async function fetchBustsData(apiKey) {
    const url = `https://api.torn.com/user/?selections=log&log=5360&key=${apiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();

      if (data.error) {
        const e = new Error(`Torn API ${data.error.code}: ${data.error.error}`);
        e.tornCode = data.error.code;
        throw e;
      }
      if (!data.log) throw new Error('Unexpected API response (no log data)');
      // Stamped only once the response is known-good. Setting it before these checks let a
      // Torn error count as a successful fetch, throttling the retry and hiding a failing
      // key behind numbers that merely looked stale.
      setLastFetchTimestampMs();
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  // One-off call for level + perks (rarely change), so this runs once on load.
  async function fetchProfileData(apiKey) {
    const url = `https://api.torn.com/user/?selections=basic,perks&key=${apiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.error) {
        const e = new Error(`Torn API ${data.error.code}: ${data.error.error}`);
        e.tornCode = data.error.code;
        throw e;
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Pull every bust-mentioning perk string across all categories.
  function extractBustPerks(data) {
    const categories = [
      'job_perks', 'property_perks', 'stock_perks', 'merit_perks',
      'education_perks', 'enhancer_perks', 'faction_perks', 'book_perks',
    ];
    const found = [];
    for (const cat of categories) {
      const arr = data[cat];
      if (Array.isArray(arr)) {
        for (const perk of arr) {
          if (typeof perk === 'string' && /bust/i.test(perk)) found.push(perk);
        }
      }
    }
    return found;
  }

  // A perk mentioning "bust" means one of three things, and only OFFENSE counts toward
  // calibration: OFFENSE raises your success chance, NERVE changes cost not odds, DEFENSE
  // makes YOU harder to bust (a different stat - adding it would inflate calibration).
  // Unmatched -> 'unknown', logged so new wording can be reported and patterns tightened.
  const PERK_NERVE_PATTERNS = [/nerve/i];
  const PERK_DEFENSE_PATTERNS = [
    /harder to bust/i, /resist(ance)?.{0,15}bust/i, /bust.{0,15}resist(ance)?/i,
    /defen(c|s)e.{0,15}bust/i, /bust.{0,15}defen(c|s)e/i, /less likely.{0,20}bust/i,
    /reduce.{0,20}(chance|likelihood).{0,15}bust/i,
  ];
  const PERK_OFFENSE_PATTERNS = [
    /bust success/i, /busting skill/i, /bust skill/i, /easier to bust/i,
  ];
  function classifyPerk(perk) {
    if (PERK_NERVE_PATTERNS.some((re) => re.test(perk))) return 'nerve';
    if (PERK_DEFENSE_PATTERNS.some((re) => re.test(perk))) return 'defense';
    if (PERK_OFFENSE_PATTERNS.some((re) => re.test(perk))) return 'offense';
    return 'unknown';
  }

  // Sum the bust bonus % from detected perks. Only 'offense' perks count.
  function sumBustSkillBonus(perkStrings) {
    let bonus = 0;
    for (const perk of perkStrings) {
      if (classifyPerk(perk) !== 'offense') continue;
      const m = perk.match(/([\d.]+)\s*%/);
      if (m) bonus += parseFloat(m[1]);
    }
    return bonus; // e.g. 115 for faction 50 + education 65
  }

  // 'unknown' perks - surfaced so unfamiliar wording can be reported rather than mis-summed.
  function unclassifiedBustPerks(perkStrings) {
    return perkStrings.filter((p) => classifyPerk(p) === 'unknown');
  }

  // Scale the detected bonus against the full-stack 115% the constants were fit on.
  // No bust perks -> conservative fallback.
  function calibrationFromPerks(perkStrings) {
    if (!Array.isArray(perkStrings) || perkStrings.length === 0) return CAL_NO_PERKS;
    const bonus = sumBustSkillBonus(perkStrings);
    const cal = (100 + bonus) / (100 + FULL_BUST_SKILL_BONUS);
    return Math.max(CAL_FLOOR, Math.min(CAL_CEILING, cal));
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  RENDER HELPERS
  ////////////////////////////////////////////////////////////////////////////

  function renderHardnessScore(playerEl, hardnessScore) {
    const el = playerEl.querySelector('.bustr-hardness-score');
    if (el) el.textContent = hardnessScore;
  }

  function renderSuccessChance(playerEl, chance) {
    const el = playerEl.querySelector('.bustr-success-chance');
    if (!el) return;
    const { greenAt, redBelow } = getEffectiveSuccessThresholds();
    el.textContent = chance + '%';
    el.classList.remove('bustr-sc--green', 'bustr-sc--orange', 'bustr-sc--red');
    if (chance >= greenAt) el.classList.add('bustr-sc--green');
    else if (chance < redBelow) el.classList.add('bustr-sc--red');
    else el.classList.add('bustr-sc--orange');
  }

  function sortByHardnessScore(playerEl, hardnessScore) {
    playerEl.style.order = hardnessScore;
  }
  function clearSortOrder(playerEl) {
    playerEl.style.order = '';
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  CALLBACKS
  ////////////////////////////////////////////////////////////////////////////

  const API_KEY_REGEX = /^[A-Za-z0-9]{16,}$/;

  function submitFormCallback() {
    const inputEl = document.querySelector('#bustr-form__input');
    const submitBtnEl = document.querySelector('#bustr-form__submit');
    if (!inputEl || !submitBtnEl) return;

    const apiKey = inputEl.value.trim();
    if (!API_KEY_REGEX.test(apiKey)) {
      inputEl.style.border = `2px solid ${redFlame}`;
      submitBtnEl.disabled = true;
      return;
    }
    setApiKey(apiKey);
    dismountBustrForm();
    window.location.reload();
  }

  function inputValidatorCallback(event) {
    const inputEl = document.querySelector('#bustr-form__input');
    const submitBtnEl = document.querySelector('#bustr-form__submit');
    if (!inputEl || !submitBtnEl) return;

    if (API_KEY_REGEX.test(event.target.value.trim())) {
      submitBtnEl.disabled = false;
      inputEl.style.border = '1px solid #444';
    } else {
      submitBtnEl.disabled = true;
    }
  }

  // Wording for a failed bust attempt isn't documented anywhere, so these lists
  // are a best guess covering phrasings Torn is known to use elsewhere. If
  // self-calibration outcomes look wrong, find the actual message text in the console and
  // report it - a wrong pattern just leaves that failure unlogged, nothing breaks.
  //
  // Three bust outcomes: success, clean fail (no penalty), and jailed (you get caught).
  // Both fails count the same for calibration but are logged separately - jailed failures
  // are what BUSTR exists to avoid. Jailed is checked first (more specific) in case a
  // message contains both "failed" and "jailed" wording.
  const FAILURE_JAILED_PATTERNS = [
    /you (have been|were) (caught|arrested|jailed|sent to jail)/i,
  ];
  const FAILURE_CLEAN_PATTERNS = [
    /you (have )?failed to bust/i,
    /unsuccessful bust/i,
  ];

  async function successfulBustMutationCallback(mutationList, observer) {
    try {
      for (const mutation of mutationList) {
        // Skip empty nodes with continue, not return (a `return` here once aborted the
        // whole batch, missing busts). textContent not innerText: this fires on every DOM
        // mutation site-wide, and innerText forces a layout reflow each read. trim()
        // compensates for the anchored regex, since textContent doesn't collapse whitespace.
        const text = (mutation.target.textContent || '').trim();
        if (!text) continue;

        if (text.match(/^(You busted ).+/) && mutation.removedNodes.length > 0) {
          observer.disconnect();
          log('SuccessfulBust', Date.now());

          // Instant local feedback
          setPenaltyScore(getPenaltyScore() + PENALTY_PER_BUST);
          setAvailableBusts(calcAvailableBusts(getPenaltyScore(), getPenaltyThreshold()));
          renderBustrStats({ availableBusts: getAvailableBusts(), penaltyScore: getPenaltyScore() });
          renderBustrColorClass(getAvailableBusts());

          successfulBustUpdateController();
          logOutcome(true); // self-calibration: attribute to whatever bust link was last clicked

          // Then resync to ground truth shortly after, once Torn's ~30s cache has
          // cleared, so any earlier missed bust gets corrected instead of drifting.
          scheduleGroundTruthResync();
        } else if (mutation.removedNodes.length > 0 && FAILURE_JAILED_PATTERNS.some((re) => re.test(text))) {
          log('FailedBust (jailed)', text);
          logOutcome(false, { jailed: true }); // self-calibration only; doesn't touch the penalty budget here
        } else if (mutation.removedNodes.length > 0 && FAILURE_CLEAN_PATTERNS.some((re) => re.test(text))) {
          log('FailedBust (clean)', text);
          logOutcome(false, { jailed: false });
        }
      }
    } catch (err) {
      console.error('[BUSTR]', err);
    }
  }

  function hardnessScoreCallback(mutationList, observer) {
    for (const mutation of mutationList) {
      if (mutation.target.classList.contains('user-info-list-wrap') && mutation.addedNodes.length > 1) {
        hardnessScoreController();
        observer.disconnect();
      }
    }
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  OBSERVERS (single managed instance each)
  ////////////////////////////////////////////////////////////////////////////

  let jailObserver = null;
  function createJailMutationObserver() {
    if (jailObserver) jailObserver.disconnect();
    jailObserver = new MutationObserver(successfulBustMutationCallback);
    jailObserver.observe(document, { attributes: false, childList: true, subtree: true });
  }

  // Arm the bust-detection observer ONLY on the jail page. It watches the whole document
  // subtree on every mutation site-wide, so off the jail page it is pure overhead (and on
  // churn-heavy pages like the item market it fired continuously). Arming it everywhere at
  // bootstrap was behind the "still fully operating on every page" and item-market issues.
  function ensureBustObserver(onJail) {
    if (onJail) {
      if (!jailObserver) createJailMutationObserver();
    } else if (jailObserver) {
      jailObserver.disconnect();
      jailObserver = null;
    }
  }

  let hardnessObserver = null;
  function createHardnessScoreObserver() {
    if (hardnessObserver) hardnessObserver.disconnect();
    hardnessObserver = new MutationObserver(hardnessScoreCallback);
    hardnessObserver.observe(document, { attributes: false, childList: true, subtree: true });
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  PASSIVE CLICK OBSERVER (self-calibration input capture)
  ////////////////////////////////////////////////////////////////////////////
  // Read-only: records which row's "Bust" link the player clicked, never
  // triggers, simulates, or modifies the click itself. See COMPLIANCE NOTE.

  let bustClickListenerAttached = false;

  function handleJailClick(event) {
    try {
      if (window.location.pathname !== '/jailview.php') return;
      if (!getUserSettings().selfCalibrationEnabled) return;
      const targetEl = event.target;
      if (!targetEl || typeof targetEl.closest !== 'function') return;

      const clickable = targetEl.closest('a, button');
      if (!clickable) return;
      const label = (clickable.textContent || clickable.title || clickable.getAttribute('aria-label') || '').trim();
      if (!/bust/i.test(label)) return; // not the bust action (e.g. profile/faction links in the same row)

      const li = clickable.closest('li');
      if (!li || !li.parentElement || !li.parentElement.classList.contains('user-info-list-wrap')) return;

      const hardnessEl = li.querySelector('.bustr-hardness-score');
      if (!hardnessEl) return;
      const hardness = parseInt(hardnessEl.textContent, 10);
      if (!Number.isFinite(hardness)) return;

      const successEl = li.querySelector('.bustr-success-chance');
      const predictedRaw = successEl ? parseInt(successEl.textContent, 10) : NaN;
      const predicted = Number.isFinite(predictedRaw) ? predictedRaw : null;

      recordPendingAttempt(hardness, predicted);
      log('Bust click captured for self-calibration', { hardness, predicted });
    } catch (err) {
      console.error('[BUSTR]', err);
    }
  }

  // Capture-phase passive listener - never preventDefault/stopPropagation, so it can't
  // interfere with the real bust click.
  function attachBustClickListener() {
    if (bustClickListenerAttached) return;
    document.addEventListener('click', handleJailClick, true);
    bustClickListenerAttached = true;
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  VIEW: STYLESHEET
  ////////////////////////////////////////////////////////////////////////////

  const bustrStylesheetHTML = `<style>
.bustr--green {--color: ${greenApple}}
.bustr--orange {--color: ${orangeFulvous}}
.bustr--red {--color: ${redFlame}}
.dark-mode.bustr--green,
.bustr--green .swiper-slide {--color: ${greenApple}}
.dark-mode.bustr--orange,
.bustr--orange .swiper-slide {--color: ${orangeAmber}}
.dark-mode.bustr--red,
.bustr--red .swiper-slide {--color: ${redMelon}}

#bustr-form.header-wrapper-top {display: flex;}
#bustr-form.header-wrapper-top .container {display: flex; justify-content: start; align-items: center; padding-left: 20px;}
#bustr-form.header-wrapper-top h2 {display: block; text-align: center; margin: 0; width: 172px;}
#bustr-form.header-wrapper-top input {
  background: linear-gradient(0deg,#111,#000);
  border-radius: 5px;
  box-shadow: 0 1px 0 hsla(0,0%,100%,.102);
  box-sizing: border-box;
  color: #9f9f9f;
  display: inline;
  font-weight: 400;
  height: 24px;
  width: clamp(170px, 50%, 250px);
  margin: 0 0 0 21px;
  outline: none;
  padding: 0 10px 0 10px;
  font-size: 12px;
  font-style: italic;
  vertical-align: middle;
  border: 0;
  text-shadow: none;
  z-index: 100;
}
#bustr-form.header-wrapper-top a {margin: 0 8px;}

/* Colour comes from --color (renderBustrColorClass sets a body class). On PDA the badge
   lives in BUSTR's own nav column, not #nav-jail, so it's listed here too or its numbers
   stay uncoloured. (No backticks in this comment: the stylesheet is a template literal.) */
#nav-jail .bustr-stats,
#bustr-sidebar-btn .bustr-stats,
#bustr-context .bustr-stats {color: var(--color, inherit);}
#nav-jail .bustr-stats span {margin-left: unset;}
.bustr-pct-line {display: block; font-size: 0.78em; line-height: 1.2; opacity: 0.85;}
/* Desktop nav badge has width to spare: count and % on one line. Mobile/PDA and the
   tap-detail popup keep the stacked layout - this is scoped to the desktop nav link. */
#nav-jail a .bustr-stats {white-space: nowrap;}
#nav-jail a .bustr-stats .bustr-pct-line {display: inline; margin-left: 6px; font-size: 0.85em;}

/* PDA/mobile count badge, in one of two places:
   1. Inside BUSTR's own nav column (normal): laid out entirely by us, with explicit sizes
      and all inherited positioning neutralised. Torn's mobileAmount class positions it
      absolutely (fine for one digit, but ours is two rows - out of flow it covered the
      BUSTR label and hid the %), and carries unpredictable font sizing, hence px below.
   2. Still in #nav-jail if the column couldn't be created (findMobileNavCell declines):
      left alone, so Torn's own positioning applies.
   nowrap on the % line: the slot is narrow and .bustr-pct-line is a flex item here, so
   without it the "%" wraps onto its own line. */
#bustr-sidebar-btn .bustr-col-inner {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  position: relative; overflow: visible; height: auto; min-height: 0;
}
/* EVERY direct child forced into normal flow, not just the badge: any one positioned
   child makes the flex stack overlap, and there are two candidates (Torn's mobileAmount
   badge and its mobileLink___* nav link). Overriding only the badge (v2.9.3/v2.9.4) let
   the link cover the %. The whole column is our clone, so nothing needs to be out of flow. */
#bustr-sidebar-btn .bustr-col-inner > * {
  position: static !important; top: auto; right: auto; bottom: auto; left: auto;
  transform: none; margin: 0; float: none;
}
/* Small on purpose: the badge shares one nav slot with the BUSTR label (~two short lines).
   px not em, so nothing unexpected inherits from Torn's nav styling. */
#bustr-sidebar-btn .bustr-mobile-badge {
  width: auto; height: auto; min-width: 0; max-width: none; padding: 0;
  display: flex; flex-direction: column; align-items: center; flex: 0 0 auto;
  line-height: 1; white-space: nowrap; font-size: 9px; font-weight: 700;
}
#bustr-sidebar-btn .bustr-mobile-badge .bustr-pct-line {
  display: block; font-size: 8px; font-weight: 400; opacity: 0.9; white-space: nowrap;
}
/* Fallback form, badge still in #nav-jail: keep it to one compact line. */
.bustr-mobile-badge .bustr-pct-line {display: block; font-size: 0.75em; opacity: 0.85; white-space: nowrap;}

/* "Jail page only" scope: hide the badge and neutralize colouring off the jail page,
   toggled purely via body class (no DOM changes). The BUSTR nav column / sidebar entry
   itself stays (it's the settings trigger, reachable everywhere - same as desktop), only
   the numbers/colours go.
   The mobile/PDA badge lives inside BUSTR's own nav column (#bustr-sidebar-btn), whose
   "#bustr-sidebar-btn .bustr-mobile-badge" display rule is an ID selector and so OUTRANKS a
   plain ".bustr-stats" hide - so on PDA the badge stayed visible off the jail page and
   jail-only "didn't work" (worked on desktop, where the badge sits in #nav-jail with no
   competing display rule). Match that ID specificity for both slots the badge can occupy
   (own column, or the #nav-jail fallback) and add !important so the hide always wins. */
body.bustr-inactive .bustr-stats,
body.bustr-inactive #bustr-sidebar-btn .bustr-mobile-badge,
body.bustr-inactive #nav-jail .bustr-mobile-badge {display: none !important;}
body.bustr-inactive.bustr--green,
body.bustr-inactive.bustr--orange,
body.bustr-inactive.bustr--red {--color: inherit;}

#bustr-context.contextMenu___bjhoL {display: none; left: unset; right: -92px; padding: 0 8px; z-index: 9999;}
.contextMenuActive___e6i_B #bustr-context.contextMenu___bjhoL {display: flex;}
#bustr-context.contextMenu___bjhoL .arrow___tKP13 {right: unset; left: -6px; border-width: 8px 6px 8px 0; border-color: transparent #444 transparent transparent;}
#bustr-context.contextMenu___bjhoL .arrow___tKP13 {border-color: transparent #373636 transparent transparent; border-width: 6px 5px 6px 0; content: ""; left: unset; right: -6px; top: -6px;}

#prefs-tab-menu #bustr-settings {display: none;}
#prefs-tab-menu #bustr-settings.active {display: block;}
#bustr-settings input[type="number"] {height: 24px; width: 48px; padding: 1px 5px; text-align: center;}

#bustr-settings-dropdown {background: #fff;}
.dark-mode #prefs-tab-menu #bustr-settings-dropdown {background: #444;}
#prefs-tab-menu #bustr-settings-sidetab.active {background: #fff; color: #999}
.dark-mode #prefs-tab-menu #bustr-settings-sidetab.active {background: #444; color: #999}

#body .users-list-title {display: flex; justify-content: start; align-items: center;}
#body .users-list-title .title{width: 269px;}
#body .users-list-title .time{width: 50px;}
#body .users-list-title .level{width: 53px;}
#body .users-list-title .reason{width: 205px;}
#body .users-list-title .hardness{display: block; width: 79px; text-align: center;}

#body .user-info-list-wrap > li .info-wrap .hardness {display: block; text-align: center;}
#body .user-info-list-wrap > li .info-wrap .hardness span.title {display: none;}

.bustr-success-chance {display: block; font-weight: 700; font-size: 11px; line-height: 1.1;}
.bustr-success-chance.bustr-sc--green {color: ${greenApple};}
.bustr-success-chance.bustr-sc--orange {color: ${orangeAmber};}
.bustr-success-chance.bustr-sc--red {color: ${redMelon};}

body.bustr-no-hardness .bustr-hardness-score {display: none;}
body.bustr-no-success .bustr-success-chance {display: none;}

/* Compact nav badge: show only the "busts left" count, hide the penalty prefix and %
   line. The mobile tap-detail menu keeps the full readout (#bustr-context, no detail class). */
body.bustr-badge-simple .bustr-badge-detail {display: none;}

/* Penalty % colour by severity (inverse of the success-chance colours). */
.bustr-pct-line.bustr-pen--green {color: ${greenApple}; opacity: 1;}
.bustr-pct-line.bustr-pen--orange {color: ${orangeAmber}; opacity: 1;}
.bustr-pct-line.bustr-pen--red {color: ${redMelon}; opacity: 1;}
/* Over 100%: heavier, brighter red + glow so it reads as clearly more serious. */
.bustr-pct-line.bustr-pen--critical {color: #ff2d2d; opacity: 1; font-weight: 800; text-shadow: 0 0 5px rgba(255, 45, 45, 0.55);}

/* Quick bust/bail indication (opt-in): green button highlight + icon hue shift. */
.user-info-list-wrap > li a.bustr-quick-on {
  box-shadow: 0 0 0 1px #8ca05a inset; border-radius: 4px;
}
.user-info-list-wrap > li a.bustr-quick-on .bust-icon,
.user-info-list-wrap > li a.bustr-quick-on .bail-icon {filter: hue-rotate(55deg) saturate(1.3);}

/* Jail-list-header refresh control. (Base values are for LIGHT theme; .dark-mode below
   restores dark-tuned colours.) */
.bustr-easy-bar .bustr-jail-refresh {
  cursor: pointer; color: #6f8340; font-size: 16px; line-height: 1;
  user-select: none; transition: transform 0.2s ease; vertical-align: middle;
}
.bustr-easy-bar .bustr-jail-refresh:hover {transform: rotate(90deg); color: #4b5c28;}

/* Easy Bust / Easy Bail action bar (opt-in; one request per tap). Its own full-width bar
   under the jail filter, so buttons have room and don't wrap into the header's icon columns. */
.bustr-easy-bar {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
  padding: 6px 12px; margin: 0;
  background: rgba(0, 0, 0, 0.06); border-bottom: 1px solid rgba(0, 0, 0, 0.14);
}
.bustr-easy-bar .bustr-easy-label {
  font-size: 10px; font-weight: 800; letter-spacing: 0.5px;
  color: #5a6b34; text-transform: uppercase;
}
.bustr-easy-btn {
  cursor: pointer; font-size: 12px; font-weight: 700; white-space: nowrap;
  color: #14180c; background: #8ca05a; border: 1px solid #6f8340; border-radius: 5px;
  padding: 4px 12px; user-select: none; line-height: 1.2; transition: background 0.12s ease;
}
.bustr-easy-btn:hover {background: #b6cc7a;}
.bustr-easy-btn:active {background: #7a9049;}
.bustr-easy-btn.bustr-easy-busy {opacity: 0.5; pointer-events: none;}
.bustr-easy-btn.bustr-easy-bail {background: #c9a84a; border-color: #a2842f;}
.bustr-easy-btn.bustr-easy-bail:hover {background: #dcbf63;}
/* Quick Bust / Quick Bail toggle pills: OFF (outlined) or ON (green fill), flipping the
   opt-in link-relabel mode. Unlike the Easy buttons these fire nothing - they only relabel
   your OWN bust/bail link so your single click skips Torn's confirm step. */
.bustr-easy-bar .bustr-quick-toggle {
  cursor: pointer; font-size: 12px; font-weight: 700; white-space: nowrap;
  color: #566b30; background: transparent; border: 1px solid #a9bd82; border-radius: 5px;
  padding: 3px 10px; user-select: none; line-height: 1.2;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}
.bustr-easy-bar .bustr-quick-toggle:hover {border-color: #6f8340; color: #3f4f22;}
.bustr-easy-bar .bustr-quick-toggle.bustr-on {
  color: #dcecb4; background: #4b5738; border-color: #8ca05a;
  box-shadow: 0 0 0 1px #8ca05a inset;
}
.bustr-easy-bar .bustr-quick-toggle::before {
  content: '\\2610'; margin-right: 5px; font-weight: 400; opacity: 0.8;
}
.bustr-easy-bar .bustr-quick-toggle.bustr-on::before {content: '\\2611'; opacity: 1;}
.bustr-easy-status {
  font-size: 11px; color: #4b5738; margin-left: auto;
  max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.user-info-list-wrap > li.bustr-easy-done {opacity: 0.5;}

/* Dark theme: only the translucent fill and text need swapping - the solid pills, Easy
   buttons and "?" chip already read well on either background. */
.dark-mode .bustr-easy-bar {
  background: rgba(0, 0, 0, 0.22); border-bottom-color: rgba(0, 0, 0, 0.35);
}
.dark-mode .bustr-easy-bar .bustr-easy-label {color: #8ca05a;}
.dark-mode .bustr-easy-bar .bustr-jail-refresh {color: #8ca05a;}
.dark-mode .bustr-easy-bar .bustr-jail-refresh:hover {color: #b6cc7a;}
.dark-mode .bustr-easy-bar .bustr-quick-toggle:not(.bustr-on) {color: #9aa87d; border-color: #4b5738;}
.dark-mode .bustr-easy-bar .bustr-quick-toggle:not(.bustr-on):hover {color: #c2d69a; border-color: #6f8340;}
.dark-mode .bustr-easy-status {color: #cfe0a0;}

/* Settings button + panel */
/* Sidebar entry (primary): a clone of a native #nav-jail row, so text colour/font/weight
   inherit and match sibling rows (findByClassPrefix in the JS swaps only label/icon). The
   background IS set explicitly (rows don't reliably show one at rest), plus a border/shadow
   reset as defense in depth against a stray state-highlight class (the JS strips /^active/i). */
#bustr-sidebar-btn,
#bustr-sidebar-btn * {
  border: none !important;
  box-shadow: none !important;
}
#bustr-sidebar-btn {
  cursor: pointer;
  background: rgba(140, 168, 90, 0.14) !important;
  border-radius: 4px;
}
#bustr-sidebar-btn:hover {
  background: rgba(140, 168, 90, 0.24) !important;
}
#bustr-sidebar-btn .bustr-icon { flex-shrink: 0; }
/* Dim backdrop behind the centered panel */
#bustr-settings-backdrop {
  position: fixed; inset: 0; z-index: 99999; background: rgba(0,0,0,0.45); display: none;
}
#bustr-settings-backdrop.bustr-open {display: block;}
/* Cloud-sync consent modal. Above the settings panel; centred; the only way past it
   is Cancel or Enable, so nothing signs in without a deliberate choice. */
.bustr-consent-backdrop {
  position: fixed; inset: 0; z-index: 100002; background: rgba(0,0,0,0.6);
  display: flex; align-items: center; justify-content: center; padding: 16px;
}
.bustr-consent-card {
  max-width: 340px; background: #2b2b2b; color: #ddd; border: 1px solid #111;
  border-radius: 8px; box-shadow: 0 10px 32px rgba(0,0,0,0.7); padding: 16px 18px;
  font-size: 12px; line-height: 1.5;
}
.bustr-consent-card h3 {margin: 0 0 8px; font-size: 14px; color: #8ca05a;}
.bustr-consent-card p {margin: 0 0 14px;}
.bustr-consent-actions {display: flex; gap: 8px; justify-content: flex-end;}
.bustr-consent-actions .bustr-btn {flex: 0 0 auto;}
#bustr-consent-ok {background: rgba(140, 168, 90, 0.35);}
/* API failure notice. Deliberately loud: the alternative symptom is a 0% penalty, which
   reads as "clear to bust" when the truth is "unknown". */
.bustr-apierror {
  margin: 6px 0; padding: 6px 8px; border-radius: 4px; font-size: 11px; line-height: 1.35;
  background: rgba(200, 70, 70, 0.16); color: ${redMelon};
}
#bustr-settings-panel {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 100000;
  width: 280px; max-height: 84vh; overflow-y: auto;
  background: #2b2b2b; color: #ccc; border: 1px solid #111; border-radius: 8px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.7); padding: 12px 14px;
  font-size: 12px; display: none;
}
#bustr-settings-panel.bustr-open {display: block;}
#bustr-settings-panel h3 {margin: 0 0 4px; font-size: 13px; color: #fff; font-weight: 700;
  display: flex; justify-content: space-between; align-items: center;}
#bustr-settings-panel h3 .bustr-close {cursor: pointer; color: #999; font-size: 16px; line-height: 1;}
#bustr-settings-panel h3 .bustr-close:hover {color: #fff;}
#bustr-settings-panel .bustr-status {color: #8ca05a; font-size: 10px; margin: 0 0 8px;}
#bustr-settings-panel .bustr-row {display: flex; align-items: center; justify-content: space-between; margin: 8px 0; gap: 8px;}
#bustr-settings-panel .bustr-row label {flex: 1; color: #bbb;}
#bustr-settings-panel input[type="number"] {width: 58px; height: 24px; padding: 1px 6px; text-align: center;
  background: #1a1a1a; color: #ddd; border: 1px solid #444; border-radius: 4px;}
#bustr-settings-panel input[type="checkbox"] {width: 16px; height: 16px;}
#bustr-settings-panel select {height: 24px; padding: 1px 4px; background: #1a1a1a; color: #ddd;
  border: 1px solid #444; border-radius: 4px; font-size: 11px;}
#bustr-settings-panel .bustr-hint {color: #888; font-size: 10px; margin: 2px 0 8px;}
#bustr-settings-panel .bustr-section {color: #8ca05a; font-size: 11px; font-weight: bold;
  text-transform: uppercase; letter-spacing: 0.03em; margin: 2px 0 6px;}
#bustr-settings-panel hr {border: 0; border-top: 1px solid #3c3c3c; margin: 10px 0;}
#bustr-settings-panel .bustr-btn {
  display: block; width: 100%; margin: 6px 0 0; padding: 6px; cursor: pointer;
  background: #4b5738; color: #fff; border: 1px solid #2c331f; border-radius: 4px; font-size: 11px;
}
#bustr-settings-panel .bustr-btn.bustr-danger {background: #5a2d2d; border-color: #3c1f1f;}

/* Help system: explanations live behind these chips and open in one shared card, instead
   of sitting inline as permanent small print. */
#bustr-settings-panel .bustr-q,
.bustr-easy-bar .bustr-q {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; margin-left: 5px; border-radius: 50%;
  background: #4b5738; color: #fff; font-size: 9px; font-weight: 700;
  cursor: pointer; user-select: none; flex: 0 0 auto; vertical-align: middle;
}
#bustr-settings-panel .bustr-q:hover,
.bustr-easy-bar .bustr-q:hover {background: #6b7d50;}
/* Chips beside a button, never inside one - a nested chip fires the button when tapped. */
#bustr-settings-panel .bustr-btn-row {display: flex; align-items: center; gap: 7px;}
#bustr-settings-panel .bustr-btn-row .bustr-btn {flex: 1;}
/* Key-creation control is an <a>, not a <button>, so restate the centring links lack. */
#bustr-settings-panel .bustr-btn-link {display: block; text-align: center; text-decoration: none;}
#bustr-settings-panel .bustr-q.bustr-q-on,
.bustr-easy-bar .bustr-q.bustr-q-on {background: #8ca05a; color: #1a1a1a;}
/* Sits to the RIGHT of the centred 280px panel: half is 140px, so 152px clears it. */
#bustr-help {
  position: fixed; z-index: 100001; display: none;
  top: 50%; left: calc(50% + 152px); transform: translateY(-50%);
  width: 250px; max-height: 70vh; overflow-y: auto;
  -webkit-overflow-scrolling: touch; overscroll-behavior: contain;
  background: #333; color: #ddd; border: 1px solid #111; border-radius: 8px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.7); padding: 0 12px 12px;
  font-size: 11px; line-height: 1.45;
}
#bustr-help.bustr-open {display: block;}
/* Header sticks to the top so the close button stays reachable however far the help text
   scrolls (long text was undismissable before). Its background covers the text underneath,
   and the negative margins let it span the card's padding. */
#bustr-help h4 {position: sticky; top: 0; background: #333; z-index: 1;
  margin: 0 -12px 5px; padding: 10px 12px 6px; font-size: 11px; color: #8ca05a;
  text-transform: uppercase; letter-spacing: 0.03em;
  display: flex; justify-content: space-between; align-items: center;}
#bustr-help h4 .bustr-help-close {cursor: pointer; color: #999; font-size: 20px; line-height: 1;
  padding: 0 4px; margin: -4px -4px -4px 8px;}
#bustr-help h4 .bustr-help-close:hover {color: #fff;}
/* No room beside the panel on phone/PDA. Centre it, don't bottom-dock: a bottom card sat
   under the mobile browser's dynamic toolbar, hiding its lower half (Firefox Android).
   Centred it can't be clipped and scrolls internally. */
@media (max-width: 780px) {
  #bustr-help {
    top: 50%; bottom: auto; left: 50%; transform: translate(-50%, -50%);
    width: min(88vw, 320px); max-height: 75vh;
  }
}


#body .user-info-list-wrap {display: flex; flex-direction: column; justify-content: start; align-items: center;}
#body .user-info-list-wrap > li {display: flex; flex-wrap: wrap; justify-content: start; align-items: center;}

#body .user-info-list-wrap > li .info-wrap {display: flex; flex-wrap: wrap; justify-content: start; align-items: center;}
#body .user-info-list-wrap > li .info-wrap .time {width: 54px;}
#body .user-info-list-wrap > li .info-wrap .level {width: 57px;}
#body .user-info-list-wrap > li .info-wrap .reason {width: 193px;}
#body .user-info-list-wrap > li .info-wrap .hardness {width: 50px;}

@media screen and (max-width:1000px) {
  #bustr-form.header-wrapper-top h2 {width: 148px;}
  #bustr-form.header-wrapper-top input {margin-left: 10px;}
}
@media screen and (max-width:784px) {
  #bustr-form.header-wrapper-top h2 {font-size: 16px; width: 80px;}
  #body .users-list-title .hardness{display: none;}
  #body .user-info-list-wrap > li .info-wrap .hardness span.title{display: block;}
  #body .user-info-list-wrap > li .info-wrap .reason {width: 164px; border-right: 1px solid rgb(34, 34, 34);}
  #body .user-info-list-wrap > li .info-wrap .hardness {width: 64px;}
}
@media screen and (max-width:386px) {
  #body .user-info-list-wrap > li .info-wrap .time {width: 98px; height: 37px;}
  #body .user-info-list-wrap > li .info-wrap .level {width: 91px; height: 37px;}
  #body .user-info-list-wrap > li .info-wrap .reason {width: 171px; height: 24px; border-right: 1px solid rgb(34, 34, 34);}
  #body .user-info-list-wrap > li .info-wrap .hardness {width: 107px;}
}
</style>`;

  function renderBustrStylesheet() {
    const headEl = document.querySelector('head');
    if (headEl) headEl.insertAdjacentHTML('beforeend', bustrStylesheetHTML);
  }

  function renderBustrColorClass(availableBusts) {
    const { redLimit, greenLimit } = getEffectiveReminderLimits();

    if (+availableBusts <= redLimit) {
      if (document.body.classList.contains('bustr--red')) return;
      document.body.classList.add('bustr--red');
      document.body.classList.remove('available___ZS04X', 'bustr--green', 'bustr--orange');
      return;
    }
    if (+availableBusts >= greenLimit) {
      if (document.body.classList.contains('bustr--green')) return;
      document.body.classList.add('available___ZS04X', 'bustr--green');
      document.body.classList.remove('bustr--orange', 'bustr--red');
      return;
    }
    if (availableBusts > redLimit && availableBusts < greenLimit) {
      if (document.body.classList.contains('bustr--orange')) return;
      document.body.classList.add('bustr--orange');
      document.body.classList.remove('available___ZS04X', 'bustr--green', 'bustr--red');
    }
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  VIEW: FORM
  ////////////////////////////////////////////////////////////////////////////

  function renderBustrForm() {
    const topHeaderBannerEl = document.querySelector('#topHeaderBanner');
    if (!topHeaderBannerEl) return;
    const bustrFormHTML = `
      <div id="bustr-form" class="header-wrapper-top">
        <div class="container clear-fix">
          <h2>Bustr API</h2>
          <input
            id="bustr-form__input"
            type="text"
            placeholder="Enter a full-acces API key..."
            autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
            data-lpignore="true" data-1p-ignore data-bwignore data-form-type="other"
          />
          <a href="#" id="bustr-form__submit" type="btn" disabled><span class="link-text">Submit</span></a>
        </div>
      </div>`;
    topHeaderBannerEl.insertAdjacentHTML('afterbegin', bustrFormHTML);
  }

  function dismountBustrForm() {
    const formEl = document.querySelector('#bustr-form');
    if (formEl) formEl.remove();
  }

  function renderBustrStats(statsObj) {
    for (const [key, value] of Object.entries(statsObj)) {
      const statsElArr = [...document.querySelectorAll(`.bustr-stats__${key}`)];
      statsElArr.forEach((el) => (el.textContent = value));
    }
    // Compact mode hides the score/threshold prefix; keep the full breakdown in the
    // title tooltip so nothing is lost.
    const { penaltyScore, penaltyThreshold, availableBusts, penaltyPct } = statsObj;
    if (availableBusts !== undefined) {
      const title = `Busts you can still safely make: ${availableBusts}`
        + (penaltyScore !== undefined && penaltyThreshold !== undefined ? `\nPenalty score: ${penaltyScore} / ${penaltyThreshold}` : '')
        + (penaltyPct !== undefined ? `\nPenalty: ${penaltyPct}%` : '');
      document.querySelectorAll('.bustr-stats').forEach((el) => (el.title = title));
    }
    // Penalty % coloured by severity, INVERSE of success-chance colours: low is green,
    // up through amber to red, and over 100% gets a heavier "critical" red.
    if (penaltyPct !== undefined) {
      const cls = penaltyPct > 100 ? 'bustr-pen--critical'
        : penaltyPct >= PEN_RED_AT ? 'bustr-pen--red'
        : penaltyPct >= PEN_ORANGE_AT ? 'bustr-pen--orange'
        : 'bustr-pen--green';
      document.querySelectorAll('.bustr-pct-line').forEach((el) => {
        el.classList.remove('bustr-pen--green', 'bustr-pen--orange', 'bustr-pen--red', 'bustr-pen--critical');
        el.classList.add(cls);
      });
    }
  }

  async function requireElement(selectors) {
    try {
      await new Promise((res, rej) => {
        if (document.querySelector(selectors)) return res();

        const maxCycles = 100; // 100 * 50ms = same ~5s timeout as before, 5x fewer queries
        let current = 1;
        const interval = setInterval(() => {
          if (document.querySelector(selectors)) {
            clearInterval(interval);
            res();
          }
          if (current === maxCycles) {
            clearInterval(interval);
            rej('Timeout: Could not find element');
          }
          current++;
        }, 50);
      });
    } catch (err) {
      console.error('[BUSTR]', err);
    }
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  VIEW: DESKTOP
  ////////////////////////////////////////////////////////////////////////////

  async function renderBustrDesktopView() {
    try {
      await requireElement('#nav-jail a');
      const jailLinkEl = document.querySelector('#nav-jail a');
      if (!jailLinkEl || jailLinkEl.querySelector('.bustr-stats')) return;

      const statsHTML = `
        <span class="amount___p8QZX bustr-stats">
          <span class="bustr-badge-detail"><span class="bustr-stats__penaltyScore">#</span> / <span class="bustr-stats__penaltyThreshold">#</span> : </span><span class="bustr-stats__availableBusts">#</span>
          <span class="bustr-pct-line"><span class="bustr-stats__penaltyPct">#</span>%</span>
        </span>`;
      jailLinkEl.insertAdjacentHTML('beforeend', statsHTML);
    } catch (err) {
      console.error('[BUSTR]', err);
    }
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  VIEW: MOBILE
  ////////////////////////////////////////////////////////////////////////////

  // Badge sits in Torn's count-badge position inside #nav-jail. Created here at init, not
  // from the tick loop: the tick can be up to statsRefreshRate away, and a not-yet-created
  // badge would show its "#" placeholders until then.
  function renderMobileBustrNotification() {
    const jailLinkEl = document.querySelector('#nav-jail a');
    if (!jailLinkEl) return;
    const notificationHTML = `
      <div class="mobileAmount___ua3ye bustr-stats bustr-mobile-badge"><span class="bustr-stats__availableBusts">#</span><span class="bustr-pct-line"><span class="bustr-stats__penaltyPct">#</span>%</span></div>`;
    jailLinkEl.insertAdjacentHTML('beforebegin', notificationHTML);
  }

  async function renderBustrMobileView() {
    try {
      await requireElement('#nav-jail a');
      const jailLinkEl = document.querySelector('#nav-jail');
      if (!jailLinkEl) return;

      // Guarded on the badge existing ANYWHERE, not inside #nav-jail: ensureSettingsTrigger
      // moves it into BUSTR's own nav column, where a scoped check would mint a duplicate.
      if (!document.querySelector('.bustr-mobile-badge')) renderMobileBustrNotification();
      if (document.getElementById('bustr-context')) return;

      const bustrContextMenuHTML = `
        <div id="bustr-context" class='contextMenu___bjhoL bustr-context-menu'>
          <span class='linkName___FoKha bustr-stats'>
          <span class="bustr-stats__penaltyScore">#</span> / <span class="bustr-stats__penaltyThreshold">#</span> : <span class="bustr-stats__availableBusts">#</span>
          <span class="bustr-pct-line"><span class="bustr-stats__penaltyPct">#</span>%</span>
          </span>
          <span class='arrow___tKP13 bustr-arrow'></span>
        </div>`;
      jailLinkEl.insertAdjacentHTML('afterend', bustrContextMenuHTML);
    } catch (err) {
      console.error('[BUSTR]', err);
    }
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  VIEW: JAIL HARDNESS
  ////////////////////////////////////////////////////////////////////////////

  function renderHardnessJailView() {
    const headingsContainerEl = document.querySelector('.users-list-title');
    if (headingsContainerEl && !headingsContainerEl.querySelector('span.hardness') && headingsContainerEl.children[3]) {
      const hardnessTitleHTML = `<span class="hardness title-divider divider-spiky">Hardness</span>`;
      headingsContainerEl.children[3].insertAdjacentHTML('afterend', hardnessTitleHTML);
    }

    const playerRowsArr = [...document.querySelectorAll('.user-info-list-wrap > li')];
    playerRowsArr.forEach((el) => {
      const playerInfoContainerEl = el.querySelector('.info-wrap');
      if (!playerInfoContainerEl) return;
      if (!playerInfoContainerEl.querySelector('.hardness.reason') && playerInfoContainerEl.children[2]) {
        const hardnessScoreHTML = `
          <span class="hardness reason">
            <span class="title bold">HARDNESS</span>
            <span class="bustr-hardness-score">#####</span>
            <span class="bustr-success-chance">--%</span>
          </span>`;
        playerInfoContainerEl.children[2].insertAdjacentHTML('afterend', hardnessScoreHTML);
      }
    });
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  CONTROLLERS
  ////////////////////////////////////////////////////////////////////////////

  async function initController() {
    try {
      renderBustrStylesheet();
      applyBadgeDetail(); // set compact/full badge mode up front, before the first tick

      // PDA's injected key is NOT copied into storage: getApiKey() treats a stored key as a
      // deliberate override that wins over PDA's, and falls back to the injected key when
      // none is set, so copying it in would have permanently shadowed the override.

      if (getMyViewportWidthType() === 'Desktop') {
        await renderBustrDesktopView();
        setRenderedView('Desktop');
      } else {
        await renderBustrMobileView();
        setRenderedView('Mobile');
      }

      if (getApiKey() !== undefined) return;

      // No key saved: render the form and wire up its listeners
      renderBustrForm();

      const submitEl = document.querySelector('#bustr-form__submit');
      const inputEl = document.querySelector('#bustr-form__input');
      if (submitEl) submitEl.addEventListener('click', submitFormCallback);
      if (inputEl) {
        inputEl.addEventListener('input', inputValidatorCallback);
        inputEl.addEventListener('keyup', (event) => {
          if (event.key === 'Enter' || event.keyCode === 13) submitFormCallback();
        });
      }
    } catch (err) {
      console.error('[BUSTR]', err);
    }
  }

  // Overlap guard so slow networks can't stack concurrent fetches
  let isLoading = false;
  // Stops auto-refetching once Torn has rejected the key, so we don't keep hitting
  // the API with a bad key (Torn warns repeated invalid-key calls can IP-ban you).
  let fatalKeyError = false;
  let resyncTimer = null;
  // On PDA a working injected key collapses the key entry to a status line (see
  // refreshApiKeyState). This latch lets "Use your own key instead" force it back open
  // without snapping shut on the next panel refresh. Reset each time the panel opens.
  let apiKeyEntryForced = false;

  async function loadController() {
    if (isLoading || fatalKeyError) return;
    // In a guard, not a bare line above the try: getApiKey() reads storage, and a throw
    // used to escape loadController and reject the caller.
    let apiKey;
    try {
      apiKey = getApiKey();
    } catch (err) {
      console.error('[BUSTR] could not read the API key', err);
      return;
    }
    if (apiKey === undefined) return; // no usable key: nothing to fetch, and the panel says so
    isLoading = true;
    try {
      const data = await fetchBustsData(apiKey);
      setGlobalBustrState({ lastApiError: null }); // last call succeeded: clear any recorded failure
      setTimestampsArray(createTimestampsArray(data));

      const statsObj = calcBustrStats(getTimestampsArray());
      setPenaltyScore(statsObj.penaltyScore);
      setPenaltyThreshold(statsObj.penaltyThreshold);
      setAvailableBusts(statsObj.availableBusts);

      renderBustrColorClass(getAvailableBusts());
      renderBustrStats(statsObj);
    } catch (err) {
      // Recorded, not just logged: a console-only message is invisible on PDA, where a
      // failing key reads on screen as 0% - indistinguishable from "no penalty".
      recordApiError('bust log', err);
      if (err && (err.tornCode === 2 || err.tornCode === 16)) {
        // Bad key / insufficient access: stop hitting the API every tick
        fatalKeyError = true;
        console.error('[BUSTR] API key rejected (' + err.message + '). Auto-refresh paused; clear cache or re-enter your key.');
      } else {
        // Transient (network/HTTP/timeout): keep the last good numbers on screen
        console.error('[BUSTR]', err);
      }
    } finally {
      isLoading = false;
    }
  }

  // Paint the "no bust history yet" state. Split out because the recalc paths below
  // return early on an empty timestampsArray, before renderBustrStats - so on a fresh
  // install the badge sat showing "#" placeholders. Zero is accurate and readable here,
  // replaced the moment real history arrives.
  function renderEmptyBustrStats() {
    renderBustrStats({
      penaltyScore: 0,
      penaltyThreshold: getPenaltyThreshold() || 0,
      availableBusts: getAvailableBusts() || 0,
      penaltyPct: 0,
    });
  }

  function recalcLocally() {
    const ts = getTimestampsArray();
    if (!ts || ts.length === 0) { renderEmptyBustrStats(); return; }
    const statsObj = calcBustrStats(ts);
    setPenaltyScore(statsObj.penaltyScore);
    setPenaltyThreshold(statsObj.penaltyThreshold);
    setAvailableBusts(statsObj.availableBusts);
    renderBustrColorClass(statsObj.availableBusts);
    renderBustrStats(statsObj);
  }

  // Lighter per-tick path. The threshold's auto mode scans the whole history for the
  // longest safe streak (costly on a heavy log) but only changes with history/settings,
  // so reuse it; only the penalty SCORE decays with time and needs re-deriving each tick.
  function recalcPenaltyScoreOnly() {
    const ts = getTimestampsArray();
    if (!ts || ts.length === 0) { renderEmptyBustrStats(); return; }
    const penaltyScore = calcPenaltyScore(ts);
    const threshold = getPenaltyThreshold();
    const availableBusts = calcAvailableBusts(penaltyScore, threshold);
    const penaltyPct = Math.round(calcPenaltyPct(ts));
    setPenaltyScore(penaltyScore);
    setAvailableBusts(availableBusts);
    renderBustrColorClass(availableBusts);
    renderBustrStats({ penaltyScore, penaltyThreshold: threshold, availableBusts, penaltyPct });
  }

  // Fetch only if enough time has passed since the last successful fetch, else recompute
  // locally. The gap dodges Torn's ~30s cache, which would return stale data and could
  // overwrite good numbers.
  function refetchIfStale(minGapMs) {
    if (fatalKeyError) return;
    const since = Date.now() - getLastFetchTimestampMs();
    if (since >= minGapMs) loadController();
    else recalcLocally();
  }

  // After a bust, schedule one refetch past the cache window. Debounced so a streak of
  // busts triggers a single resync once it settles.
  function scheduleGroundTruthResync() {
    if (fatalKeyError) return;
    if (resyncTimer) clearTimeout(resyncTimer);
    resyncTimer = setTimeout(() => {
      resyncTimer = null;
      loadController();
    }, JAIL_MIN_FETCH_GAP_MS + 5000);
  }

  function successfulBustUpdateController() {
    createJailMutationObserver();
  }

  function clearBustrPageColoring() {
    document.body.classList.remove('available___ZS04X', 'bustr--green', 'bustr--orange', 'bustr--red');
  }

  // Apply the "jail page only" scope: off the jail page, hide BUSTR's badge and colouring
  // via the bustr-inactive body class and return true (nothing further to render). Also
  // run at bootstrap, not just from masterTick - the tick's setInterval doesn't fire until
  // one refresh interval after load, so jail-only mode used to leave BUSTR visible for
  // 30-60s on other pages, reading as "jail-only isn't working".
  function applyActiveScope(onJail) {
    const inactive = getUserSettings().activeScope === 'jailOnly' && !onJail;
    document.body.classList.toggle('bustr-inactive', inactive);
    if (inactive) clearBustrPageColoring();
    return inactive;
  }

  // Settings changed in one Torn tab don't reach another open tab: each loads
  // GLOBAL_BUSTR_STATE into memory once and every read after (getUserSettings(), etc.)
  // comes from that copy, not storage - so a setting toggled in one tab is silently
  // ignored in another (confirmed against logged data). Re-reading userSettings from
  // storage and merging closes the gap. Safe: every mutation writes to storage in the
  // same call that updates memory (setGlobalBustrState), so nothing unpersisted is clobbered.
  function resyncSettingsFromStorage() {
    const stored = Store.get(STATE_KEY);
    if (!stored || !stored.userSettings) return;
    const current = JSON.stringify(getUserSettings());
    const incoming = JSON.stringify(stored.userSettings);
    if (current === incoming) return;
    GLOBAL_BUSTR_STATE = { ...GLOBAL_BUSTR_STATE, userSettings: stored.userSettings };
    if (document.getElementById('bustr-settings-panel')) populateSettingsPanelInputs();
    applySettings();
  }

  function masterTick() {
    // Lighter on the browser: do nothing at all while the tab is backgrounded.
    // Numbers are purely time-derived (decay) or re-fetched from the API, so
    // there's nothing to "catch up" on - the next tick after regaining focus
    // just recomputes/refetches normally. See the visibilitychange listener below
    // for an immediate resync the moment the tab becomes visible again.
    if (document.hidden) return;

    resyncSettingsFromStorage(); // pick up changes made in another tab before anything below reads settings

    applyBadgeDetail(); // keep the compact/full nav badge in sync (cheap body-class toggle, every page)

    const onJail = window.location.pathname === '/jailview.php';
    if (SHOW_SETTINGS_PANEL) ensureSettingsUi(); // keep the trigger reachable regardless of scope

    ensureBustObserver(onJail); // arm on the jail page, tear down everywhere else - in all modes

    if (applyActiveScope(onJail)) return; // jail-only + off jail: nav badge/colour hidden, nothing else to do

    // Cheap path every tick: only the penalty score decays with time and needs re-deriving
    // (see recalcLocally() vs recalcPenaltyScoreOnly()).
    recalcPenaltyScoreOnly();

    // Live-tick per-target hardness/success % on the jail page - pure local recompute, no
    // API calls.
    if (onJail) renderJailRows();
    if (fatalKeyError || isLoading) return;
    // Only the jail page fetches the bust log: busts only happen there, so off it the
    // cached timestamps + decay already give the correct penalty with zero log requests.
    if (onJail) {
      const since = Date.now() - getLastFetchTimestampMs();
      if (since >= JAIL_MIN_FETCH_GAP_MS) loadController();
    }
  }

  let masterTickIntervalId = null;
  function startRefreshLoops() {
    if (masterTickIntervalId !== null) clearInterval(masterTickIntervalId);
    const settings = getUserSettings();
    let rate = (typeof settings.statsRefreshRate === 'number' && settings.statsRefreshRate > 0)
      ? settings.statsRefreshRate
      : DEFAULT_REFRESH_SECONDS;
    if (rate < 15) rate = 15; // sane floor
    masterTickIntervalId = setInterval(masterTick, rate * 1000);
  }

  let visibilityListenerAttached = false;
  // masterTick no-ops while the tab is hidden; this fires one tick on foreground so
  // numbers aren't stale on switch-back.
  function attachVisibilityResync() {
    if (visibilityListenerAttached || typeof document.addEventListener !== 'function') return;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) masterTick();
    });
    visibilityListenerAttached = true;
  }

  async function viewportResizeController() {
    try {
      if (!window.visualViewport) return;
      window.visualViewport.addEventListener('resize', async () => {
        if (!getRenderedView()) return;
        if (getMyViewportWidthType() !== getRenderedView()) {
          await initController();
          // Repaint after a mobile/desktop switch. On the jail page fetch fresh; off it,
          // repaint the badge from the cached log + decay - no API call (see masterTick).
          if (window.location.pathname === '/jailview.php') await loadController();
          else recalcLocally();
        }
      });
    } catch (err) {
      console.error('[BUSTR]', err);
    }
  }

  // Per-row display pass: compute hardness + success and apply/clear the easiest-first
  // sort. Value visibility is body-class driven, so this always computes.
  function renderJailRows() {
    if (window.location.pathname !== '/jailview.php') return;
    const playersArr = [...document.querySelectorAll('ul.user-info-list-wrap > li')];
    if (!playersArr.length) return;
    // No page-level loading-placeholder guard on purpose: the old one checked playersArr[0]
    // for a 'last' class, but a single-row page (last page of a list) is first AND last, so
    // it skipped the whole page and left #####/--% stuck. The per-row check below
    // (getLevelJailDurationInfo returning null) skips incomplete rows one at a time instead.
    const sortOn = getUserSettings().sortByHardness !== false;
    const penaltyPct = calcPenaltyPct(getTimestampsArray());

    for (const playerEl of playersArr) {
      const info = getLevelJailDurationInfo(playerEl);
      if (!info) continue;
      const [level, durationInHours] = info;
      const hardnessScore = calcHardnessScore(level, durationInHours);
      renderHardnessScore(playerEl, hardnessScore);
      if (sortOn) sortByHardnessScore(playerEl, hardnessScore);
      else clearSortOrder(playerEl);
      renderSuccessChance(playerEl, calcSuccessChance(hardnessScore, penaltyPct));
    }
    applyQuickActions(); // keep the opt-in quick-bust/bail relabelling in sync every render pass
    renderEasyActionButtons(); // re-ensure the Easy actions bar if Torn re-rendered the header away
  }

  // Quick Bust / Quick Bail. Points the PLAYER's own click at Torn's no-confirmation link
  // variant (step=breakout -> breakout1, step=buy -> buy1) so the confirm page is skipped.
  // It NEVER clicks or fetches - one human click still equals one request. Opt-in. See the
  // COMPLIANCE NOTE at the top of the file.
  //
  // Rewritten at CLICK TIME, not ahead: Torn's React jail list re-renders rows constantly,
  // wiping any pre-written '1' so the confirm page returns intermittently. So we only paint
  // the indicator here and rewrite the clicked link in a capture-phase handler
  // (installQuickClickHandler) just before navigation - immune to re-render races. Idempotent
  // and never strips anyone's '1', but conflicts with TornTools' own Quick Bust (same link),
  // so that must be off for BUSTR's to work.
  function setQuickLink(anchorEl, on) {
    if (!anchorEl) return;
    anchorEl.classList.toggle('bustr-quick-on', on); // green highlight so the mode is obvious
  }

  function applyQuickActions() {
    if (window.location.pathname !== '/jailview.php') return;
    const us = getUserSettings();
    const rows = document.querySelectorAll('ul.user-info-list-wrap > li');
    for (const li of rows) {
      setQuickLink(li.querySelector("a[href*='step=breakout']"), us.quickBust === true);
      setQuickLink(li.querySelector("a[href*='step=buy']"), us.quickBail === true);
    }
  }

  // Capture-phase click handler: the single source of truth for quick bust/bail. Fires on
  // the PLAYER's real click before Torn's handlers and points it at the no-confirm variant,
  // fresh each time so React re-renders don't matter. Installed once; no-op unless the
  // matching toggle is on.
  let quickClickInstalled = false;
  function installQuickClickHandler() {
    if (quickClickInstalled) return;
    quickClickInstalled = true;
    document.addEventListener('click', (e) => {
      if (window.location.pathname !== '/jailview.php') return;
      const us = getUserSettings();
      if (us.quickBust !== true && us.quickBail !== true) return;
      const anchorEl = e.target && e.target.closest
        ? e.target.closest("a[href*='step=breakout'], a[href*='step=buy']")
        : null;
      if (!anchorEl) return;
      const href = anchorEl.getAttribute('href') || '';
      const isBust = /step=breakout/.test(href);
      const on = isBust ? us.quickBust === true : us.quickBail === true;
      if (!on) return;
      // Idempotent: 'breakout'/'breakout1' both become 'breakout1'. Never strips.
      const next = href.replace(/(step=(?:breakout|buy))1?(?=&|$)/, (_m, base) => base + '1');
      if (next !== href) anchorEl.setAttribute('href', next);
    }, true);
  }

  // Jail-list refresh control. The list is React-rendered from a JSON fetch, so BUSTR can't
  // swap the DOM itself; instead it drives Torn's OWN in-place refresh - toggling the URL
  // hash's ?start to a sentinel and back forces a re-fetch/re-render with no page reload
  // (Torn dedupes on ?start, so re-selecting the same page is a no-op). Only reads the list
  // you're viewing, never a bust/bail control; the observer re-decorates the fresh rows.
  function refreshJailList() {
    try {
      const start = (window.location.hash.match(/start=(\d+)/) || [])[1] || '0';
      window.location.hash = '#bustr-refresh';
      setTimeout(() => { window.location.hash = '#start=' + start; }, 30);
    } catch (err) {
      window.location.reload(); // last-resort fallback
    }
  }

  // ----- Easy Bust / Easy Bail (opt-in, consent-gated) --------------------------
  // One tap = ONE request for the single best currently-shown target, sent to jailview.php.
  // Strictly 1 tap = 1 request: a guard blocks overlapping fires, no timer/loop/queue, and
  // the button does nothing until tapped again. BUSTR chooses only WHICH shown target; YOU
  // choose whether and when to tap. See the COMPLIANCE NOTE at the top.
  let easyActionInFlight = false;

  // Sticky retry (Easy Bust only). On a failed bust where the captive is still jailed,
  // remember their Torn XID so the NEXT tap re-targets that exact person until they're
  // busted or leave jail. Cleared on success, on "gone", or when they leave the list. Only
  // changes WHICH shown target the next tap picks; never fires on its own (see COMPLIANCE).
  let easyRetryId = null;

  // Best-effort captive name from the jail row (status-line fallback when the response
  // doesn't carry it).
  function jailRowName(li) {
    if (!li) return null;
    const el = li.querySelector('a.user.name') || li.querySelector('a.user') || li.querySelector('a[href*="profiles.php"]');
    if (!el) return null;
    const n = (el.textContent || el.getAttribute('title') || '').trim();
    return n || null;
  }

  // Read the row's success/hardness overlay into a target descriptor. Shared by sticky-retry
  // and best-pick so both report identical fields.
  function easyTargetFromRow(li, href, id) {
    const successEl = li.querySelector('.bustr-success-chance');
    const hardnessEl = li.querySelector('.bustr-hardness-score');
    const success = successEl ? parseInt(successEl.textContent, 10) : NaN;
    const hardness = hardnessEl ? parseInt(hardnessEl.textContent, 10) : NaN;
    return {
      li, href, id, name: jailRowName(li),
      success: Number.isFinite(success) ? success : null,
      hardness: Number.isFinite(hardness) ? hardness : null,
    };
  }

  // Pick the single best shown target. Bust: highest success %. Bail: lowest hardness.
  // Skips rows already actioned this render and rows without the matching link; null if
  // none. Sticky retry (bust only): re-offer easyRetryId's captive first, else best-pick.
  function pickEasyTarget(kind) {
    const linkSel = kind === 'bust' ? "a[href*='step=breakout']" : "a[href*='step=buy']";
    const rows = [...document.querySelectorAll('ul.user-info-list-wrap > li')];

    if (kind === 'bust' && easyRetryId) {
      for (const li of rows) {
        if (li.classList.contains('bustr-easy-done')) continue;
        const link = li.querySelector(linkSel);
        if (!link) continue;
        const href = link.getAttribute('href') || '';
        const m = href.match(/XID=(\d+)/);
        if (m && m[1] === easyRetryId) return easyTargetFromRow(li, href, easyRetryId);
      }
      easyRetryId = null; // remembered captive is no longer in jail: advance normally
    }

    let best = null;
    for (const li of rows) {
      if (li.classList.contains('bustr-easy-done')) continue;
      const link = li.querySelector(linkSel);
      if (!link) continue;
      const href = link.getAttribute('href') || '';
      const idMatch = href.match(/XID=(\d+)/);
      if (!idMatch) continue;
      const t = easyTargetFromRow(li, href, idMatch[1]);
      // Bust wants the highest success %; bail wants the lowest hardness (cheapest).
      t.rank = kind === 'bust'
        ? (Number.isFinite(t.success) ? t.success : -1)
        : (Number.isFinite(t.hardness) ? -t.hardness : -Infinity);
      if (!best || t.rank > best.rank) best = t;
    }
    return best;
  }

  // Classify Torn's JSON reply into success / jailed / clean-fail / gone. "gone" = already
  // left jail (not a real outcome, so not logged for calibration), checked first. Defensive:
  // on an unfamiliar shape, report not-success and don't guess jailed.
  function classifyEasyResponse(kind, data) {
    const text = ((data && (data.msg || data.text)) || '').toString();
    const green = !!(data && data.color === 'green');
    if (/no longer in jail|not in jail|already (been )?(busted|bailed|released|free)|isn't in jail/i.test(text)) {
      return { success: false, jailed: false, gone: true, text };
    }
    if (kind === 'bail') return { success: green || /bailed|released|out of jail/i.test(text), jailed: false, text };
    const success = green || /you busted/i.test(text);
    if (success) return { success: true, jailed: false, text };
    const jailed = FAILURE_JAILED_PATTERNS.some((re) => re.test(text));
    return { success: false, jailed, text };
  }

  // Pull the target's name from Torn's reply, which wraps it in a profile anchor. Parsed via
  // an inert DOMParser doc (no scripts/resources) and read as textContent, so encoded names
  // decode ("Foo&amp;Bar" -> "Foo&Bar"). Null if no name anchor.
  function responseName(data) {
    const raw = (data && (data.msg || data.text)) || '';
    if (!raw) return null;
    try {
      const doc = new DOMParser().parseFromString(raw, 'text/html');
      const a = doc.querySelector('a[href*="profiles.php"]') || doc.querySelector('a');
      const n = a ? (a.textContent || '').trim() : '';
      return n || null;
    } catch (e) {
      return null;
    }
  }

  // A short, clean status line for the bar - never Torn's raw reply (verbose, may carry
  // HTML). Includes the target's name when known.
  function easyStatusMessage(kind, outcome, data, name, willRetry) {
    if (!data) return 'No response from Torn';
    if (outcome.gone) return 'This person is no longer in jail.';
    const verb = kind === 'bust' ? 'busted' : 'bailed';
    if (outcome.success) return name ? name + ' was ' + verb + '.' : (kind === 'bust' ? 'Busted!' : 'Bailed!');
    if (kind === 'bust' && outcome.jailed) return name ? 'Failed to bust ' + name + ' - you got jailed.' : 'Failed - you got jailed';
    const base = name ? 'Failed to ' + kind + ' ' + name + '.' : (kind === 'bust' ? 'Bust failed' : 'Bail failed');
    return willRetry ? base + ' Tap again to retry.' : base;
  }

  // Fire exactly ONE request for the chosen shown target. Guarded so overlapping
  // taps cannot double-fire; still no timer, loop, or auto-chaining. A failed bust
  // simply stays selected so your NEXT manual tap retries the same captive (see
  // easyRetryId) - the script never re-fires without a fresh press.
  async function fireEasyAction(kind, btn, statusEl) {
    if (easyActionInFlight) return;
    const target = pickEasyTarget(kind);
    if (!target) { if (statusEl) statusEl.textContent = 'No eligible targets'; return; }

    const noConfirmHref = kind === 'bust'
      ? target.href.replace(/step=breakout\b/, 'step=breakout1')
      : target.href.replace(/step=buy\b/, 'step=buy1');
    let url;
    try { url = new URL(noConfirmHref, window.location.origin).href; }
    catch (e) { if (statusEl) statusEl.textContent = 'Bad target link'; return; }

    // Self-calibration: freeze the exact inputs so the outcome logs correctly. Only with
    // self-cal on and a numeric hardness (else the row fails the m:2 validity filter anyway).
    if (kind === 'bust' && getUserSettings().selfCalibrationEnabled && Number.isFinite(target.hardness)) {
      recordPendingAttempt(target.hardness, target.success);
    }

    easyActionInFlight = true;
    if (btn) btn.classList.add('bustr-easy-busy');
    if (statusEl) statusEl.textContent = kind === 'bust' ? 'Busting...' : 'Bailing...';
    try {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      const raw = await res.text();
      let data = null;
      try { data = JSON.parse(raw); } catch (e) { data = null; }
      const outcome = classifyEasyResponse(kind, data || {});

      const name = responseName(data) || target.name || null; // prefer Torn's reply, fall back to the row

      // Whether we're done with this captive. On a clean bust fail with them still jailed,
      // leave the row eligible and remember them so the next tap retries the SAME person;
      // advance only once busted or gone. Bail (and non-bust paths) stay one-and-done.
      let finishedWithTarget = true;

      if (kind === 'bust') {
        if (outcome.gone) {
          takePendingAttempt(); // target already left jail: discard, don't log a phantom failure
          easyRetryId = null;
        } else if (outcome.success) {
          logOutcome(true); // consumes the pending attempt if self-cal recorded one
          setPenaltyScore(getPenaltyScore() + PENALTY_PER_BUST);
          setAvailableBusts(calcAvailableBusts(getPenaltyScore(), getPenaltyThreshold()));
          renderBustrStats({ availableBusts: getAvailableBusts(), penaltyScore: getPenaltyScore() });
          renderBustrColorClass(getAvailableBusts());
          easyRetryId = null;
        } else if (data) {
          logOutcome(false, { jailed: outcome.jailed });
          if (outcome.jailed) {
            easyRetryId = null; // you got jailed - you can't retry until you're out
          } else {
            easyRetryId = target.id; // clean fail, still in jail: retry this person next tap
            finishedWithTarget = false;
          }
        }
        scheduleGroundTruthResync(); // correct the budget from the real bust log shortly after
      }

      // Mark done only when moving on, so a retry target stays eligible for the next tap
      // (done rows are skipped by pickEasyTarget).
      if (finishedWithTarget) target.li.classList.add('bustr-easy-done');
      if (statusEl) statusEl.textContent = easyStatusMessage(kind, outcome, data, name, !finishedWithTarget);
    } catch (err) {
      console.error('[BUSTR] Easy action request failed', err);
      if (statusEl) statusEl.textContent = 'Request failed';
    } finally {
      easyActionInFlight = false;
      if (btn) btn.classList.remove('bustr-easy-busy');
    }
  }

  // Reflect a Quick pill's on/off look from the current setting.
  function syncQuickPill(pill, key) {
    const on = getUserSettings()[key] === true;
    pill.classList.toggle('bustr-on', on);
    pill.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  // Build/maintain BUSTR's jail action bar: its OWN full-width row above the list's column
  // header (not inside that cramped header) so buttons have room. Self-heals if Torn drops it.
  function renderEasyActionButtons() {
    if (window.location.pathname !== '/jailview.php') return;
    const us = getUserSettings();
    let bar = document.querySelector('.bustr-easy-bar');
    if (!bar) {
      const anchor = document.querySelector('.users-list-title') || document.querySelector('ul.user-info-list-wrap');
      if (!anchor || !anchor.parentNode) return;
      bar = document.createElement('div');
      bar.className = 'bustr-easy-bar';
      anchor.parentNode.insertBefore(bar, anchor);
    }

    // Each control is created once and reused; a stable order is re-applied at the end of
    // every pass (appendChild moves the node), so the bar self-heals on a header re-render.

    // BUSTR label.
    let lbl = bar.querySelector('.bustr-easy-label');
    if (!lbl) {
      lbl = document.createElement('span');
      lbl.className = 'bustr-easy-label';
      lbl.textContent = 'BUSTR';
      bar.appendChild(lbl);
    }

    // Quick Bust / Quick Bail toggle pills (always shown): a one-tap flip of the opt-in
    // confirm-skip mode, on the jail page itself.
    const quickPill = (key, label) => {
      const cls = 'bustr-quick-' + (key === 'quickBust' ? 'bust' : 'bail'); // stable handle
      let p = bar.querySelector('.' + cls);
      if (!p) {
        p = document.createElement('span');
        p.className = 'bustr-quick-toggle ' + cls;
        p.textContent = label;
        p.setAttribute('role', 'switch');
        p.addEventListener('click', () => {
          updateSetting(key, getUserSettings()[key] !== true);
          applyQuickActions();      // repaint the row link highlights immediately
          syncQuickPill(p, key);
        });
        bar.appendChild(p);
      }
      syncQuickPill(p, key);
      return p;
    };
    const pillBust = quickPill('quickBust', 'Quick Bust');
    const pillBail = quickPill('quickBail', 'Quick Bail');

    // "?" explainer for the Quick pills - reuses the panel's shared help card.
    let help = bar.querySelector('.bustr-q');
    if (!help) {
      help = document.createElement('span');
      help.className = 'bustr-q';
      help.textContent = '?';
      help.title = 'What do these do?';
      help.addEventListener('click', () => {
        ensureSettingsPanelDom(); // guarantees #bustr-help exists before showHelp runs
        showHelp('quickactions', help);
      });
      bar.appendChild(help);
    }

    // Status span pinned to the far right (margin-left:auto).
    let statusEl = bar.querySelector('.bustr-easy-status');
    if (!statusEl) {
      statusEl = document.createElement('span');
      statusEl.className = 'bustr-easy-status';
      bar.appendChild(statusEl);
    }

    // Refresh button: always present.
    let refresh = bar.querySelector('.bustr-jail-refresh');
    if (!refresh) {
      refresh = document.createElement('span');
      refresh.className = 'bustr-jail-refresh';
      refresh.textContent = '↻'; // clockwise arrow
      refresh.title = 'Refresh the jail list';
      refresh.addEventListener('click', refreshJailList);
    }

    // Easy buttons: present only when their (consent-gated) setting is on.
    const easyBtn = (kind, label, want) => {
      const cls = 'bustr-easy-' + kind;
      let b = bar.querySelector('.' + cls);
      if (want && !b) {
        b = document.createElement('span');
        b.className = 'bustr-easy-btn ' + cls;
        b.textContent = label;
        b.title = 'One tap = one ' + kind + ' request for the ' +
          (kind === 'bust' ? 'best-odds' : 'cheapest') + ' shown target (BUSTR sends it)';
        b.addEventListener('click', () => fireEasyAction(kind, b, statusEl));
      } else if (!want && b) {
        b.remove();
        b = null;
      }
      return b;
    };
    const easyBust = easyBtn('bust', 'Easy Bust', us.easyBust === true);
    const easyBail = easyBtn('bail', 'Easy Bail', us.easyBail === true);

    // Re-apply the canonical left-to-right order every pass.
    // [BUSTR] [Quick Bust] [Quick Bail] [?] [Easy Bust] [Easy Bail] [↻] .... [status]
    [lbl, pillBust, pillBail, help, easyBust, easyBail, refresh, statusEl]
      .forEach((el) => { if (el) bar.appendChild(el); });
  }

  // Compact vs full nav badge, toggled by a single body class (the badge exists on
  // every Torn page, so this is a global toggle, not jail-only).
  function applyBadgeDetail() {
    document.body.classList.toggle('bustr-badge-simple', getUserSettings().navBadgeDetail !== 'full');
  }

  // Toggle visibility of the hardness number and the success % via body classes.
  function applyJailVisibility() {
    document.body.classList.toggle('bustr-no-hardness', getUserSettings().showHardnessScore === false);
    document.body.classList.toggle('bustr-no-success', getUserSettings().showSuccessChance === false);
  }

  function hardnessScoreController() {
    if (window.location.pathname !== '/jailview.php') return;
    refetchIfStale(JAIL_MIN_FETCH_GAP_MS); // fresh numbers the moment you reach jail
    createHardnessScoreObserver();
    installQuickClickHandler(); // race-proof quick bust/bail; safe no-op unless a toggle is on
    renderHardnessJailView();
    renderEasyActionButtons(); // BUSTR jail bar: refresh button + Easy Bust/Bail
    applyJailVisibility();
    renderJailRows();
    if (SHOW_SETTINGS_PANEL) ensureSettingsUi();
  }

  // Re-render rows (e.g. after the API returns the real level). Name kept for call sites.
  function refreshSuccessChances() {
    if (window.location.pathname !== '/jailview.php') return;
    renderHardnessJailView();
    applyJailVisibility();
    renderJailRows();
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  SETTINGS PANEL (jail page only)
  ////////////////////////////////////////////////////////////////////////////

  function updateSetting(key, value) {
    setUserSettings({ ...getUserSettings(), [key]: value });
  }
  function updateLimit(key, value) {
    const us = getUserSettings();
    setUserSettings({ ...us, reminderLimits: { ...us.reminderLimits, [key]: value } });
  }
  const clampPct = (v) => Math.max(0, Math.min(100, v));
  const numOr = (el, fallback) => { const v = parseFloat(el.value); return isNaN(v) ? fallback : v; };

  // Re-apply every setting to what's already on screen, no reload needed.
  function applySettings() {
    applyBadgeDetail(); // reflect a compact/full badge toggle immediately
    recalcLocally(); // recomputes available busts + nav colour (limits, custom threshold)
    // Reflect an "Active on" scope change (Anywhere <-> Jail page only) right away, not on the
    // next interval tick up to statsRefreshRate seconds later - toggling bustr-inactive here
    // hides/shows the badge the instant the dropdown changes. Cheap body-class toggle; no-op in
    // "always" mode. recalcLocally above may have repainted the badge, but the class still hides it.
    applyActiveScope(window.location.pathname === '/jailview.php');
    if (window.location.pathname === '/jailview.php') {
      applyJailVisibility();
      renderJailRows();
    }
  }

  function openSettings() {
    const p = document.getElementById('bustr-settings-panel');
    const b = document.getElementById('bustr-settings-backdrop');
    if (!p) return;
    apiKeyEntryForced = false; // start collapsed each open when a healthy PDA key is active
    populateSettingsPanelInputs(); // resync every field to current settings, not just on first build
    refreshSettingsStatus();
    p.classList.add('bustr-open');
    if (b) b.classList.add('bustr-open');
  }
  function closeSettings() {
    const p = document.getElementById('bustr-settings-panel');
    const b = document.getElementById('bustr-settings-backdrop');
    if (p) p.classList.remove('bustr-open');
    if (b) b.classList.remove('bustr-open');
    hideHelp(); // help card lives outside the panel, else it's left floating
  }
  function toggleSettings() {
    const p = document.getElementById('bustr-settings-panel');
    if (p && p.classList.contains('bustr-open')) closeSettings();
    else openSettings();
  }

  // The fit is otherwise only recomputed in logOutcome() on a NEW outcome, so a backlog of
  // existing data sits unused (after enabling self-cal, or updating to a version that added
  // a fit) until the next bust. Recomputing on panel open (cheap grid search over in-memory
  // data) keeps it reflecting everything that currently exists.
  function refitFromExistingOutcomes() {
    const state = getGlobalBustrState();
    const log = state.outcomeLog || [];
    if (log.length === 0) return;
    const fittedCalibration = computeSelfCalibration(log);
    if (fittedCalibration !== state.selfCalibrationValue) {
      setGlobalBustrState({ selfCalibrationValue: fittedCalibration });
    }
  }

  // Reports WHICH key is in play without putting the key in the DOM - the panel gets
  // screenshotted for support, and BUSTR never exposes your key.
  function refreshApiKeyState() {
    const el = document.getElementById('bustr-set-apikey-state');
    if (!el) return;
    const k = describeApiKey();
    const saved = k.source === 'user override';
    // A PDA key BUSTR can use: injected, right length, not being rejected. When healthy
    // there's nothing to enter (PDA supplied it at install), so collapse to the status line
    // and offer an opt-in override rather than a second "type your key here" box (the
    // reported PDA double-entry). If it's missing/wrong-length/rejected, the entry stays open.
    const healthyPda = k.source === 'PDA injected' && k.looksValid && !fatalKeyError;
    let msg;
    // A healthy PDA key reuses the same "API key is saved." line as a user-saved key,
    // so the two settled states read identically - the button below is what differs
    // (Clear saved key vs. the opt-in "use your own key" override link).
    if (saved || healthyPda) msg = 'API key is saved.';
    else if (k.source === 'PDA injected') msg = 'The key from the PDA app is not working. Enter your own key below to override it.';
    else if (k.pdaTokenSubstituted) msg = 'The PDA app supplied an EMPTY key, so BUSTR has no key to use. Create one below.';
    else msg = 'No API key set. Create one below.';
    // Say so outright when the key is the wrong length: Torn answers a malformed key with
    // "Incorrect key", which reads as "wrong key" and sends you re-checking a good one.
    if (k.source !== 'none' && !k.looksValid) {
      msg += ` Warning: it is ${k.resolvedLength} characters, but a Torn key is ${k.expectedLength}. Torn will reject it as "Incorrect key". Re-paste it carefully.`;
    }
    el.textContent = msg;

    // A saved key leaves nothing to type, so collapse the paste field/Save to the status
    // line plus a Clear button (clearing brings the field back; Clear is hidden with no
    // saved key). A healthy PDA key collapses the same way but offers an opt-in override
    // link instead of Clear (no stored override to clear yet).
    const entry = document.getElementById('bustr-set-apikey-entry');
    const clearBtn = document.getElementById('bustr-set-apikey-clear');
    const overrideLink = document.getElementById('bustr-set-apikey-override');
    const collapse = saved || (healthyPda && !apiKeyEntryForced);
    if (entry) entry.style.display = collapse ? 'none' : '';
    if (clearBtn) clearBtn.style.display = saved ? '' : 'none';
    if (overrideLink) overrideLink.style.display = (healthyPda && !apiKeyEntryForced) ? '' : 'none';
  }

  function refreshSettingsStatus() {
    refitFromExistingOutcomes();
    refreshApiKeyState();
    const el = document.getElementById('bustr-set-status');
    if (el) {
      const pen = Math.round(calcPenaltyPct(getTimestampsArray()));
      const settings = getUserSettings();
      const log = getGlobalBustrState().outcomeLog || [];
      let mode = (typeof settings.skillCalibrationOverride === 'number') ? 'manual' : 'auto';
      if (settings.selfCalibrationEnabled
        && typeof getGlobalBustrState().selfCalibrationValue === 'number'
        && typeof settings.skillCalibrationOverride !== 'number') {
        mode = 'learned';
      }
      // Version first: this line gets read back in bug reports.
      el.textContent = `BUSTR v${SCRIPT_VERSION} \u00b7 Lvl ${getPlayerLevel()} \u00b7 calibration ${getSkillCalibration().toFixed(2)} (${mode}) \u00b7 current penalty ${pen}%`;

      // A failing API key must not be silent: the only other symptom is a 0% penalty,
      // reading as "clear to bust" when the real figure is unknown.
      const apiErr = getGlobalBustrState().lastApiError;
      const errEl = document.getElementById('bustr-set-apierror');
      if (errEl) {
        if (!apiErr) {
          errEl.textContent = '';
          errEl.style.display = 'none';
        } else {
          const hint = (apiErr.code === 16 || apiErr.code === 2)
            ? ' Your key is rejected or lacks the ' + API_KEY_SELECTIONS + ' selections BUSTR reads. Use "Create a key for BUSTR" below to generate one with exactly those. On PDA the key in use is the one set in the PDA app, unless you save your own here.'
            : ' This is usually transient; the numbers on screen are the last good ones.';
          errEl.textContent = `API (${apiErr.what}) failed: ${apiErr.message}.${hint}`;
          errEl.style.display = '';
        }
      }
    }

    const statsEl = document.getElementById('bustr-set-selfcal-stats');
    if (statsEl) {
      const log = getGlobalBustrState().outcomeLog || [];
      const stats = selfCalibrationStats(log);
      if (!stats) {
        statsEl.textContent = 'No outcomes logged yet. Logging starts the moment this is enabled.';
      } else {
        // "Usable" counts only outcomes under the current penalty model (see
        // fittableOutcomes). Pre-v2.7.19 samples froze an inflated penalty% and can't be
        // fitted, so they're shown but never voted on.
        const need = Math.max(0, SELF_CAL_MIN_SAMPLES - stats.usable);
        const legacy = stats.n - stats.usable;
        const fitNote = need > 0
          ? `needs ${need} more sample(s) before the fit is used`
          : `fitted calibration: ${getGlobalBustrState().selfCalibrationValue}`;
        const legacyNote = legacy > 0
          ? ` \u00b7 ${legacy} pre-v2.7.19 sample(s) shown but not fitted (recorded under the old penalty model)`
          : '';
        statsEl.textContent = `${stats.n} outcome(s) logged \u00b7 ${stats.successRatePct}% succeeded \u00b7 ${stats.jailed} jailed \u00b7 ${fitNote}${legacyNote}`;
      }
    }
  }

  // Quantifies what perk-based calibration would change, rather than leaving it an invisible
  // multiplier. The delta depends on hardness (calibration scales the hardness/skill term),
  // so it's shown at one reference point - the hardness where a no-perk player sits at ~50%
  // with no penalty, mid-curve where the difference is most visible rather than lost to the
  // 1/99 clamp. Shown always, regardless of whether the setting is on.
  function refreshPerkImpactDisplay() {
    const el = document.getElementById('bustr-set-perk-impact');
    if (!el) return;
    const bustPerks = getGlobalBustrState().bustPerks || [];
    if (bustPerks.length === 0) {
      el.textContent = 'No bust perks detected from the API yet, so there is nothing to compare.';
      return;
    }
    const perkCal = calibrationFromPerks(bustPerks);
    const level = getPlayerLevel();
    const hMid = Math.round(((SUCCESS_A - 50) * level) / (SUCCESS_B * 60));
    const baseline = Math.round(calcSuccessChanceRaw(hMid, 0, CAL_CEILING));
    const withPerks = Math.round(calcSuccessChanceRaw(hMid, 0, perkCal));
    const delta = withPerks - baseline;
    const sign = delta > 0 ? '+' : '';
    el.textContent = `At a mid-range target (hardness ~${hMid}, no penalty): ${baseline}% baseline vs ${withPerks}% with your detected perks (${sign}${delta} point${Math.abs(delta) === 1 ? '' : 's'}).`;
  }

  // Re-reads every input from the persisted settings. Called on first build AND every open
  // (see openSettings), so if on-screen state drifts from storage (e.g. bfcache restore),
  // reopening the panel always shows the truth.
  function populateSettingsPanelInputs() {
    const panel = document.getElementById('bustr-settings-panel');
    if (!panel) return;
    const byId = (id) => document.getElementById(id);
    const us = getUserSettings();

    byId('bustr-set-green').value = us.reminderLimits.greenLimit;
    byId('bustr-set-red').value = us.reminderLimits.redLimit;
    byId('bustr-set-threshold').value = us.customPenaltyThreshold || 0;
    byId('bustr-set-refresh').value = us.statsRefreshRate || DEFAULT_REFRESH_SECONDS;
    byId('bustr-set-hardness').checked = us.showHardnessScore !== false;
    byId('bustr-set-sort').checked = us.sortByHardness !== false;
    byId('bustr-set-easybust').checked = us.easyBust === true;
    byId('bustr-set-easybail').checked = us.easyBail === true;
    byId('bustr-set-success').checked = us.showSuccessChance !== false;
    byId('bustr-set-scgreen').value = typeof us.successGreenAt === 'number' ? us.successGreenAt : SC_GREEN_AT;
    byId('bustr-set-scred').value = typeof us.successRedBelow === 'number' ? us.successRedBelow : SC_RED_BELOW;
    byId('bustr-set-cal').value = (typeof us.skillCalibrationOverride === 'number' && us.skillCalibrationOverride > 0)
      ? us.skillCalibrationOverride : '';
    byId('bustr-set-selfcal').checked = us.selfCalibrationEnabled === true;
    byId('bustr-set-playstyle').value = us.playStyle === 'maxcount' ? 'maxcount' : 'safety';
    byId('bustr-set-scope').value = us.activeScope === 'jailOnly' ? 'jailOnly' : 'always';
    byId('bustr-set-badgesimple').checked = us.navBadgeDetail !== 'full';
    byId('bustr-set-useperkcal').checked = us.usePerkCalibration === true;
    const cloudBox = byId('bustr-set-cloudsync');
    if (cloudBox) cloudBox.checked = us.cloudSyncEnabled === true && CloudSync.signedIn();
    refreshCloudStatus();
    refreshPerkImpactDisplay();
  }

  // One-line cloud status for the panel: unavailable / off / synced / error.
  function refreshCloudStatus(msg) {
    const el = document.getElementById('bustr-cloud-status');
    if (!el) return;
    if (typeof msg === 'string') { el.textContent = msg; return; }
    if (!hasGMXhr) { el.textContent = 'Unavailable here - this app or manager does not provide cross-origin requests. Works on desktop and recent Torn PDA.'; return; }
    if (CloudSync.enabled() && CloudSync.signedIn()) {
      el.textContent = 'On - synced as player ' + (CloudSync.playerId || '?') + '.';
    } else {
      el.textContent = 'Off. Your bust history stays only on this device.';
    }
  }

  // Explicit consent before the first cloud enable. Resolves true only on "Enable sync";
  // nothing signs in or uploads until then.
  function showCloudConsent() {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'bustr-consent-backdrop';
      back.innerHTML = `
        <div class="bustr-consent-card">
          <h3>Enable cloud sync?</h3>
          <p>Backs up your bust history across your devices, tied to your Torn ID. Stored: your bust stats, plus the perks, level, calibration, BUSTR settings and script version behind your predictions - all to improve BUSTR's model. Never your API key, name, or faction. Switching it off deletes your cloud copy.</p>
          <div class="bustr-consent-actions">
            <button type="button" class="bustr-btn" id="bustr-consent-cancel">Cancel</button>
            <button type="button" class="bustr-btn" id="bustr-consent-ok">Enable sync</button>
          </div>
        </div>`;
      const done = (val) => { try { back.remove(); } catch (e) {} resolve(val); };
      back.addEventListener('click', (e) => { if (e.target === back) done(false); });
      document.body.appendChild(back);
      back.querySelector('#bustr-consent-cancel').addEventListener('click', () => done(false));
      back.querySelector('#bustr-consent-ok').addEventListener('click', () => done(true));
    });
  }

  // Consent before the FIRST Easy Bust/Bail enable. These fire real requests (unlike Quick,
  // which only relabels your click), so the difference is spelled out. One consent covers
  // both toggles; resolves true only on "Enable".
  function showEasyActionsConsent() {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'bustr-consent-backdrop';
      back.innerHTML = `
        <div class="bustr-consent-card">
          <h3>Enable Easy Bust / Easy Bail?</h3>
          <p>Unlike Quick actions (which only relabel your own click), this makes BUSTR <b>send the bust/bail request itself</b> when you tap the header button. It is still ONE tap = ONE request, to the same jail page, with no looping or auto-repeat - the button does nothing until you tap it again, and BUSTR only picks which shown target. You decide whether and when to tap. Use at your own discretion.</p>
          <div class="bustr-consent-actions">
            <button type="button" class="bustr-btn" id="bustr-consent-cancel">Cancel</button>
            <button type="button" class="bustr-btn" id="bustr-consent-ok">Enable</button>
          </div>
        </div>`;
      const done = (val) => { try { back.remove(); } catch (e) {} resolve(val); };
      back.addEventListener('click', (e) => { if (e.target === back) done(false); });
      document.body.appendChild(back);
      back.querySelector('#bustr-consent-cancel').addEventListener('click', () => done(false));
      back.querySelector('#bustr-consent-ok').addEventListener('click', () => done(true));
    });
  }

  // Turning either Easy toggle ON is gated on a one-time consent (easyActionsConsented).
  // Reverts the checkbox if declined.
  async function handleEasyToggle(key, checkbox) {
    const on = checkbox.checked;
    if (on && getUserSettings().easyActionsConsented !== true) {
      const ok = await showEasyActionsConsent();
      if (!ok) { checkbox.checked = false; updateSetting(key, false); renderEasyActionButtons(); return; }
      updateSetting('easyActionsConsented', true);
    }
    updateSetting(key, on);
    renderEasyActionButtons();
  }

  function ensureSettingsUi() {
    if (!SHOW_SETTINGS_PANEL || !document.body) return;
    ensureSettingsPanelDom();
    ensureSettingsTrigger();
  }

  // The container for the sidebar trigger. #nav-jail's container isn't guaranteed to be a
  // <ul> (Torn's newer fly-out sidebar may differ), so prefer a real <ul> ancestor, else
  // #nav-jail's immediate parent. (Walking further up to "a container with several children"
  // matched <body> on real pages and misplaced the button; one level up can't misfire.)
  function findSidebarContainer(jail) {
    if (!jail) return null;
    return jail.closest('ul') || jail.parentElement || null;
  }

  // Mobile/PDA only. Returns the nav CELL that #nav-jail lives in (the element to clone for
  // a column of our own), or null if it can't be established.
  //
  // #nav-jail is NOT the nav slot on mobile - it sits inside one (learned across
  // v2.8.1-v2.8.3). The cell is #nav-jail's parent, and a clone of it inserted after it is a
  // genuine extra column. The catch: if that parent were the nav BAR, cloning it would
  // duplicate the navigation. So the shape is verified, returning null unless BOTH hold:
  //   - the cell contains exactly ONE #nav-* item (so it's Jail's alone)
  //   - its parent contains several (so it's really the bar of sibling cells)
  // A wrong guess does nothing rather than damaging the nav.
  function findMobileNavCell(jail) {
    const cell = jail && jail.parentElement;
    if (!cell) return null;
    if (cell.querySelectorAll('[id^="nav-"]').length !== 1) return null; // the bar, or some shared wrapper
    const bar = cell.parentElement;
    if (!bar || bar.querySelectorAll('[id^="nav-"]').length < 2) return null; // not a bar of cells
    return cell;
  }

  // Torn's hashed CSS-module classes (e.g. "active__xlAlO") keep a stable prefix but a
  // changing hash suffix, so match the prefix with [class*=] to survive re-hashing.
  function findByClassPrefix(root, prefix) {
    return root.querySelector(`[class*="${prefix}"]`);
  }

  // Remove any "active*" class from an element and its subtree. Torn marks the current-page
  // sidebar row with one, so a #nav-jail clone made on the jail page would otherwise carry
  // that highlight onto the settings button.
  function stripActiveStateClasses(el) {
    [el, ...el.querySelectorAll('*')].forEach((node) => {
      if (!node.classList) return;
      [...node.classList].forEach((cls) => {
        if (/^active/i.test(cls)) node.classList.remove(cls);
      });
    });
  }

  function buildSidebarButton(sourceEl) {
    // Clone a native sidebar row (#nav-jail) rather than building our own, so the button
    // inherits Torn's real classes/layout/hover and looks like it belongs.
    const li = sourceEl.cloneNode(true);
    stripActiveStateClasses(li);
    li.removeAttribute('id');
    // Strip ids from the whole subtree: on mobile the source is Jail's nav CELL, so the
    // clone carries a nested #nav-jail whose duplicate id would confuse Torn's scripts (and
    // our own #nav-jail lookups).
    li.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    li.id = 'bustr-sidebar-btn';
    li.title = 'BUSTR settings';
    li.querySelectorAll('.bustr-stats').forEach((el) => el.remove()); // strip any cloned BUSTR badge
    // And any copy of Torn's count badge: ensureSettingsTrigger moves the real one in, so
    // the clone shouldn't carry a frozen snapshot. Prefix match (Torn re-hashes the suffix).
    li.querySelectorAll('[class*="mobileAmount"]').forEach((el) => el.remove());
    const anchor = li.querySelector('a') || li;
    anchor.removeAttribute('href'); // never navigate - this opens the settings panel
    // Confirmed via live DevTools inspection: the real jail link carries an
    // "i-date" attribute (looks like a Torn-internal tracking/analytics hook).
    // Strip it from the clone - there's no reason to carry a duplicate copy of
    // whatever that identifier is onto an unrelated button, and no way to know
    // whether Torn's own scripts assume it's unique per element.
    anchor.removeAttribute('i-date');

    // Swap TEXT/ICON content only, keeping Torn's own labelled elements intact -
    // this is what actually makes it look identical to sibling rows (same
    // font-size/color/weight from Torn's real CSS), instead of replacing the
    // structure with generic unstyled spans that only approximate the look.
    const label = findByClassPrefix(anchor, 'linkName');
    if (label) {
      label.textContent = 'BUSTR';
    } else {
      anchor.textContent = 'BUSTR'; // fallback if that class name ever changes
    }
    const iconWrap = findByClassPrefix(anchor, 'svgIconWrap') || findByClassPrefix(anchor, 'defaultIcon');
    if (iconWrap) {
      // An unlocked padlock, not a gear - busting is literally unlocking, and reads as
      // "BUSTR" at a glance. Inline SVG with stroke="currentColor" (not an emoji glyph, which
      // renders full-colour regardless of theme) so it matches the active text colour like
      // Torn's own icons. Path is Feather Icons' "unlock" (MIT), sized to Torn's 17x17.
      iconWrap.innerHTML = `<svg class="bustr-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
      </svg>`;
    }

    li.addEventListener('click', (e) => { e.preventDefault(); toggleSettings(); });
    return li;
  }

  function ensureSettingsTrigger() {
    const existing = document.getElementById('bustr-sidebar-btn');
    const jail = document.querySelector('#nav-jail');
    const list = findSidebarContainer(jail);

    // Mobile/PDA: BUSTR gets its own nav column right of Jail, and the badge moves into it
    // so they travel together. Only when findMobileNavCell proves the structure; else the
    // sidebar path below applies.
    const cell = jail && isMobileViewport() ? findMobileNavCell(jail) : null;
    if (cell) {
      let col = existing;
      if (!col) {
        col = buildSidebarButton(cell); // clone the CELL, so the clone IS a column
        cell.insertAdjacentElement('afterend', col);
      } else if (col.previousElementSibling !== cell) {
        // Re-anchor if Torn's renderer moved things (relocates, not clones; no-op if correct).
        cell.insertAdjacentElement('afterend', col);
      }
      // MOVE the badge, don't build one: it's created at init with real numbers, and
      // relocating the node keeps them. v2.8.3 built a fresh one here and it sat on "#"
      // until the next stats render.
      const badge = document.querySelector('.bustr-mobile-badge');
      if (badge && !col.contains(badge)) {
        const anchor = col.querySelector('a') || col;
        anchor.insertAdjacentElement('beforebegin', badge);
        recalcPenaltyScoreOnly(); // repaint, in case the badge wasn't painted before the move
      }
      // Stack the badge above the label. Tagged here rather than via Torn's hashed class
      // name; this is the badge's actual parent. Re-asserted every tick (Torn re-renders).
      if (badge && badge.parentElement) badge.parentElement.classList.add('bustr-col-inner');
      return;
    }

    if (list && jail) {
      // Best-effort placement: right after a "TornTools" entry, else the end of the list
      // (TornTools absent, or its wording differs). Its ".tt-settings" pill now lives in a
      // container outside the main nav list, so search the whole document for the class
      // (insertAdjacentElement works relative to the target's own parent). The text-scan
      // fallback stays list-scoped, for if the class name itself ever changes.
      const tornToolsItem = document.querySelector('.tt-settings')
        || [...list.children].find((child) => /torntools/i.test(child.textContent || ''));

      if (existing) {
        // Re-verify position every tick, not "insert once and forget": Torn's live-rendered
        // sidebar can reorder this tree around our manually-injected node, drifting it away
        // from its anchor (reported: it jumped from after TornTools to before it). Only moves
        // when genuinely out of place (relocates, not clones; cheap every tick).
        if (tornToolsItem && existing.previousElementSibling !== tornToolsItem) {
          tornToolsItem.insertAdjacentElement('afterend', existing);
        }
        return;
      }

      const li = buildSidebarButton(jail);
      if (tornToolsItem) {
        tornToolsItem.insertAdjacentElement('afterend', li);
      } else {
        list.appendChild(li);
      }
      return;
    }

    // No sidebar anchor on this page (e.g. the Attacking page has no left nav). Do nothing -
    // no floating fallback; settings are only reachable from the sidebar.
  }

  // Explanations for the "?" chips, kept out of the panel markup so it reads as controls,
  // not an essay.
  const HELP = {
    budget: ['Bust budget', 'How many more busts BUSTR thinks you can make before failure gets likely. This is the number on the Jail nav badge. It is completely separate from the per-target success %: nothing in this section ever changes a prisoner\'s odds, only the budget count and the colours.'],
    green: ['Green at', 'The nav badge and page tint turn green when your available-bust count is this number or higher. Default is 3.'],
    red: ['Red at / below', 'They turn red at this number or below. Default is 0, so red means the budget is spent. Anything between the red and green numbers shows orange.'],
    threshold: ['Custom threshold', 'Your penalty ceiling: how much bust penalty you can carry before BUSTR calls the budget spent. Leave it at 0 and BUSTR works this out from your own bust history, by finding the longest run of busts you have actually sustained. Set a number only if you want to override that estimate.'],
    refresh: ['Refresh rate', 'How often the on-screen numbers redraw, in seconds. This does NOT control how often BUSTR calls the Torn API. Those calls are throttled separately, to at most once every 35 seconds on the jail page and once every 30 minutes elsewhere, so lowering this costs you nothing in API usage. Minimum 15.'],
    scope: ['Active on', 'Anywhere: the nav badge and colours appear on every Torn page. Jail page only: hides them and pauses background checks everywhere except the jail page. Use it if the badge distracts you while doing other things.'],
    badge: ['Compact nav badge', 'On (default): the Jail nav badge shows how many more busts you can safely make (colour-coded by budget) plus your penalty %, which is coloured by severity - green when low, amber mid, red high, and a heavier red over 100%. Off: it also shows the raw penalty score / threshold prefix. Either way the full breakdown is always available by hovering the badge and in this panel\'s status line, so nothing is lost.'],
    display: ['Jail list display', 'These change only what the jail list shows and how it is sorted. The hardness score and the odds underneath are always calculated the same way regardless.'],
    hardness: ['Hardness number', 'Shows each prisoner\'s hardness score, which is their level multiplied by their remaining jail time plus three hours. Higher means harder to bust.'],
    sort: ['Sort easiest-first', 'Reorders the jail list so the easiest targets sit at the top. Torn\'s own order is by time remaining instead.'],
    quickactions: ['Quick actions', 'Optional. When on, BUSTR relabels Torn\'s own bust/bail link to its no-confirmation variant (the button gets a green highlight) so your single click skips the "are you sure?" step. BUSTR never clicks or busts for you - you still press every button yourself, one click per bust. This is the same mechanism the long-running TornTools extension uses. If you run TornTools, turn its own Quick Bust off to use this - the two act on the same link and conflict. Off by default; leave off if you prefer Torn\'s confirmation.'],
    easyactions: ['Easy actions', 'Optional and OFF by default. Adds a one-tap "Easy Bust" / "Easy Bail" button to the jail list header. Unlike Quick actions (which only relabel your own click), tapping this makes BUSTR send the request itself for the single best shown target - bust picks the highest success %, bail picks the cheapest. If a bust fails and that person is still in jail, the next tap retries the same person - until they are busted or no longer in jail - then moves on to the next best target. It is strictly one tap = one request, to the same jail page, with no looping or auto-repeat: the button does nothing until you tap it again, and you decide when to tap. Enabling asks for a one-time confirmation. Use at your own discretion.'],
    success: ['Show success %', 'Shows your estimated chance of busting each prisoner, from their hardness and your current penalty.'],
    sccolour: ['Success % colours', 'Colour thresholds for the per-target percentage: green at or above the first number, red below the second, orange in between. Display only, they never change the percentage itself.'],
    model: ['Success % model', 'These change the actual predicted number. When more than one applies the priority is: manual override wins, then self-calibration once it has enough data, then the perk baseline.'],
    cal: ['Skill calibration', 'Scales how skilled BUSTR assumes you are at busting. 1.0 means the full perk stack the model was built on (faction Bust Skill plus all LAW courses). Lower it if you have fewer perks, roughly 0.70 for faction perks only. Leave blank for automatic. Worth knowing: this only scales the target-difficulty half of the model, so it cannot compensate for penalty, and forcing it very low to "fix" failures will distort the odds on easy targets.'],
    selfcal: ['Self-calibration', 'Learns your real success curve from your own results. It records which prisoner you clicked Bust on and whether it worked, entirely on your own machine. It stays inactive until 100 usable samples exist, because fitting on fewer was measured to make predictions worse rather than better. Only used when the manual override above is blank.'],
    perkcal: ['Perk-based calibration', 'On by default. BUSTR estimates your skill from the bust perks it detects on your account, so an under-perked player is not shown the same odds as a fully-perked one. Validated against real pooled outcomes to improve the success % (most at low and mid penalty); it only affects the success number, never your penalty. Once self-calibration has enough of your own results it takes over. Turn this off to use the plain baseline of 1.0 instead. Torn does not publish how perks map to bust skill, so this is a grounded estimate rather than a measurement.'],
    playstyle: ['Play style', 'Changes when the colours flip, not the numbers underneath. Safety uses your thresholds as set. Max count shifts the bands so you spend longer in the orange zone, which raises daily bust volume at the cost of more failures and more jail time. Nothing is ever busted for you either way.'],
    exportHelp: ['Debug export', 'Copies a snapshot for the script maintainer to debug with: your level, settings, detected perks, current penalty, calibration, and logged bust history. Your API key is never included, and this script never reads your username, ID, or faction.'],
    apikey: ['API key', 'BUSTR needs three things from Torn: your level, your bust perks, and your own bust history. "Create a key for BUSTR" opens Torn\'s API page with exactly those (' + API_KEY_SELECTIONS + ') pre-ticked and nothing else, so the key cannot touch your money, mail, or faction. Generate it there, paste it here. The key is stored on this device only and sent nowhere except Torn\'s own API. On PDA the app supplies its own key; saving one here overrides it.'],
    cloudsync: ['Cloud sync', 'Off by default. When on, your bust history is backed up to a database and merged across your devices, tied to your verified Torn ID. What is stored: your bust stats (hardness, penalty, outcome, time), plus the context behind your predictions - your bust perks, level, calibration, BUSTR settings and script version - all so BUSTR\'s model can be improved across users. Never stored: your API key, name, ID, or faction. Turning it off deletes your cloud copy. Works on desktop and on Torn PDA (recent versions provide the cross-origin support it needs); where that is missing, the option shows as unavailable.'],
    reset: ['Reset settings', 'Puts every setting in this panel back to its default. Your saved API key and your logged bust history are both kept.'],
    wipe: ['Clear all data', 'Removes everything BUSTR has stored on this device: settings, saved API key, and your entire logged bust history. This cannot be undone.'],
  };

  function hideHelp() {
    const card = document.getElementById('bustr-help');
    if (card) card.classList.remove('bustr-open');
    document.querySelectorAll('.bustr-q.bustr-q-on')
      .forEach((el) => el.classList.remove('bustr-q-on'));
  }

  // Clicking the same chip again closes the card, so a chip is a toggle rather than
  // a one-way trip that leaves the user hunting for a close button.
  function showHelp(key, chipEl) {
    const card = document.getElementById('bustr-help');
    const entry = HELP[key];
    if (!card || !entry) return;
    const alreadyOpen = card.classList.contains('bustr-open') && chipEl.classList.contains('bustr-q-on');
    hideHelp();
    if (alreadyOpen) return;
    card.innerHTML = `<h4>${entry[0]}<span class="bustr-help-close" id="bustr-help-close">&times;</span></h4><div>${entry[1]}</div>`;
    card.classList.add('bustr-open');
    chipEl.classList.add('bustr-q-on');
    const closeEl = document.getElementById('bustr-help-close');
    if (closeEl) closeEl.addEventListener('click', hideHelp);
  }

  const q = (key) => `<span class="bustr-q" data-help="${key}" title="What is this?">?</span>`;

  // How long an armed destructive button stays armed: long enough for a deliberate second
  // tap, short enough not to catch an unrelated click later.
  const TWO_STEP_ARM_MS = 4000;

  // Turns a button into a two-tap confirm: first tap arms it and swaps the label, a second
  // within TWO_STEP_ARM_MS acts, else it disarms. Shared by every destructive button so
  // they can't drift apart. Not window.confirm(): that's reflexively dismissed and renders
  // badly in the PDA webview where these buttons are finger-sized and adjacent.
  function wireTwoStepButton(btn, restLabel, armedLabel, action) {
    if (!btn) return;
    let timer = null;
    btn.addEventListener('click', () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        action();
        return;
      }
      btn.textContent = armedLabel;
      timer = setTimeout(() => {
        timer = null;
        btn.textContent = restLabel;
      }, TWO_STEP_ARM_MS);
    });
  }

  function ensureSettingsPanelDom() {
    if (document.getElementById('bustr-settings-panel')) return;

    const backdrop = document.createElement('div');
    backdrop.id = 'bustr-settings-backdrop';
    backdrop.addEventListener('click', closeSettings);

    const panel = document.createElement('div');
    panel.id = 'bustr-settings-panel';
    panel.innerHTML = `
      <h3>BUSTR settings <span class="bustr-close" id="bustr-set-close">\u00d7</span></h3>
      <div class="bustr-status" id="bustr-set-status"></div>
      <div class="bustr-apierror" id="bustr-set-apierror" style="display:none"></div>

      <div class="bustr-section">Bust budget ${q('budget')}</div>
      <div class="bustr-row"><label>Green at (available busts) ${q('green')}</label><input type="number" id="bustr-set-green" min="0"></div>
      <div class="bustr-row"><label>Red at / below ${q('red')}</label><input type="number" id="bustr-set-red" min="0"></div>
      <div class="bustr-row"><label>Custom threshold (0 = auto) ${q('threshold')}</label><input type="number" id="bustr-set-threshold" min="0"></div>
      <div class="bustr-row"><label>Refresh rate (sec) ${q('refresh')}</label><input type="number" id="bustr-set-refresh" min="15"></div>
      <div class="bustr-row"><label>Active on ${q('scope')}</label>
        <select id="bustr-set-scope">
          <option value="always">Anywhere (always)</option>
          <option value="jailOnly">Jail page only</option>
        </select>
      </div>
      <div class="bustr-row"><label>Compact nav badge ${q('badge')}</label><input type="checkbox" id="bustr-set-badgesimple"></div>
      <hr>

      <div class="bustr-section">Jail list display ${q('display')}</div>
      <div class="bustr-row"><label>Show hardness number ${q('hardness')}</label><input type="checkbox" id="bustr-set-hardness"></div>
      <div class="bustr-row"><label>Sort easiest-first ${q('sort')}</label><input type="checkbox" id="bustr-set-sort"></div>
      <div class="bustr-row"><label>Easy bust (BUSTR fires it) ${q('easyactions')}</label><input type="checkbox" id="bustr-set-easybust"></div>
      <div class="bustr-row"><label>Easy bail (BUSTR fires it)</label><input type="checkbox" id="bustr-set-easybail"></div>
      <div class="bustr-row"><label>Show success % ${q('success')}</label><input type="checkbox" id="bustr-set-success"></div>
      <div class="bustr-row"><label>Success green at % ${q('sccolour')}</label><input type="number" id="bustr-set-scgreen" min="0" max="100"></div>
      <div class="bustr-row"><label>Success red below %</label><input type="number" id="bustr-set-scred" min="0" max="100"></div>
      <hr>

      <div class="bustr-section">Success % model ${q('model')}</div>
      <div class="bustr-row"><label>Skill calibration (manual override) ${q('cal')}</label><input type="number" id="bustr-set-cal" min="0" max="2" step="0.05"></div>
      <div class="bustr-row"><label>Self-calibration (learn from my outcomes) ${q('selfcal')}</label><input type="checkbox" id="bustr-set-selfcal"></div>
      <div class="bustr-hint" id="bustr-set-selfcal-stats">No outcomes logged yet.</div>
      <button type="button" class="bustr-btn" id="bustr-set-selfcal-clear">Clear outcome log</button>
      <div class="bustr-row"><label>Use perk-based calibration ${q('perkcal')}</label><input type="checkbox" id="bustr-set-useperkcal"></div>
      <div class="bustr-hint" id="bustr-set-perk-impact"></div>
      <button type="button" class="bustr-btn" id="bustr-set-force-update">Force update level/perks now</button>
      <hr>

      <div class="bustr-section">Play style ${q('playstyle')}</div>
      <div class="bustr-row"><label>Play style</label>
        <select id="bustr-set-playstyle">
          <option value="safety">Safety (recommended)</option>
          <option value="maxcount">Max count (aggressive)</option>
        </select>
      </div>
      <hr>

      <div class="bustr-section">API key ${q('apikey')}</div>
      <div class="bustr-hint" id="bustr-set-apikey-state"></div>
      <div id="bustr-set-apikey-entry">
        <a class="bustr-btn bustr-btn-link" id="bustr-set-apikey-make" href="${API_KEY_CREATE_URL}" target="_blank" rel="noopener noreferrer">Create a key for BUSTR</a>
        <div class="bustr-hint">Opens Torn's API page with only the ${API_KEY_SELECTIONS} boxes already ticked. Generate it there, then paste it below.</div>
        <!-- NOT type="password": that makes the browser's password manager offer to
             save/fill it and autofill nearby boxes (reported), and autocomplete=off is
             ignored on password fields. Masked with -webkit-text-security instead; the
             data-*ignore hints tell 3rd-party managers to skip it. -->
        <input type="text" id="bustr-set-apikey" placeholder="Paste your API key"
          autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
          data-lpignore="true" data-1p-ignore data-bwignore data-form-type="other"
          style="width:100%;box-sizing:border-box;margin:4px 0;-webkit-text-security:disc;">
        <button type="button" class="bustr-btn" id="bustr-set-apikey-save">Save key</button>
      </div>
      <a class="bustr-btn bustr-btn-link" id="bustr-set-apikey-override" href="#" style="display:none;">Not working? Use your own key instead</a>
      <button type="button" class="bustr-btn" id="bustr-set-apikey-clear">Clear saved key</button>
      <hr>

      <div class="bustr-section">Cloud sync ${q('cloudsync')}</div>
      <div class="bustr-hint" id="bustr-cloud-status"></div>
      <div class="bustr-row"><label>Sync my bust history</label><input type="checkbox" id="bustr-set-cloudsync"></div>
      <div class="bustr-hint">Off by default. Backs up your bust history plus the perks, level, calibration and BUSTR settings behind your predictions, tied to your Torn ID (used to improve BUSTR's model). Never your API key. Works on desktop and on Torn PDA.</div>
      <button type="button" class="bustr-btn" id="bustr-set-cloud-delete">Delete my cloud data</button>
      <hr>

      <div class="bustr-section">Debug export ${q('exportHelp')}</div>
      <button type="button" class="bustr-btn" id="bustr-set-export">Copy debug export</button>
      <textarea id="bustr-set-export-area" readonly style="display:none;width:100%;height:80px;margin-top:6px;background:#1a1a1a;color:#ddd;border:1px solid #444;border-radius:4px;font-size:10px;padding:4px;box-sizing:border-box;"></textarea>
      <hr>

      <div class="bustr-section">Reset</div>
      <div class="bustr-btn-row"><button type="button" class="bustr-btn" id="bustr-set-reset">Reset settings only</button>${q('reset')}</div>
      <div class="bustr-btn-row"><button type="button" class="bustr-btn bustr-danger" id="bustr-set-wipe">Erase all BUSTR data</button>${q('wipe')}</div>`;

    // One shared help card for every chip, appended to body so it can sit outside the
    // panel's bounds and scroll container.
    const help = document.createElement('div');
    help.id = 'bustr-help';

    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
    document.body.appendChild(help);

    // Delegated, so chips added later need no extra wiring. CAPTURE phase (the `true`) is
    // not a detail: in the bubble phase a control's own handler would run first, too late
    // for stopPropagation() - a "?" chip inside a <button> then fired it (v2.11.0: the chip
    // on "Reset settings only" really reset settings). Chips are no longer nested in buttons
    // (the structural fix); capture is belt-and-braces so it can't recur.
    panel.addEventListener('click', (e) => {
      const chip = e.target.closest ? e.target.closest('.bustr-q') : null;
      if (!chip) return;
      e.preventDefault();
      e.stopPropagation();
      showHelp(chip.dataset.help, chip);
    }, true);

    const byId = (id) => document.getElementById(id);

    populateSettingsPanelInputs(); // initial fill; also re-run every time the panel opens (see openSettings)

    byId('bustr-set-close').addEventListener('click', closeSettings);

    // Wire inputs (each persists then re-applies live)
    byId('bustr-set-green').addEventListener('change', (e) => { updateLimit('greenLimit', Math.max(0, numOr(e.target, 3))); applySettings(); });
    byId('bustr-set-red').addEventListener('change', (e) => { updateLimit('redLimit', Math.max(0, numOr(e.target, 0))); applySettings(); });
    byId('bustr-set-threshold').addEventListener('change', (e) => { updateSetting('customPenaltyThreshold', Math.max(0, numOr(e.target, 0))); applySettings(); refreshSettingsStatus(); });
    byId('bustr-set-refresh').addEventListener('change', (e) => { updateSetting('statsRefreshRate', Math.max(15, numOr(e.target, DEFAULT_REFRESH_SECONDS))); startRefreshLoops(); });
    byId('bustr-set-hardness').addEventListener('change', (e) => { updateSetting('showHardnessScore', e.target.checked); applySettings(); });
    byId('bustr-set-sort').addEventListener('change', (e) => { updateSetting('sortByHardness', e.target.checked); applySettings(); });
    byId('bustr-set-easybust').addEventListener('change', (e) => { handleEasyToggle('easyBust', e.target); });
    byId('bustr-set-easybail').addEventListener('change', (e) => { handleEasyToggle('easyBail', e.target); });
    byId('bustr-set-success').addEventListener('change', (e) => { updateSetting('showSuccessChance', e.target.checked); applySettings(); });
    byId('bustr-set-scgreen').addEventListener('change', (e) => { updateSetting('successGreenAt', clampPct(numOr(e.target, SC_GREEN_AT))); applySettings(); });
    byId('bustr-set-scred').addEventListener('change', (e) => { updateSetting('successRedBelow', clampPct(numOr(e.target, SC_RED_BELOW))); applySettings(); });
    byId('bustr-set-cal').addEventListener('change', (e) => {
      const raw = e.target.value.trim();
      const v = raw === '' ? null : Math.max(0, parseFloat(raw) || 0);
      updateSetting('skillCalibrationOverride', (v && v > 0) ? v : null);
      applySettings();
      refreshSettingsStatus();
    });
    byId('bustr-set-selfcal').addEventListener('change', (e) => {
      updateSetting('selfCalibrationEnabled', e.target.checked);
      applySettings();
      refreshSettingsStatus();
    });
    byId('bustr-set-playstyle').addEventListener('change', (e) => {
      updateSetting('playStyle', e.target.value === 'maxcount' ? 'maxcount' : 'safety');
      applySettings();
    });
    byId('bustr-set-scope').addEventListener('change', (e) => {
      updateSetting('activeScope', e.target.value === 'jailOnly' ? 'jailOnly' : 'always');
      applySettings();
    });
    byId('bustr-set-badgesimple').addEventListener('change', (e) => {
      updateSetting('navBadgeDetail', e.target.checked ? 'simple' : 'full');
      applySettings();
    });
    byId('bustr-set-useperkcal').addEventListener('change', (e) => {
      updateSetting('usePerkCalibration', e.target.checked);
      skillCalibration = calibrationFromBustPerksRespectingSettings(getGlobalBustrState().bustPerks);
      applySettings();
      refreshSettingsStatus();
      refreshPerkImpactDisplay();
    });
    byId('bustr-set-force-update').addEventListener('click', (e) => forceProfileRefresh(e.target));

    // One-way diagnostic export, no Import: settings are changed in the panel directly, so
    // this button just produces something to hand a maintainer for debugging.
    byId('bustr-set-export').addEventListener('click', () => {
      const area = byId('bustr-set-export-area');
      area.value = JSON.stringify(buildDiagnosticExport(), null, 2);
      area.style.display = 'block';
      area.focus();
      area.select();
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(area.value);
      } catch (err) { /* clipboard API unavailable (e.g. PDA) - textarea is already selected for manual copy */ }
    });

    // Buttons (user-initiated, so destructive ones just act)
    // Saving a key must also release the fatalKeyError latch (set on Torn reject code 2/16,
    // which stops loadController calling the API): without clearing it, a CORRECT key would
    // fetch nothing until a reload, looking exactly like the key being wrong again.
    byId('bustr-set-apikey-save').addEventListener('click', () => {
      const input = byId('bustr-set-apikey');
      const key = (input.value || '').trim();
      if (!key) return;
      setApiKey(key);
      input.value = '';
      fatalKeyError = false;
      apiKeyEntryForced = false; // saved override now wins; collapse back to the status line
      setGlobalBustrState({ lastApiError: null });
      refreshApiKeyState();
      refreshSettingsStatus();
      loadController();
      forceProfileRefresh(); // re-read level/perks under the new key too
    });
    // Escape hatch when PDA's injected key is active but the user wants their own: reveal
    // the collapsed paste field. The latch keeps it open until a key is saved or reopened.
    const overrideLink = byId('bustr-set-apikey-override');
    if (overrideLink) overrideLink.addEventListener('click', (e) => {
      e.preventDefault();
      apiKeyEntryForced = true;
      refreshApiKeyState();
      const input = byId('bustr-set-apikey');
      if (input) input.focus();
    });
    byId('bustr-set-apikey-clear').addEventListener('click', () => {
      deleteApiKey();
      fatalKeyError = false;
      apiKeyEntryForced = false;
      setGlobalBustrState({ lastApiError: null });
      refreshApiKeyState();
      refreshSettingsStatus();
      loadController();
    });

    // Cloud sync. Turning ON asks consent BEFORE any sign-in/upload; cancel or failure
    // reverts the box so it never lies about state.
    const cloudBox = byId('bustr-set-cloudsync');
    if (cloudBox) {
      if (!hasGMXhr) cloudBox.disabled = true; // inert without GM_xmlhttpRequest
      cloudBox.addEventListener('change', async (e) => {
        if (e.target.checked) {
          const ok = await showCloudConsent();
          if (!ok) { e.target.checked = false; return; }
          refreshCloudStatus('Enabling...');
          try {
            await CloudSync.enable();
            refreshCloudStatus();
          } catch (err) {
            e.target.checked = false;
            refreshCloudStatus('Could not enable: ' + (err && err.message ? err.message : err));
          }
        } else {
          refreshCloudStatus('Turning off and deleting cloud copy...');
          try { await CloudSync.disableAndDelete(); } catch (err) { /* local flag already off; ignore */ }
          refreshCloudStatus();
        }
      });
    }
    // "Delete my cloud data": two-tap, and turns sync off (else the next bust re-uploads).
    wireTwoStepButton(byId('bustr-set-cloud-delete'),
      'Delete my cloud data', 'Tap again to delete it',
      async () => {
        refreshCloudStatus('Deleting cloud copy...');
        try { await CloudSync.disableAndDelete(); } catch (err) { /* ignore */ }
        const cb = byId('bustr-set-cloudsync'); if (cb) cb.checked = false;
        refreshCloudStatus();
      });

    // No "Re-enter API key" button any more: it did exactly what "Clear saved key"
    // above does (delete the stored key), just with a page reload, and having both
    // in the same panel made it look like one of them did something else.
    // Every irreversible action gets the same two-tap confirm (see wireTwoStepButton).
    // "Clear saved key" is deliberately NOT in this list: re-pasting a key is trivial,
    // and it is the recovery path when a key is wrong, so slowing it down would get in
    // the way at exactly the moment someone is trying to fix something.
    wireTwoStepButton(byId('bustr-set-reset'),
      'Reset settings only', 'Tap again to reset settings',
      () => { setUserSettings(defaultState().userSettings); window.location.reload(); });

    wireTwoStepButton(byId('bustr-set-wipe'),
      'Erase all BUSTR data', 'Tap again to erase everything',
      () => { deleteApiKey(); deleteGlobalBustrState(); window.location.reload(); });
    // Also two-step: this discards every logged outcome (the self-calibration data, months
    // of play), the same history "Erase all" destroys, so it gets the same protection.
    wireTwoStepButton(byId('bustr-set-selfcal-clear'),
      'Clear outcome log', 'Tap again to clear the log',
      () => {
        setGlobalBustrState({ outcomeLog: [], selfCalibrationValue: null });
        refreshSettingsStatus();
      });

    refreshSettingsStatus();
  }

  // Perk-based calibration (ON by default since v2.17.0, validated on cloud data). Derived
  // from the detected bust-skill bonus relative to a full 115% stack; a grounded estimate,
  // not a published formula, but better than assuming everyone is fully perked. Applies only
  // to the success/skill term. Off (or overridden by the manual setting) returns baseline 1.0.
  function calibrationFromBustPerksRespectingSettings(bustPerks) {
    if (!getUserSettings().usePerkCalibration) return CAL_CEILING;
    // Parse-confidence guard: a bust perk carrying a % that we couldn't classify as offense
    // (likely a missed skill perk in new/localised wording) makes the sum unreliable, so
    // fall back to baseline rather than over-pessimise. No-% utility perks don't trip this.
    if (unclassifiedBustPerks(bustPerks).some((p) => /[\d.]+\s*%/.test(p))) return CAL_CEILING;
    return calibrationFromPerks(bustPerks);
  }

  // Shared by the daily-TTL auto path and the "force update" button, so they can't drift.
  async function fetchAndApplyProfile() {
    const data = await fetchProfileData(getApiKey());
    if (data.level) setPlayerLevel(data.level);

    const bustPerks = extractBustPerks(data);
    skillCalibration = calibrationFromBustPerksRespectingSettings(bustPerks);
    setGlobalBustrState({ bustPerks, lastProfileFetchMs: Date.now() });
    CloudSync.pushSoon(); // back up changed perks/level if sync is on (no-op otherwise)
    log('Level', getPlayerLevel(), '| bust bonus', sumBustSkillBonus(bustPerks) + '%',
      '| calibration', getSkillCalibration().toFixed(2), '| perks:', bustPerks);
    refreshSuccessChances(); // repaint now the real level is in
    refreshPerkImpactDisplay(); // perk data changed; update the panel comparison if open

    if (bustPerks.length === 0) {
      console.warn('[BUSTR] No bust perks detected from the API, so the success % is biased conservative. If you run bust perks, set a Skill calibration in the Settings panel, or share your detected perks so the parser can be tuned.');
    }
    const unclassified = unclassifiedBustPerks(bustPerks);
    if (unclassified.length > 0) {
      console.warn('[BUSTR] Detected bust-related perk(s) with unrecognized wording (not counted toward calibration): ' + JSON.stringify(unclassified) + '. Share these so the offense/defense/nerve patterns can be tightened.');
    }
  }

  async function profileController() {
    if (getApiKey() === undefined) return;

    // Apply calibration immediately from the last cached perks
    skillCalibration = calibrationFromBustPerksRespectingSettings(getGlobalBustrState().bustPerks);

    // Skip the network call if level/perks were pulled recently
    const sinceProfile = Date.now() - (getGlobalBustrState().lastProfileFetchMs || 0);
    if (sinceProfile < PLAYER_INFO_TTL_MS && getGlobalBustrState().lastProfileFetchMs) {
      refreshSuccessChances();
      return;
    }

    try {
      await fetchAndApplyProfile();
    } catch (err) {
      recordApiError('level/perks', err);
      console.error('[BUSTR] profile fetch failed', err);
    }
  }

  // "Force update" button: bypass the daily TTL, e.g. right after levelling up so
  // hardness/success % reflect it now instead of waiting up to 24h.
  async function forceProfileRefresh(buttonEl) {
    if (getApiKey() === undefined) return;
    if (buttonEl) { buttonEl.disabled = true; buttonEl.textContent = 'Updating...'; }
    try {
      await fetchAndApplyProfile();
      refreshSettingsStatus();
      if (buttonEl) buttonEl.textContent = 'Updated!';
    } catch (err) {
      recordApiError('level/perks', err); // surface it in the panel, not just the console
      refreshSettingsStatus();
      console.error('[BUSTR] forced profile refresh failed', err);
      if (buttonEl) buttonEl.textContent = 'Update failed - retry';
    } finally {
      if (buttonEl) {
        setTimeout(() => {
          buttonEl.disabled = false;
          buttonEl.textContent = 'Force update level/perks now';
        }, 2000);
      }
    }
  }

  // PDA injects after window.onload, so race a readyState check against the load event
  const PDAPromise = new Promise((res) => {
    if (document.readyState === 'complete') res();
  });
  const browserPromise = new Promise((res) => {
    window.addEventListener('load', () => res());
  });

  (async function () {
    try {
      await Promise.race([PDAPromise, browserPromise]);

      migrateFromLegacyStorage();
      loadGlobalBustrState();
      sanitizeOutcomeLog(); // strip synthetic/test rows before they sync or reach the stats
      CloudSync.initFromLoad(); // pull+merge cloud history if sync is on (no-op otherwise)
      // Restore the cached level so the success model is right before the API replies
      if (typeof getGlobalBustrState().playerLevel === 'number') {
        playerLevel = getGlobalBustrState().playerLevel;
      }

      await initController();
      // Paint the cached numbers immediately, before the network fetch below. initController()
      // just created the nav badge with "#" placeholders; loadGlobalBustrState() restored the
      // cached penaltyScore/threshold/timestamps but nothing painted them yet. Since Torn
      // reloads the script every navigation, without this the "#" showed for a full API
      // round-trip on every page change. recalcLocally() is a free local recompute (no-ops if
      // nothing is cached).
      // The UI is set up BEFORE any network call, never behind an await on one: this used to
      // sit after `await loadController()`, so a bad/blank key that rejected took down the
      // whole interface - including the settings panel where the key is fixed. Nothing below
      // may depend on the API having succeeded.
      const onJail = window.location.pathname === '/jailview.php';
      if (SHOW_SETTINGS_PANEL) ensureSettingsUi(); // sidebar button / nav column on every page

      // Apply jail-only suppression immediately, not on the first interval tick
      // (30-60s later). Returns true when in jail-only mode AND off the jail page.
      const inactive = applyActiveScope(onJail);

      // These run in every state. They are cheap, they keep the settings button
      // re-anchored if Torn re-renders its nav, and they pick up navigation. None of
      // them fetch or scan on their own.
      startRefreshLoops();
      attachVisibilityResync();
      viewportResizeController();

      // Jail page only + off the jail page: the settings button is all that should
      // exist. Skip every fetch, recompute, page scan and observer. In "always" mode
      // `inactive` is never true, so the penalty display below still updates everywhere.
      if (inactive) return;

      // In "always" mode this runs on every page, so the nav badge shows and decays while
      // you do other things; in jail-only mode it's reached only on the jail page.
      recalcLocally(); // paint the badge from cached log + decay - correct everywhere, no API call
      // Only the jail page hits the API: off it the cached log + decay is already correct
      // (busts only happen on jail), so no log/profile request while browsing the rest of
      // Torn. loadController still guards its own errors so a bad key can't abort init.
      if (onJail) {
        try {
          await loadController();
        } catch (err) {
          console.error('[BUSTR] initial load failed (UI is already up)', err);
        }
        profileController(); // fire-and-forget: level + perks, once (daily-throttled inside)
      }

      // Jail-page machinery only: hardnessScoreController self-guards to jail, the bust
      // observer arms only there, and passive click capture is gated too. Off jail in
      // "always" mode, only the penalty display above stays live.
      hardnessScoreController();
      ensureBustObserver(onJail);
      if (onJail) attachBustClickListener(); // passive only - see COMPLIANCE NOTE at top of file
    } catch (err) {
      console.error('[BUSTR]', err);
    }
  })();
})();