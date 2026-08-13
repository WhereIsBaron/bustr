// ==UserScript==
// @name         BUSTR: Jail Bust Assistant + PDA (Baron)
// @namespace    http://torn.city.com.dot.com.com
// @version      2.17.1
// @description  Shows your success odds on every jailed target, and how many busts you can make before failure gets likely
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

// Security/reliability-hardened build. See CHANGELOG.md for full version history.
//
// ---------------------------------------------------------------------------
// COMPLIANCE NOTE (read this before adding anything new):
// This script is a read-only assistant: it fetches your OWN data from the
// official Torn API, reads what's already rendered on the page, and displays
// numbers and colours. It never performs a game action on your behalf - no
// `.click()`, no synthetic/dispatched events, no form submission of anything
// but your own API key into this script's own storage. The self-calibration
// feature below listens for clicks the PLAYER makes (passive observation) to
// log outcomes locally; it does not simulate or trigger any bust attempt.
// Keep it that way. Anything that would press the bust button for the user
// crosses from "assist tool" into "bot" under Torn's rules and must not be
// added here.
// ---------------------------------------------------------------------------

(() => {
  'use strict';

  ////////////////////////////////////////////////////////////////////////////
  ////  CONFIG / CONSTANTS
  ////////////////////////////////////////////////////////////////////////////

  const DEBUG = false; // set true while debugging to re-enable console logs
  const SCRIPT_VERSION = '2.17.1'; // keep in sync with the @version header above - stamped into diagnostic exports

  // Penalty model. Matches the documented in-game mechanic: each bust adds a
  // penalty that decays hyperbolically as P0 / (1 + c*t), losing half at 10h and
  // hard-cutting to zero at 72h. PENALTY_PER_BUST is a proxy unit (P0); its
  // absolute value cancels out of the available-busts maths, only the curve shape
  // and the 72h window matter here.
  //
  // VALIDATED against the source "Advanced Jail Bust Guide" (Nosy): its formula
  // image confirms Penalty(t) = P0/(1+c*t); its own measured-vs-estimated charts
  // for two real testers (L53 over ~30h, L61 over ~95h) show this model tracking
  // real bust outcomes to within ~1%, matching the guide's own claimed accuracy.
  // A separate third-party forum post independently audited BUSTR specifically and
  // confirmed its *original* exponential-decay formula (128/2^(t/7.2)) was wrong
  // for exactly this reason - this hyperbolic form is the fix, already applied
  // here, and is what that audit was asking for.
  const PENALTY_PER_BUST = 128;
  const PENALTY_WINDOW_HOURS = 72;
  const PENALTY_DECAY_C = 0.1; // per hour -> half the penalty gone at t = 10h
  // Torn's log API returns your most recent bust entries regardless of age, not a
  // fixed recent window - a light buster's "last 100 busts" can span years. Any
  // bust past PENALTY_WINDOW_HOURS already contributes 0 to penaltyScore, but
  // calcPenaltyThreshold's "longest safe streak" search has no such cutoff and can
  // lock onto an ancient burst from a much lower level/different perks, which
  // doesn't reflect current capability. Prune to this window before anything else
  // ever sees the array.
  const RECENT_HISTORY_WINDOW_DAYS = 30;

  // --- Success-chance model (reverse-engineered in the community busting guide) ---
  // Per-target odds: success% = A - (B*60/skill)*hardness - penalty%, clamped 0..100,
  // where skill = your level * skillCalibration.
  // Level and perks are read from the Torn API (basic + perks selections) once a day
  // and cached. skillCalibration scales your detected bust-skill bonus against the
  // fully-perked buster the guide's constants were fit on (faction Bust Skill X = 50%
  // plus all LAW courses = 65%, total 115%). Matching that 115% gives 1.0; less gives
  // proportionally less. This treats Torn's own "% bust skill" figures as additive and
  // the law-firm perk as non-skill (its 10* is just the success-chance viewer). The
  // exact perk-to-skill mapping is NOT published, so this is a grounded estimate that
  // self-calibration (logging real outcomes) will eventually replace.
  // Set SKILL_CALIBRATION_OVERRIDE to a number to force it.
  const SHOW_SUCCESS_CHANCE = true;
  const SHOW_SETTINGS_PANEL = true;        // floating settings panel on the jail page
  const PLAYER_INFO_TTL_MS = 24 * 60 * 60 * 1000; // re-read level/perks from the API at most daily
  const PLAYER_LEVEL_FALLBACK = 100;       // used only until the API fills it in
  const SKILL_CALIBRATION_OVERRIDE = null; // set a number (e.g. 0.9) to force it; null = auto from perks
  const FULL_BUST_SKILL_BONUS = 115;       // full stack: faction 50% + education 65%
  const CAL_CEILING = 1.0;                 // clamp ceiling for the auto calibration
  const CAL_FLOOR = 0.4;                   // clamp floor
  const CAL_NO_PERKS = 0.85;               // fallback when the API returns no bust perks at all
  // VALIDATED against the guide's own formula image: success% = a - b*(difficulty/skill)
  // - penalty, where difficulty = target_level*(time_minutes+180) - i.e. our hardness
  // (computed in HOURS) times 60 to convert to the guide's minutes, divided by skill.
  // That's exactly SUCCESS_B * 60 / skill * hardness below - confirmed structurally
  // correct, not just dimensionally plausible.
  const SUCCESS_A = 266.6;           // guide constant (level/perk independent)
  // The guide's TEXT states b = 0.427, but that contradicts its own no-penalty
  // scatter plot (multiple testers, all on one line once normalized by raw level:
  // ~100% success at difficulty/skill ~= 580, ~0% at ~= 950). Solving a=266.6 against
  // those two endpoints gives b in the 0.27-0.29 range, not 0.427 (which predicts
  // ~19% at the point the chart shows ~100% - off by 80 points). The guide's stated
  // 0.427 appears to be an error in the original text; the plotted data is the more
  // reliable source and is what this constant is fit to.
  const SUCCESS_B = 0.28;            // chart-derived slope (per minute)
  // VALIDATED: a level-61 full-perk tester's measured fresh penalty was ~17%
  // (per the guide's own "recovery from one bust" chart). 1037/61 = 17.0% - matches.
  const PENALTY_PCT_ANCHOR = 1037;   // P0% * level (level-61 tester showed ~17% fresh)
  // Colour thresholds for the per-target %
  const SC_GREEN_AT = 66;
  const SC_RED_BELOW = 33;

  // --- Penalty weighting (v2.8.0: replaces the old "high-penalty caution" guardrail) ---
  // The guide's formula is purely additive and counts penalty at face value:
  // success = A - hardness_term - penalty. Measured against real logged outcomes,
  // that under-weights penalty by about 2x. The old guardrail tried to patch this
  // by re-weighting only the EXCESS above a 100% threshold, which had two failures:
  // it did nothing at all in the 40-100% band where plenty of real failures happen,
  // and above the threshold its learned weight (fitted as high as 8) crushed every
  // target to the 1% floor even though those attempts really succeed ~27% of the time.
  //
  // Replaced by a single always-on multiplier. Fitted against 38 clean logged
  // outcomes, the optimum is sharp and sits at 2.0 (1.5 -> Brier 0.244, 2.0 -> 0.141,
  // 2.5 -> 0.222). Cross-checked by letting a grid search choose BOTH the skill
  // calibration and this weight with no constraints: it independently lands on
  // calibration 1.00 (i.e. the perk-derived value) and weight 1.95, which is this
  // model. That agreement is the main evidence the shape is right and not just tuned.
  const PENALTY_WEIGHT = 2.0;
  // PENALTY_WEIGHT re-validated in v2.10.0 against a second, fully disjoint batch of
  // 43 logged outcomes: batch 1 fits W=1.95, batch 2 fits W=2.25, pooled (n=81)
  // W=2.15. Two independent datasets bracketing 2.0 is the strongest confirmation
  // this constant has had; the pooled optimum's gain over 2.0 is ~0.007 Brier, i.e.
  // noise. Do not chase it.

  // Penalty SATURATION (v2.16.0). The linear -W*penalty term is correct up to moderate
  // penalty but keeps subtracting without bound at high penalty, which floored every
  // high-penalty prediction to the shrink floor (~16%). The first cross-user cloud data
  // (134 reconstructable outcomes, 10 players) showed that is badly wrong: busts at
  // 130-230% penalty actually succeed ~40-55%, and the current model scored Brier 0.30 -
  // WORSE than predicting the base rate (0.24). Penalty's real effect plateaus. Capping
  // the penalty% that feeds the term restores calibration: leave-one-out picked a cap of
  // ~91-97% (stable with AND without the single heaviest player), dropping LOO Brier to
  // ~0.23. Shipped at 95%. This also lets self-calibration work at high penalty again -
  // before, it maxed out uselessly because the penalty term, which it cannot touch, was
  // doing the flooring. REFINE the exact cap as more lvl/cal-stamped data accumulates.
  const PENALTY_SATURATION_PCT = 95;

  // --- Prediction calibration shrink (v2.10.0) ---
  // The linear model DISCRIMINATES correctly - higher predictions really do succeed
  // more often - but it is overconfident in both directions. Pooled reliability over
  // 81 logged outcomes: where it said 99% reality was 85%; said 83% -> 68%; said 69%
  // -> 50%; said 7% -> 29%. Monotonic, so the ordering is right; only the magnitude
  // is wrong, spread too wide from the centre.
  //
  // Fix: after the raw score is computed and clamped, pull it toward a centre:
  //   shown = CENTER + K * (raw - CENTER)
  // With K=0.65 / CENTER=45 the displayed range becomes roughly 16%..81%, which is
  // honest: the best-looking targets in the data succeed ~85% of the time, not 100%,
  // and the worst still succeed ~29%, not 1%. This deliberately means the script
  // will never show 100% again - that is a feature, not a regression; 100% was a
  // promise the data shows it could not keep.
  //
  // Validation, because in-sample improvement alone is how the v2.8.0 raised-floor
  // mistake happened (in-sample 0.136, leave-one-out 0.173 - pure overfitting):
  // this one PASSES leave-one-out. Pooled Brier 0.2164 -> 0.1970 in-sample, and
  // 0.2164 -> 0.2018 under leave-one-out with k and centre refit on every fold.
  // Constants are FIXED here, not fitted per player: the whole lesson of v2.8.0 is
  // that free parameters at n~40-80 buy noise, not accuracy.
  const PRED_SHRINK_K = 0.65;    // fraction of the raw spread that survives
  const PRED_SHRINK_CENTER = 45; // %, the pivot predictions are pulled toward

  // --- Self-calibration (learns YOUR real success curve from logged outcomes) ---
  // Passive only: built from clicks the player makes and the bust-result text Torn
  // already renders. Never simulates input. See the COMPLIANCE NOTE at the top.
  const OUTCOME_LOG_MAX = 500;           // cap on stored attempts (oldest dropped first) - this, not
  // RECENT_HISTORY_WINDOW_DAYS, is what actually limits self-calibration's history: it's a count cap,
  // not a day-based one, and only ever grows forward from whenever self-calibration was enabled - it
  // can't be backfilled from Torn's own bust log, which doesn't record what was predicted at the time.
  //
  // These bounds are deliberately tight, and that is the whole lesson of v2.7.19/v2.8.0.
  // Leave-one-out cross-validation on real data showed self-calibration ACTIVELY HURTING
  // at small sample counts: fitting calibration scored worse out-of-sample (Brier 0.148)
  // than not fitting at all and just using the perk-derived value (0.141), and fitting
  // more free parameters was worse still (0.164). It was fitting noise, not skill.
  // Worse, the old floor of 0.3 let it collapse onto a value that was pure pathology:
  // calibration only scales the hardness term, so it CANNOT explain failures that are
  // really caused by penalty, and it "explained" them anyway by making hardness brutal.
  // So: a floor/ceiling near the physically plausible perk range (it should never stray
  // far from a real perk-derived skill), and a sample count high enough that the fit is
  // reacting to a real curve rather than to a bad afternoon.
  const SELF_CAL_MIN_SAMPLES = 100;     // don't trust a fit smaller than this (was 15: far too few, it overfit)
  const SELF_CAL_FLOOR = 0.6;           // search/clamp range for the fitted calibration (was 0.3: allowed a pathological collapse)
  const SELF_CAL_CEILING = 1.4;         // stays near the physically plausible perk range
  const SELF_CAL_STEP = 0.02;           // grid-search resolution
  const PENDING_ATTEMPT_TIMEOUT_MS = 20 * 1000; // discard a click if no result follows in time

  // --- Scoped API key creation ---
  // Torn's preferences page accepts a pre-filled "create key" link, so a new user can
  // be handed a key request with the exact selections already ticked instead of being
  // told to go and find the right boxes themselves.
  //
  // The selections listed here are the COMPLETE set this script calls, and nothing
  // more - `basic` (level), `perks` (bust perks), `log` (your own bust history, read
  // with log=5360). Keep this in sync with fetchBustsData/fetchProfileData; if a new
  // selection is ever added there it must be added here too, or new users will get a
  // key that silently cannot serve it.
  //
  // This deliberately replaces the old "paste a Full Access key" instruction. A Full
  // Access key grants everything - money, mail, events, faction controls - and BUSTR
  // reads three things. Asking for the minimum is worth the extra constant, and it
  // limits the blast radius if a key is ever leaked from local storage.
  // SEPARATOR: "?" after "#tab=api", then "&" between the parameters after that:
  //   #tab=api?step=addNewKey&title=BUSTR&user=...
  // This is not a typo and must not be "corrected" to "&step=". Everything after the
  // "#" is one fragment string, and Torn's own handler splits it on "?" to separate
  // the tab name from that tab's parameters. Write "&step=" and the tab value parses
  // as the entire rest of the string, the step parameter is never found, and the user
  // lands on a bare API page with nothing pre-ticked - a silent failure that ends with
  // them creating a Full Access key instead, defeating the point of the link.
  // Verified the wrong way round in v2.12.1: "&" was tried and confirmed broken.
  const API_KEY_SELECTIONS = 'basic,log,perks';
  const API_KEY_CREATE_URL =
    'https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=BUSTR&user=' + API_KEY_SELECTIONS;

  // Stamped onto every outcome logged from v2.8.0 on. Entries recorded before the
  // v2.7.19 penalty decoupling froze a penalty% that was computed with the
  // self-calibrated skill in its denominator, so their `pen` is inflated (a real
  // export showed 300% where the true figure was 90%) and is NOT comparable to
  // anything logged since. Unstamped legacy entries are therefore kept for the
  // on-screen history and stats, but excluded from the fit - feeding them back in
  // would re-derive the calibration from corrupted penalties and reintroduce the
  // exact bug v2.7.19 fixed.
  const OUTCOME_MODEL_VERSION = 2;

  // --- Play style (display-only: shifts colour thresholds, never acts for you) ---
  // 'safety' uses the settings panel's thresholds as-is. 'maxcount' is an opt-in
  // preset for volume grinders riding the edge of the penalty curve - per the
  // guide, regen climbs with penalty, so deliberately playing in the orange zone
  // maximizes daily bust count at the cost of more failed attempts. This only
  // changes when the page is colored red/green/orange; it does not bust for you.
  const PLAYSTYLE_MAXCOUNT_BUST_OFFSET = -3;    // redLimit shifts 3 lower (tolerates a deeper deficit before red)
  const PLAYSTYLE_MAXCOUNT_SUCCESS_OFFSET = -20; // success colour bands both shift 20pts lower

  // Timing
  const DEFAULT_REFRESH_SECONDS = 30;        // tick cadence (local recompute runs every tick)
  const JAIL_MIN_FETCH_GAP_MS = 35 * 1000;   // min spacing between API fetches on the jail page (dodges Torn's ~30s cache)
  const FETCH_TIMEOUT_MS = 10000;

  // Storage keys
  const STATE_KEY = 'globalBustrState';
  const API_KEY_NAME = 'bustrApiKey';
  const LEGACY_API_KEY_NAME = 'bustrApiKey'; // same name, but in localStorage pre-v2

  // --- Cloud sync (optional, off by default). These three values are public by
  // design and safe to ship in the script; the only real secret (the Firebase
  // service account) lives server-side in the Netlify function, never here. ---
  const CLOUD_FUNCTION_URL = 'https://bustr-jail-bust-assistant.netlify.app/.netlify/functions/bustr-auth';
  const CLOUD_FIREBASE_API_KEY = 'AIzaSyCw5UQGI-N1pEJZ7xg3OvO_elaTLQfeDYg';
  const CLOUD_PROJECT_ID = 'bustr---jail-bust-assistant';
  const CLOUD_AUTH_KEY = 'bustrCloudAuth'; // kept OUT of state so it never lands in a debug export
  const CLOUD_PULL_KEY = 'bustrCloudLastPull'; // device-local timestamp of the last successful pull (not synced)
  const CLOUD_PULL_MIN_INTERVAL_MS = 60 * 60 * 1000; // re-pull from the cloud at most once per hour per device (a backup only needs occasional convergence; enabling sync still pulls immediately to restore)
  const CLOUD_PUSH_DEBOUNCE_MS = 90 * 1000; // coalesce a whole busting flurry into one write: the timer resets on each bust, so back-to-back busts flush as a single upload once you pause

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
        showSuccessChance: SHOW_SUCCESS_CHANCE, // per-target % visible
        skillCalibrationOverride: SKILL_CALIBRATION_OVERRIDE, // null = auto from perks
        successGreenAt: SC_GREEN_AT,   // % at/above which a target is green
        successRedBelow: SC_RED_BELOW, // % below which a target is red
        selfCalibrationEnabled: true, // use the learned-from-outcomes calibration once enough samples exist (default on: passive-only, see COMPLIANCE NOTE)
        playStyle: 'safety',           // 'safety' | 'maxcount' (display-only thresholds, see PLAYSTYLE_* constants)
        activeScope: 'always',         // 'always' | 'jailOnly' - suppresses nav badge/colours + background fetch off the jail page
        usePerkCalibration: true,      // ON by default (v2.17.0): scales the SUCCESS/skill term by your detected bust perks. Validated on cross-user cloud data to improve predictions (esp. low/mid penalty) with negligible downside; self-cal still overrides once it has enough samples, and the penalty term stays on baseline (see getPenaltySkillCalibration).
        perkCalDefaultApplied: true,   // marks that the v2.17.0 "perk-cal on by default" migration has run; see loadGlobalBustrState. New installs start applied so a later manual opt-out is never re-flipped.
        cloudSyncEnabled: false,       // off by default; opt-in cloud backup of outcomeLog, gated behind an explicit consent prompt (see CloudSync)
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

  // Skill calibration for the PENALTY term specifically (penaltyPctAt). Penalty puts
  // calibration in the DENOMINATOR (p0 = PENALTY_PCT_ANCHOR / (level * calibration)), so
  // any auto-fitted value fed here couples two things that must stay independent - the
  // exact mechanism behind the v2.7.19 feedback loop, where a self-cal floor of 0.3
  // tripled per-bust penalty (1037/100 -> 1037/30), pushed accumulated penalty past 300%
  // and floored every on-screen success% at 1. It has always excluded self-cal for that
  // reason; as of v2.17.0 it also excludes the perk-derived estimate. Perk calibration
  // was validated (cross-user cloud data) ONLY for the success/skill term, with penalties
  // held at the neutral baseline; letting perks scale this denominator too is unvalidated
  // and would over-penalise under-perked players. So penalty uses the neutral baseline
  // here - a manual override is still honoured as a deliberate user statement of skill.
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
    // Migration: usePerkCalibration replaced the old, inverted ignorePerks
    // setting (perk calibration used to be on by default; now it's opt-in).
    // Preserve whatever a user with an old saved ignorePerks value was actually
    // getting, rather than silently resetting everyone to the new default.
    if (typeof savedSettings.usePerkCalibration !== 'boolean' && typeof savedSettings.ignorePerks === 'boolean') {
      GLOBAL_BUSTR_STATE.userSettings.usePerkCalibration = !savedSettings.ignorePerks;
    }
    // Prune settings keys nothing reads any more, AFTER the migration above (which
    // is the one legitimate reader of ignorePerks). highPenaltyCaution died with the
    // high-penalty guardrail in v2.8.0; without this, both keys ride along in saved
    // state and diagnostic exports forever, implying features that no longer exist.
    delete GLOBAL_BUSTR_STATE.userSettings.ignorePerks;
    delete GLOBAL_BUSTR_STATE.userSettings.highPenaltyCaution;
    // Migration: perk calibration became ON by default in v2.17.0 (validated on real
    // cross-user data to improve success predictions). Turn it on ONCE for existing users
    // so they get the benefit too, tracked by a flag so this never re-runs - if a user
    // then turns it off, that choice sticks. Only the success/skill term is affected; the
    // penalty term stays on baseline regardless (see getPenaltySkillCalibration).
    if (GLOBAL_BUSTR_STATE.userSettings.perkCalDefaultApplied !== true) {
      GLOBAL_BUSTR_STATE.userSettings.usePerkCalibration = true;
      GLOBAL_BUSTR_STATE.userSettings.perkCalDefaultApplied = true;
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

  // Non-throwing wrapper for callers on the tick loop, which must not break the tick
  // if visualViewport is unavailable (getMyViewportWidthType throws in that case).
  // Falls back to reporting Desktop, i.e. the long-standing sidebar placement.
  function isMobileViewport() {
    try {
      return getMyViewportWidthType() !== 'Desktop';
    } catch (e) {
      return false;
    }
  }


  // Torn API keys are exactly API_KEY_LENGTH alphanumeric characters and nothing
  // else, so anything that isn't alphanumeric is not part of the key. Stripping it
  // is not cosmetic - two real cases, both confirmed from a PDA export where the
  // saved key measured 17 characters and PDA's injected key measured 18:
  //   - PDA's injected-key-token substitution can land the key WRAPPED IN QUOTES, so
  //     PDA_API_KEY holds "abc..." (18) rather than abc... (16).
  //   - A key pasted on a phone routinely carries an invisible character (zero-width
  //     space, non-breaking space). String.trim() does NOT remove those.
  // Either way Torn receives a malformed key and answers "Incorrect key", which reads
  // as "your key is wrong" while the key on screen is visibly, correctly right - the
  // single most misleading failure this script can produce, and it cost real time.
  const API_KEY_LENGTH = 16;
  function sanitizeApiKey(raw) {
    if (typeof raw !== 'string') return '';
    return raw.replace(/[^A-Za-z0-9]/g, '');
  }

  function setApiKey(apiKey) {
    Store.set(API_KEY_NAME, sanitizeApiKey(apiKey));
  }
  // A key the user set explicitly always wins, including on PDA.
  //
  // This used to return PDA_API_KEY unconditionally on PDA, ignoring any stored key
  // entirely - so on PDA there was no way to supply your own key at all. The PDA app
  // injects whatever key it was configured with, and if that key is wrong or lacks
  // access, BUSTR reads no bust log, every penalty reads 0%, and entering a correct
  // key in the panel changed nothing because this function never looked at it.
  // Confirmed from a real PDA export: `Torn API 2: Incorrect key` against the
  // injected key, while the same account worked fine on desktop.
  function getApiKey() {
    // Both sources are sanitized on the way out (see sanitizeApiKey) - PDA's
    // substitution can wrap the key in quotes, and a pasted key can carry invisible
    // characters. Neither is visible to the user, both make Torn reject the key.
    const stored = sanitizeApiKey(Store.get(API_KEY_NAME));
    if (stored !== '') return stored;
    // A blank injected key counts as NO key, not as a key. isPDA() only checks that
    // the ###...### token was substituted, and an empty string satisfies that - so if
    // the PDA app injects nothing (no key configured, or a failed substitution), this
    // used to hand back '' and BUSTR would call Torn with `key=`, which Torn answers
    // with "Incorrect key". That reads as "your key is wrong" when the truth is "no
    // key ever arrived", which sends you off checking a key that was fine all along.
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

    // <= (not <): a window of length longestSequence ending exactly at the last
    // array entry is a valid position and must be checked too. With strict <, the
    // case timestampsArray.length === longestSequence (the whole array IS the
    // longest cluster - the common case once old history is pruned, see
    // RECENT_HISTORY_WINDOW_DAYS) makes this loop bound 0, so the body never runs
    // and the function silently returns a threshold of 0 - which then makes
    // availableBusts deeply negative for anyone with a nonzero penalty. Found by
    // recomputing this against a real user's exported data after pruning old
    // entries out of their history.
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

    // textContent instead of innerText: same regex result here (unanchored \d+
    // search, so stray whitespace doesn't matter) but avoids forcing a layout
    // reflow - this runs once per jail row every tick now that rows live-update.
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

  // Same formula as calcSuccessChance, but takes the calibration as a parameter
  // (unrounded) instead of reading getSkillCalibration(). Pure math, no settings
  // lookups - shared by the live display and by the self-calibration grid search
  // below, so the two can never disagree about what the formula actually computes.
  //
  // Penalty is counted at PENALTY_WEIGHT (2x face value). See that constant for the
  // evidence; briefly, the guide's face-value penalty is measurably too weak, and
  // the previous fix for that (re-weighting only the excess above a 100% threshold)
  // was wrong in both directions at once - inert in the 40-100% band where real
  // failures happen, and far too harsh above it.
  function calcSuccessChanceRaw(hardness, penaltyPct, calibration) {
    const skill = getPlayerLevel() * calibration;
    // Penalty's effect saturates: past PENALTY_SATURATION_PCT it stops biting harder
    // (see the constant - fit by leave-one-out on real cross-user outcomes). Below it,
    // the model is unchanged, so the well-calibrated low/mid-penalty range is preserved.
    const effectivePenalty = PENALTY_WEIGHT * Math.min(penaltyPct, PENALTY_SATURATION_PCT);
    const raw = SUCCESS_A - (SUCCESS_B * 60 / skill) * hardness - effectivePenalty;
    // Clamp to [1,100] FIRST, then shrink toward the centre (see PRED_SHRINK_K).
    // Order matters: the raw linear score can be hundreds of points above 100 for an
    // easy target, and shrinking before clamping would let that excess headroom leak
    // back into the displayed number, recreating exactly the overconfidence the
    // shrink exists to correct. Post-shrink output spans roughly 16..81, so no
    // second clamp is needed, but one is kept as a defensive invariant.
    //
    // (Historical note: a raised FLOOR was tried for the same symptom and rejected -
    // it looked great in-sample, Brier 0.136, and collapsed under leave-one-out,
    // 0.173. The shrink is the version of that idea that survives cross-validation,
    // because it corrects both tails and the middle instead of just the bottom.)
    const clamped = Math.max(1, Math.min(100, raw));
    const shrunk = PRED_SHRINK_CENTER + PRED_SHRINK_K * (clamped - PRED_SHRINK_CENTER);
    return Math.max(1, Math.min(100, shrunk));
  }

  // Estimated odds of busting a target of the given hardness right now.
  function calcSuccessChance(hardness, penaltyPct) {
    return Math.round(calcSuccessChanceRaw(hardness, penaltyPct, getSkillCalibration()));
  }

  ////////////////////////////////////////////////////////////////////////////
  ////  SELF-CALIBRATION (learns your real success curve from logged outcomes)
  ////////////////////////////////////////////////////////////////////////////
  // Passive: built only from clicks you make and the result text Torn already
  // renders. See the COMPLIANCE NOTE at the top of the file - nothing here
  // simulates input or acts on your behalf.
  //
  // Simplification worth knowing: each logged attempt freezes the penalty% that
  // was showing at click time. Re-fitting only searches over the calibration
  // used in the hardness/skill term, not by re-deriving penalty% under each
  // candidate (that would need a full bust-history snapshot per attempt, which
  // isn't worth the storage for a coarse fit). In practice penalty% moves the
  // result by a roughly constant offset, so this barely affects the fit - the
  // hardness slope is the dominant term and that part IS recalibrated exactly.

  // Only entries stamped with the current OUTCOME_MODEL_VERSION are eligible to
  // fit. Anything logged before the v2.7.19 penalty decoupling froze an inflated
  // penalty% (see OUTCOME_MODEL_VERSION), and fitting against those would re-derive
  // the calibration from corrupted penalties. They still count in the displayed
  // history and stats, they just can't vote on the number.
  function fittableOutcomes(outcomeLog) {
    if (!Array.isArray(outcomeLog)) return [];
    return outcomeLog.filter((o) => o && o.m === OUTCOME_MODEL_VERSION);
  }

  // True for a genuine logged bust. The private cloud round-trip test (cloud/test/
  // test.html) wrote sample rows tagged with a `note` field; nothing in BUSTR ever
  // writes one, so a `note` is the unambiguous signature of a synthetic test write. A
  // numeric ts is also required - it is the merge/sort key. Real legacy entries that
  // predate model versioning have no `m` stamp; those are still real busts and are kept.
  function isRealOutcome(o) {
    return !!o && typeof o === 'object' && typeof o.ts === 'number' && !('note' in o);
  }

  // Grid-search the calibration that best matches predicted vs actual outcomes.
  // Returns null if there aren't enough eligible attempts yet.
  //
  // Unlike previous versions this fits over ALL penalty ranges rather than only
  // low-penalty samples. That exclusion existed to stop penalty-driven failures
  // from dragging the calibration down, but it was treating the symptom: the real
  // cause was that penalty was under-weighted in the formula, so the fit had to
  // distort the hardness term to explain failures it could not otherwise account
  // for. With PENALTY_WEIGHT correcting the penalty term directly, penalty-driven
  // failures are explained by the penalty term, which is exactly where they belong,
  // and every sample can safely inform the fit.
  //
  // Note this searches ONLY the calibration, not the penalty weight. Fitting both
  // was tested and generalized worse (leave-one-out Brier 0.164 vs 0.148 for
  // calibration alone, vs 0.141 for fitting nothing at all). Extra freedom here
  // buys noise, not accuracy.
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

  // Where the API key came from and whether it even looks like a key. The key itself
  // is NEVER included - only its source and length - but that is enough to tell an
  // empty/failed PDA injection (length 0) apart from a real key Torn is rejecting,
  // which are identical symptoms otherwise and lead to completely different fixes.
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
      // RAW vs sanitized lengths: a raw length above the sanitized one means the key
      // arrived carrying characters that aren't part of it (PDA's quotes, an
      // invisible character from a paste). That gap is the whole diagnosis.
      overrideLength: overrideLen,
      overrideRawLength: overrideRawLen,
      pdaTokenSubstituted: isPDA(), // false = the ###...### placeholder is still literal (not running under PDA)
      pdaKeyLength: pdaLen,
      pdaKeyRawLength: pdaRawLen,
    };
  }

  // What the badge is ACTUALLY doing on screen, per the browser rather than per my
  // assumptions. The PDA layout can't be inspected remotely and guessing at it has
  // cost several rounds, so this reports it: where the badge lives, whether the
  // column styling reached it, what the browser computed for the properties that
  // decide overlap, and its measured size. Layout facts only, no personal data.
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

  // Diagnostic snapshot for sharing with a script maintainer - everything needed
  // to reproduce and debug a user's numbers (version, level, settings, detected
  // perks, current penalty, calibration fits, full bust history), and nothing
  // else: no API key (stored under a separate key entirely, see getApiKey()),
  // no Torn username/ID/faction - this script never reads or stores those.
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
      // Every tunable the success/penalty model is built from, so a report from a
      // user on an older or newer build can be interpreted correctly even without
      // checking out that exact script version.
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
      // Capture the exact model inputs used for the shown prediction, so a logged
      // outcome is fully reconstructable later (recompute raw/shown from h+pen+lvl+cal).
      // Cross-user analysis showed the stored `pred` alone is not enough - it mixes
      // pre/post-shrink displays and omits level/calibration - which blocked a rigorous
      // leave-one-out recalibration of the penalty curve. These two fields unblock it.
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

  // Attribute a bust result to the last captured click, log it, and re-fit.
  // No-ops silently if no recent click was captured (e.g. self-calibration was
  // just enabled, or the result mutation fired without a matching click).
  // jailed is only meaningful when success is false (a successful bust never
  // results in you being jailed) - always stored as a plain boolean regardless,
  // so downstream code never has to special-case null/undefined.
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

  // Drop any non-genuine rows from the stored log (see isRealOutcome). This heals a log
  // that picked up synthetic rows from the cloud round-trip test, so they never reach the
  // displayed stats or get pushed back to the cloud. Runs once at load and is a no-op when
  // the log is already clean. The fit itself is unaffected either way, since
  // fittableOutcomes already admits only current-model (`m`) rows.
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
  // (plain fetch to these hosts is blocked on-page; GM_xmlhttpRequest runs outside the
  // page context, so it is not). This works on desktop managers AND on Torn PDA, which
  // provides GM_xmlhttpRequest natively on recent versions and honours @connect. Where
  // it is absent (older PDA builds / minimal managers), hasGMXhr is false and the whole
  // feature no-ops cleanly - it is gated on the capability, not on desktop-vs-PDA.
  //
  // The API key is sent once, to the verification function, and is never stored in the
  // cloud. The auth SESSION (refresh token, uid, playerId) lives under CLOUD_AUTH_KEY
  // via Store, deliberately OUT of GLOBAL_BUSTR_STATE so it can never reach the debug
  // export (which only serialises state).

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
      // Only write back when the cloud is actually missing entries we have. When the
      // cloud already holds everything (the common case on a page load), this is a pure
      // read and costs no write - the old code wrote on every single load.
      if (merged.length !== (cloud ? cloud.length : 0)) await fsPatch(a.uid, { log: merged, ...profileSnapshot() });
    }
    // Extra per-user context backed up for opted-in users alongside the log, so the
    // model can be studied and tuned against real cross-user data. This mirrors the
    // model-relevant fields of the debug export (never the diagnostic/DOM/key parts):
    // perks + level, the script version and effective calibration that produced the
    // predictions, and the settings that change how predictions are derived. The
    // perk-based calibration a user sees is still computed locally; this only informs
    // the shared model. Written only while sync is on.
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
        settings: {                         // only the prediction-affecting settings
          perkCal: !!us.usePerkCalibration,
          selfCal: !!us.selfCalibrationEnabled,
          calOverride: (typeof us.skillCalibrationOverride === 'number' ? us.skillCalibrationOverride : null),
          playStyle: us.playStyle || null,
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
      // Torn navigations each re-run the whole script, so an unthrottled pull would hit
      // the cloud on every page load. A backup only needs to converge occasionally, so
      // cap pulls to once per CLOUD_PULL_MIN_INTERVAL_MS per device. New busts still push
      // up immediately via pushSoon; this only rate-limits pulling other devices' changes.
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

  // Persist why an API call failed, so it can be shown in the settings panel and
  // carried in the diagnostic export. Torn's own error codes matter here: 2 is a bad
  // key and 16 is "access level not high enough", which is the one that bites on PDA
  // - a key without the `log` selection fetches no bust history at all, so every
  // penalty number silently reads 0, which looks like "no penalty" rather than like
  // an error. See API_KEY_CREATE_URL: the panel can hand the user a link that
  // pre-ticks exactly the selections this script reads, which is the fix for both
  // that failure and for the old advice to just grant a Full Access key.
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
      // Stamped only once the response is known-good. It used to be set the moment
      // JSON parsed, i.e. BEFORE these checks, so a Torn error response counted as a
      // successful fetch: the timestamp advanced, refetchIfStale then throttled the
      // retry as though fresh data had just arrived, and a diagnostic export showed a
      // recent "successful" fetch alongside an empty history. That combination is
      // actively misleading - it hid a failing API key behind numbers that merely
      // looked stale rather than broken.
      setLastFetchTimestampMs();
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  // One-off call for level + perks. Folded into a single request via comma-separated
  // selections. Perks rarely change, so this runs once on load, not on refresh.
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

  // Pull every perk string that mentions busting, across all perk categories.
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

  // Precise per-perk classification, instead of "any string mentioning bust counts
  // the same". A perk that mentions "bust" can mean three different things:
  //  - OFFENSE: raises YOUR success chance when busting others (counts toward calibration)
  //  - NERVE:   changes nerve cost only, not odds (e.g. "+2 bust nerve cost reduction")
  //  - DEFENSE: makes YOU harder to bust (a different stat entirely - must not be
  //    added to your offensive calibration, or it would silently inflate it)
  // Anything that mentions "bust" but matches none of these is 'unknown' - logged
  // so new/unseen perk wording can be reported and the patterns tightened.
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

  // Sum the success-affecting bust bonus % from the detected perk strings. Only
  // perks classified 'offense' count - nerve perks change cost not odds, and
  // defense perks affect being busted, not your busting skill.
  function sumBustSkillBonus(perkStrings) {
    let bonus = 0;
    for (const perk of perkStrings) {
      if (classifyPerk(perk) !== 'offense') continue;
      const m = perk.match(/([\d.]+)\s*%/);
      if (m) bonus += parseFloat(m[1]);
    }
    return bonus; // e.g. 115 for faction 50 + education 65
  }

  // Perks that mention "bust" but don't match a known offense/nerve/defense pattern.
  // Surfaced so unfamiliar wording (new perks, other languages, etc.) can be reported
  // and the classification patterns above tightened, instead of silently mis-summed.
  function unclassifiedBustPerks(perkStrings) {
    return perkStrings.filter((p) => classifyPerk(p) === 'unknown');
  }

  // Map a detected bonus to a calibration scaled against the full-stack 115% the
  // constants were fit on. No bust perks at all -> conservative fallback.
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
  // self-calibration outcomes look wrong, open the console after a failed bust,
  // find the actual message text, and report it so these can be corrected - a
  // wrong pattern just means that failure goes unlogged (safe: no data is
  // mis-attributed), not that anything breaks.
  //
  // Torn has three bust outcomes, not two (per the community guide): success,
  // "fail without penalty" (clean fail, no consequence), and "fail, get caught
  // and sent to jail yourself". Both are failures for calibration purposes, but
  // they're worth logging separately - jailed failures are the actual thing
  // BUSTR exists to help you avoid, so how often they happen (and at what
  // hardness/penalty) is worth tracking on its own. Checked in this order:
  // jailed-wording is more specific, so it wins if a message happens to contain
  // both "failed" and "jailed" language.
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
        // Skip nodes with no text instead of bailing out of the whole batch.
        // The old `return` here let one empty mutation abort detection entirely,
        // which was a real source of missed busts.
        // textContent instead of innerText: this callback can fire on every DOM
        // mutation across the whole page (chat included), and innerText forces a
        // synchronous layout reflow on every read - textContent doesn't. trim()
        // compensates for the anchored regex below, since textContent (unlike
        // innerText) doesn't collapse surrounding whitespace.
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

  // Arm the bust-detection observer ONLY on the jail page; tear it down everywhere
  // else. That observer watches the entire document subtree and runs its callback on
  // every DOM mutation anywhere on the site. On the jail page that is what detects a
  // successful bust; on any other page it is pure overhead, and on churn-heavy pages
  // like the item market it fires continuously for a bust that can never happen there.
  // It used to be armed once at bootstrap on EVERY page regardless of location or
  // scope - that is what "the script was still fully operating on every page" and the
  // item-market loading issues came down to. This is a perf fix in all modes, not
  // only jail-only.
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

  // Capture phase, passive listener only - never calls preventDefault/stopPropagation,
  // so it cannot interfere with the real bust click in any way.
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

/* Red/orange/green comes from --color, which renderBustrColorClass drives via a body
   class. #bustr-sidebar-btn is listed because on PDA the badge lives in BUSTR's own
   nav column rather than inside #nav-jail, so the #nav-jail selector never reached it
   and the numbers stayed uncoloured. The column is a clone of the Jail cell and so
   carries the swiper-slide class itself, which means the .bustr--red .swiper-slide
   rule above already sets --color on it - it only needed reading.
   (No backticks in this comment: the whole stylesheet is a template literal.) */
#nav-jail .bustr-stats,
#bustr-sidebar-btn .bustr-stats,
#bustr-context .bustr-stats {color: var(--color, inherit);}
#nav-jail .bustr-stats span {margin-left: unset;}
.bustr-pct-line {display: block; font-size: 0.78em; line-height: 1.2; opacity: 0.85;}

/* PDA/mobile count badge. It exists in one of two places, styled differently:

   1. Inside BUSTR's own nav column (the normal case). Laid out entirely by us: normal
      flow, explicit sizes, every inherited positioning property neutralised. Torn's
      mobileAmount class is deliberately overridden here rather than worked around.
      That class positions the badge ABSOLUTELY, which is correct for the single digit
      Torn uses it for, but ours is two rows - out of flow it landed on top of the
      BUSTR label, which is what hid the %. It also carries font sizing we can't see
      or predict, so the sizes below are stated outright instead of inherited.
   2. Still in #nav-jail, only if the column could not be created (findMobileNavCell
      declines). Left entirely alone there, so Torn's own badge positioning applies.

   nowrap on the % line: the slot is narrow and .bustr-pct-line is a flex item here
   (blockified whatever its display value), so without it the "%" character wraps off
   its own number onto a line of its own. */
#bustr-sidebar-btn .bustr-col-inner {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  position: relative; overflow: visible; height: auto; min-height: 0;
}
/* EVERY direct child is forced into normal flow, not just the badge. Flex only lays
   out in-flow children, so a single positioned child is enough to make the stack
   overlap - and there are two candidates here, not one: the badge carries Torn's
   absolutely-positioned mobileAmount class, and Torn's own nav link (mobileLink___*)
   may be positioned as well. Overriding only the badge (v2.9.3/v2.9.4) left the link
   free to sit on top of it, which is why the % kept disappearing behind the label.
   This whole column is our clone, so nothing inside it needs to be out of flow. */
#bustr-sidebar-btn .bustr-col-inner > * {
  position: static !important; top: auto; right: auto; bottom: auto; left: auto;
  transform: none; margin: 0; float: none;
}
/* Sizes are small on purpose. The badge shares one nav slot with the BUSTR label, so
   it gets roughly two short lines of room - anything bigger and the rows crowd each
   other. Stated in px rather than em so they can't inherit something unexpected from
   Torn's own nav styling. */
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

/* "Jail page only" scope: hide the nav badge and neutralize page colouring off the
   jail page, without touching any DOM structure (toggled purely via body class). */
body.bustr-inactive .bustr-stats {display: none;}
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

/* Settings button + panel */
/* Sidebar entry (primary). This is a clone of a native row (#nav-jail), and the
   goal is for text colour/font/weight to look IDENTICAL to sibling rows - see
   findByClassPrefix in the JS, which swaps only the label text/icon content and
   keeps Torn's own classed elements so that styling is inherited, not guessed.
   Background is NOT left to inherit, though: it gets an explicit, visible
   background of our own (sidebar rows don't reliably show one at rest), plus a
   defensive border/shadow reset in case a state-highlight class slips through
   (Torn marks the current-page row with a class like "active__xlAlO" - the JS
   strips anything matching /^active/i; this reset is just defense in depth). */
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
/* API failure notice. Deliberately loud: the alternative symptom is a penalty of
   0%, which reads as "clear to bust" when the truth is "unknown". */
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

/* Help system. Every explanation used to sit inline as permanent small print, which
   made the panel a wall of text a new user had to read past to reach the controls.
   The prose now lives behind these chips and opens in one shared card. */
#bustr-settings-panel .bustr-q {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; margin-left: 5px; border-radius: 50%;
  background: #4b5738; color: #fff; font-size: 9px; font-weight: 700;
  cursor: pointer; user-select: none; flex: 0 0 auto; vertical-align: middle;
}
#bustr-settings-panel .bustr-q:hover {background: #6b7d50;}
/* Chips beside a button, never inside one - a chip nested in a <button> fires that
   button when tapped. See the capture-phase note on the panel's click handler. */
#bustr-settings-panel .bustr-btn-row {display: flex; align-items: center; gap: 7px;}
#bustr-settings-panel .bustr-btn-row .bustr-btn {flex: 1;}
/* The key-creation control is an <a>, not a <button>, so it needs the button's box
   model restated - buttons centre their text and links do not. */
#bustr-settings-panel .bustr-btn-link {display: block; text-align: center; text-decoration: none;}
#bustr-settings-panel .bustr-q.bustr-q-on {background: #8ca05a; color: #1a1a1a;}
/* Sits to the RIGHT of the panel on a desktop-width viewport. The panel is 280px
   wide and centred, so half of it is 140px; 152px clears it with a small gap. */
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
/* Header sticks to the top of the card so the close button stays reachable no matter
   how far the description is scrolled - the whole point of the fix, since long help
   text is exactly what could not be dismissed before. Its background covers the text
   scrolling underneath, and the negative margins let it span the card's padding. */
#bustr-help h4 {position: sticky; top: 0; background: #333; z-index: 1;
  margin: 0 -12px 5px; padding: 10px 12px 6px; font-size: 11px; color: #8ca05a;
  text-transform: uppercase; letter-spacing: 0.03em;
  display: flex; justify-content: space-between; align-items: center;}
#bustr-help h4 .bustr-help-close {cursor: pointer; color: #999; font-size: 20px; line-height: 1;
  padding: 0 4px; margin: -4px -4px -4px 8px;}
#bustr-help h4 .bustr-help-close:hover {color: #fff;}
/* No room beside the panel on a phone or PDA. Centre it rather than docking to the
   bottom: a bottom-docked card sat under the mobile browser's dynamic toolbar, which
   hid its lower half and its scroll area entirely (reported on Firefox Android).
   Centred, it can't be clipped by that toolbar, and it scrolls internally. */
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
          <span class="bustr-stats__penaltyScore">#</span> / <span class="bustr-stats__penaltyThreshold">#</span> : <span class="bustr-stats__availableBusts">#</span>
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

  // Badge lives in Torn's own count-badge position inside #nav-jail (immediately
  // before the link). Created here during init, not from the settings trigger on
  // the tick loop: the tick can be up to statsRefreshRate away, and a badge that
  // doesn't exist yet can't be filled by renderBustrStats, so it would sit showing
  // its literal "#" placeholders until the first tick landed.
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

      // Guarded on the badge existing ANYWHERE, not on it being inside #nav-jail:
      // ensureSettingsTrigger moves it into BUSTR's own nav column once that exists,
      // at which point a scoped check would report "missing" and mint a second one
      // on the next viewport change.
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

      // Note: PDA's injected key is NOT copied into storage here any more. Storing
      // it would make it indistinguishable from a key the user chose, and getApiKey()
      // now treats a stored key as a deliberate override that wins over PDA's. It
      // already falls back to the injected key when no override is set, so copying
      // it in bought nothing and would have permanently shadowed the override.

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
  // On PDA a working injected key means there is nothing to type, so the key entry
  // collapses to a status line (see refreshApiKeyState). This latch lets the user
  // force the entry back open via "Use your own key instead" without it snapping shut
  // on the next panel refresh. Reset each time the panel opens.
  let apiKeyEntryForced = false;

  async function loadController() {
    if (isLoading || fatalKeyError) return;
    // Resolved inside a guard, not on a bare line above the try: getApiKey() reads
    // storage, and anything it throws used to escape loadController entirely and
    // reject the caller.
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
      // Recorded, not just logged. A failing key previously showed up ONLY as a
      // console message, which nobody sees on PDA - on screen the penalty simply
      // read 0%, which is indistinguishable from "you genuinely have no penalty"
      // and is the more dangerous of the two readings to get wrong.
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

  // Recompute from the stored timestamps with no API call. The penalty score
  // decays purely as a function of time, so this stays accurate between fetches.
  // Recomputes the threshold too (the part of calcBustrStats that scans the whole
  // bust history for the longest safe streak) - use this after the timestamps
  // array or the custom-threshold setting actually changes, not on every tick.
  // Paint the "no bust history yet" state. Split out because the recalc paths below
  // return early when timestampsArray is empty, and renderBustrStats sits AFTER that
  // return - so on a fresh install, or before the first API fetch lands, the nav
  // badge was never written to at all and sat showing its literal "#" placeholders
  // indefinitely. Zero is both accurate here and readable; it's replaced the moment
  // real history arrives.
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

  // Lighter per-tick path: the threshold (calcPenaltyThreshold) only changes when
  // bust history or the custom-threshold setting changes, not every tick, but its
  // auto-detected mode scans the whole history for the longest safe streak - real
  // cost for a heavy buster's log if redone on every 15-30s tick. Only the penalty
  // SCORE needs to be re-derived every tick (it decays purely with elapsed time),
  // so reuse the already-computed threshold instead of recalculating it.
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

  // Fetch only if enough time has passed since the last successful fetch, else
  // recompute locally. The gap dodges Torn's ~30s service cache, where an immediate
  // refetch would just return stale cached data and could overwrite good numbers.
  function refetchIfStale(minGapMs) {
    if (fatalKeyError) return;
    const since = Date.now() - getLastFetchTimestampMs();
    if (since >= minGapMs) loadController();
    else recalcLocally();
  }

  // After a bust, schedule one ground-truth refetch past the cache window.
  // Debounced so a streak of busts triggers a single resync once it settles.
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

  // Apply the "jail page only" scope. When active and off the jail page, hide BUSTR's
  // nav badge and page colouring via the bustr-inactive body class (see the CSS), and
  // return true so callers know there's nothing further to render. Returns false
  // otherwise. Extracted from masterTick specifically so it can ALSO run once at
  // bootstrap: masterTick was the only caller, and it runs on a setInterval that does
  // not fire until one full refresh interval after load. That meant on any non-jail
  // page, jail-only mode left the badge and colours visible for 30-60s before the
  // first tick suppressed them - which reads exactly as "jail-only isn't working,
  // BUSTR still shows on other pages." Applying it at load closes that window.
  function applyActiveScope(onJail) {
    const inactive = getUserSettings().activeScope === 'jailOnly' && !onJail;
    document.body.classList.toggle('bustr-inactive', inactive);
    if (inactive) clearBustrPageColoring();
    return inactive;
  }

  // One timer on a fixed cadence. It always recomputes locally (free, handles
  // decay) and only hits the API when the context-appropriate gap has elapsed:
  // tight on the jail page where you actually bust, slow everywhere else.
  // Settings changed in one Torn tab don't reach another already-open tab on
  // their own: each tab loads GLOBAL_BUSTR_STATE into memory once and every
  // read after that (getUserSettings(), etc.) comes from that in-memory copy,
  // not from storage. A user with multiple tabs open can toggle a setting in
  // one, switch to another, and have it silently keep using the old value -
  // this was confirmed against real logged data (two attempts computed WITHOUT
  // high-penalty-caution weighting despite it being persisted as on, followed
  // by one that correctly used it). Re-reading userSettings from storage here
  // and merging any change into memory closes that gap. Safe to do broadly:
  // every actual state mutation in this script already writes to storage in
  // the same call that updates memory (setGlobalBustrState), so there's never
  // an unpersisted in-memory-only change this could clobber.
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

    const onJail = window.location.pathname === '/jailview.php';
    if (SHOW_SETTINGS_PANEL) ensureSettingsUi(); // keep the trigger reachable regardless of scope

    ensureBustObserver(onJail); // arm on the jail page, tear down everywhere else - in all modes

    if (applyActiveScope(onJail)) return; // jail-only + off jail: nav badge/colour hidden, nothing else to do

    // Cheap path every tick: penalty score decays purely with elapsed time, so
    // this is the only thing that needs re-deriving on a 15-30s cadence. The
    // threshold (auto-detected longest-safe-streak scan) is recomputed only after
    // a real fetch or a settings change - see recalcLocally() vs recalcPenaltyScoreOnly().
    recalcPenaltyScoreOnly();

    // Live-tick the per-target hardness/success % on the jail page. Pure local
    // recompute (hardness/success are derived from numbers already in the DOM) -
    // no extra API calls, so it's safe to run every tick.
    if (onJail) renderJailRows();
    if (fatalKeyError || isLoading) return;
    // Only the jail page fetches the bust log. Busts can only happen on the jail page,
    // so off it the log never changes - the cached timestamps plus time-decay already
    // give the correct penalty with no API call. This keeps the budget badge live and
    // decaying everywhere while making ZERO log requests as you navigate the rest of Torn.
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
  // masterTick no-ops while the tab is hidden (see masterTick) to save background
  // CPU/network across multi-tab Torn sessions. This fires one immediate tick the
  // moment the tab is foregrounded again, so numbers aren't stale on switch-back.
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

  // Reusable per-row display pass: compute hardness + success and apply or clear
  // the easiest-first sort. Visibility of each value is handled by body classes,
  // so this always computes and the panel can toggle display instantly.
  function renderJailRows() {
    if (window.location.pathname !== '/jailview.php') return;
    const playersArr = [...document.querySelectorAll('ul.user-info-list-wrap > li')];
    if (!playersArr.length) return;
    // No page-level "skip if the first row looks like a loading placeholder" guard
    // here on purpose (there used to be one, checking playersArr[0] for a 'last'
    // class). It broke real data: on a jail page with exactly one row (e.g. the
    // final page of a list), that row is simultaneously first and last, so it can
    // carry whatever 'last' class Torn applies for end-of-list styling - which the
    // old guard couldn't distinguish from an actual loading skeleton, so it
    // skipped rendering the ENTIRE page and left the #####/--% placeholder stuck.
    // The per-row check below (getLevelJailDurationInfo returning null) is the
    // correct place to skip incomplete rows - one at a time, without blocking
    // everything else on the page.
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
    renderHardnessJailView();
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
    recalcLocally(); // recomputes available busts + nav colour (limits, custom threshold)
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
    hideHelp(); // the help card lives outside the panel, so it would otherwise be left floating
  }
  function toggleSettings() {
    const p = document.getElementById('bustr-settings-panel');
    if (p && p.classList.contains('bustr-open')) closeSettings();
    else openSettings();
  }

  // Read-only line so you can see WHY the numbers are what they are.
  // Both fits are otherwise only (re)computed inside logOutcome(), when a NEW
  // outcome is logged - which means existing historical data just sits unused
  // until the next bust if a user updates to a script version that added a fit,
  // or enables self-calibration after already having a backlog of outcomes
  // logged. Recomputing here (cheap: a grid search over already-in-memory data)
  // every time the panel is opened means it always reflects everything that
  // currently exists, not just whatever was there as of the last bust.
  function refitFromExistingOutcomes() {
    const state = getGlobalBustrState();
    const log = state.outcomeLog || [];
    if (log.length === 0) return;
    const fittedCalibration = computeSelfCalibration(log);
    if (fittedCalibration !== state.selfCalibrationValue) {
      setGlobalBustrState({ selfCalibrationValue: fittedCalibration });
    }
  }

  // Reports WHICH key is in play without ever putting the key itself in the DOM -
  // the panel is shared over screenshots for support, and this script's whole
  // premise is that it never exposes your key.
  function refreshApiKeyState() {
    const el = document.getElementById('bustr-set-apikey-state');
    if (!el) return;
    const k = describeApiKey();
    const saved = k.source === 'user override';
    // A PDA key BUSTR can actually use: injected, right length, and not currently being
    // rejected by Torn. When it is healthy there is nothing to enter - the PDA app
    // already supplied the key at install - so we do not want a second key box that
    // reads as "type your key here" (the reported PDA double-entry). We collapse to the
    // status line and offer an opt-in override instead. When the injected key is missing,
    // the wrong length, or Torn is rejecting it, the entry stays open so the user can fix it.
    const healthyPda = k.source === 'PDA injected' && k.looksValid && !fatalKeyError;
    let msg;
    // A healthy PDA key reuses the same "API key is saved." line as a user-saved key,
    // so the two settled states read identically - the button below is what differs
    // (Clear saved key vs. the opt-in "use your own key" override link).
    if (saved || healthyPda) msg = 'API key is saved.';
    else if (k.source === 'PDA injected') msg = 'The key from the PDA app is not working. Enter your own key below to override it.';
    else if (k.pdaTokenSubstituted) msg = 'The PDA app supplied an EMPTY key, so BUSTR has no key to use. Create one below.';
    else msg = 'No API key set. Create one below.';
    // Say it outright when the key is the wrong length. Torn answers a malformed key
    // with "Incorrect key", which reads as "wrong key" and sends you off re-checking
    // a key that was right all along.
    if (k.source !== 'none' && !k.looksValid) {
      msg += ` Warning: it is ${k.resolvedLength} characters, but a Torn key is ${k.expectedLength}. Torn will reject it as "Incorrect key". Re-paste it carefully.`;
    }
    el.textContent = msg;

    // Once a key is saved there is nothing left to type, so the paste field and its
    // Save button only take up room and invite re-entering a key that already works.
    // Collapse to the status line plus a single Clear button; clearing brings the
    // field back. Clear is likewise hidden when there is no saved key to clear. A
    // healthy PDA key collapses the same way, but with an opt-in override link rather
    // than a Clear button (there is no stored override to clear yet).
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
      // Version first: this line is what gets read back in bug reports, and knowing
      // which build produced the numbers is the first thing worth knowing.
      el.textContent = `BUSTR v${SCRIPT_VERSION} \u00b7 Lvl ${getPlayerLevel()} \u00b7 calibration ${getSkillCalibration().toFixed(2)} (${mode}) \u00b7 current penalty ${pen}%`;

      // A failing API key must not be silent. Without this the only symptom is a
      // penalty of 0%, which reads as "you're clear to bust" - the exact opposite of
      // the truth when the real figure is unknown.
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
        // "Usable" counts only outcomes recorded under the current penalty model
        // (see fittableOutcomes). Anything logged before v2.7.19 froze an inflated
        // penalty% and can't be fitted against, so it's shown but never voted on.
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

  // Quantifies exactly what perk-based calibration would change, instead of it
  // being an invisible multiplier baked into the final percentage. The delta
  // isn't a flat shift (it depends on hardness, since calibration scales the
  // hardness/skill term specifically), so this picks one reference point - the
  // hardness where a baseline (no-perk) player sits at ~50% with no penalty,
  // i.e. the middle of the curve where a calibration difference is most visible
  // rather than lost to the 1/99 clamp at the extremes - and shows both numbers
  // side by side, always, regardless of whether the setting is currently on.
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

  // Re-reads every input/checkbox/select from the current persisted settings.
  // Called once when the panel is first built, AND every time it's opened (see
  // openSettings) - so if the on-screen state ever drifts from what's actually
  // stored (e.g. the page was restored from the browser's back/forward cache
  // instead of a fresh load, or anything else re-parents/rebuilds these inputs
  // without our knowledge), reopening the panel always shows the truth instead
  // of carrying forward whatever the inputs last happened to display.
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
    byId('bustr-set-success').checked = us.showSuccessChance !== false;
    byId('bustr-set-scgreen').value = typeof us.successGreenAt === 'number' ? us.successGreenAt : SC_GREEN_AT;
    byId('bustr-set-scred').value = typeof us.successRedBelow === 'number' ? us.successRedBelow : SC_RED_BELOW;
    byId('bustr-set-cal').value = (typeof us.skillCalibrationOverride === 'number' && us.skillCalibrationOverride > 0)
      ? us.skillCalibrationOverride : '';
    byId('bustr-set-selfcal').checked = us.selfCalibrationEnabled === true;
    byId('bustr-set-playstyle').value = us.playStyle === 'maxcount' ? 'maxcount' : 'safety';
    byId('bustr-set-scope').value = us.activeScope === 'jailOnly' ? 'jailOnly' : 'always';
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

  // Explicit consent before the first cloud enable. Returns a Promise<boolean>:
  // resolves true only on "Enable sync". Nothing signs in or uploads until this does.
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

  function ensureSettingsUi() {
    if (!SHOW_SETTINGS_PANEL || !document.body) return;
    ensureSettingsPanelDom();
    ensureSettingsTrigger();
  }

  // The trigger: a sidebar entry when the sidebar is found (appended last, so it
  // lands below TornTools' items), otherwise a floating gear as a fallback.
  // #nav-jail's container isn't guaranteed to be a literal <ul> - Torn's newer
  // fly-out sidebar may use a different element entirely. Prefer a real <ul>
  // ancestor if there is one; otherwise just use #nav-jail's immediate parent.
  // (An earlier version of this walked further up looking for "a container with
  // several children" as a heuristic, but that's exactly what <body> itself
  // often looks like once a page has any other widgets on it - it matched body
  // directly on a real page and silently misplaced the button. One level up is
  // the only assumption that can't misfire that way.)
  function findSidebarContainer(jail) {
    if (!jail) return null;
    return jail.closest('ul') || jail.parentElement || null;
  }

  // Mobile/PDA only. Returns the nav CELL that #nav-jail lives in - the element to
  // clone to get a real column of our own - or null if that can't be established.
  //
  // Background, learned expensively across v2.8.1-v2.8.3: #nav-jail is NOT the nav
  // slot on mobile. It sits inside one. Every attempt that treated it as the slot
  // failed - inserting a sibling of it stacked BUSTR *under* Jail, and laying its
  // children out in a row overflowed into the neighbouring buttons. The cell is
  // #nav-jail's parent, and a clone of the cell inserted after the cell is a
  // genuine extra column in the bar.
  //
  // The catch: if that parent were actually the nav BAR rather than a per-item cell,
  // cloning it would duplicate a chunk of the navigation. So the shape is verified
  // instead of assumed, and null (fall back to the existing placement, i.e. no
  // change) is returned unless BOTH hold:
  //   - the candidate cell contains exactly ONE #nav-* item, so it's Jail's alone
  //   - its parent contains several, so it really is the bar full of sibling cells
  // A wrong guess therefore can't damage the nav; it just does nothing.
  function findMobileNavCell(jail) {
    const cell = jail && jail.parentElement;
    if (!cell) return null;
    if (cell.querySelectorAll('[id^="nav-"]').length !== 1) return null; // the bar, or some shared wrapper
    const bar = cell.parentElement;
    if (!bar || bar.querySelectorAll('[id^="nav-"]').length < 2) return null; // not a bar of cells
    return cell;
  }

  // Torn's hashed CSS-module class names (e.g. "active__xlAlO", "linkName__i3mIk")
  // keep a stable, readable prefix even though the hash suffix can change between
  // deployments - confirmed via live DevTools inspection. Match on that prefix
  // with [class*=] rather than hardcoding the full name, so this survives Torn
  // re-hashing its build without matching anything else by accident.
  function findByClassPrefix(root, prefix) {
    return root.querySelector(`[class*="${prefix}"]`);
  }

  // Removes any class starting with "active" from an element and everything
  // inside it. Torn marks whichever sidebar row matches the current page with a
  // class like this; if #nav-jail happens to be cloned while the user is
  // actually on the jail page, the clone would otherwise carry that same
  // "current page" highlight styling onto an unrelated settings button.
  function stripActiveStateClasses(el) {
    [el, ...el.querySelectorAll('*')].forEach((node) => {
      if (!node.classList) return;
      [...node.classList].forEach((cls) => {
        if (/^active/i.test(cls)) node.classList.remove(cls);
      });
    });
  }

  function buildSidebarButton(sourceEl) {
    // Clone an existing native sidebar row (#nav-jail itself) instead of building
    // our own element, so the button inherits Torn's real classes/layout/hover
    // styling rather than approximating it - it should look like it belongs there.
    const li = sourceEl.cloneNode(true);
    stripActiveStateClasses(li);
    li.removeAttribute('id');
    // Strip ids from the whole subtree, not just the root. On mobile the source is
    // Jail's nav CELL, so the clone carries a nested copy of #nav-jail: leaving that
    // in place would put a duplicate id in the document and hand Torn's own scripts
    // (and our own #nav-jail lookups) a second element claiming to be the Jail nav.
    li.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    li.id = 'bustr-sidebar-btn';
    li.title = 'BUSTR settings';
    li.querySelectorAll('.bustr-stats').forEach((el) => el.remove()); // strip any cloned BUSTR badge
    // Any copy of Torn's own count badge too: this button shows BUSTR's numbers (the
    // real badge is moved in by ensureSettingsTrigger), not a frozen snapshot of
    // Jail's. Class-prefix match, since Torn re-hashes the suffix between builds.
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
      // An unlocked padlock, not a settings gear - busting someone out of jail is
      // literally unlocking them, and it reads as "BUSTR" rather than generic
      // "settings" at a glance. Inline SVG with stroke="currentColor" instead of
      // a Unicode emoji glyph: emoji render as full-colour pictographs on most
      // platforms regardless of page theme, which is exactly what made the old
      // gear stand out awkwardly - this instead always matches whatever text
      // colour is active, dark mode or not, same as Torn's own icons do.
      // Path is Feather Icons' "unlock" (MIT licensed), sized to match the 17x17
      // icons Torn itself uses in this sidebar.
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

    // Mobile/PDA: BUSTR gets its own column in the nav bar, right of Jail, and the
    // count/penalty badge moves into it so the two travel together. Only runs when
    // findMobileNavCell can actually prove the structure; otherwise this is skipped
    // entirely and the sidebar path below applies unchanged.
    const cell = jail && isMobileViewport() ? findMobileNavCell(jail) : null;
    if (cell) {
      let col = existing;
      if (!col) {
        col = buildSidebarButton(cell); // clone the CELL, so the clone IS a column
        cell.insertAdjacentElement('afterend', col);
      } else if (col.previousElementSibling !== cell) {
        // Re-anchor if Torn's renderer moved things. insertAdjacentElement relocates
        // rather than clones, so this is cheap and a no-op once already correct.
        cell.insertAdjacentElement('afterend', col);
      }
      // MOVE the badge rather than build one here. It's created during init and is
      // already populated with real numbers; relocating the same node keeps those.
      // v2.8.3 created a fresh badge on this tick-driven path instead, which left it
      // showing its literal "#" placeholders until the next stats render landed.
      const badge = document.querySelector('.bustr-mobile-badge');
      if (badge && !col.contains(badge)) {
        const anchor = col.querySelector('a') || col;
        anchor.insertAdjacentElement('beforebegin', badge);
        // Repaint right after relocating. The move itself preserves the numbers,
        // but this also covers the case where the badge hadn't been painted yet
        // (created after the last stats render), so it can never sit on "#".
        recalcPenaltyScoreOnly();
      }
      // Stack the badge above the label rather than letting it overlap. Tagged here
      // rather than styled by Torn's own class name because that name is hashed and
      // changes between their builds; this is the badge's actual parent, whatever it
      // happens to be called. Re-asserted every tick since Torn re-renders this tree.
      if (badge && badge.parentElement) badge.parentElement.classList.add('bustr-col-inner');
      return;
    }

    if (list && jail) {
      // Best-effort placement: right after a "TornTools" entry in the same list, so
      // it sits between TornTools Settings and the Awards section below it (per the
      // user's sidebar layout). Falls back to the end of the list if no match is
      // found (TornTools not installed, or its wording/structure differs) - still
      // works, just may land in a different spot until that selector is confirmed.
      // TornTools' own entry used to be a direct sibling of every #nav-* row
      // (confirmed via DevTools at the time), but a later TornTools update moved
      // its ".tt-settings" pill into a separate container outside the main nav
      // list entirely - confirmed live: #nav-jail.parentElement !== .tt-settings
      // .parentElement. Search the whole document for the class match instead of
      // scoping to this list's direct children, since insertAdjacentElement works
      // relative to the target's own actual parent regardless of which container
      // that turns out to be. Text-scan fallback stays list-scoped (last resort
      // if the class name itself ever changes, not the container it lives in).
      const tornToolsItem = document.querySelector('.tt-settings')
        || [...list.children].find((child) => /torntools/i.test(child.textContent || ''));

      if (existing) {
        // Re-verify position every tick instead of "insert once and forget."
        // Torn's sidebar (and TornTools' own injected pill) is rendered by a live
        // framework that can re-render/reorder this part of the tree - our button
        // is a manually-injected node those renderers don't know about, so a
        // re-render elsewhere in the list can leave it behind in the wrong spot
        // relative to the anchor it was originally placed next to (reported: the
        // button drifted from right after TornTools to right before it). Only
        // actually moves the node when it's genuinely out of place -
        // insertAdjacentElement on an existing node relocates it rather than
        // cloning it, so this is safe/cheap to run on every tick.
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

    // No sidebar anchor found on this page (e.g. the Attacking page renders
    // without the normal left nav at all). Intentionally do nothing here - no
    // floating fallback trigger anymore. BUSTR settings are only ever reachable
    // from the sidebar; on pages where the sidebar isn't present, they're simply
    // not reachable, rather than showing a separate floating button elsewhere.
  }

  // Build the modal panel + backdrop once.
  // Explanations for the "?" chips. Kept out of the panel markup so the panel reads
  // as controls rather than an essay - a new user should be able to scan it and only
  // dig into whichever setting they actually care about.
  const HELP = {
    budget: ['Bust budget', 'How many more busts BUSTR thinks you can make before failure gets likely. This is the number on the Jail nav badge. It is completely separate from the per-target success %: nothing in this section ever changes a prisoner\'s odds, only the budget count and the colours.'],
    green: ['Green at', 'The nav badge and page tint turn green when your available-bust count is this number or higher. Default is 3.'],
    red: ['Red at / below', 'They turn red at this number or below. Default is 0, so red means the budget is spent. Anything between the red and green numbers shows orange.'],
    threshold: ['Custom threshold', 'Your penalty ceiling: how much bust penalty you can carry before BUSTR calls the budget spent. Leave it at 0 and BUSTR works this out from your own bust history, by finding the longest run of busts you have actually sustained. Set a number only if you want to override that estimate.'],
    refresh: ['Refresh rate', 'How often the on-screen numbers redraw, in seconds. This does NOT control how often BUSTR calls the Torn API. Those calls are throttled separately, to at most once every 35 seconds on the jail page and once every 30 minutes elsewhere, so lowering this costs you nothing in API usage. Minimum 15.'],
    scope: ['Active on', 'Anywhere: the nav badge and colours appear on every Torn page. Jail page only: hides them and pauses background checks everywhere except the jail page. Use it if the badge distracts you while doing other things.'],
    display: ['Jail list display', 'These change only what the jail list shows and how it is sorted. The hardness score and the odds underneath are always calculated the same way regardless.'],
    hardness: ['Hardness number', 'Shows each prisoner\'s hardness score, which is their level multiplied by their remaining jail time plus three hours. Higher means harder to bust.'],
    sort: ['Sort easiest-first', 'Reorders the jail list so the easiest targets sit at the top. Torn\'s own order is by time remaining instead.'],
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
    document.querySelectorAll('#bustr-settings-panel .bustr-q.bustr-q-on')
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

  // How long an armed destructive button stays armed. Long enough to be a deliberate
  // second tap, short enough that the button is never left primed waiting to catch an
  // unrelated click a minute later.
  const TWO_STEP_ARM_MS = 4000;

  // Turns a button into a two-tap confirm: first tap arms it and swaps the label,
  // second tap within TWO_STEP_ARM_MS performs the action, and it disarms itself
  // otherwise. Shared by every irreversible action in the panel so they cannot drift
  // apart, and so adding a new destructive button is a one-liner that is safe by
  // construction rather than by remembering.
  //
  // Deliberately not window.confirm(): it is trained-away muscle memory to dismiss,
  // and it renders badly inside the PDA webview where these buttons are finger-sized
  // and adjacent to each other.
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
      <hr>

      <div class="bustr-section">Jail list display ${q('display')}</div>
      <div class="bustr-row"><label>Show hardness number ${q('hardness')}</label><input type="checkbox" id="bustr-set-hardness"></div>
      <div class="bustr-row"><label>Sort easiest-first ${q('sort')}</label><input type="checkbox" id="bustr-set-sort"></div>
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
        <!-- NOT type="password": a password field makes the browser's built-in password
             manager offer to save/fill it, and pair it with a nearby text box (Torn's
             chat search) to autofill - reported as "this script triggers autofill in
             other boxes", and it stopped the moment BUSTR was disabled. autocomplete=off
             does not help; browsers ignore it on password fields. We keep the value
             masked instead with -webkit-text-security (Chromium desktop + the PDA
             webview), and the data-*ignore hints tell 3rd-party managers to skip it. -->
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

    // One shared help card for every chip, appended to body rather than to the panel
    // so it can sit outside the panel's bounds (and outside its scroll container).
    const help = document.createElement('div');
    help.id = 'bustr-help';

    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
    document.body.appendChild(help);

    // Delegated, so chips added to the markup later need no extra wiring.
    //
    // CAPTURE phase (the `true`), and that is not a detail. In the bubble phase this
    // listener sits on an ANCESTOR of every control, so a control's own handler runs
    // first and stopPropagation() here is far too late to stop it. A "?" chip placed
    // inside a <button> therefore fired that button. That shipped briefly in v2.11.0
    // and the chip on "Reset settings only" really did reset the settings; the same
    // chip on "Erase all BUSTR data" would have wiped the lot. Capture runs root ->
    // target, so this now intercepts the click before any control sees it.
    // The chips are also no longer nested inside buttons, which is the structural
    // fix; this is the belt-and-braces one so the mistake cannot recur.
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
    byId('bustr-set-useperkcal').addEventListener('change', (e) => {
      updateSetting('usePerkCalibration', e.target.checked);
      skillCalibration = calibrationFromBustPerksRespectingSettings(getGlobalBustrState().bustPerks);
      applySettings();
      refreshSettingsStatus();
      refreshPerkImpactDisplay();
    });
    byId('bustr-set-force-update').addEventListener('click', (e) => forceProfileRefresh(e.target));

    // One-way diagnostic export only - there is no Import. Settings are changed
    // in this panel directly, so there's no reason to overwrite them from a
    // pasted file; the only purpose of this button is producing something the
    // user can hand to a script maintainer to debug/improve BUSTR.
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
    // Saving a key must also release the fatalKeyError latch. It's set once Torn
    // rejects a key (code 2/16) and it stops loadController from ever calling the
    // API again - so without clearing it, entering a CORRECT key would still fetch
    // nothing until a full page reload, which looks exactly like the key being
    // wrong again.
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
    // Opt-in escape hatch when the PDA app's injected key is active but the user wants
    // their own: reveal the (otherwise collapsed) paste field. The latch keeps it open
    // across panel refreshes until a key is saved or the panel is reopened.
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

    // Cloud sync. The checkbox turning ON must ask for consent BEFORE anything signs
    // in or uploads; cancel or any failure reverts it so the box never lies about state.
    const cloudBox = byId('bustr-set-cloudsync');
    if (cloudBox) {
      if (!hasGMXhr) cloudBox.disabled = true; // desktop-only feature; inert on PDA/mobile shims
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
    // "Delete my cloud data": two-tap like the other destructive actions. Also turns
    // sync off, since deleting while still syncing would just re-upload on the next bust.
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
    // Also two-step: this throws away every logged bust outcome, which is the data
    // self-calibration is built from and can represent months of play. It destroys
    // exactly the same history "Erase all" does, so it gets the same protection.
    wireTwoStepButton(byId('bustr-set-selfcal-clear'),
      'Clear outcome log', 'Tap again to clear the log',
      () => {
        setGlobalBustrState({ outcomeLog: [], selfCalibrationValue: null });
        refreshSettingsStatus();
      });

    refreshSettingsStatus();
  }

  // Fetch level + perks and feed them into the success model. Respects a daily TTL
  // (perks rarely change, so this avoids an API call on every page load). Calibration
  // is derived from the detected bust-skill bonus relative to a full 115% stack.
  // The skill-calibration setting (Settings panel) overrides it.
  // ON by default as of v2.17.0 (validated on cross-user cloud data). The perk-to-skill
  // estimate is a grounded guess, not a published Torn formula (see the constants block),
  // but it beats assuming every player is fully perked. Applies only to the success/skill
  // term; the penalty term stays on baseline. Turned off, this returns the guide's plain
  // baseline (1.0), same as a fully-perked tester.
  function calibrationFromBustPerksRespectingSettings(bustPerks) {
    if (!getUserSettings().usePerkCalibration) return CAL_CEILING;
    // Parse-confidence guard: if a bust perk carries a % but we could not classify it as
    // offense (a likely-missed skill perk in new or localised wording), the summed bonus
    // is unreliable and could over-pessimise, so fall back to the neutral baseline rather
    // than trust a shaky number. Perks with no % (utility perks) never affect the sum and
    // do not trip this. Verified against real synced perks: nothing currently trips it.
    if (unclassifiedBustPerks(bustPerks).some((p) => /[\d.]+\s*%/.test(p))) return CAL_CEILING;
    return calibrationFromPerks(bustPerks);
  }

  // Shared by the daily-TTL auto path and the settings-panel "force update" button,
  // so both stay in sync instead of duplicating the fetch-and-apply logic.
  async function fetchAndApplyProfile() {
    const data = await fetchProfileData(getApiKey());
    if (data.level) setPlayerLevel(data.level);

    const bustPerks = extractBustPerks(data);
    skillCalibration = calibrationFromBustPerksRespectingSettings(bustPerks);
    setGlobalBustrState({ bustPerks, lastProfileFetchMs: Date.now() });
    CloudSync.pushSoon(); // perks/level may have changed; back them up if sync is on (no-op otherwise)
    log('Level', getPlayerLevel(), '| bust bonus', sumBustSkillBonus(bustPerks) + '%',
      '| calibration', getSkillCalibration().toFixed(2), '| perks:', bustPerks);
    refreshSuccessChances(); // correct the paint now the real level is in
    refreshPerkImpactDisplay(); // perk data just changed, update the settings panel comparison if open

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

    // Apply calibration immediately from whatever perks were last cached
    skillCalibration = calibrationFromBustPerksRespectingSettings(getGlobalBustrState().bustPerks);

    // Skip the network call if we pulled level/perks recently
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

  // Manual "force update" button in the settings panel: bypass the daily TTL,
  // e.g. right after the user levels up and wants hardness/success % to reflect
  // it immediately instead of waiting up to 24h for the next automatic refresh.
  async function forceProfileRefresh(buttonEl) {
    if (getApiKey() === undefined) return;
    if (buttonEl) { buttonEl.disabled = true; buttonEl.textContent = 'Updating...'; }
    try {
      await fetchAndApplyProfile();
      refreshSettingsStatus();
      if (buttonEl) buttonEl.textContent = 'Updated!';
    } catch (err) {
      recordApiError('level/perks', err); // surface it in the panel, don't bury it in a console
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

  // PDA injects after window.onload, so race a readyState check against load
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
      sanitizeOutcomeLog(); // strip any synthetic/test rows before they can sync or reach the stats
      CloudSync.initFromLoad(); // if sync is enabled + signed in, pull cloud history and merge (no-op otherwise)
      // Restore the cached level so the success model is right before the API replies
      if (typeof getGlobalBustrState().playerLevel === 'number') {
        playerLevel = getGlobalBustrState().playerLevel;
      }

      await initController();
      // Paint whatever's already cached from a previous page load immediately,
      // before waiting on the network fetch below. initController() just created
      // the nav badge with literal "#" placeholder text (see renderBustrDesktopView/
      // renderBustrMobileView) - loadGlobalBustrState() above already restored any
      // previously-fetched penaltyScore/threshold/timestampsArray into memory, but
      // nothing had painted it onto the DOM yet. Torn reloads this script fresh on
      // every page navigation, so without this the "#" placeholder was visible for
      // one full API round-trip on literally every page change, not just first
      // install - recalcLocally() is a free, synchronous local recompute (no-ops
      // if there's nothing cached yet) so this either fixes it instantly or costs
      // nothing.
      // The UI is set up BEFORE any network call, and never behind an await on one.
      // This used to sit after `await loadController()`, which meant any rejection
      // from that call aborted the rest of this bootstrap: no settings trigger, no
      // nav column, no refresh loop, no jail rendering. A bad or blank API key would
      // take the entire interface down with it - precisely the situation where the
      // settings panel is the one thing you need, since it's where the key is fixed.
      // Nothing below this line may depend on the API having succeeded.
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

      // Penalty display and its data. In "always" mode this runs on every page, so the
      // nav badge shows and decays while you do other things; in jail-only mode it
      // only reaches here on the jail page.
      recalcLocally(); // paint the badge from cached log + decay - correct on every page, no API call
      // Only the jail page hits the API. Off the jail page the cached log + decay above is
      // already correct (busts only happen on jail), so we make NO log or profile request
      // while navigating the rest of Torn. This used to fire a `log` API call on every
      // single page load, which quietly ate the log quota over a browsing session.
      // loadController still guards its own errors so a bad key can never abort init.
      if (onJail) {
        try {
          await loadController();
        } catch (err) {
          console.error('[BUSTR] initial load failed (UI is already up)', err);
        }
        profileController(); // fire-and-forget: level + perks, once (daily-throttled inside)
      }

      // Jail-page machinery only. hardnessScoreController self-guards to the jail page;
      // the bust observer arms only there (ensureBustObserver); and passive bust-click
      // capture has nothing to capture elsewhere, so it is gated too. Off the jail page
      // in "always" mode, only the penalty display above stays live.
      hardnessScoreController();
      ensureBustObserver(onJail);
      if (onJail) attachBustClickListener(); // passive only - see COMPLIANCE NOTE at top of file
    } catch (err) {
      console.error('[BUSTR]', err);
    }
  })();
})();