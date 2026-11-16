// ==UserScript==
// @name         BUSTR: Jail Bust Assistant + PDA (Baron)
// @namespace    http://torn.city.com.dot.com.com
// @version      2.30.0
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

// Security/reliability-hardened build. Version history: the BUSTR forum thread changelog.
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
  const SCRIPT_VERSION = '2.30.0'; // keep in sync with @version above

  const PENALTY_PER_BUST = 128;
  const PENALTY_WINDOW_HOURS = 72;
  const PENALTY_DECAY_C = 0.1; // per hour -> half gone at 10h
  const RECENT_HISTORY_WINDOW_DAYS = 30;

  const SHOW_SUCCESS_CHANCE = true;
  const SHOW_SETTINGS_PANEL = true;        // floating settings panel on the jail page
  const PLAYER_INFO_TTL_MS = 24 * 60 * 60 * 1000; // re-read level/perks at most daily
  const PLAYER_LEVEL_FALLBACK = 100;       // used only until the API fills it in
  const SKILL_CALIBRATION_OVERRIDE = null; // number forces it; null = auto from perks
  const FULL_BUST_SKILL_BONUS = 115;       // full stack: faction 50% + education 65%
  const CAL_CEILING = 1.0;                 // auto-cal clamp ceiling
  const CAL_FLOOR = 0.4;                   // clamp floor
  const CAL_NO_PERKS = 0.85;               // fallback when the API returns no bust perks
  const SUCCESS_A = 266.6;           // guide constant (level/perk independent)
  const SUCCESS_B = 0.28;            // chart-derived slope (per minute)
  const PENALTY_PCT_ANCHOR = 1037;   // P0% * level; L61 tester's ~17% fresh = 1037/61
  const SC_GREEN_AT = 60;
  const SC_RED_BELOW = 40;

  const PEN_ORANGE_AT = 50;
  const PEN_RED_AT = 85;

  const PENALTY_WEIGHT = 2.0;

  const PENALTY_SATURATION_PCT = 95;

  const PRED_SHRINK_K = 0.40;    // fraction of raw spread that survives (was 0.65; refit v2.20.0)
  const PRED_SHRINK_CENTER = 45; // %, the pivot predictions are pulled toward

  const SUCCESS_LIFT_K = 36;        // points of lift per 1.0 of cal above the pivot (18 -> 24 v2.24.0 -> 36 v2.26.0)
  const SUCCESS_LIFT_PIVOT = 0.85;  // no-lift point; matches CAL_NO_PERKS

  const OUTCOME_LOG_MAX = 500;           // cap on stored attempts (oldest dropped). A count
  const SELF_CAL_FLOOR = 0.45;          // fitted-cal clamp floor (was 0.3, then 0.6; 0.45 v2.24.0)
  const SELF_CAL_CEILING = 1.9;         // fitted-cal clamp ceiling (1.4 -> 1.7 v2.22.2 -> 1.8 v2.24.0 -> 1.9 v2.26.0)
  const SELF_CAL_STEP = 0.02;           // grid-search resolution

  const SELF_CAL_PRIOR_PSEUDO_N = 100;  // shrinkage strength: the fitted cal earns ~half weight
  const SELF_CAL_HALF_LIFE_DAYS = 60;   // recency half-life: an outcome this old counts half as
  const SELF_CAL_CI_Z = 1.28;           // ~80% normal z for the ADVISORY cal interval (drives the
  const PENDING_ATTEMPT_TIMEOUT_MS = 20 * 1000; // discard a click if no result follows in time

  const API_KEY_SELECTIONS = 'basic,log,perks';
  const API_KEY_CREATE_URL =
    'https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=BUSTR&user=' + API_KEY_SELECTIONS;

  const OUTCOME_MODEL_VERSION = 2;

  const PLAYSTYLE_MAXCOUNT_BUST_OFFSET = -3;    // redLimit shifts 3 lower
  const PLAYSTYLE_MAXCOUNT_SUCCESS_OFFSET = -20; // success colour bands shift 20pts lower

  const DEFAULT_REFRESH_SECONDS = 30;        // tick cadence (local recompute runs every tick)
  const DECAY_REPAINT_MS = 1000;             // featherweight fetch-free repaint of the time-decaying penalty (no API call; see decayRepaintTick)
  const JAIL_MIN_FETCH_GAP_MS = 35 * 1000;   // min gap between jail-page API fetches (dodges Torn's ~30s cache)
  const FETCH_TIMEOUT_MS = 10000;

  const STATE_KEY = 'globalBustrState';
  const UI_SECTIONS_KEY = 'bustrUiSections'; // local-only (never synced): which settings sections are collapsed
  const API_KEY_NAME = 'bustrApiKey';
  const LEGACY_API_KEY_NAME = 'bustrApiKey'; // same name, but in localStorage pre-v2

  const CLOUD_FUNCTION_URL = 'https://bustr-jail-bust-assistant.netlify.app/.netlify/functions/bustr-auth';
  const CLOUD_FIREBASE_API_KEY = 'AIzaSyCw5UQGI-N1pEJZ7xg3OvO_elaTLQfeDYg';
  const CLOUD_PROJECT_ID = 'bustr---jail-bust-assistant';
  const CLOUD_AUTH_KEY = 'bustrCloudAuth'; // kept OUT of state so it never lands in a debug export
  const CLOUD_PULL_KEY = 'bustrCloudLastPull'; // device-local timestamp of the last pull (not synced)
  const CLOUD_PULL_MIN_INTERVAL_MS = 60 * 60 * 1000; // re-pull at most hourly per device (enabling sync still pulls immediately)
  const CLOUD_PUSH_DEBOUNCE_MS = 90 * 1000; // coalesce a busting flurry into one write (timer resets per bust; flushes when you pause)

  const log = (...args) => { if (DEBUG) console.log('[BUSTR]', ...args); };

  log('BUSTR v2 loaded');


  const PDA_API_KEY = '###PDA-APIKEY###';
  function isPDA() {
    return !/^(###).+(###)$/.test(PDA_API_KEY);
  }

  const hasGM =
    typeof GM_setValue !== 'undefined' &&
    typeof GM_getValue !== 'undefined' &&
    typeof GM_deleteValue !== 'undefined';
  const useGM = hasGM && !isPDA();


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
      localStorage.removeItem(LEGACY_API_KEY_NAME);
      localStorage.removeItem(STATE_KEY);
    } catch (err) {
      console.error('[BUSTR] migration failed', err);
    }
  }


  const greenApple = '#85b200';
  const orangeFulvous = '#d08000';
  const orangeAmber = '#ffbf00';
  const redFlame = '#e64d1a';
  const redMelon = '#ffa8a8';
  const LIGHT_GREEN = '#3f6b00';
  const LIGHT_ORANGE = '#a35a00';
  const LIGHT_RED = '#c62828';
  function lightSurface(sel, bodyPrefix = 'body') {
    return `${bodyPrefix}.bustr-theme-light ${sel}, ${bodyPrefix}:not(.dark-mode):not(.bustr-theme-dark) ${sel}`;
  }
  function darkSurface(sel, bodyPrefix = 'body') {
    return `${bodyPrefix}.bustr-theme-dark ${sel}, ${bodyPrefix}.dark-mode:not(.bustr-theme-light) ${sel}`;
  }


  function defaultState() {
    return {
      userSettings: {
        reminderLimits: {
          redLimit: 0,   // red at this number and under
          greenLimit: 3, // green at this number and over
        },
        statsRefreshRate: DEFAULT_REFRESH_SECONDS, // seconds (local recompute)
        showHardnessScore: true,   // hardness number visible
        quickBust: false,          // opt-in: relabel Torn's OWN bust link to no-confirm (step=breakout1); never clicks for you. See COMPLIANCE NOTE.
        quickBail: false,          // opt-in: same for the bail link (buy -> buy1)
        easyBust: false,           // opt-in (consent-gated): header button, 1 tap = 1 bust request for the best shown target. See COMPLIANCE NOTE.
        easyBail: false,           // opt-in (consent-gated): same, bails the cheapest shown inmate.
        easyActionsConsented: false, // true once the Easy actions consent prompt is accepted (covers both)
        showSuccessChance: SHOW_SUCCESS_CHANCE, // per-target % visible
        skillCalibrationOverride: SKILL_CALIBRATION_OVERRIDE, // null = auto from perks
        successGreenAt: SC_GREEN_AT,   // % at/above which a target is green
        successRedBelow: SC_RED_BELOW, // % below which a target is red
        selfCalibrationEnabled: true, // ON = blend the cal learned from your own outcomes with the perk baseline (shrinkage + recency, see getSkillCalibration/computeSelfCalFit); OFF = perk baseline only. Default on: passive-only, see COMPLIANCE NOTE.
        playStyle: 'safety',           // 'safety' | 'maxcount' (display-only thresholds, see PLAYSTYLE_* constants)
        activeScope: 'always',         // 'always' | 'jailOnly' - suppresses nav badge/colours + background fetch off the jail page
        navBadgeDetail: 'simple',      // 'simple' = badge shows only busts-left (default); 'full' = score/threshold : busts + penalty %. Full breakdown always in hover tooltip.
        pdaHoldDetails: false,         // PDA only (default OFF since v2.29.4): ON = force the compact badge + reveal the full readout on a long-press/right-click of the Jail button (see installPdaHoldPopover); OFF = full readout inline like desktop. No effect off PDA.
        textSize: 'normal',            // 'normal' | 'large' | 'xlarge' - scales all of BUSTR's own text (1x / 1.25x / 1.5x); large+ also bolds the numbers. See applyAppearance.
        theme: 'auto',                 // 'auto' (follow Torn's light/dark) | 'light' | 'dark' - for BUSTR's own cards (settings, help, consent, PDA hold card). See applyAppearance.
        pdaHoldOffDefaultApplied: true, // marks the v2.29.4 pdaHold-off migration ran (see loadGlobalBustrState); new installs start applied so an opt-in isn't re-flipped.
        usePerkCalibration: true,     // ON by default (v2.17.0): scales the success/skill term by detected perks. Self-cal overrides once it has samples; penalty term stays on baseline (see getPenaltySkillCalibration).
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
      selfCalFit: null,                   // the self-calibration fit {cal, calFlat, lo, hi, effN, n, ts} from computeSelfCalFit, or null. The single per-user estimate; drives the shrinkage blend. Never pushed to cloud.
    };
  }

  let GLOBAL_BUSTR_STATE = defaultState();

  let playerLevel = PLAYER_LEVEL_FALLBACK;
  function getPlayerLevel() { return playerLevel; }
  function setPlayerLevel(level) {
    if (typeof level === 'number' && level > 0) {
      playerLevel = level;
      setGlobalBustrState({ playerLevel: level });
    }
  }

  let skillCalibration = CAL_CEILING;
  function getSkillCalibration() {
    const override = getUserSettings().skillCalibrationOverride;
    if (typeof override === 'number' && override > 0) return override;

    if (getUserSettings().selfCalibrationEnabled) {
      const fit = getGlobalBustrState().selfCalFit;
      if (fit && typeof fit.cal === 'number' && fit.effN > 0) {
        const wFit = fit.effN / (fit.effN + SELF_CAL_PRIOR_PSEUDO_N);
        return (1 - wFit) * skillCalibration + wFit * fit.cal;
      }
    }
    return skillCalibration;
  }

  function getPenaltySkillCalibration() {
    const override = getUserSettings().skillCalibrationOverride;
    if (typeof override === 'number' && override > 0) return override;
    return CAL_CEILING;
  }

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


  const LOG_CLEARED_KEY = 'bustr_outcome_log_cleared_at';
  function getLogClearedAt() {
    const v = Number(Store.get(LOG_CLEARED_KEY));
    return Number.isFinite(v) ? v : 0;
  }
  function markOutcomeLogCleared() {
    Store.set(LOG_CLEARED_KEY, Date.now());
  }
  function mergeOutcomeLogs(a, b, clearedAt) {
    const seen = new Map();
    for (const o of [...(b || []), ...(a || [])]) {
      if (isRealOutcome(o) && o.ts > (clearedAt || 0)) seen.set(o.ts, o);
    }
    const out = [...seen.values()].sort((x, y) => x.ts - y.ts);
    while (out.length > OUTCOME_LOG_MAX) out.shift();
    return out;
  }
  function sameLogRows(x, y) {
    return x.length === y.length && x.every((o, i) => o && y[i] && o.ts === y[i].ts);
  }
  function mergeStoredOutcomeLog() {
    try {
      const stored = Store.get(STATE_KEY);
      const storedLog = (stored && Array.isArray(stored.outcomeLog)) ? stored.outcomeLog : [];
      const mine = Array.isArray(GLOBAL_BUSTR_STATE.outcomeLog) ? GLOBAL_BUSTR_STATE.outcomeLog : [];
      const merged = mergeOutcomeLogs(mine, storedLog, getLogClearedAt());
      if (!sameLogRows(merged, mine)) {
        GLOBAL_BUSTR_STATE = { ...GLOBAL_BUSTR_STATE, outcomeLog: merged, selfCalFit: computeSelfCalFit(merged) };
      }
    } catch (err) {
      console.error('[BUSTR] outcome log merge failed', err);
    }
  }

  function setGlobalBustrState(newState) {
    GLOBAL_BUSTR_STATE = { ...GLOBAL_BUSTR_STATE, ...newState };
    mergeStoredOutcomeLog(); // never write back an older log over rows another tab saved
    Store.set(STATE_KEY, GLOBAL_BUSTR_STATE);
  }
  function getGlobalBustrState() {
    return GLOBAL_BUSTR_STATE;
  }
  function loadGlobalBustrState() {
    const loaded = Store.get(STATE_KEY);
    if (loaded === undefined) return false;
    GLOBAL_BUSTR_STATE = { ...GLOBAL_BUSTR_STATE, ...loaded };
    const defaults = defaultState().userSettings;
    const savedSettings = (loaded && loaded.userSettings) || {};
    GLOBAL_BUSTR_STATE.userSettings = {
      ...defaults,
      ...savedSettings,
      reminderLimits: { ...defaults.reminderLimits, ...(savedSettings.reminderLimits || {}) },
    };
    if (typeof savedSettings.usePerkCalibration !== 'boolean' && typeof savedSettings.ignorePerks === 'boolean') {
      GLOBAL_BUSTR_STATE.userSettings.usePerkCalibration = !savedSettings.ignorePerks;
    }
    delete GLOBAL_BUSTR_STATE.userSettings.ignorePerks;
    delete GLOBAL_BUSTR_STATE.userSettings.highPenaltyCaution;
    if (GLOBAL_BUSTR_STATE.userSettings.perkCalDefaultApplied !== true) {
      GLOBAL_BUSTR_STATE.userSettings.usePerkCalibration = true;
      GLOBAL_BUSTR_STATE.userSettings.perkCalDefaultApplied = true;
    }
    if (GLOBAL_BUSTR_STATE.userSettings.pdaHoldOffDefaultApplied !== true) {
      GLOBAL_BUSTR_STATE.userSettings.pdaHoldDetails = false;
      GLOBAL_BUSTR_STATE.userSettings.pdaHoldOffDefaultApplied = true;
    }
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
    markOutcomeLogCleared(); // so a still-open older tab can't write the erased history back
    GLOBAL_BUSTR_STATE = defaultState();
    Store.remove(STATE_KEY);
  }

  function getMyViewportWidthType() {
    if (!window.visualViewport) throw new Error('Visual viewport not loaded');
    return window.visualViewport.width > 1000 ? 'Desktop' : 'Mobile';
  }

  function isMobileViewport() {
    try {
      return getMyViewportWidthType() !== 'Desktop';
    } catch (e) {
      return false;
    }
  }


  const API_KEY_LENGTH = 16;
  function sanitizeApiKey(raw) {
    if (typeof raw !== 'string') return '';
    return raw.replace(/[^A-Za-z0-9]/g, '');
  }

  function setApiKey(apiKey) {
    Store.set(API_KEY_NAME, sanitizeApiKey(apiKey));
  }
  function getApiKey() {
    const stored = sanitizeApiKey(Store.get(API_KEY_NAME));
    if (stored !== '') return stored;
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

  function addOptimisticBustTimestamp() {
    const now = Date.now() / 1000;
    const ts = getTimestampsArray();
    const next = Array.isArray(ts) ? ts.slice() : [];
    next.unshift(now); // newest-first, matching createTimestampsArray / calcPenaltyThreshold
    setTimestampsArray(next);
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

  function setAvailableBusts(newAvailableBusts) {
    setGlobalBustrState({ availableBusts: newAvailableBusts });
  }
  function getAvailableBusts() {
    return getGlobalBustrState().availableBusts;
  }


  function createTimestampsArray(data) {
    const cutoff = Date.now() / 1000 - RECENT_HISTORY_WINDOW_DAYS * 24 * 60 * 60;
    const timestamps = [];
    for (const entry in data.log) {
      const ts = data.log[entry].timestamp;
      if (ts >= cutoff) timestamps.push(ts);
    }
    return timestamps;
  }

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

  function penaltyPctAt(hoursAgo) {
    if (hoursAgo < 0) hoursAgo = 0;
    if (hoursAgo > PENALTY_WINDOW_HOURS) return 0;
    const skill = getPlayerLevel() * getPenaltySkillCalibration();
    const p0 = PENALTY_PCT_ANCHOR / skill;
    return p0 / (1 + PENALTY_DECAY_C * hoursAgo);
  }

  function calcPenaltyPct(timestampsArray) {
    if (!timestampsArray || timestampsArray.length === 0) return 0;
    const now = Date.now() / 1000;
    let pct = 0;
    for (const ts of timestampsArray) pct += penaltyPctAt((now - ts) / 3600);
    return pct;
  }

  function calcSuccessChanceRaw(hardness, penaltyPct, calibration) {
    const skill = getPlayerLevel() * calibration;
    const effectivePenalty = PENALTY_WEIGHT * Math.min(penaltyPct, PENALTY_SATURATION_PCT);
    const raw = SUCCESS_A - (SUCCESS_B * 60 / skill) * hardness - effectivePenalty;
    const clamped = Math.max(1, Math.min(100, raw));
    const shrunk = PRED_SHRINK_CENTER + PRED_SHRINK_K * (clamped - PRED_SHRINK_CENTER);
    const lift = SUCCESS_LIFT_K * (calibration - SUCCESS_LIFT_PIVOT);
    return Math.max(1, Math.min(100, shrunk + lift));
  }

  function calcSuccessChance(hardness, penaltyPct) {
    return Math.round(calcSuccessChanceRaw(hardness, penaltyPct, getSkillCalibration()));
  }


  function fittableOutcomes(outcomeLog) {
    if (!Array.isArray(outcomeLog)) return [];
    return outcomeLog.filter((o) => o && o.m === OUTCOME_MODEL_VERSION);
  }

  function isRealOutcome(o) {
    return !!o && typeof o === 'object' && typeof o.ts === 'number' && !('note' in o);
  }

  function computeSelfCalFit(outcomeLog) {
    const usable = fittableOutcomes(outcomeLog);
    if (usable.length === 0) return null;
    const now = Date.now();
    const DAY_MS = 86400000;
    const rows = usable.map((o) => {
      const ts = (typeof o.ts === 'number') ? o.ts : now;
      const ageDays = Math.max(0, (now - ts) / DAY_MS); // clamp future/missing ts to age 0
      return { h: o.h, pen: o.pen, y: o.success ? 1 : 0, w: Math.exp(-ageDays / SELF_CAL_HALF_LIFE_DAYS) };
    });
    let effN = 0;
    for (const r of rows) effN += r.w;
    let bestCal = null, bestErr = Infinity, bestFlat = null, bestFlatErr = Infinity;
    for (let c = SELF_CAL_FLOOR; c <= SELF_CAL_CEILING + 1e-9; c += SELF_CAL_STEP) {
      let err = 0, flat = 0;
      for (const r of rows) {
        const d = calcSuccessChanceRaw(r.h, r.pen, c) / 100 - r.y;
        const sq = d * d;
        err += r.w * sq;
        flat += sq;
      }
      if (err < bestErr) { bestErr = err; bestCal = c; }
      if (flat < bestFlatErr) { bestFlatErr = flat; bestFlat = c; }
    }
    if (bestCal === null) return null;
    const eps = SELF_CAL_STEP;
    let info = 0;
    for (const r of rows) {
      const dp = (calcSuccessChanceRaw(r.h, r.pen, bestCal + eps) - calcSuccessChanceRaw(r.h, r.pen, bestCal - eps)) / (200 * eps);
      info += r.w * dp * dp;
    }
    const residualVar = bestErr / Math.max(effN, 1e-9);
    const se = info > 1e-9 ? Math.sqrt(residualVar / info) : (SELF_CAL_CEILING - SELF_CAL_FLOOR);
    const clamp = (v) => Math.min(SELF_CAL_CEILING, Math.max(SELF_CAL_FLOOR, v));
    const r2 = (v) => Math.round(v * 100) / 100;
    return {
      cal: r2(bestCal),
      calFlat: r2(bestFlat),
      lo: r2(clamp(bestCal - SELF_CAL_CI_Z * se)),
      hi: r2(clamp(bestCal + SELF_CAL_CI_Z * se)),
      effN: Math.round(effN * 10) / 10,
      n: usable.length,
      ts: now,
    };
  }

  function selfCalTrend(fit) {
    if (!fit || typeof fit.cal !== 'number' || typeof fit.calFlat !== 'number') return 'steady';
    const d = fit.cal - fit.calFlat;
    if (d > 0.03) return 'rising';
    if (d < -0.03) return 'falling';
    return 'steady';
  }

  function selfCalBrierCheck(outcomeLog) {
    const usable = fittableOutcomes(outcomeLog)
      .filter((o) => typeof o.ts === 'number')
      .sort((a, b) => a.ts - b.ts);
    const fullFit = computeSelfCalFit(outcomeLog);
    const prior = skillCalibration;
    const blend = (fit) => {
      if (!fit || !(fit.effN > 0)) return prior;
      const w = fit.effN / (fit.effN + SELF_CAL_PRIOR_PSEUDO_N);
      return (1 - w) * prior + w * fit.cal;
    };
    const out = {
      effCal: Math.round(blend(fullFit) * 100) / 100,
      lo: fullFit ? fullFit.lo : null,
      hi: fullFit ? fullFit.hi : null,
      effN: fullFit ? fullFit.effN : 0,
      trend: selfCalTrend(fullFit),
      holdout: null,
    };
    if (fittableOutcomes(outcomeLog).length === 0) return null;
    if (usable.length < 40) return out; // too little for a meaningful 70/30 temporal split
    const cut = Math.floor(usable.length * 0.7);
    const train = usable.slice(0, cut);
    const test = usable.slice(cut);
    if (test.length === 0) return out;
    const oldCal = prior; // baseline: perk prior with no learning (self-cal off)
    const newCal = blend(computeSelfCalFit(train)); // self-cal on: the shrinkage blend
    const brierOn = (rows, cal) => {
      let s = 0;
      for (const o of rows) { const d = calcSuccessChanceRaw(o.h, o.pen, cal) / 100 - (o.success ? 1 : 0); s += d * d; }
      return Math.round((s / rows.length) * 1e4) / 1e4;
    };
    out.holdout = { testN: test.length, brierOld: brierOn(test, oldCal), brierNew: brierOn(test, newCal) };
    return out;
  }

  function selfCalibrationStats(outcomeLog) {
    if (!Array.isArray(outcomeLog) || outcomeLog.length === 0) return null;
    const n = outcomeLog.length;
    const successes = outcomeLog.filter((o) => o.success).length;
    const jailed = outcomeLog.filter((o) => o.jailed).length;
    const usable = fittableOutcomes(outcomeLog).length;
    return { n, successRatePct: Math.round((100 * successes) / n), jailed, usable };
  }

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
      overrideLength: overrideLen,
      overrideRawLength: overrideRawLen,
      pdaTokenSubstituted: isPDA(), // false = the ###...### placeholder is still literal (not running under PDA)
      pdaKeyLength: pdaLen,
      pdaKeyRawLength: pdaRawLen,
    };
  }

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
      holder: computed(holder),
      link: computed(link),
      pctText: pctSpan ? pctSpan.textContent : null, // '#' here means the stats renderer never reached it
      badgeSize: { w: badge.offsetWidth, h: badge.offsetHeight },
      pctLineSize: pctLine ? { w: pctLine.offsetWidth, h: pctLine.offsetHeight } : null,
      holderSize: holder ? { w: holder.offsetWidth, h: holder.offsetHeight } : null,
      colSize: col ? { w: col.offsetWidth, h: col.offsetHeight } : null,
    };
  }

  function describeNavStructure() {
    const jail = document.querySelector('#nav-jail');
    if (!jail) return null;
    const describe = (el) => {
      if (!el || !el.tagName) return null;
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
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

  function buildDiagnosticExport() {
    const state = getGlobalBustrState();
    const outcomeLog = Array.isArray(state.outcomeLog) ? state.outcomeLog : [];
    const nameFreeLog = outcomeLog.map((o) => { if (!o || typeof o !== 'object') return o; const { nm, ...rest } = o; return rest; });
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
      selfCalFit: state.selfCalFit || null, // the self-calibration fit {cal, calFlat, lo, hi, effN, n, ts}; name-free, local only
      outcomeStats: selfCalibrationStats(outcomeLog),
      outcomeLog: nameFreeLog, // no nm (see above)
      timestampsArray: state.timestampsArray || [],
      cache: {
        lastProfileFetchMs: state.lastProfileFetchMs || 0, // when level/perks were last pulled
        lastFetchTimestampMs: state.lastFetchTimestampMs || 0, // when the bust-log API last SUCCEEDED
      },
      lastApiError: state.lastApiError || null, // why the last API call failed, or null if it succeeded
      fatalKeyError, // true once Torn rejected the key (code 2/16) and auto-refresh was paused
      apiKey: describeApiKey(), // SOURCE and LENGTH only - never the key itself (see describeApiKey)
      modelConstants: {
        SUCCESS_A, SUCCESS_B,
        PENALTY_PER_BUST, PENALTY_WINDOW_HOURS, PENALTY_DECAY_C, PENALTY_PCT_ANCHOR, RECENT_HISTORY_WINDOW_DAYS,
        CAL_CEILING, CAL_FLOOR, CAL_NO_PERKS, FULL_BUST_SKILL_BONUS,
        PENALTY_WEIGHT, PENALTY_SATURATION_PCT, PRED_SHRINK_K, PRED_SHRINK_CENTER, OUTCOME_MODEL_VERSION,
        SELF_CAL_FLOOR, SELF_CAL_CEILING, SELF_CAL_STEP, OUTCOME_LOG_MAX,
        SELF_CAL_PRIOR_PSEUDO_N, SELF_CAL_HALF_LIFE_DAYS, SELF_CAL_CI_Z,
      },
    };
  }

  let pendingAttempt = null;

  function recordPendingAttempt(hardness, predictedChance, name) {
    pendingAttempt = {
      hardness,
      predictedChance,
      name: (typeof name === 'string' ? name : ''),
      penaltyPct: calcPenaltyPct(getTimestampsArray()),
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
      nm: attempt.name || '', // captive name for the local history view only - stripped before any cloud push
      ts: Date.now(),
      m: OUTCOME_MODEL_VERSION, // marks this pen as recorded under the corrected penalty model
    });
    while (outcomeLog.length > OUTCOME_LOG_MAX) outcomeLog.shift();

    setGlobalBustrState({ outcomeLog, selfCalFit: computeSelfCalFit(outcomeLog) });
    CloudSync.pushSoon(); // opt-in cloud backup; no-op unless enabled + signed in (see CloudSync)

    const outcomeLabel = success ? 'success' : (jailed ? 'failure (jailed)' : 'failure (clean)');
    console.log(`[BUSTR] Adaptive calibration: logged ${outcomeLabel} (hardness ${attempt.hardness}, predicted ${attempt.predictedChance}%) - ${outcomeLog.length} sample(s) recorded.`);
    logSelfCalCheck(outcomeLog);
  }

  function logSelfCalCheck(outcomeLog) {
    const chk = selfCalBrierCheck(outcomeLog);
    if (!chk) return;
    let line = `[BUSTR] Adaptive cal: effective cal ${chk.effCal}`
      + (chk.lo != null ? ` [${chk.lo} - ${chk.hi}]` : '')
      + `, effN ${chk.effN}, trend ${chk.trend}.`;
    if (chk.holdout) {
      line += ` Holdout (predicting your ${chk.holdout.testN} most recent fittable bust(s)): Brier perks-only ${chk.holdout.brierOld} vs adaptive ${chk.holdout.brierNew} (lower is better).`;
    }
    console.log(line);
  }

  function sanitizeOutcomeLog() {
    const state = getGlobalBustrState();
    const logArr = Array.isArray(state.outcomeLog) ? state.outcomeLog : [];
    const clean = logArr.filter(isRealOutcome);
    if (clean.length !== logArr.length) {
      setGlobalBustrState({ outcomeLog: clean, selfCalFit: computeSelfCalFit(clean) });
      console.log(`[BUSTR] Removed ${logArr.length - clean.length} non-genuine outcome row(s) from the log.`);
    }
  }


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
    function mergeLogs(a, b) {
      return mergeOutcomeLogs(a, b, getLogClearedAt());
    }
    const stripNm = (logArr) => (logArr || []).map((o) => { const { nm, ...rest } = o; return rest; });
    const enabled = () => !!getUserSettings().cloudSyncEnabled;
    const signedIn = () => { const a = loadAuth(); return !!(a && a.refreshToken); };

    async function mergeWithCloud(a) {
      const cloud = (await fsGet(a.uid)) || [];
      mergeStoredOutcomeLog(); // pick up rows another tab saved since this tab loaded
      const localLog = getGlobalBustrState().outcomeLog || [];
      const merged = mergeLogs(localLog, cloud);
      if (!sameLogRows(merged, localLog)) {
        setGlobalBustrState({ outcomeLog: merged, selfCalFit: computeSelfCalFit(merged) });
      }
      return { cloud, merged: getGlobalBustrState().outcomeLog || [] };
    }
    async function pullMerge() {
      const a = loadAuth(); if (!a) return;
      const { cloud, merged } = await mergeWithCloud(a);
      if (!sameLogRows(merged, cloud)) await fsPatch(a.uid, { log: stripNm(merged), ...profileSnapshot() });
    }
    function profileSnapshot() {
      const s = getGlobalBustrState();
      const us = getUserSettings();
      return {
        perks: Array.isArray(s.bustPerks) ? s.bustPerks : [],
        level: getPlayerLevel() || 0,
        sv: SCRIPT_VERSION,                 // which build produced these numbers (pre/post-shrink etc.)
        cal: getSkillCalibration(),         // effective skill calibration currently in use (the shrinkage blend)
        selfCalVal: (s.selfCalFit && typeof s.selfCalFit.cal === 'number' ? s.selfCalFit.cal : null), // the self-cal fit's point estimate (same cloud field, now single-sourced)
        pda: isPDA(),                       // desktop vs PDA, for segmentation
        settings: {
          perkCal: !!us.usePerkCalibration,
          selfCal: !!us.selfCalibrationEnabled,
          calOverride: (typeof us.skillCalibrationOverride === 'number' ? us.skillCalibrationOverride : null),
          playStyle: us.playStyle || null,
          redLimit: us.reminderLimits ? us.reminderLimits.redLimit : null,
          greenLimit: us.reminderLimits ? us.reminderLimits.greenLimit : null,
          statsRefreshRate: (typeof us.statsRefreshRate === 'number' ? us.statsRefreshRate : null),
          activeScope: us.activeScope || null,
          navBadgeDetail: us.navBadgeDetail || null,
          showHardnessScore: !!us.showHardnessScore,
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
    async function push() {
      const a = loadAuth(); if (!a) return;
      const { merged } = await mergeWithCloud(a);
      await fsPatch(a.uid, { log: stripNm(merged), ...profileSnapshot() });
    }
    function pushSoon() {
      if (!enabled() || !signedIn()) return;
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(() => push().catch((e) => log('cloud push failed', e)), CLOUD_PUSH_DEBOUNCE_MS);
    }
    function initFromLoad() {
      if (!enabled() || !signedIn() || !hasGMXhr) return;
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

  async function fetchTornJson(url) {
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

  async function fetchBustsData(apiKey) {
    const data = await fetchTornJson(`https://api.torn.com/user/?selections=log&log=5360&key=${apiKey}`);
    if (!data.log) throw new Error('Unexpected API response (no log data)');
    setLastFetchTimestampMs();
    return data;
  }

  async function fetchProfileData(apiKey) {
    return fetchTornJson(`https://api.torn.com/user/?selections=basic,perks&key=${apiKey}`);
  }

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

  function sumBustSkillBonus(perkStrings) {
    let bonus = 0;
    for (const perk of perkStrings) {
      if (classifyPerk(perk) !== 'offense') continue;
      const m = perk.match(/([\d.]+)\s*%/);
      if (m) bonus += parseFloat(m[1]);
    }
    return bonus; // e.g. 115 for faction 50 + education 65
  }

  function unclassifiedBustPerks(perkStrings) {
    return perkStrings.filter((p) => classifyPerk(p) === 'unknown');
  }

  function calibrationFromPerks(perkStrings) {
    if (!Array.isArray(perkStrings) || perkStrings.length === 0) return CAL_NO_PERKS;
    const bonus = sumBustSkillBonus(perkStrings);
    const cal = (100 + bonus) / (100 + FULL_BUST_SKILL_BONUS);
    return Math.max(CAL_FLOOR, Math.min(CAL_CEILING, cal));
  }


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
        const text = (mutation.target.textContent || '').trim();
        if (!text) continue;

        if (text.match(/^(You busted ).+/) && mutation.removedNodes.length > 0) {
          observer.disconnect();
          log('SuccessfulBust', Date.now());

          addOptimisticBustTimestamp(); // add the bust to the cached log...
          recalcPenaltyScoreOnly();     // ...and repaint from it, so the decay owns the value (no scalar-bump snap-back)

          successfulBustUpdateController();
          logOutcome(true); // self-calibration: attribute to whatever bust link was last clicked

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


  let jailObserver = null;
  function createJailMutationObserver() {
    if (jailObserver) jailObserver.disconnect();
    jailObserver = new MutationObserver(successfulBustMutationCallback);
    jailObserver.observe(document, { attributes: false, childList: true, subtree: true });
  }

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

      recordPendingAttempt(hardness, predicted, jailRowName(li));
      log('Bust click captured for self-calibration', { hardness, predicted });
    } catch (err) {
      console.error('[BUSTR]', err);
    }
  }

  function attachBustClickListener() {
    if (bustClickListenerAttached) return;
    document.addEventListener('click', handleJailClick, true);
    bustClickListenerAttached = true;
  }


  const bustrStylesheetHTML = `<style id="bustr-stylesheet">
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
  font-size: calc(12px * var(--bustr-fs, 1));
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
  line-height: 1; white-space: nowrap; font-size: calc(9px * min(var(--bustr-fs, 1), 1.25)); font-weight: 700;
}
#bustr-sidebar-btn .bustr-mobile-badge .bustr-pct-line {
  display: block; font-size: calc(8px * min(var(--bustr-fs, 1), 1.25)); font-weight: 400; opacity: 0.9; white-space: nowrap;
}
/* Fallback form, badge still in #nav-jail: keep it to one compact line. */
.bustr-mobile-badge .bustr-pct-line {display: block; font-size: 0.75em; opacity: 0.85; white-space: nowrap;}
/* PDA slide-out / vertical nav: the badge sits in #nav-jail (not BUSTR's own column), laid out
   in normal flow, so a two-line count-over-% badge makes the Jail row taller than its siblings
   and stretches the menu. Put the count and % on ONE compact line here so the row height matches
   the rest of the nav. The stacked two-line layout is kept only in BUSTR's own mobile column
   (#bustr-sidebar-btn), which is a vertical cell with room for it. */
#nav-jail .bustr-mobile-badge {
  display: inline-flex; align-items: baseline; gap: 4px;
  line-height: 1; white-space: nowrap; vertical-align: middle;
}
#nav-jail .bustr-mobile-badge .bustr-pct-line {
  display: inline; margin-left: 0; font-size: 0.8em; line-height: 1;
}

/* "Jail page only" scope: hide BUSTR entirely off the jail page - the badge, the colouring,
   AND BUSTR's own nav column / sidebar settings trigger (#bustr-sidebar-btn) - toggled purely
   via body class (no DOM changes). The trigger reappears on the jail page itself, so that is
   where you re-open settings to switch the scope back; in this mode BUSTR is, by request,
   invisible everywhere else. (Only BUSTR's own injected #bustr-sidebar-btn is hidden - never
   Torn's real #nav-jail link, which is Torn's own navigation.)
   The mobile/PDA badge lives inside BUSTR's own nav column (#bustr-sidebar-btn), whose
   "#bustr-sidebar-btn .bustr-mobile-badge" display rule is an ID selector and so OUTRANKS a
   plain ".bustr-stats" hide - so on PDA the badge stayed visible off the jail page and
   jail-only "didn't work" (worked on desktop, where the badge sits in #nav-jail with no
   competing display rule). Match that ID specificity for both slots the badge can occupy
   (own column, or the #nav-jail fallback) and add !important so the hide always wins.
   #bustr-sidebar-btn itself is an ID selector, so hiding the whole column needs no extra help. */
body.bustr-inactive .bustr-stats,
body.bustr-inactive #bustr-sidebar-btn,
body.bustr-inactive #bustr-sidebar-btn .bustr-mobile-badge,
body.bustr-inactive #nav-jail .bustr-mobile-badge {display: none !important;}
body.bustr-inactive.bustr--green,
body.bustr-inactive.bustr--orange,
body.bustr-inactive.bustr--red {--color: inherit;}

#bustr-context.contextMenu___bjhoL {display: none; left: unset; right: -92px; padding: 0 8px; z-index: 9999;}
.contextMenuActive___e6i_B #bustr-context.contextMenu___bjhoL {display: flex;}
/* PDA hold-to-reveal ON (body.bustr-pda-hold): the full readout lives ONLY in the hold
   popover, so re-hide the contextMenuActive-driven popover above unless it is actively held
   open (.bustr-show). It already outranks that rule on specificity; !important too (lab4g)
   because on PDA Torn's own nav styling carries !important (lab4f's badge lesson) and this hide
   must win whenever the popover is not held open. :not(.bustr-show) leaves a real hold alone.
   Off PDA / hold OFF the class is absent, so desktop and the hold-off nav readout are unchanged. */
body.bustr-pda-hold #bustr-context.contextMenu___bjhoL:not(.bustr-show) {display: none !important;}
/* lab4g: with Hold ON the long-press on the hold targets is BUSTR's, so stop iOS grabbing it for
   its own link callout/preview - that takeover can cancel the touch (touchcancel), and a
   cancelled touch now cancels the hold. No-op on Android; absent off PDA / with hold OFF. */
body.bustr-pda-hold #nav-jail,
body.bustr-pda-hold #bustr-sidebar-btn {-webkit-touch-callout: none;}
/* Hold-for-details ON pulls BUSTR OUT of the nav bar entirely: every numeric badge (the inline
   #nav-jail readout, the mobile badge) AND BUSTR's own nav column / settings button
   (#bustr-sidebar-btn, which also carries the moved mobile badge) are hidden, so the count AND
   the BUSTR button live ONLY in the hold popover (#bustr-context, a sibling of #nav-jail, not
   matched here): a long-press/right-click on Jail reveals busts + penalty % with the BUSTR
   button underneath (.bustr-ctx-btn below, lab4h). !important, like the jail-only hide above,
   so Torn's own nav styling (its !important / inline display on the badge) cannot keep it
   visible on PDA - specificity alone lost (lab4f). Absent off PDA / with hold OFF, so desktop
   and the hold-off nav (badge + BUSTR column) are unchanged. */
body.bustr-pda-hold #nav-jail .bustr-stats,
body.bustr-pda-hold #nav-jail .bustr-mobile-badge,
body.bustr-pda-hold #bustr-sidebar-btn {display: none !important;}
/* lab4h: the BUSTR button inside the hold popover. Hidden by default, so the hold-off /
   non-PDA popover stays stats-only exactly as before; shown only while hold is on, where it is
   the settings entry point replacing the hidden nav column. cursor:pointer (below) also makes
   iOS deliver the tap as a click. */
.bustr-ctx-btn {display: none;}
/* lab4i: Hold ON - the popover as one neat card. It renders IN FLOW in the JAIL slot, right
   under the JAIL label (the user's lab4h screenshots), and in flow is what keeps it inside the
   horizontally scrolling nav strip, so its POSITION is deliberately untouched - only its look.
   The popover's side padding and Torn's arrow span sat in its flex row beside the stats and
   pushed them ~10px right of JAIL, so both go and the row centres instead. The stats span
   becomes the card: dark, bordered, a caret pointing up at JAIL, count and % on ONE line split
   by a thin divider (shorter than the old stacked pair), the BUSTR button full-width along the
   bottom. position:relative + z-index lift it over the neighbouring nav labels it overlaps
   while open. !important on box/size: the span also wears Torn's linkName class, whose PDA
   styling could otherwise resize or clip it (lab4f lesson). NO display on the card itself: as
   a flex item it is block already, and a display !important here would outrank the jail-only
   hide (body.bustr-inactive .bustr-stats). All scoped to body.bustr-pda-hold, so desktop and
   the hold-OFF popover are unchanged. */
body.bustr-pda-hold #bustr-context.contextMenu___bjhoL {padding: 0 !important; justify-content: center;}
body.bustr-pda-hold #bustr-context .bustr-arrow {display: none !important;}
body.bustr-pda-hold #bustr-context .bustr-stats {
  flex: 0 0 auto; position: relative; z-index: 2;
  width: auto !important; max-width: none !important; height: auto !important; overflow: visible !important;
  margin: 6px 0 2px !important; padding: 4px 5px !important;
  background: #2a2a2a !important; border: 1px solid #555 !important; border-radius: 6px !important;
  text-align: center; white-space: nowrap;
  font-size: calc(13px * var(--bustr-fs, 1)) !important; font-weight: 700; line-height: 14px !important;
}
/* The caret: two stacked border triangles - the outer in the border colour, the inner in the
   card colour 1px lower, covering the border line under it - so it reads as one outlined notch.
   Every box property is set in case Torn's linkName class has pseudo-elements of its own. */
body.bustr-pda-hold #bustr-context .bustr-stats::before,
body.bustr-pda-hold #bustr-context .bustr-stats::after {
  content: ""; position: absolute; left: 50%; right: auto; bottom: auto;
  width: 0; height: 0; margin: 0; padding: 0; background: none; transform: none;
  border-style: solid; border-color: transparent;
}
body.bustr-pda-hold #bustr-context .bustr-stats::before {top: -5px; margin-left: -5px; border-width: 0 5px 5px; border-bottom-color: #555;}
body.bustr-pda-hold #bustr-context .bustr-stats::after {top: -4px; margin-left: -4px; border-width: 0 4px 4px; border-bottom-color: #2a2a2a;}
/* Compact OFF: the score / threshold prefix becomes its own small, dim line above the count;
   its trailing " : " (.bustr-ctx-sep) only makes sense inline, so it goes. :not(.bustr-compact)
   so this never fights the compact hide further down. */
body.bustr-pda-hold:not(.bustr-compact) #bustr-context .bustr-ctx-detail {
  display: block; margin-bottom: 3px; font-size: calc(9px * var(--bustr-fs, 1)); font-weight: 400; line-height: 11px; opacity: 0.7;
}
body.bustr-pda-hold #bustr-context .bustr-ctx-sep {display: none;}
/* The % sits beside the count after a thin divider; its severity colour classes still apply. */
body.bustr-pda-hold #bustr-context .bustr-pct-line {
  display: inline-block; margin-left: 2px; padding-left: 6px;
  border-left: 1px solid rgba(255, 255, 255, 0.22);
  font-size: calc(11px * var(--bustr-fs, 1)); line-height: 13px;
}
body.bustr-pda-hold #bustr-context .bustr-ctx-btn {
  display: block; margin: 5px 0 0; padding: 2px 6px; border-radius: 4px;
  background: rgba(140, 168, 90, 0.18); border: 1px solid rgba(140, 168, 90, 0.45); color: #e6e6e6;
  font-size: calc(10px * var(--bustr-fs, 1)); font-weight: 700; line-height: 12px; text-align: center; white-space: nowrap;
  cursor: pointer;
}
body.bustr-pda-hold #bustr-context .bustr-ctx-btn:active {background: rgba(140, 168, 90, 0.34);}
/* PDA hold-to-reveal: our OWN show class, independent of Torn's native contextMenuActive
   state, so a long-press / right-click opens the full readout even when PDA takes the
   desktop render branch. Two classes outrank the base one-class display:none above - no
   !important needed. See installPdaHoldPopover / wirePdaHoldHandlers. */
#bustr-context.contextMenu___bjhoL.bustr-show {display: flex;}
#bustr-context.contextMenu___bjhoL .arrow___tKP13 {border-color: transparent #373636 transparent transparent; border-width: 6px 5px 6px 0; content: ""; left: unset; right: -6px; top: -6px;}

#body .users-list-title {display: flex; justify-content: start; align-items: center;}
#body .users-list-title .title{width: 269px;}
#body .users-list-title .time{width: 50px;}
#body .users-list-title .level{width: 53px;}
#body .users-list-title .reason{width: 205px;}
#body .users-list-title .hardness{display: block; width: 79px; text-align: center;}

#body .user-info-list-wrap > li .info-wrap .hardness {display: block; text-align: center;}
#body .user-info-list-wrap > li .info-wrap .hardness span.title {display: none;}

.bustr-success-chance {display: block; font-weight: 700; font-size: calc(11px * var(--bustr-fs, 1)); line-height: 1.1;}
.bustr-success-chance.bustr-sc--green {color: ${greenApple};}
.bustr-success-chance.bustr-sc--orange {color: ${orangeAmber};}
.bustr-success-chance.bustr-sc--red {color: ${redMelon};}

body.bustr-no-hardness .bustr-hardness-score {display: none;}
/* Only "Show hardness number" hides the number - Compact nav badge no longer does (lab4m). */
body.bustr-no-success .bustr-success-chance {display: none;}

/* Compact nav badge: show only the "busts left" count, hide the penalty prefix. On PDA the
   badge is always compact (the full readout moves to the hold popover). */
body.bustr-badge-simple .bustr-badge-detail {display: none;}
/* When the Compact preference is on, the hold popover compacts the same way the nav badge
   does: hide its "score / threshold :" prefix, leaving busts-left + penalty %. Uses its OWN
   class (not .bustr-badge-detail), so it is driven by the compact preference rather than PDA's
   always-on badge-simple state - so holding with compact OFF still reveals the full readout. */
body.bustr-compact #bustr-context .bustr-ctx-detail {display: none;}

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
  cursor: pointer; color: #6f8340; line-height: 1; user-select: none;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
  display: inline-flex; align-items: center; justify-content: center;
  box-sizing: border-box; min-width: 50px; min-height: 28px;
  margin-left: 6px; padding: 3px 16px; border-radius: 6px;
  background: rgba(111, 131, 64, 0.12); border: 1px solid rgba(111, 131, 64, 0.38);
}
.bustr-easy-bar .bustr-jail-refresh-glyph {font-size: calc(18px * var(--bustr-fs, 1)); line-height: 1; transition: transform 0.2s ease;}
.bustr-easy-bar .bustr-jail-refresh:hover {background: rgba(111, 131, 64, 0.22); border-color: rgba(111, 131, 64, 0.6); color: #4b5c28;}
.bustr-easy-bar .bustr-jail-refresh:hover .bustr-jail-refresh-glyph {transform: rotate(90deg);}
/* Touch devices (phones, Torn PDA): keep the reload pill WIDE for an easy finger target, but
   at the same height as on desktop so it never stretches the BUSTR bar taller than Torn's row.
   (Only width grows here - an earlier taller min-height stretched the bar on PDA.) */
@media (pointer: coarse) {
  .bustr-easy-bar .bustr-jail-refresh {min-width: 64px; padding: 3px 22px;}
}

/* Easy Bust / Easy Bail action bar (opt-in; one request per tap). Its own full-width bar
   under the jail filter, so buttons have room and don't wrap into the header's icon columns. */
.bustr-easy-bar {
  display: flex; align-items: center; flex-wrap: wrap; gap: 5px;
  padding: 6px 12px; margin: 0;
  background: rgba(0, 0, 0, 0.06); border-bottom: 1px solid rgba(0, 0, 0, 0.14);
}
.bustr-easy-bar .bustr-easy-label {
  font-size: calc(10px * var(--bustr-fs, 1)); font-weight: 800; letter-spacing: 0.5px;
  color: #5a6b34; text-transform: uppercase;
}
.bustr-easy-btn {
  cursor: pointer; font-size: calc(12px * var(--bustr-fs, 1)); font-weight: 700; white-space: nowrap;
  color: #14180c; background: #8ca05a; border: 1px solid #6f8340; border-radius: 5px;
  padding: 4px 12px; user-select: none; line-height: 1.2; transition: background 0.12s ease;
}
.bustr-easy-btn:hover {background: #b6cc7a;}
.bustr-easy-btn:active {background: #7a9049;}
.bustr-easy-btn.bustr-easy-busy {opacity: 0.5; pointer-events: none;}
.bustr-easy-btn.bustr-easy-bail {background: #c9a84a; border-color: #a2842f;}
.bustr-easy-btn.bustr-easy-bail:hover {background: #dcbf63;}
/* Quick Bust toggle pill: OFF (outlined) or ON (green fill), flipping the opt-in link-relabel
   mode. Unlike the Easy buttons it fires nothing - it only relabels your OWN bust link so your
   single click skips Torn's confirm step. (Quick Bail's toggle lives in the settings panel.)
   Slim side padding keeps the bar short. */
.bustr-easy-bar .bustr-quick-toggle {
  cursor: pointer; font-size: calc(12px * var(--bustr-fs, 1)); font-weight: 700; white-space: nowrap;
  color: #566b30; background: transparent; border: 1px solid #a9bd82; border-radius: 5px;
  padding: 3px 5px; user-select: none; line-height: 1.2;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}
.bustr-easy-bar .bustr-quick-toggle:hover {border-color: #6f8340; color: #3f4f22;}
.bustr-easy-bar .bustr-quick-toggle.bustr-on {
  color: #dcecb4; background: #4b5738; border-color: #8ca05a;
  box-shadow: 0 0 0 1px #8ca05a inset;
}
.bustr-easy-bar .bustr-quick-toggle::before {
  content: '\\2610'; margin-right: 2px; font-weight: 400; opacity: 0.8;
}
.bustr-easy-bar .bustr-quick-toggle.bustr-on::before {content: '\\2611'; opacity: 1;}
.bustr-easy-status {
  font-size: calc(11px * var(--bustr-fs, 1)); color: #4b5738; margin-left: auto;
  max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* Empty until the first Easy action: take no room (and no flex gap), so it can never wrap
   onto a blank second line of its own. */
.bustr-easy-status:empty {display: none;}
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

/* Busts left + penalty % in the jail bar (same numbers and colours as the Jail nav badge).
   Busts-left takes the badge's body.bustr--green/orange/red colour; the % keeps its own
   penalty-severity colour from .bustr-pct-line.bustr-pen--*. */
/* Pinned to the far right with flex order (not DOM order, which a header re-render can shuffle):
   [BUSTR] [Quick Bust] [?] [Easy Bust] [Easy Bail] [refresh] .... [status] [5 left . 64%].
   margin-left:auto pushes it right; when the status text is showing, the status takes the auto
   margin and the counter sits just after it. */
.bustr-easy-bar .bustr-easy-status {order: 98;}
.bustr-easy-bar .bustr-easy-status:not(:empty) ~ .bustr-bar-stats {margin-left: 10px;}
.bustr-easy-bar .bustr-bar-stats {
  order: 99;
  display: inline-flex; align-items: baseline; gap: 6px; margin-left: auto; white-space: nowrap;
  font-size: calc(13px * var(--bustr-fs, 1)); font-weight: 700; line-height: 1.2;
}
.bustr-easy-bar .bustr-bar-busts {color: var(--color, inherit);}
.bustr-easy-bar .bustr-bar-sep {opacity: 0.5; font-weight: 400;}
.bustr-easy-bar .bustr-bar-stats .bustr-pct-line {display: inline; font-size: 1em; line-height: inherit;}
body:not(.dark-mode).bustr--green .bustr-easy-bar .bustr-bar-busts {color: ${LIGHT_GREEN};}
body:not(.dark-mode).bustr--orange .bustr-easy-bar .bustr-bar-busts {color: ${LIGHT_ORANGE};}
body:not(.dark-mode).bustr--red .bustr-easy-bar .bustr-bar-busts {color: ${LIGHT_RED};}

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
  font-size: calc(12px * var(--bustr-fs, 1)); line-height: 1.5;
}
.bustr-consent-card h3 {margin: 0 0 8px; font-size: calc(14px * var(--bustr-fs, 1)); color: #8ca05a;}
.bustr-consent-card p {margin: 0 0 14px;}
.bustr-consent-actions {display: flex; gap: 8px; justify-content: flex-end;}
.bustr-consent-actions .bustr-btn {flex: 0 0 auto;}
#bustr-consent-ok {background: rgba(140, 168, 90, 0.35);}
/* API failure notice. Deliberately loud: the alternative symptom is a 0% penalty, which
   reads as "clear to bust" when the truth is "unknown". */
.bustr-apierror {
  margin: 6px 0; padding: 6px 8px; border-radius: 4px; font-size: calc(11px * var(--bustr-fs, 1)); line-height: 1.35;
  background: rgba(200, 70, 70, 0.16); color: ${redMelon};
}
#bustr-settings-panel {
  position: fixed; top: 7vh; left: 50%; transform: translateX(-50%); z-index: 100000;
  width: min(calc(280px * var(--bustr-fs, 1)), 94vw); max-height: 84vh; overflow-y: auto;
  background: #2b2b2b; color: #ccc; border: 1px solid #111; border-radius: 8px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.7); padding: 12px 14px;
  font-size: calc(12px * var(--bustr-fs, 1)); display: none;
}
#bustr-settings-panel.bustr-open {display: block;}
#bustr-settings-panel h3 {margin: 0 0 4px; font-size: calc(13px * var(--bustr-fs, 1)); color: #fff; font-weight: 700;
  display: flex; justify-content: space-between; align-items: center;}
#bustr-settings-panel h3 .bustr-close {cursor: pointer; color: #999; font-size: calc(16px * var(--bustr-fs, 1)); line-height: 1;}
#bustr-settings-panel h3 .bustr-close:hover {color: #fff;}
#bustr-settings-panel .bustr-status {color: #8ca05a; font-size: calc(10px * var(--bustr-fs, 1)); margin: 0 0 8px;}
#bustr-settings-panel .bustr-row {display: flex; align-items: center; justify-content: space-between; margin: 8px 0; gap: 8px;}
#bustr-settings-panel .bustr-row label {flex: 1; color: #bbb;}
#bustr-settings-panel input[type="number"] {width: 58px; height: 24px; padding: 1px 6px; text-align: center;
  background: #1a1a1a; color: #ddd; border: 1px solid #444; border-radius: 4px;}
#bustr-settings-panel input[type="checkbox"] {width: 16px; height: 16px;}
#bustr-settings-panel select {height: 24px; padding: 1px 4px; background: #1a1a1a; color: #ddd;
  border: 1px solid #444; border-radius: 4px; font-size: calc(11px * var(--bustr-fs, 1));}
#bustr-settings-panel .bustr-hint {color: #888; font-size: calc(10px * var(--bustr-fs, 1)); margin: 2px 0 8px;}
/* Faded "(default N)" note inside a setting's label - matches the hint's muted tone/size. */
#bustr-settings-panel .bustr-default {color: #888; font-size: calc(10px * var(--bustr-fs, 1)); font-weight: 400;}
#bustr-settings-panel .bustr-section {color: #8ca05a; font-size: calc(11px * var(--bustr-fs, 1)); font-weight: bold;
  text-transform: uppercase; letter-spacing: 0.03em; margin: 2px 0 6px;}
#bustr-settings-panel .bustr-collapsible {cursor: pointer; -webkit-user-select: none; user-select: none;}
#bustr-settings-panel .bustr-caret {display: inline-block; margin-right: 4px; font-size: calc(9px * var(--bustr-fs, 1));
  transition: transform 0.12s ease;}
#bustr-settings-panel .bustr-section.bustr-expanded .bustr-caret {transform: rotate(90deg);}
#bustr-settings-panel .bustr-collapse-body[hidden] {display: none;}
#bustr-settings-panel .bustr-subsection {color: #8ca05a; font-size: calc(10px * var(--bustr-fs, 1)); font-weight: bold; margin: 12px 0 4px; opacity: 0.85;}
#bustr-settings-panel .bustr-hist-filter {margin-top: 4px;}
#bustr-settings-panel .bustr-hist-list {max-height: 220px; overflow-y: auto; margin: 4px 0 2px; border: 1px solid #333; border-radius: 4px;}
#bustr-settings-panel .bustr-hist-row {display: flex; align-items: center; gap: 6px; padding: 4px 6px; font-size: calc(10px * var(--bustr-fs, 1)); border-bottom: 1px solid #262626;}
#bustr-settings-panel .bustr-hist-row:last-child {border-bottom: 0;}
#bustr-settings-panel .bustr-hist-time {color: #888; white-space: nowrap;}
#bustr-settings-panel .bustr-hist-name {flex: 1; min-width: 0; color: #ddd; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;}
#bustr-settings-panel .bustr-hist-h {color: #9a9a9a; white-space: nowrap;}
#bustr-settings-panel .bustr-hist-pct {white-space: nowrap; color: #cfcfcf; font-variant-numeric: tabular-nums; min-width: 30px; text-align: right;}
#bustr-settings-panel .bustr-hist-outcome {width: 8px; height: 8px; border-radius: 50%; flex: none;}
#bustr-settings-panel .bustr-ho-success {background: #5a8c3a;}
#bustr-settings-panel .bustr-ho-fail {background: #b5842f;}
#bustr-settings-panel .bustr-ho-jailed {background: #9c3b3b;}
#bustr-settings-panel .bustr-hist-empty {color: #777; font-size: calc(10px * var(--bustr-fs, 1)); padding: 8px 4px; text-align: center;}
#bustr-settings-panel hr {border: 0; border-top: 1px solid #3c3c3c; margin: 10px 0;}
#bustr-settings-panel .bustr-btn {
  display: block; width: 100%; box-sizing: border-box; margin: 6px 0 0; padding: 6px; cursor: pointer;
  background: #4b5738; color: #fff; border: 1px solid #2c331f; border-radius: 4px; font-size: calc(11px * var(--bustr-fs, 1));
}
#bustr-settings-panel .bustr-btn.bustr-danger {background: #5a2d2d; border-color: #3c1f1f;}

/* Help system: explanations live behind these chips and open in one shared card, instead
   of sitting inline as permanent small print. */
#bustr-settings-panel .bustr-q,
.bustr-easy-bar .bustr-q {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; margin-left: 5px; border-radius: 50%;
  background: #4b5738; color: #fff; font-size: calc(9px * var(--bustr-fs, 1)); font-weight: 700;
  cursor: pointer; user-select: none; flex: 0 0 auto; vertical-align: middle;
}
#bustr-settings-panel .bustr-q:hover,
.bustr-easy-bar .bustr-q:hover {background: #6b7d50;}
.bustr-easy-bar .bustr-q {margin-left: 0;} /* the bar's flex gap already spaces it */
/* Bust stats chip: same chip as "?", a small square with a bar-chart glyph. */
.bustr-easy-bar .bustr-q.bustr-stats-q {border-radius: 3px; width: 16px;}
.bustr-easy-bar .bustr-stats-q svg {width: 10px; height: 10px; display: block; fill: currentColor;}
/* Stats card: a compact table, labels muted, numbers bright; the Today column carries a soft
   tint so the eye lands on it first. */
/* Normal weight inside the stats card, even with Large/XL text (which bolds the help card):
   bold everywhere read as a heavy block; only the key rows and the picked day stay bold. */
#bustr-help #bustr-st-body {font-weight: 400; font-size: calc(11.5px * var(--bustr-fs, 1)); line-height: 1.4;}
#bustr-help .bustr-st-table {width: 100%; border-collapse: collapse; margin: 0 0 8px; font-variant-numeric: tabular-nums;}
#bustr-help .bustr-st-table th {text-align: right; font-weight: 600; color: #a0a0a0; padding: 3px 5px 4px;
  font-size: calc(10px * var(--bustr-fs, 1)); text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid #4a4a4a;}
#bustr-help .bustr-st-table td {text-align: right; padding: 3px 5px; color: #f0f0f0; font-weight: 400; border-bottom: 1px solid #3a3a3a;}
#bustr-help .bustr-st-table th:first-child, #bustr-help .bustr-st-table td:first-child {text-align: left; padding-left: 0; color: #bdbdbd;
  font-weight: 400; text-transform: none; letter-spacing: 0;}
#bustr-help .bustr-st-table .bustr-st-today {background: rgba(140,160,90,0.12);}
#bustr-help .bustr-st-table tr.bustr-st-key td {font-weight: 700;}
#bustr-help .bustr-st-table tr.bustr-st-key td:first-child {color: #dcdcdc;}
#bustr-help .bustr-st-table tr.bustr-st-sub td:first-child {padding-left: 10px; font-size: calc(10px * var(--bustr-fs, 1));}
#bustr-help .bustr-st-table tr.bustr-st-gap td {border-top: 1px solid #555;}
#bustr-help .bustr-st-table tr:last-child td {border-bottom: 0;}
#bustr-help .bustr-st-table td.bustr-st-dim {color: #7c7c7c; font-weight: 400;}
#bustr-help .bustr-st-good {color: #8fd14f;}
#bustr-help .bustr-st-bad {color: #ef8a78;}
#bustr-help .bustr-st-facts {display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; padding: 6px 0; border-top: 1px solid #4a4a4a;}
#bustr-help .bustr-st-facts > span:nth-child(odd) {color: #bdbdbd;}
#bustr-help .bustr-st-facts > span:nth-child(even) {color: #f0f0f0; font-weight: 600;}
#bustr-help .bustr-st-facts > span.bustr-st-good {color: #8fd14f;}
#bustr-help .bustr-st-facts > span.bustr-st-bad {color: #ef8a78;}
#bustr-help .bustr-st-link {color: #e6c34a; cursor: pointer; text-decoration: underline dotted; text-underline-offset: 2px;}
/* The explanation sits behind a small "?" at the card's foot (hidden until tapped). */
#bustr-help .bustr-st-help-row {display: flex; justify-content: flex-end; padding-top: 2px;}
#bustr-help .bustr-st-qbtn {display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%;
  background: #4b5738; color: #fff; font-size: calc(10px * var(--bustr-fs, 1)); font-weight: 700; cursor: pointer; user-select: none;}
#bustr-help .bustr-st-qbtn:hover {background: #6b7d50;}
#bustr-help .bustr-st-qbtn.bustr-st-qbtn-on {background: #8ca05a; color: #1a1a1a;}
#bustr-help .bustr-st-note {margin-top: 4px; color: #a0a0a0; font-size: calc(10px * var(--bustr-fs, 1)); padding-top: 6px; border-top: 1px solid #3a3a3a;}
/* Two-column stats card when stacked would be taller than the screen (big text, short screen). */
/* body-prefixed so it outranks the Large/XL "centre the help card" width rules. */
body #bustr-help.bustr-st-card.bustr-st-wide {width: calc(500px * var(--bustr-fs, 1)); max-width: calc(100vw - 16px);}
#bustr-help.bustr-st-wide .bustr-st-cols {display: grid; grid-template-columns: 1fr 1.15fr; gap: 14px; align-items: start;}
#bustr-help .bustr-cal-few i {color: #a0a0a0;}
/* Stats card: dragged by its title bar. */
#bustr-help.bustr-st-card h4 {cursor: move; touch-action: none; user-select: none;}
#bustr-help.bustr-st-dragging {opacity: 0.94;}
/* Its "?" explanation: a small card of its own beside the stats card (placed in JS). */
#bustr-st-explain {position: fixed; z-index: 100002; width: calc(220px * var(--bustr-fs, 1)); max-height: calc(100vh - 16px); overflow-y: auto;
  background: #333; color: #ddd; border: 1px solid #111; border-radius: 8px; box-shadow: 0 8px 28px rgba(0,0,0,0.7);
  padding: 0 12px 10px; font-size: calc(11px * var(--bustr-fs, 1)); line-height: 1.45; font-weight: 400;}
#bustr-st-explain h4 {margin: 0 -12px 4px; padding: 10px 12px 6px; font-size: calc(11px * var(--bustr-fs, 1)); color: #8ca05a;
  text-transform: uppercase; letter-spacing: 0.03em; display: flex; justify-content: space-between; align-items: center;}
#bustr-st-explain .bustr-help-close {cursor: pointer; color: #999; font-size: calc(20px * var(--bustr-fs, 1)); line-height: 1; padding: 0 4px; margin: -4px -4px -4px 8px;}
#bustr-st-explain .bustr-help-close:hover {color: #fff;}
#bustr-st-explain p {margin: 0 0 6px; color: #d6d6d6;}
#bustr-st-explain b {color: #f0f0f0;}
/* Stats card calendar: Monday-first month grid; busted days show their count, tinted by
   whether that day beat the odds. */
#bustr-help .bustr-cal {margin: 0 0 8px;}
#bustr-help .bustr-cal-head {display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;}
#bustr-help .bustr-cal-title {font-weight: 700; color: #e8e8e8;}
#bustr-help .bustr-cal-nav {cursor: pointer; padding: 0 8px; font-size: calc(16px * var(--bustr-fs, 1)); line-height: 1; color: #bbb; border-radius: 4px; user-select: none;}
#bustr-help .bustr-cal-nav:hover {background: #444; color: #fff;}
#bustr-help .bustr-cal-nav.bustr-cal-off {opacity: 0.25; cursor: default; background: none;}
#bustr-help .bustr-cal-grid {display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px;}
#bustr-help .bustr-cal-dow {text-align: center; color: #7a7a7a; font-size: calc(9px * var(--bustr-fs, 1)); font-weight: 700;}
#bustr-help .bustr-cal-day {position: relative; text-align: center; padding: 3px 0 2px; border-radius: 4px; cursor: pointer;
  color: #dedede; line-height: 1.1; font-variant-numeric: tabular-nums; border: 1px solid transparent; user-select: none;}
#bustr-help .bustr-cal-day:hover {background: #444;}
#bustr-help .bustr-cal-day i {display: block; font-style: normal; font-size: calc(8px * var(--bustr-fs, 1)); font-weight: 700;}
#bustr-help .bustr-cal-good {background: rgba(143,209,79,0.16);}
#bustr-help .bustr-cal-good i {color: #8fd14f;}
#bustr-help .bustr-cal-bad {background: rgba(239,138,120,0.16);}
#bustr-help .bustr-cal-bad i {color: #ef8a78;}
#bustr-help .bustr-cal-today {border-color: #6b7d50;}
#bustr-help .bustr-cal-sel {border-color: #e6c34a; color: #fff; font-weight: 700;}
#bustr-help .bustr-cal-future {color: #5e5e5e; cursor: default;}
#bustr-help .bustr-cal-future:hover {background: none;}
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
  top: 50%; left: calc(50% + 140px * var(--bustr-fs, 1) + 12px); transform: translateY(-50%);
  width: calc(250px * var(--bustr-fs, 1)); max-height: 70vh; overflow-y: auto;
  -webkit-overflow-scrolling: touch; overscroll-behavior: contain;
  background: #333; color: #ddd; border: 1px solid #111; border-radius: 8px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.7); padding: 0 12px 12px;
  font-size: calc(11px * var(--bustr-fs, 1)); line-height: 1.45;
}
#bustr-help.bustr-open {display: block;}
/* Header sticks to the top so the close button stays reachable however far the help text
   scrolls (long text was undismissable before). Its background covers the text underneath,
   and the negative margins let it span the card's padding. */
#bustr-help h4 {position: sticky; top: 0; background: #333; z-index: 1;
  margin: 0 -12px 5px; padding: 10px 12px 6px; font-size: calc(11px * var(--bustr-fs, 1)); color: #8ca05a;
  text-transform: uppercase; letter-spacing: 0.03em;
  display: flex; justify-content: space-between; align-items: center;}
#bustr-help h4 .bustr-help-close {cursor: pointer; color: #999; font-size: calc(20px * var(--bustr-fs, 1)); line-height: 1;
  padding: 0 4px; margin: -4px -4px -4px 8px;}
#bustr-help h4 .bustr-help-close:hover {color: #fff;}
/* No room beside the panel on phone/PDA. Centre it, don't bottom-dock: a bottom card sat
   under the mobile browser's dynamic toolbar, hiding its lower half (Firefox Android).
   Centred it can't be clipped and scrolls internally. */
@media (max-width: 780px) {
  #bustr-help {
    top: 50%; bottom: auto; left: 50%; transform: translate(-50%, -50%);
    width: min(88vw, calc(320px * var(--bustr-fs, 1))); max-height: 75vh;
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

/* ---- Text size (Settings > General > Text size; applyAppearance sets the body class) ----
   Every BUSTR px font-size above is calc(Npx * var(--bustr-fs, 1)), so one variable scales
   all of BUSTR's own text. Normal = 1, so nothing changes for anyone who leaves it alone.
   The PDA nav-column badge is capped at 1.25x: it shares one narrow nav slot with its label. */
body.bustr-fs-lg {--bustr-fs: 1.25;}
body.bustr-fs-xl {--bustr-fs: 1.5;}
/* Text that inherits Torn's own size (the hardness number, the desktop nav badge) scales from it. */
.bustr-hardness-score {font-size: calc(1em * var(--bustr-fs, 1));}
#nav-jail a .bustr-stats {font-size: calc(1em * var(--bustr-fs, 1));}
/* Large and up: numbers go bold, and settings labels get heavier so thin text is easier to read. */
body.bustr-fs-lg .bustr-hardness-score, body.bustr-fs-xl .bustr-hardness-score,
body.bustr-fs-lg .bustr-pct-line, body.bustr-fs-xl .bustr-pct-line,
body.bustr-fs-lg #nav-jail .bustr-stats, body.bustr-fs-xl #nav-jail .bustr-stats {font-weight: 700;}
body.bustr-fs-lg .bustr-success-chance, body.bustr-fs-xl .bustr-success-chance {font-weight: 800;}
body.bustr-fs-lg #bustr-settings-panel .bustr-row label, body.bustr-fs-xl #bustr-settings-panel .bustr-row label,
body.bustr-fs-lg #bustr-help, body.bustr-fs-xl #bustr-help {font-weight: 600;}
body.bustr-fs-lg #bustr-settings-panel input[type="checkbox"], body.bustr-fs-xl #bustr-settings-panel input[type="checkbox"] {width: 20px; height: 20px;}
body.bustr-fs-lg #bustr-settings-panel input[type="number"], body.bustr-fs-xl #bustr-settings-panel input[type="number"],
body.bustr-fs-lg #bustr-settings-panel select, body.bustr-fs-xl #bustr-settings-panel select {height: calc(24px * var(--bustr-fs));}
/* The help card sits beside the panel only when both fit; the wider panels need a wider screen. */
@media (max-width: 1000px) {
  body.bustr-fs-lg #bustr-help {top: 50%; bottom: auto; left: 50%; transform: translate(-50%, -50%); width: min(88vw, calc(320px * var(--bustr-fs))); max-height: 75vh;}
}
@media (max-width: 1240px) {
  body.bustr-fs-xl #bustr-help {top: 50%; bottom: auto; left: 50%; transform: translate(-50%, -50%); width: min(88vw, calc(320px * var(--bustr-fs))); max-height: 75vh;}
}

/* ---- Readable colours on Torn's LIGHT theme ----
   The success % and penalty % used the pale dark-theme tints (amber #ffbf00, pink #ffa8a8)
   even on Torn's white background, where they all but vanish. Torn's light theme = no
   .dark-mode on body; these darker tints only apply there. */
body:not(.dark-mode) .bustr-success-chance.bustr-sc--green {color: ${LIGHT_GREEN};}
body:not(.dark-mode) .bustr-success-chance.bustr-sc--orange {color: ${LIGHT_ORANGE};}
body:not(.dark-mode) .bustr-success-chance.bustr-sc--red {color: ${LIGHT_RED};}
body:not(.dark-mode) .bustr-pct-line.bustr-pen--green {color: ${LIGHT_GREEN};}
body:not(.dark-mode) .bustr-pct-line.bustr-pen--orange {color: ${LIGHT_ORANGE};}
body:not(.dark-mode) .bustr-pct-line.bustr-pen--red {color: ${LIGHT_RED};}

/* ---- BUSTR theme (Settings > General > Theme) for BUSTR's own cards ----
   The settings panel, help card, consent card and PDA hold card were always dark. Auto (the
   default) follows Torn: light when Torn is light. Light / Dark force one. Base rules above are
   the dark look; these override it. Selectors come from lightSurface() (see its comment). */
${lightSurface('#bustr-settings-panel')} {background: #f6f6f2; color: #222; border-color: #b9b9b0; box-shadow: 0 8px 28px rgba(0,0,0,0.35);}
${lightSurface('#bustr-settings-panel h3')} {color: #111;}
${lightSurface('#bustr-settings-panel h3 .bustr-close')}, ${lightSurface('#bustr-help h4 .bustr-help-close')} {color: #555;}
${lightSurface('#bustr-settings-panel h3 .bustr-close:hover')}, ${lightSurface('#bustr-help h4 .bustr-help-close:hover')} {color: #000;}
${lightSurface('#bustr-settings-panel .bustr-row label')} {color: #222;}
${lightSurface('#bustr-settings-panel input[type="number"]')}, ${lightSurface('#bustr-settings-panel select')} {background: #fff; color: #111; border-color: #999;}
${lightSurface('#bustr-settings-panel .bustr-hint')}, ${lightSurface('#bustr-settings-panel .bustr-default')}, ${lightSurface('#bustr-settings-panel .bustr-hist-time')}, ${lightSurface('#bustr-settings-panel .bustr-hist-empty')} {color: #5c5c5c;}
${lightSurface('#bustr-settings-panel .bustr-status')}, ${lightSurface('#bustr-settings-panel .bustr-section')}, ${lightSurface('#bustr-settings-panel .bustr-subsection')} {color: #48601c;}
${lightSurface('#bustr-settings-panel .bustr-hist-list')} {border-color: #ccc;}
${lightSurface('#bustr-settings-panel .bustr-hist-row')} {border-bottom-color: #e0e0da;}
${lightSurface('#bustr-settings-panel .bustr-hist-name')} {color: #1a1a1a;}
${lightSurface('#bustr-settings-panel .bustr-hist-h')} {color: #4a4a4a;}
${lightSurface('#bustr-settings-panel .bustr-hist-pct')} {color: #222;}
${lightSurface('#bustr-settings-panel hr')} {border-top-color: #d4d4cc;}
${lightSurface('.bustr-apierror')} {background: rgba(198, 40, 40, 0.1); color: ${LIGHT_RED};}
${lightSurface('#bustr-help')} {background: #fbfbf8; color: #222; border-color: #b9b9b0; box-shadow: 0 8px 28px rgba(0,0,0,0.35);}
${lightSurface('#bustr-help h4')} {background: #fbfbf8; color: #48601c;}
${lightSurface('#bustr-help .bustr-st-table th')} {color: #6a6a62; border-bottom-color: #c9c9c0;}
${lightSurface('#bustr-help .bustr-st-table td')} {color: #1a1a1a; border-bottom-color: #e6e6df;}
${lightSurface('#bustr-help .bustr-st-table td:first-child')}, ${lightSurface('#bustr-help .bustr-st-facts > span:nth-child(odd)')} {color: #5a5a54;}
${lightSurface('#bustr-help .bustr-st-table tr.bustr-st-key td:first-child')}, ${lightSurface('#bustr-help .bustr-st-facts > span:nth-child(even)')} {color: #1a1a1a;}
${lightSurface('#bustr-help .bustr-st-table .bustr-st-today')} {background: rgba(90,120,30,0.09);}
${lightSurface('#bustr-help .bustr-st-table tr.bustr-st-gap td')}, ${lightSurface('#bustr-help .bustr-st-facts')} {border-top-color: #c9c9c0;}
${lightSurface('#bustr-help .bustr-st-table td.bustr-st-dim')} {color: #a5a59c;}
${lightSurface('#bustr-help .bustr-st-good')} {color: ${LIGHT_GREEN};}
${lightSurface('#bustr-help .bustr-st-bad')} {color: ${LIGHT_RED};}
${lightSurface('#bustr-help .bustr-st-facts > span.bustr-st-good')} {color: ${LIGHT_GREEN};}
${lightSurface('#bustr-help .bustr-st-facts > span.bustr-st-bad')} {color: ${LIGHT_RED};}
${lightSurface('#bustr-help .bustr-st-note')} {color: #6a6a62; border-top-color: #e6e6df;}
${lightSurface('#bustr-help .bustr-cal-title')} {color: #1a1a1a;}
${lightSurface('#bustr-help .bustr-st-link')} {color: #8a6a00;}
${lightSurface('#bustr-st-explain')} {background: #fbfbf8; color: #222; border-color: #b9b9b0; box-shadow: 0 8px 28px rgba(0,0,0,0.35);}
${lightSurface('#bustr-st-explain h4')} {color: #48601c;}
${lightSurface('#bustr-st-explain p')} {color: #333;}
${lightSurface('#bustr-st-explain b')} {color: #000;}
${lightSurface('#bustr-st-explain .bustr-help-close')} {color: #555;}
${lightSurface('#bustr-help .bustr-cal-nav')} {color: #555;}
${lightSurface('#bustr-help .bustr-cal-nav:hover')}, ${lightSurface('#bustr-help .bustr-cal-day:hover')} {background: #e8e8e0; color: #000;}
${lightSurface('#bustr-help .bustr-cal-dow')} {color: #8a8a82;}
${lightSurface('#bustr-help .bustr-cal-day')} {color: #333;}
${lightSurface('#bustr-help .bustr-cal-good')} {background: rgba(63,107,0,0.12);}
${lightSurface('#bustr-help .bustr-cal-good i')} {color: ${LIGHT_GREEN};}
${lightSurface('#bustr-help .bustr-cal-bad')} {background: rgba(198,40,40,0.10);}
${lightSurface('#bustr-help .bustr-cal-bad i')} {color: ${LIGHT_RED};}
${lightSurface('#bustr-help .bustr-cal-today')} {border-color: #8ca05a;}
${lightSurface('#bustr-help .bustr-cal-sel')} {border-color: #b08a12; color: #000;}
${lightSurface('#bustr-help .bustr-cal-future')} {color: #c0c0b8;}
${lightSurface('#bustr-help .bustr-cal-few i')} {color: #77776f;}
${lightSurface('.bustr-consent-card')} {background: #f6f6f2; color: #222; border-color: #b9b9b0; box-shadow: 0 10px 32px rgba(0,0,0,0.35);}
${lightSurface('.bustr-consent-card h3')} {color: #48601c;}
/* PDA hold card: light card, darker severity tints so the numbers stay readable on it. */
${lightSurface('#bustr-context .bustr-stats', 'body.bustr-pda-hold')} {background: #fbfbf8 !important; border-color: #a8a8a0 !important;}
${lightSurface('#bustr-context .bustr-stats::before', 'body.bustr-pda-hold')} {border-bottom-color: #a8a8a0;}
${lightSurface('#bustr-context .bustr-stats::after', 'body.bustr-pda-hold')} {border-bottom-color: #fbfbf8;}
${lightSurface('#bustr-context .bustr-pct-line', 'body.bustr-pda-hold')} {border-left-color: rgba(0, 0, 0, 0.2);}
${lightSurface('#bustr-context .bustr-ctx-btn', 'body.bustr-pda-hold')} {color: #222; background: rgba(111, 131, 64, 0.16); border-color: rgba(111, 131, 64, 0.55);}
${lightSurface('#bustr-context .bustr-stats', 'body.bustr--green')} {--color: ${LIGHT_GREEN};}
${lightSurface('#bustr-context .bustr-stats', 'body.bustr--orange')} {--color: ${LIGHT_ORANGE};}
${lightSurface('#bustr-context .bustr-stats', 'body.bustr--red')} {--color: ${LIGHT_RED};}
${lightSurface('#bustr-context .bustr-pct-line.bustr-pen--green')} {color: ${LIGHT_GREEN};}
${lightSurface('#bustr-context .bustr-pct-line.bustr-pen--orange')} {color: ${LIGHT_ORANGE};}
${lightSurface('#bustr-context .bustr-pct-line.bustr-pen--red')} {color: ${LIGHT_RED};}
/* Dark card forced (or Auto) while Torn is light: keep the card's pale tints, which read on dark. */
${darkSurface('#bustr-context .bustr-pct-line.bustr-pen--green')} {color: ${greenApple};}
${darkSurface('#bustr-context .bustr-pct-line.bustr-pen--orange')} {color: ${orangeAmber};}
${darkSurface('#bustr-context .bustr-pct-line.bustr-pen--red')} {color: ${redMelon};}
</style>`;

  function renderBustrStylesheet() {
    if (document.getElementById('bustr-stylesheet')) return;
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
    const { penaltyScore, penaltyThreshold, availableBusts, penaltyPct } = statsObj;
    if (availableBusts !== undefined) {
      const title = `Busts you can still safely make: ${availableBusts}`
        + (penaltyScore !== undefined && penaltyThreshold !== undefined ? `\nPenalty score: ${penaltyScore} / ${penaltyThreshold}` : '')
        + (penaltyPct !== undefined ? `\nPenalty: ${penaltyPct}%` : '');
      document.querySelectorAll('.bustr-stats').forEach((el) => (el.title = title));
    }
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
        if (document.querySelector(selectors)) { res(); return; }

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

      if (!document.querySelector('.bustr-mobile-badge')) renderMobileBustrNotification();
      ensureBustrContextPopover();
    } catch (err) {
      console.error('[BUSTR]', err);
    }
  }


  function ensureBustrContextPopover() {
    if (document.getElementById('bustr-context')) return;
    const jailEl = document.getElementById('nav-jail');
    if (!jailEl) return;
    const bustrContextMenuHTML = `
        <div id="bustr-context" class='contextMenu___bjhoL bustr-context-menu'>
          <span class='linkName___FoKha bustr-stats'>
          <span class="bustr-ctx-detail"><span class="bustr-stats__penaltyScore">#</span> / <span class="bustr-stats__penaltyThreshold">#</span><span class="bustr-ctx-sep"> : </span></span><span class="bustr-stats__availableBusts">#</span>
          <span class="bustr-pct-line"><span class="bustr-stats__penaltyPct">#</span>%</span>
          <span class="bustr-ctx-btn" role="button">BUSTR</span>
          </span>
          <span class='arrow___tKP13 bustr-arrow'></span>
        </div>`;
    jailEl.insertAdjacentHTML('afterend', bustrContextMenuHTML);
    const pop = document.getElementById('bustr-context');
    const ctxBtn = pop && pop.querySelector('.bustr-ctx-btn');
    if (ctxBtn) {
      ctxBtn.addEventListener('click', (e) => {
        e.preventDefault();
        pop.classList.remove('bustr-show');
        toggleSettings();
      });
    }
  }

  function installPdaHoldPopover() {
    if (!isPDA() || getUserSettings().pdaHoldDetails === false) return;
    ensureBustrContextPopover();
    if (window.__bustrHoldWired) return; // document-delegated, so wire exactly once per page
    window.__bustrHoldWired = true;
    wirePdaHoldHandlers();
  }

  function wirePdaHoldHandlers() {
    const HOLD_SEL = '#nav-jail, #bustr-sidebar-btn';
    const LP_MS = 350;
    const LP_SLOP = 10; // px of finger travel that turns a hold into a swipe / scroll
    let lpTimer = null;
    let lpFired = false;
    let lpX = 0;
    let lpY = 0;
    let touching = false; // a finger is down on a hold target (tells a long-press from a right-click)
    const enabled = () => getUserSettings().pdaHoldDetails !== false;
    const popover = () => document.getElementById('bustr-context');
    const showPopover = () => { if (!enabled()) return; const p = popover(); if (p) p.classList.add('bustr-show'); };
    const hidePopover = () => { const p = popover(); if (p) p.classList.remove('bustr-show'); };
    const inHold = (t) => !!(t && t.closest && t.closest(HOLD_SEL));
    const inPopover = (t) => !!(t && t.closest && t.closest('#bustr-context'));
    const clearTimer = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
    const endTouch = () => { clearTimer(); touching = false; };

    document.addEventListener('touchstart', (e) => {
      if (inHold(e.target) && enabled()) {
        lpFired = false;
        clearTimer();
        const t = e.touches && e.touches[0];
        lpX = t ? t.clientX : 0;
        lpY = t ? t.clientY : 0;
        touching = true;
        lpTimer = setTimeout(() => { lpTimer = null; lpFired = true; showPopover(); }, LP_MS);
      } else if (!inPopover(e.target)) {
        hidePopover(); // a tap anywhere else closes it
      }
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!lpTimer) return;
      const t = e.touches && e.touches[0];
      if (!t || Math.abs(t.clientX - lpX) > LP_SLOP || Math.abs(t.clientY - lpY) > LP_SLOP) clearTimer();
    }, { passive: true, capture: true });
    document.addEventListener('touchcancel', endTouch, { passive: true, capture: true });

    document.addEventListener('touchend', (e) => {
      endTouch();
      if (lpFired && inHold(e.target)) e.preventDefault(); // swallow the tap that would follow a hold
    }, { passive: false });

    document.addEventListener('click', (e) => {
      if (inHold(e.target)) {
        if (lpFired) { e.preventDefault(); e.stopImmediatePropagation(); lpFired = false; }
      } else if (!inPopover(e.target)) {
        hidePopover();
      }
    }, true);

    document.addEventListener('contextmenu', (e) => {
      if (!inHold(e.target) || !enabled()) return;
      e.preventDefault();
      if (touching) { clearTimer(); lpFired = true; showPopover(); return; }
      const p = popover();
      if (p) p.classList.toggle('bustr-show');
    });
  }


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


  async function initController() {
    try {
      renderBustrStylesheet();
      applyBadgeDetail(); // set compact/full badge mode up front, before the first tick


      if (getMyViewportWidthType() === 'Desktop') {
        await renderBustrDesktopView();
        setRenderedView('Desktop');
      } else {
        await renderBustrMobileView();
        setRenderedView('Mobile');
      }

      installPdaHoldPopover(); // PDA: compact badge + hold-to-reveal popover (no-op off PDA / when disabled)

      if (getApiKey() !== undefined) return;
      if (document.getElementById('bustr-form')) return;

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

  let isLoading = false;
  let fatalKeyError = false;
  let resyncTimer = null;
  let apiKeyAccessType = null;
  let apiKeyTypeInFlight = false;
  let apiKeyTypeLastTry = 0;

  async function loadController() {
    if (isLoading || fatalKeyError) return;
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
      recordApiError('bust log', err);
      if (err && (err.tornCode === 2 || err.tornCode === 16)) {
        fatalKeyError = true;
        console.error('[BUSTR] API key rejected (' + err.message + '). Auto-refresh paused; clear cache or re-enter your key.');
      } else {
        console.error('[BUSTR]', err);
      }
    } finally {
      isLoading = false;
    }
  }

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

  function refetchIfStale(minGapMs) {
    if (fatalKeyError) return;
    const since = Date.now() - getLastFetchTimestampMs();
    if (since >= minGapMs) loadController();
    else recalcLocally();
  }

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

  function applyActiveScope(onJail) {
    const inactive = getUserSettings().activeScope === 'jailOnly' && !onJail;
    document.body.classList.toggle('bustr-inactive', inactive);
    if (inactive) clearBustrPageColoring();
    return inactive;
  }

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
    if (document.hidden) return;

    resyncSettingsFromStorage(); // pick up changes made in another tab before anything below reads settings

    applyBadgeDetail(); // keep the compact/full nav badge in sync (cheap body-class toggle, every page)
    installPdaHoldPopover(); // PDA: re-ensure the hold-to-reveal popover survives Torn nav re-renders (no-op off PDA)

    const onJail = window.location.pathname === '/jailview.php';
    if (SHOW_SETTINGS_PANEL) ensureSettingsUi(); // build the trigger every tick; jail-only scope hides it off-jail via the bustr-inactive CSS

    ensureBustObserver(onJail); // arm on the jail page, tear down everywhere else - in all modes

    if (applyActiveScope(onJail)) return; // jail-only + off jail: nav badge/colour hidden, nothing else to do

    recalcPenaltyScoreOnly();

    if (onJail) renderJailRows();
    if (fatalKeyError || isLoading) return;
    if (onJail) {
      const since = Date.now() - getLastFetchTimestampMs();
      if (since >= JAIL_MIN_FETCH_GAP_MS) loadController();
    }
  }

  let lastDecayRepaintScore = null;
  function decayRepaintTick() {
    if (document.hidden) return;
    const ts = getTimestampsArray();
    if (!ts || ts.length === 0) return;
    const score = calcPenaltyScore(ts);
    if (score === lastDecayRepaintScore) return;
    lastDecayRepaintScore = score;
    if (applyActiveScope(window.location.pathname === '/jailview.php')) return; // jail-only + off jail: badge hidden, nothing to repaint
    recalcPenaltyScoreOnly();
  }

  let masterTickIntervalId = null;
  let decayRepaintIntervalId = null;
  function startRefreshLoops() {
    if (masterTickIntervalId !== null) clearInterval(masterTickIntervalId);
    if (decayRepaintIntervalId !== null) clearInterval(decayRepaintIntervalId);
    const settings = getUserSettings();
    let rate = (typeof settings.statsRefreshRate === 'number' && settings.statsRefreshRate > 0)
      ? settings.statsRefreshRate
      : DEFAULT_REFRESH_SECONDS;
    if (rate < 15) rate = 15; // sane floor
    masterTickIntervalId = setInterval(masterTick, rate * 1000);
    decayRepaintIntervalId = setInterval(decayRepaintTick, DECAY_REPAINT_MS);
  }

  let visibilityListenerAttached = false;
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
          if (window.location.pathname === '/jailview.php') await loadController();
          else recalcLocally();
        }
      });
    } catch (err) {
      console.error('[BUSTR]', err);
    }
  }

  function renderJailRows() {
    if (window.location.pathname !== '/jailview.php') return;
    const playersArr = [...document.querySelectorAll('ul.user-info-list-wrap > li')];
    if (!playersArr.length) return;
    const penaltyPct = calcPenaltyPct(getTimestampsArray());

    for (const playerEl of playersArr) {
      const info = getLevelJailDurationInfo(playerEl);
      if (!info) continue;
      const [level, durationInHours] = info;
      const hardnessScore = calcHardnessScore(level, durationInHours);
      renderHardnessScore(playerEl, hardnessScore);
      sortByHardnessScore(playerEl, hardnessScore);
      renderSuccessChance(playerEl, calcSuccessChance(hardnessScore, penaltyPct));
    }
    applyQuickActions(); // keep the opt-in quick-bust/bail relabelling in sync every render pass
    renderEasyActionButtons(); // re-ensure the Easy actions bar if Torn re-rendered the header away
  }

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
      const next = href.replace(/(step=(?:breakout|buy))1?(?=&|$)/, (_m, base) => base + '1');
      if (next !== href) anchorEl.setAttribute('href', next);
    }, true);
  }

  function refreshJailList() {
    try {
      const start = (window.location.hash.match(/start=(\d+)/) || [])[1] || '0';
      window.location.hash = '#bustr-refresh';
      setTimeout(() => { window.location.hash = '#start=' + start; }, 30);
    } catch (err) {
      window.location.reload(); // last-resort fallback
    }
  }

  let easyActionInFlight = false;

  let easyRetryId = null;

  function cleanProfileName(el) {
    if (!el) return null;
    const title = (el.getAttribute('title') || '').trim();
    if (title) {
      const n = title.replace(/\s*\[\d+\]\s*$/, '').trim();
      if (n) return n;
    }
    const tc = (el.textContent || '').trim();
    return tc || null;
  }

  function jailRowName(li) {
    if (!li) return null;
    const el = li.querySelector('a.user.name') || li.querySelector('a.user') || li.querySelector('a[href*="profiles.php"]');
    if (!el) return null;
    return cleanProfileName(el);
  }

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
      t.rank = kind === 'bust'
        ? (Number.isFinite(t.success) ? t.success : -1)
        : (Number.isFinite(t.hardness) ? -t.hardness : -Infinity);
      if (!best || t.rank > best.rank) best = t;
    }
    return best;
  }

  const NO_NERVE_MSG = "You don't have enough nerve, try again later."; // Torn's own wording
  const BUST_NERVE_BASE = 5;
  const BUST_NERVE_MAX_CUT = 3;
  function readSidebarNerve() {
    for (const n of document.querySelectorAll('p[class*="barName"]')) {
      if (!/^\s*nerve/i.test(n.textContent || '')) continue;
      const v = n.parentElement && n.parentElement.querySelector('p[class*="barValue"]');
      const m = v && (v.textContent || '').match(/(\d[\d,]*)\s*\/\s*\d/);
      if (m) return parseInt(m[1].replace(/,/g, ''), 10);
    }
    return null;
  }
  function bustNerveCost() {
    let cut = 0;
    for (const p of getGlobalBustrState().bustPerks || []) {
      if (classifyPerk(p) !== 'nerve' || /%/.test(p)) continue; // flat nerve cuts only
      const m = p.match(/(\d+)/);
      if (m) cut += parseInt(m[1], 10);
    }
    return BUST_NERVE_BASE - Math.min(BUST_NERVE_MAX_CUT, cut);
  }

  function classifyEasyResponse(kind, data) {
    const text = ((data && (data.msg || data.text)) || '').toString();
    const green = !!(data && data.color === 'green');
    if (/(not|n't) (have )?enough nerve/i.test(text)) return { success: false, jailed: false, noNerve: true, text };
    if (/no longer in jail|not in jail|already (been )?(busted|bailed|released|free)|isn't in jail/i.test(text)) {
      return { success: false, jailed: false, gone: true, text };
    }
    if (kind === 'bail') return { success: green || /bailed|released|out of jail/i.test(text), jailed: false, text };
    const success = green || /you busted/i.test(text);
    if (success) return { success: true, jailed: false, text };
    const jailed = FAILURE_JAILED_PATTERNS.some((re) => re.test(text));
    return { success: false, jailed, text };
  }

  function responseName(data) {
    const raw = (data && (data.msg || data.text)) || '';
    if (!raw) return null;
    try {
      const doc = new DOMParser().parseFromString(raw, 'text/html');
      const a = doc.querySelector('a[href*="profiles.php"]') || doc.querySelector('a');
      return a ? cleanProfileName(a) : null;
    } catch (e) {
      return null;
    }
  }

  function easyStatusMessage(kind, outcome, data, name, willRetry) {
    if (!data) return 'No response from Torn';
    if (outcome.noNerve) return NO_NERVE_MSG;
    if (outcome.gone) return 'This person is no longer in jail.';
    const verb = kind === 'bust' ? 'busted' : 'bailed';
    if (outcome.success) return name ? name + ' was ' + verb + '.' : (kind === 'bust' ? 'Busted!' : 'Bailed!');
    if (kind === 'bust' && outcome.jailed) return name ? 'Failed to bust ' + name + ' - you got jailed.' : 'Failed - you got jailed';
    const base = name ? 'Failed to ' + kind + ' ' + name + '.' : (kind === 'bust' ? 'Bust failed' : 'Bail failed');
    return willRetry ? base + ' Tap again to retry.' : base;
  }

  async function fireEasyAction(kind, btn, statusEl) {
    if (easyActionInFlight) return;
    if (kind === 'bust') {
      const nerve = readSidebarNerve();
      if (nerve !== null && nerve < bustNerveCost()) { if (statusEl) statusEl.textContent = NO_NERVE_MSG; return; }
    }
    const target = pickEasyTarget(kind);
    if (!target) { if (statusEl) statusEl.textContent = 'No eligible targets'; return; }

    const noConfirmHref = kind === 'bust'
      ? target.href.replace(/step=breakout\b/, 'step=breakout1')
      : target.href.replace(/step=buy\b/, 'step=buy1');
    let url;
    try { url = new URL(noConfirmHref, window.location.origin).href; }
    catch (e) { if (statusEl) statusEl.textContent = 'Bad target link'; return; }

    if (kind === 'bust' && getUserSettings().selfCalibrationEnabled && Number.isFinite(target.hardness)) {
      recordPendingAttempt(target.hardness, target.success, target.name);
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

      let finishedWithTarget = true;

      if (kind === 'bust' && outcome.noNerve) {
        takePendingAttempt(); // Torn refused (no nerve): nothing happened, so log nothing
        finishedWithTarget = false; // keep the row eligible for when your nerve is back
      } else if (kind === 'bust') {
        if (outcome.gone) {
          takePendingAttempt(); // target already left jail: discard, don't log a phantom failure
          easyRetryId = null;
        } else if (outcome.success) {
          logOutcome(true); // consumes the pending attempt if self-cal recorded one
          addOptimisticBustTimestamp(); // add the bust to the cached log...
          recalcPenaltyScoreOnly();     // ...and repaint from it, so the decay owns the value (no scalar-bump snap-back)
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

  function syncQuickPill(pill, key) {
    const on = getUserSettings()[key] === true;
    pill.classList.toggle('bustr-on', on);
    pill.setAttribute('aria-checked', on ? 'true' : 'false');
  }

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


    let lbl = bar.querySelector('.bustr-easy-label');
    if (!lbl) {
      lbl = document.createElement('span');
      lbl.className = 'bustr-easy-label';
      lbl.textContent = 'BUSTR';
      bar.appendChild(lbl);
    }

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

    let help = bar.querySelector('.bustr-q:not(.bustr-stats-q)');
    if (!help) {
      help = document.createElement('span');
      help.className = 'bustr-q';
      help.textContent = '?';
      help.title = 'What does this do?';
      help.addEventListener('click', () => {
        ensureSettingsPanelDom(); // guarantees #bustr-help exists before showHelp runs
        showHelp('quickactions', help);
      });
      bar.appendChild(help);
    }

    let statsChip = bar.querySelector('.bustr-stats-q');
    if (!statsChip) {
      statsChip = document.createElement('span');
      statsChip.className = 'bustr-q bustr-stats-q';
      statsChip.setAttribute('role', 'button');
      statsChip.setAttribute('aria-label', 'Your bust stats');
      statsChip.innerHTML = '<svg viewBox="0 0 10 10" aria-hidden="true"><rect x="0" y="6" width="2.4" height="4"/><rect x="3.8" y="3" width="2.4" height="7"/><rect x="7.6" y="0" width="2.4" height="10"/></svg>';
      statsChip.addEventListener('click', () => {
        ensureSettingsPanelDom();
        showBustStats(statsChip);
      });
      bar.appendChild(statsChip);
    }

    let statusEl = bar.querySelector('.bustr-easy-status');
    if (!statusEl) {
      statusEl = document.createElement('span');
      statusEl.className = 'bustr-easy-status';
      bar.appendChild(statusEl);
    }

    let barStats = bar.querySelector('.bustr-bar-stats');
    const barStatsNew = !barStats;
    if (!barStats) {
      barStats = document.createElement('span');
      barStats.className = 'bustr-stats bustr-bar-stats';
      barStats.innerHTML = '<span class="bustr-bar-busts"><span class="bustr-stats__availableBusts">-</span> left</span>'
        + '<span class="bustr-bar-sep">&middot;</span>'
        + '<span class="bustr-pct-line"><span class="bustr-stats__penaltyPct">-</span>%</span>';
    }

    let refresh = bar.querySelector('.bustr-jail-refresh');
    if (!refresh) {
      refresh = document.createElement('span');
      refresh.className = 'bustr-jail-refresh';
      refresh.setAttribute('role', 'button');
      refresh.setAttribute('aria-label', 'Refresh the jail list');
      const refreshGlyph = document.createElement('span');
      refreshGlyph.className = 'bustr-jail-refresh-glyph';
      refreshGlyph.textContent = '↻'; // clockwise arrow (spins inside the static pill on hover)
      refresh.appendChild(refreshGlyph);
      refresh.addEventListener('click', refreshJailList);
    }

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

    const order = [lbl, pillBust, help, statsChip, easyBust, easyBail, refresh, statusEl, barStats].filter(Boolean);
    const inOrder = order.every((el, i) =>
      el.parentNode === bar && el.nextElementSibling === (order[i + 1] || null));
    if (!inOrder) order.forEach((el) => bar.appendChild(el));
    if (barStatsNew) recalcPenaltyScoreOnly(); // fill it now rather than on the next tick
  }

  function applyBadgeDetail() {
    const us = getUserSettings();
    const pdaCompact = isPDA() && us.pdaHoldDetails !== false;
    document.body.classList.toggle('bustr-badge-simple', pdaCompact || us.navBadgeDetail !== 'full');
    document.body.classList.toggle('bustr-pda-hold', pdaCompact);
    document.body.classList.toggle('bustr-compact', us.navBadgeDetail !== 'full');
  }

  function applyAppearance() {
    const us = getUserSettings();
    const cl = document.body.classList;
    cl.toggle('bustr-fs-lg', us.textSize === 'large');
    cl.toggle('bustr-fs-xl', us.textSize === 'xlarge');
    cl.toggle('bustr-theme-light', us.theme === 'light');
    cl.toggle('bustr-theme-dark', us.theme === 'dark');
    if (typeof fitStatsCard === 'function') fitStatsCard(); // open stats card follows a text-size change
  }

  function applyJailVisibility() {
    applyAppearance();
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

  function refreshSuccessChances() {
    if (window.location.pathname !== '/jailview.php') return;
    renderHardnessJailView();
    applyJailVisibility();
    renderJailRows();
  }


  function updateSetting(key, value) {
    setUserSettings({ ...getUserSettings(), [key]: value });
  }
  const clampPct = (v) => Math.max(0, Math.min(100, v));
  const numOr = (el, fallback) => { const v = parseFloat(el.value); return isNaN(v) ? fallback : v; };

  function applySettings() {
    applyBadgeDetail(); // reflect a compact/full badge toggle immediately
    recalcLocally(); // recomputes available busts + nav colour (limits, custom threshold)
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

  function refitFromExistingOutcomes() {
    const state = getGlobalBustrState();
    const outcomes = state.outcomeLog || [];
    if (outcomes.length === 0) return;
    setGlobalBustrState({ selfCalFit: computeSelfCalFit(outcomes) });
  }

  async function detectApiKeyType() {
    if (apiKeyTypeInFlight || apiKeyAccessType) return;
    const now = Date.now();
    if (now - apiKeyTypeLastTry < 60000) return; // don't re-probe on every panel refresh / failure
    const k = describeApiKey();
    if (!k.looksValid) return;
    let key;
    try { key = getApiKey(); } catch (e) { return; }
    if (!key) return;
    apiKeyTypeInFlight = true;
    apiKeyTypeLastTry = now;
    try {
      const data = await fetchTornJson(`https://api.torn.com/key/?selections=info&key=${key}`);
      if (!data) return;
      const info = (data.info && typeof data.info === 'object') ? data.info : data;
      const at = info && info.access_type;
      if (typeof at === 'string' && at && getApiKey() === key) {
        apiKeyAccessType = at;
        refreshApiKeyState();
      }
    } catch (e) {
      /* advisory only - stay silent on any failure (HTTP / Torn error, timeout, bad JSON) */
    } finally {
      apiKeyTypeInFlight = false;
    }
  }

  function refreshApiKeyState() {
    const el = document.getElementById('bustr-set-apikey-state');
    if (!el) return;
    const k = describeApiKey();
    const saved = k.source === 'user override';
    const healthyPda = k.source === 'PDA injected' && k.looksValid && !fatalKeyError;
    const settled = saved || healthyPda; // a usable key is in play (saved by the user or PDA-injected)
    const broadKey = settled && apiKeyAccessType && apiKeyAccessType !== 'Custom';
    let msg;
    if (broadKey) msg = `BUSTR is working, but it is using a ${apiKeyAccessType} key. For safety, create a key scoped to only what BUSTR needs (${API_KEY_SELECTIONS}) and save that instead.`;
    else if (saved) msg = 'API key is saved.';
    else if (healthyPda) msg = 'BUSTR is using the key from the PDA app. To use your own instead, create or paste one below.';
    else if (k.source === 'PDA injected') msg = 'The key from the PDA app is not working. Enter your own key below.';
    else if (k.pdaTokenSubstituted) msg = 'The PDA app supplied an EMPTY key, so BUSTR has no key to use. Create one below.';
    else msg = 'No API key set. Create one below.';
    if (k.source !== 'none' && !k.looksValid) {
      msg += ` Warning: it is ${k.resolvedLength} characters, but a Torn key is ${k.expectedLength}. Torn will reject it as "Incorrect key". Re-paste it carefully.`;
    }
    el.textContent = msg;

    const entry = document.getElementById('bustr-set-apikey-entry');
    const clearBtn = document.getElementById('bustr-set-apikey-clear');
    const collapse = saved && !broadKey;
    if (entry) entry.style.display = collapse ? 'none' : '';
    if (clearBtn) clearBtn.style.display = saved ? '' : 'none';

    detectApiKeyType(); // fire-and-forget; self-guards, resolves the key type once then nudges
  }

  function refreshSettingsStatus() {
    refitFromExistingOutcomes();
    refreshApiKeyState();
    const el = document.getElementById('bustr-set-status');
    if (el) {
      const pen = Math.round(calcPenaltyPct(getTimestampsArray()));
      const settings = getUserSettings();
      let mode = (typeof settings.skillCalibrationOverride === 'number') ? 'manual' : 'auto';
      if (typeof settings.skillCalibrationOverride !== 'number' && settings.selfCalibrationEnabled) {
        const st = getGlobalBustrState();
        if (st.selfCalFit && st.selfCalFit.effN > 0) mode = 'adaptive';
      }
      el.textContent = `BUSTR v${SCRIPT_VERSION} \u00b7 Lvl ${getPlayerLevel()} \u00b7 calibration ${getSkillCalibration().toFixed(2)} (${mode}) \u00b7 current penalty ${pen}%`;

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
      const st = getGlobalBustrState();
      const stats = selfCalibrationStats(st.outcomeLog || []);
      if (!stats) {
        statsEl.textContent = 'No outcomes logged yet. Logging starts the moment this is enabled.';
      } else {
        const legacy = stats.n - stats.usable;
        const fit = st.selfCalFit;
        const fitNote = (fit && fit.effN > 0)
          ? `effective cal ${getSkillCalibration().toFixed(2)} \u00b7 fit ${fit.cal} [${fit.lo} - ${fit.hi}], effN ${fit.effN}, trend ${selfCalTrend(fit)}`
          : 'no usable outcomes yet (perk baseline until some are logged)';
        const legacyNote = legacy > 0
          ? ` \u00b7 ${legacy} pre-v2.7.19 sample(s) shown but not fitted (recorded under the old penalty model)`
          : '';
        statsEl.textContent = `${stats.n} outcome(s) logged \u00b7 ${stats.successRatePct}% succeeded \u00b7 ${stats.jailed} jailed \u00b7 ${fitNote}${legacyNote}`;
      }
    }
  }

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

  function histRangeStart(key) {
    const now = new Date();
    if (key === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (key === '7d') return Date.now() - 7 * 24 * 60 * 60 * 1000;
    return 0;
  }
  function fmtHistTime(ts, rangeKey) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (rangeKey === 'today') return hh + ':' + mm;
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
    return d.getDate() + ' ' + mon + ' ' + hh + ':' + mm;
  }
  function renderBustHistory() {
    try {
      const listEl = document.getElementById('bustr-hist-list');
      const sumEl = document.getElementById('bustr-hist-summary');
      if (!listEl || !sumEl) return;
      mergeStoredOutcomeLog(); // show busts logged in your other Torn tabs too (memory only)
      const rangeSel = document.getElementById('bustr-hist-range');
      const rangeKey = rangeSel ? rangeSel.value : 'today';
      const start = histRangeStart(rangeKey);
      const entries = (getGlobalBustrState().outcomeLog || [])
        .filter((o) => o && typeof o.ts === 'number' && o.ts >= start)
        .sort((a, b) => b.ts - a.ts);
      const total = entries.length;
      const wins = entries.filter((o) => o.success).length;
      const rate = total ? Math.round((wins / total) * 100) : 0;
      const label = rangeKey === 'today' ? 'today' : (rangeKey === '7d' ? 'in the last 7 days' : 'all time');
      sumEl.textContent = total
        ? total + ' bust' + (total === 1 ? '' : 's') + ' ' + label + ' - ' + wins + ' landed (' + rate + '%).'
        : 'No busts logged ' + label + '.';
      if (!total) { listEl.innerHTML = '<div class="bustr-hist-empty">Nothing here yet.</div>'; return; }
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      listEl.innerHTML = entries.map((o) => {
        const outClass = o.success ? 'bustr-ho-success' : (o.jailed ? 'bustr-ho-jailed' : 'bustr-ho-fail');
        const outTitle = o.success ? 'Busted' : (o.jailed ? 'Failed - got jailed' : 'Failed');
        const name = o.nm ? esc(o.nm) : '-';
        const pct = (typeof o.pred === 'number') ? o.pred + '%' : '-';
        const h = (typeof o.h === 'number') ? 'H' + o.h : '';
        return '<div class="bustr-hist-row">'
          + '<span class="bustr-hist-outcome ' + outClass + '" title="' + outTitle + '"></span>'
          + '<span class="bustr-hist-time">' + fmtHistTime(o.ts, rangeKey) + '</span>'
          + '<span class="bustr-hist-name">' + name + '</span>'
          + '<span class="bustr-hist-h">' + h + '</span>'
          + '<span class="bustr-hist-pct">' + pct + '</span>'
          + '</div>';
      }).join('');
    } catch (e) { console.error('[BUSTR] history render failed', e); }
  }

  function bustStatsFor(entries) {
    const n = entries.length;
    const wins = entries.filter((o) => o.success).length;
    const jailed = entries.filter((o) => !o.success && o.jailed).length;
    const preds = entries.filter((o) => typeof o.pred === 'number');
    const avgPred = preds.length ? preds.reduce((s, o) => s + o.pred, 0) / preds.length : null;
    const predRate = preds.length ? (preds.filter((o) => o.success).length / preds.length) * 100 : null;
    const landedH = entries.filter((o) => o.success && typeof o.h === 'number').map((o) => o.h);
    return {
      n, wins, fails: n - wins, jailed,
      rate: n ? (wins / n) * 100 : null,
      avgPred,
      luck: predRate == null ? null : predRate - avgPred,
      hardest: landedH.length ? Math.max.apply(null, landedH) : null,
    };
  }
  function fmtAgo(ms) {
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' h ' + (m % 60) + ' min ago';
    const d = Math.floor(h / 24);
    return d + ' day' + (d === 1 ? '' : 's') + ' ago';
  }
  const statsView = { y: 0, m: 0, day: 0, help: false };
  function dayStartOf(ts) { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
  const MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const STATS_MIN_DAY = 3;
  function bustStatsCalendarHtml(all) {
    const { y, m } = statsView;
    const first = new Date(y, m, 1);
    const daysIn = new Date(y, m + 1, 0).getDate();
    const lead = (first.getDay() + 6) % 7; // Monday-first grid
    const monthStart = first.getTime();
    const monthEnd = new Date(y, m + 1, 1).getTime();
    const byDay = {};
    all.forEach((o) => {
      if (o.ts < monthStart || o.ts >= monthEnd) return;
      const k = new Date(o.ts).getDate();
      (byDay[k] = byDay[k] || []).push(o);
    });
    const today = dayStartOf(Date.now());
    const now = new Date();
    const earliest = all.length ? new Date(all[0].ts) : now;
    const canPrev = y > earliest.getFullYear() || (y === earliest.getFullYear() && m > earliest.getMonth());
    const canNext = y < now.getFullYear() || (y === now.getFullYear() && m < now.getMonth());
    let html = '<div class="bustr-cal">'
      + '<div class="bustr-cal-head">'
      + '<span class="bustr-cal-nav' + (canPrev ? '' : ' bustr-cal-off') + '" data-st-nav="-1" role="button" aria-label="Previous month">&lsaquo;</span>'
      + '<span class="bustr-cal-title">' + MON_LONG[m] + ' ' + y + '</span>'
      + '<span class="bustr-cal-nav' + (canNext ? '' : ' bustr-cal-off') + '" data-st-nav="1" role="button" aria-label="Next month">&rsaquo;</span>'
      + '</div><div class="bustr-cal-grid">';
    ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach((d) => { html += '<span class="bustr-cal-dow">' + d + '</span>'; });
    for (let i = 0; i < lead; i++) html += '<span></span>';
    for (let d = 1; d <= daysIn; d++) {
      const ts = new Date(y, m, d).getTime();
      const list = byDay[d] || [];
      const cls = ['bustr-cal-day'];
      if (ts > today) cls.push('bustr-cal-future');
      if (ts === today) cls.push('bustr-cal-today');
      if (ts === statsView.day) cls.push('bustr-cal-sel');
      let count = '';
      if (list.length) {
        const s = bustStatsFor(list);
        if (list.length >= STATS_MIN_DAY && s.luck != null) cls.push(s.luck < 0 ? 'bustr-cal-bad' : 'bustr-cal-good');
        else cls.push('bustr-cal-few');
        count = '<i>' + list.length + '</i>';
      }
      html += '<span class="' + cls.join(' ') + '"' + (ts > today ? '' : ' data-st-day="' + ts + '" role="button"')
        + '>' + d + count + '</span>';
    }
    return html + '</div></div>';
  }

  function bustStatsHtml() {
    mergeStoredOutcomeLog(); // include busts logged in your other Torn tabs
    const all = (getGlobalBustrState().outcomeLog || [])
      .filter((o) => o && typeof o.ts === 'number')
      .sort((a, b) => a.ts - b.ts);
    if (!all.length) {
      return 'No busts logged yet. BUSTR records each bust you make while it is running, '
        + 'then shows your numbers here.';
    }
    const dayStart = statsView.day;
    const dayEnd = new Date(new Date(dayStart).getFullYear(), new Date(dayStart).getMonth(), new Date(dayStart).getDate() + 1).getTime();
    const isToday = dayStart === dayStartOf(Date.now());
    const dd = new Date(dayStart);
    const dayLabel = isToday ? 'Today' : dd.getDate() + ' ' + MON_SHORT[dd.getMonth()];
    const dayList = all.filter((o) => o.ts >= dayStart && o.ts < dayEnd);
    const tn = new Date();
    const weekStart = new Date(tn.getFullYear(), tn.getMonth(), tn.getDate() - 6).getTime();
    const cols = [
      [dayLabel, bustStatsFor(dayList)],
      ['7 days', bustStatsFor(all.filter((o) => o.ts >= weekStart))],
      ['All', bustStatsFor(all)],
    ];
    const dash = '-';
    const pct = (v) => (v == null ? dash : Math.round(v) + '%');
    const luck = (s) => {
      if (s.luck == null) return dash;
      const d = Math.round(s.luck);
      const cls = d > 0 ? 'bustr-st-good' : (d < 0 ? 'bustr-st-bad' : '');
      return '<span class="' + cls + '">' + (d > 0 ? '+' : '') + d + ' pts</span>';
    };
    const rows = [
      ['Busts', (s) => s.n, 'bustr-st-key'],
      ['Landed', (s) => s.wins, ''],
      ['Failed', (s) => s.fails, ''],
      ['of which jailed', (s) => s.jailed, 'bustr-st-sub'],
      ['Success rate', (s) => pct(s.rate), 'bustr-st-key bustr-st-gap'],
      ['Avg odds taken', (s) => pct(s.avgPred), ''],
      ['vs the odds', luck, ''],
      ['Hardest landed', (s) => (s.hardest == null ? dash : 'H' + s.hardest), ''],
    ];
    const cell = (v, i) => {
      const dim = v === 0 || v === dash;
      const cls = [i === 0 ? 'bustr-st-today' : '', dim ? 'bustr-st-dim' : ''].filter(Boolean).join(' ');
      return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</td>';
    };
    let html = '<div class="bustr-st-cols"><div class="bustr-st-col">' + bustStatsCalendarHtml(all) + '</div><div class="bustr-st-col">';
    html += '<table class="bustr-st-table"><tr><th></th>'
      + cols.map((c, i) => '<th' + (i === 0 ? ' class="bustr-st-today"' : '') + '>' + c[0] + '</th>').join('') + '</tr>';
    rows.forEach((r) => {
      html += '<tr' + (r[2] ? ' class="' + r[2] + '"' : '') + '><td>' + r[0] + '</td>'
        + cols.map((c, i) => cell(r[1](c[1]), i)).join('') + '</tr>';
    });
    html += '</table>';

    let cur = 0, best = 0, bestTs = 0;
    all.forEach((o) => {
      if (o.success) { cur++; if (cur > best) { best = cur; bestTs = o.ts; } }
      else if (o.jailed) cur = 0;
    });
    const landedByDay = {};
    all.forEach((o) => { if (o.success) { const k = dayStartOf(o.ts); landedByDay[k] = (landedByDay[k] || 0) + 1; } });
    let bestDay = 0, bestDayN = 0;
    Object.keys(landedByDay).forEach((k) => {
      if (landedByDay[k] > bestDayN || (landedByDay[k] === bestDayN && Number(k) > bestDay)) { bestDayN = landedByDay[k]; bestDay = Number(k); }
    });
    const fmtDay = (ts) => { const d = new Date(ts); return d.getDate() + ' ' + MON_SHORT[d.getMonth()] + (d.getFullYear() === new Date().getFullYear() ? '' : ' ' + d.getFullYear()); };
    const dayLink = (ts, text) => '<span class="bustr-st-link" data-st-day="' + dayStartOf(ts) + '" data-st-goto="1" role="button">' + text + '</span>';
    html += '<div class="bustr-st-facts">'
      + '<span>Current streak</span><span class="' + (cur ? 'bustr-st-good' : '') + '">' + cur + ' landed, no arrest</span>'
      + '<span>Best streak</span><span>' + (best ? best + ' landed - ' + dayLink(bestTs, fmtDay(bestTs)) : '-') + '</span>'
      + '<span>Best day</span><span>' + (bestDayN ? bestDayN + ' landed - ' + dayLink(bestDay, fmtDay(bestDay)) : '-') + '</span>'
      + '<span>Last bust</span><span>' + fmtAgo(Date.now() - all[all.length - 1].ts) + '</span>'
      + '</div>';
    html += '<div class="bustr-st-help-row"><span class="bustr-st-qbtn' + (statsView.help ? ' bustr-st-qbtn-on' : '') + '" data-st-help="1" role="button" aria-label="What do these mean?">?</span></div>';
    return html + '</div></div>';
  }

  function rerenderBustStats() {
    const body = document.getElementById('bustr-st-body');
    if (body) body.innerHTML = bustStatsHtml();
    fitStatsCard();
    syncStatsExplain();
  }

  const STATS_EXPLAIN_HTML = '<p>Tap a day to see it. Green days beat the odds, red days fell short. Days with fewer than ' + STATS_MIN_DAY + ' busts stay grey - too few to call.</p>'
    + '<p><b>Streak</b> - landed busts until you get jailed. A fail that does not jail you does not break it.</p>'
    + '<p><b>Best day</b> - the day with the most landed busts.</p>'
    + '<p><b>vs the odds</b> - your success rate minus the average odds BUSTR showed, both over the busts that had odds shown.</p>'
    + '<p><b>7 days</b> - today and the 6 days before it. Days run midnight to midnight on your device clock.</p>'
    + '<p>Counts busts BUSTR logged on this device (or synced), up to the last ' + OUTCOME_LOG_MAX + '. '
    + 'Full list: Settings - Bust history.</p>'
    + '<p>Drag the stats card by its title to move it.</p>';
  function syncStatsExplain() {
    let ex = document.getElementById('bustr-st-explain');
    const card = document.getElementById('bustr-help');
    const want = statsView.help && card && card.classList.contains('bustr-open') && card.classList.contains('bustr-st-card');
    if (!want) { if (ex) ex.remove(); return; }
    if (!ex) {
      ex = document.createElement('div');
      ex.id = 'bustr-st-explain';
      ex.innerHTML = '<h4>About these numbers<span class="bustr-help-close" role="button" aria-label="Close">&times;</span></h4>' + STATS_EXPLAIN_HTML;
      ex.querySelector('.bustr-help-close').addEventListener('click', () => { statsView.help = false; rerenderBustStats(); });
      document.body.appendChild(ex);
    }
    placeStatsExplain();
  }
  function placeStatsExplain() {
    const ex = document.getElementById('bustr-st-explain');
    const card = document.getElementById('bustr-help');
    if (!ex || !card) return;
    const r = card.getBoundingClientRect();
    const w = ex.offsetWidth, h = ex.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    let left;
    if (r.right + 10 + w <= vw - 8) left = r.right + 10;
    else if (r.left - 10 - w >= 8) left = r.left - 10 - w;
    else left = Math.max(8, (vw - w) / 2); // phone: no room either side, sit on top of the card
    const top = Math.max(8, Math.min(r.top, vh - h - 8));
    ex.style.left = Math.round(left) + 'px';
    ex.style.top = Math.round(top) + 'px';
  }

  function placeStatsCard(card, left, top) {
    const w = card.offsetWidth, h = card.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    const l = Math.max(8, Math.min(left, vw - w - 8));
    const t = Math.max(8, Math.min(top, vh - h - 8));
    card.style.left = Math.round(l) + 'px';
    card.style.top = Math.round(t) + 'px';
    return { left: l, top: t };
  }

  const STATS_POS_KEY = 'bustrStatsCardPos';
  function makeStatsCardDraggable(card) {
    const head = card.querySelector('h4');
    if (!head) return;
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target.closest && e.target.closest('.bustr-help-close'))) return;
      const r = card.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      card.style.transform = 'none';
      placeStatsCard(card, r.left, r.top);
      try { head.setPointerCapture(e.pointerId); } catch (err) { /* moves still arrive while over the head */ }
      card.classList.add('bustr-st-dragging');
      const move = (ev) => { placeStatsCard(card, ev.clientX - dx, ev.clientY - dy); placeStatsExplain(); };
      const up = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        head.removeEventListener('pointercancel', up);
        card.classList.remove('bustr-st-dragging');
        const cr = card.getBoundingClientRect();
        try { Store.set(STATS_POS_KEY, { left: Math.round(cr.left), top: Math.round(cr.top) }); } catch (err) { /* position is a convenience only */ }
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
      head.addEventListener('pointercancel', up);
      e.preventDefault();
    });
  }

  function fitStatsCard() {
    const card = document.getElementById('bustr-help');
    if (!card || !card.classList.contains('bustr-open') || !card.classList.contains('bustr-st-card')) return;
    const maxH = window.innerHeight - 16;
    card.classList.remove('bustr-st-wide');
    if (card.scrollHeight > maxH) {
      const fs = parseFloat(getComputedStyle(document.body).getPropertyValue('--bustr-fs')) || 1;
      if (window.innerWidth - 16 >= 500 * fs) card.classList.add('bustr-st-wide');
    }
    const r = card.getBoundingClientRect();
    if (getComputedStyle(card).transform !== 'none' && !card.style.left) return; // centred by CSS (phone)
    placeStatsCard(card, r.left, r.top);
    placeStatsExplain();
  }
  let statsResizeHooked = false;

  function showBustStats(chipEl) {
    try {
      const now = new Date();
      statsView.y = now.getFullYear(); statsView.m = now.getMonth(); statsView.day = dayStartOf(now.getTime()); statsView.help = false;
      showCard('Your bust stats', '<div id="bustr-st-body">' + bustStatsHtml() + '</div>', chipEl);
      const card = document.getElementById('bustr-help');
      if (!card || !card.classList.contains('bustr-open')) return;
      card.classList.add('bustr-st-card');
      const body = document.getElementById('bustr-st-body');
      if (body) {
        body.addEventListener('click', (e) => {
          const t = e.target.closest ? e.target.closest('[data-st-day],[data-st-nav],[data-st-help]') : null;
          if (!t || t.classList.contains('bustr-cal-off')) return;
          if (t.dataset.stHelp) {
            statsView.help = !statsView.help;
          } else if (t.dataset.stDay) {
            statsView.day = Number(t.dataset.stDay);
            const jd = new Date(statsView.day); statsView.y = jd.getFullYear(); statsView.m = jd.getMonth();
          } else {
            const d = new Date(statsView.y, statsView.m + Number(t.dataset.stNav), 1);
            statsView.y = d.getFullYear(); statsView.m = d.getMonth();
          }
          rerenderBustStats();
        });
      }
      makeStatsCardDraggable(card);
      card.style.maxHeight = 'calc(100vh - 16px)';
      let saved = null;
      try { saved = Store.get(STATS_POS_KEY); } catch (err) { saved = null; }
      if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
        card.style.transform = 'none';
        placeStatsCard(card, saved.left, saved.top);
      } else if (window.innerWidth > 780) {
        const r = chipEl.getBoundingClientRect();
        card.style.transform = 'none';
        placeStatsCard(card, r.left - 12, r.bottom + 8);
      }
      fitStatsCard();
      if (!statsResizeHooked) { statsResizeHooked = true; window.addEventListener('resize', fitStatsCard); }
    } catch (e) { console.error('[BUSTR] bust stats failed', e); }
  }

  function populateSettingsPanelInputs() {
    const panel = document.getElementById('bustr-settings-panel');
    if (!panel) return;
    const byId = (id) => document.getElementById(id);
    const us = getUserSettings();

    byId('bustr-set-refresh').value = us.statsRefreshRate || DEFAULT_REFRESH_SECONDS;
    byId('bustr-set-hardness').checked = us.showHardnessScore !== false;
    byId('bustr-set-quickbail').checked = us.quickBail === true;
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
    byId('bustr-set-textsize').value = ['large', 'xlarge'].includes(us.textSize) ? us.textSize : 'normal';
    byId('bustr-set-theme').value = ['light', 'dark'].includes(us.theme) ? us.theme : 'auto';
    byId('bustr-set-badgesimple').checked = us.navBadgeDetail !== 'full';
    byId('bustr-set-pdahold').checked = us.pdaHoldDetails !== false;
    byId('bustr-set-useperkcal').checked = us.usePerkCalibration === true;
    const cloudBox = byId('bustr-set-cloudsync');
    if (cloudBox) cloudBox.checked = us.cloudSyncEnabled === true && CloudSync.signedIn();
    refreshCloudStatus();
    refreshPerkImpactDisplay();
    renderBustHistory();
  }

  function applyDebugExportVisibility() {
    const sec = document.getElementById('bustr-debug-export-section');
    if (!sec) return;
    const syncActive = hasGMXhr && CloudSync.enabled() && CloudSync.signedIn();
    sec.style.display = syncActive ? 'none' : '';
  }

  function refreshCloudStatus(msg) {
    const el = document.getElementById('bustr-cloud-status');
    if (!el) return;
    applyDebugExportVisibility();
    if (typeof msg === 'string') { el.textContent = msg; return; }
    if (!hasGMXhr) { el.textContent = 'Unavailable here - this app or manager does not provide cross-origin requests. Works on desktop and recent Torn PDA.'; return; }
    if (CloudSync.enabled() && CloudSync.signedIn()) {
      el.textContent = 'On - synced as player ' + (CloudSync.playerId || '?') + '.';
    } else {
      el.textContent = 'Off. Your bust history stays only on this device.';
    }
  }

  function showConsentModal(title, bodyHTML, okLabel) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'bustr-consent-backdrop';
      back.innerHTML = `
        <div class="bustr-consent-card">
          <h3>${title}</h3>
          <p>${bodyHTML}</p>
          <div class="bustr-consent-actions">
            <button type="button" class="bustr-btn" id="bustr-consent-cancel">Cancel</button>
            <button type="button" class="bustr-btn" id="bustr-consent-ok">${okLabel}</button>
          </div>
        </div>`;
      const done = (val) => { try { back.remove(); } catch (e) {} resolve(val); };
      back.addEventListener('click', (e) => { if (e.target === back) done(false); });
      document.body.appendChild(back);
      back.querySelector('#bustr-consent-cancel').addEventListener('click', () => done(false));
      back.querySelector('#bustr-consent-ok').addEventListener('click', () => done(true));
    });
  }

  function showCloudConsent() {
    return showConsentModal(
      'Enable cloud sync?',
      'Backs up your bust history across your devices, tied to your Torn ID. Stored: your bust stats, plus the perks, level, calibration, BUSTR settings and script version behind your predictions - all to improve BUSTR\'s model. Never your API key, name, or faction. Switching it off deletes your cloud copy.',
      'Enable sync'
    );
  }

  function showEasyActionsConsent() {
    return showConsentModal(
      'Enable Easy Bust / Easy Bail?',
      'Unlike Quick actions (which only relabel your own click), this makes BUSTR <b>send the bust/bail request itself</b> when you tap the header button. It is still ONE tap = ONE request, to the same jail page, with no looping or auto-repeat - the button does nothing until you tap it again, and BUSTR only picks which shown target. You decide whether and when to tap. Use at your own discretion.',
      'Enable'
    );
  }

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

  function findSidebarContainer(jail) {
    if (!jail) return null;
    return jail.closest('ul') || jail.parentElement || null;
  }

  function findMobileNavCell(jail) {
    const cell = jail && jail.parentElement;
    if (!cell) return null;
    if (cell.querySelectorAll('[id^="nav-"]').length !== 1) return null; // the bar, or some shared wrapper
    const bar = cell.parentElement;
    if (!bar || bar.querySelectorAll('[id^="nav-"]').length < 2) return null; // not a bar of cells
    return cell;
  }

  function findByClassPrefix(root, prefix) {
    return root.querySelector(`[class*="${prefix}"]`);
  }

  function stripActiveStateClasses(el) {
    [el, ...el.querySelectorAll('*')].forEach((node) => {
      if (!node.classList) return;
      [...node.classList].forEach((cls) => {
        if (/^active/i.test(cls)) node.classList.remove(cls);
      });
    });
  }

  function buildSidebarButton(sourceEl) {
    const li = sourceEl.cloneNode(true);
    stripActiveStateClasses(li);
    li.removeAttribute('id');
    li.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    li.id = 'bustr-sidebar-btn';
    li.title = 'BUSTR settings';
    li.querySelectorAll('.bustr-stats').forEach((el) => el.remove()); // strip any cloned BUSTR badge
    li.querySelectorAll('[class*="mobileAmount"]').forEach((el) => el.remove());
    const anchor = li.querySelector('a') || li;
    anchor.removeAttribute('href'); // never navigate - this opens the settings panel
    anchor.removeAttribute('i-date');

    const label = findByClassPrefix(anchor, 'linkName');
    if (label) {
      label.textContent = 'BUSTR';
    } else {
      anchor.textContent = 'BUSTR'; // fallback if that class name ever changes
    }
    const iconWrap = findByClassPrefix(anchor, 'svgIconWrap') || findByClassPrefix(anchor, 'defaultIcon');
    if (iconWrap) {
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

    const cell = jail && isMobileViewport() ? findMobileNavCell(jail) : null;
    if (cell) {
      let col = existing;
      if (!col) {
        col = buildSidebarButton(cell); // clone the CELL, so the clone IS a column
        cell.insertAdjacentElement('afterend', col);
      } else if (col.previousElementSibling !== cell) {
        cell.insertAdjacentElement('afterend', col);
      }
      const badge = document.querySelector('.bustr-mobile-badge');
      if (badge && !col.contains(badge)) {
        const anchor = col.querySelector('a') || col;
        anchor.insertAdjacentElement('beforebegin', badge);
        recalcPenaltyScoreOnly(); // repaint, in case the badge wasn't painted before the move
      }
      if (badge && badge.parentElement) badge.parentElement.classList.add('bustr-col-inner');
      return;
    }

    if (list && jail) {
      const tornToolsItem = document.querySelector('.tt-settings')
        || [...list.children].find((child) => /torntools/i.test(child.textContent || ''));

      if (existing) {
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

  }

  const HELP = {
    history: ['Bust history', 'Every bust you have attempted, newest first: the time, who you went for, their hardness, the success % BUSTR predicted, and whether it worked (green dot), failed (amber) or got you jailed (red). The filter counts how many you did today, in the last 7 days, or all time. It reads the same on-device log that powers adaptive calibration - captive names stay on this device and are never uploaded, even with cloud sync on.'],
    refresh: ['Refresh rate', 'How often the on-screen numbers redraw, in seconds. This does NOT control how often BUSTR calls the Torn API. Those calls are throttled separately: your bust log is fetched at most once every 35 seconds and only while you are on the jail page, and your level/perks at most once a day. Everywhere else the numbers are worked out on your device from the last fetch, with no API call at all, so lowering this costs you nothing in API usage. Minimum 15.'],
    scope: ['Active on', 'Anywhere: the nav badge and colours appear on every Torn page. Jail page only: hides them and pauses background checks everywhere except the jail page. Use it if the badge distracts you while doing other things.'],
    badge: ['Compact nav badge', 'On (default): the Jail nav badge shows how many more busts you can safely make (colour-coded by budget) plus your penalty %, which is coloured by severity - green when low, amber mid, red high, and a heavier red over 100%. Off: it also shows the raw penalty score / threshold prefix. Either way the full breakdown is always available by hovering the badge and in this panel\'s status line, so nothing is lost.'],
    textsize: ['Text size', 'Makes all of BUSTR\'s text bigger: the success % and hardness number on the jail page, the Jail nav badge, and these settings. Large is 1.25x, Extra large 1.5x, and both also make the numbers bold. Normal (default) is the standard size. On PDA the small badge in the nav bar grows a little less, so it still fits its slot.'],
    theme: ['Theme', 'Light or dark look for BUSTR\'s own windows: these settings, the help card, and the PDA hold card. Auto (default) follows Torn - light when you use Torn\'s light mode, dark in dark mode. Light and Dark keep that look whatever Torn uses. The colours on the jail page itself always follow Torn.'],
    pdahold: ['Hold Jail for details (PDA)', 'PDA only. Off by default. On: BUSTR leaves the nav bar - no numbers and no BUSTR button there, so it takes none of your nav-bar space. Press and hold the Jail button (or right-click it) to pop up your remaining busts and penalty % (plus the score / threshold when Compact nav badge is off), with the BUSTR button underneath - tap it to open these settings. A normal tap still opens Jail as usual. Off (default): the badge and the BUSTR button sit in the nav bar as before. Has no effect anywhere except PDA.'],
    display: ['Jail list display', 'These change only what the jail list shows. The list is always sorted easiest-first, and the hardness score and the odds underneath are always calculated the same way regardless.'],
    hardness: ['Hardness number', 'Shows each prisoner\'s hardness score, which is their level multiplied by their remaining jail time plus three hours. Higher means harder to bust.'],
    quickactions: ['Quick actions', 'Optional. When on, BUSTR relabels Torn\'s own bust/bail link to its no-confirmation variant (the button gets a green highlight) so your single click skips the "are you sure?" step. BUSTR never clicks or busts for you - you still press every button yourself, one click per bust. This is the same mechanism the long-running TornTools extension uses. If you run TornTools, turn its own Quick Bust off to use this - the two act on the same link and conflict. Off by default; leave off if you prefer Torn\'s confirmation.'],
    easyactions: ['Easy actions', 'Optional and OFF by default. Adds a one-tap "Easy Bust" / "Easy Bail" button to the jail list header. Unlike Quick actions (which only relabel your own click), tapping this makes BUSTR send the request itself for the single best shown target - bust picks the highest success %, bail picks the cheapest. If a bust fails and that person is still in jail, the next tap retries the same person - until they are busted or no longer in jail - then moves on to the next best target. It is strictly one tap = one request, to the same jail page, with no looping or auto-repeat: the button does nothing until you tap it again, and you decide when to tap. Enabling asks for a one-time confirmation. Use at your own discretion.'],
    success: ['Show success %', 'Shows your estimated chance of busting each prisoner, from their hardness and your current penalty.'],
    sccolour: ['Success % colours', 'Colour thresholds for the per-target percentage: green at or above the first number, red below the second, orange in between. Display only, they never change the percentage itself.'],
    model: ['Success % model', 'These change the actual predicted number. When more than one applies the priority is: manual override wins, then adaptive calibration once it has enough data, then the perk baseline.'],
    cal: ['Skill calibration', 'Scales how skilled BUSTR assumes you are at busting. 1.0 means the full perk stack the model was built on (faction Bust Skill plus all LAW courses). Lower it if you have fewer perks, roughly 0.70 for faction perks only. Leave blank for automatic. Worth knowing: this only scales the target-difficulty half of the model, so it cannot compensate for penalty, and forcing it very low to "fix" failures will distort the odds on easy targets.'],
    selfcal: ['Adaptive calibration', 'Learns your real success curve from your own results. It records which prisoner you clicked Bust on and whether it worked, entirely on your own machine, and uses that to adjust how skilled it assumes you are. It blends your fitted curve with the perk baseline in proportion to how much usable data you have (Bayesian shrinkage), and weights recent busts more than old ones (about a 60-day half-life) so the number tracks you getting stronger as you level and add perks. At zero samples it is identical to the perk baseline, with a lot of data it converges to your own fit, and it can never lurch on a handful of results. The panel shows the effective calibration, a confidence range, an effective sample count, and whether you are trending up or down. Only used when the manual override above is blank; turn it off to use the perk baseline alone. It never changes the underlying model, only how your one skill number is estimated.'],
    perkcal: ['Perk-based calibration', 'On by default. BUSTR estimates your skill from the bust perks it detects on your account, so an under-perked player is not shown the same odds as a fully-perked one. Validated against real pooled outcomes to improve the success % (most at low and mid penalty); it only affects the success number, never your penalty. Once adaptive calibration has enough of your own results it takes over. Turn this off to use the plain baseline of 1.0 instead. Torn does not publish how perks map to bust skill, so this is a grounded estimate rather than a measurement.'],
    playstyle: ['Play style', 'Changes when the colours flip, not the numbers underneath. Safety uses your thresholds as set. Max count shifts the bands so you spend longer in the orange zone, which raises daily bust volume at the cost of more failures and more jail time. Nothing is ever busted for you either way.'],
    exportHelp: ['Debug export', 'Copies a snapshot for the script maintainer to debug with: your level, settings, detected perks, current penalty, calibration, and logged bust history. Your API key and the names of the players you bust are never included, and this script never reads your username, ID, or faction.'],
    apikey: ['API key', 'BUSTR needs three things from Torn: your level, your bust perks, and your own bust history. "Create a key for BUSTR" opens Torn\'s API page with exactly those (' + API_KEY_SELECTIONS + ') pre-ticked and nothing else, so the key cannot touch your money, mail, or faction. Generate it there, paste it here. The key is stored on this device only and sent nowhere except Torn\'s own API. On PDA the app supplies its own key; saving one here overrides it.'],
    cloudsync: ['Cloud sync', 'Off by default. When on, your bust history is backed up to a database and merged across your devices, tied to your verified Torn ID. What is stored: your bust stats (hardness, penalty, outcome, time), plus the context behind your predictions - your bust perks, level, calibration, BUSTR settings and script version - all so BUSTR\'s model can be improved across users. Never stored: your API key, name, ID, or faction. Turning it off deletes your cloud copy. Works on desktop and on Torn PDA (recent versions provide the cross-origin support it needs); where that is missing, the option shows as unavailable.'],
    reset: ['Reset settings', 'Puts every setting in this panel back to its default. Your saved API key and your logged bust history are both kept.'],
    wipe: ['Clear all data', 'Removes everything BUSTR has stored on this device: settings, saved API key, and your entire logged bust history. This cannot be undone.'],
  };

  function hideHelp() {
    const card = document.getElementById('bustr-help');
    if (card) { card.classList.remove('bustr-open', 'bustr-st-card', 'bustr-st-dragging'); card.style.cssText = ''; } // drop the stats card's placement
    const stEx = document.getElementById('bustr-st-explain');
    if (stEx) stEx.remove();
    document.querySelectorAll('.bustr-q.bustr-q-on')
      .forEach((el) => el.classList.remove('bustr-q-on'));
  }

  function showHelp(key, chipEl) {
    const entry = HELP[key];
    if (entry) showCard(entry[0], entry[1], chipEl);
  }

  function showCard(title, bodyHtml, chipEl) {
    const card = document.getElementById('bustr-help');
    if (!card) return;
    const alreadyOpen = card.classList.contains('bustr-open') && chipEl.classList.contains('bustr-q-on');
    hideHelp();
    if (alreadyOpen) return;
    card.innerHTML = `<h4>${title}<span class="bustr-help-close" id="bustr-help-close">&times;</span></h4><div>${bodyHtml}</div>`;
    card.classList.add('bustr-open');
    chipEl.classList.add('bustr-q-on');
    const closeEl = document.getElementById('bustr-help-close');
    if (closeEl) closeEl.addEventListener('click', hideHelp);
  }

  const q = (key) => `<span class="bustr-q" data-help="${key}" title="What is this?">?</span>`;

  const TWO_STEP_ARM_MS = 4000;

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

  const DEFAULT_COLLAPSED_SECTIONS = ['display', 'model', 'history', 'clouddebug'];
  function getSectionCollapsed(id) {
    const ui = Store.get(UI_SECTIONS_KEY) || {};
    return Object.prototype.hasOwnProperty.call(ui, id) ? !!ui[id] : DEFAULT_COLLAPSED_SECTIONS.indexOf(id) !== -1;
  }
  function setSectionCollapsed(id, collapsed) {
    const ui = Store.get(UI_SECTIONS_KEY) || {};
    ui[id] = !!collapsed;
    Store.set(UI_SECTIONS_KEY, ui);
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

      <div class="bustr-section">General</div>
      <div class="bustr-row"><label>Active on ${q('scope')}</label>
        <select id="bustr-set-scope">
          <option value="always">Anywhere (always)</option>
          <option value="jailOnly">Jail page only</option>
        </select>
      </div>
      <div class="bustr-row"><label>Refresh rate (sec) ${q('refresh')}</label><input type="number" id="bustr-set-refresh" min="15"></div>
      <div class="bustr-row"><label>Play style ${q('playstyle')}</label>
        <select id="bustr-set-playstyle">
          <option value="safety">Safety (recommended)</option>
          <option value="maxcount">Max count (aggressive)</option>
        </select>
      </div>
      <div class="bustr-row"><label>Text size ${q('textsize')}</label>
        <select id="bustr-set-textsize">
          <option value="normal">Normal</option>
          <option value="large">Large</option>
          <option value="xlarge">Extra large</option>
        </select>
      </div>
      <div class="bustr-row"><label>Theme ${q('theme')}</label>
        <select id="bustr-set-theme">
          <option value="auto">Auto (match Torn)</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
      <hr>

      <div class="bustr-section bustr-collapsible" data-sec="display"><span class="bustr-caret">▸</span>Jail display ${q('display')}</div>
      <div class="bustr-collapse-body" data-sec-body="display">
      <div class="bustr-row"><label>Show hardness number ${q('hardness')}</label><input type="checkbox" id="bustr-set-hardness"></div>
      <div class="bustr-row"><label>Quick bail (you click, no confirm) ${q('quickactions')}</label><input type="checkbox" id="bustr-set-quickbail"></div>
      <div class="bustr-row"><label>Easy bust (BUSTR fires it) ${q('easyactions')}</label><input type="checkbox" id="bustr-set-easybust"></div>
      <div class="bustr-row"><label>Easy bail (BUSTR fires it)</label><input type="checkbox" id="bustr-set-easybail"></div>
      <div class="bustr-row"><label>Show success % ${q('success')}</label><input type="checkbox" id="bustr-set-success"></div>
      <div class="bustr-row"><label>Success green at % <span class="bustr-default">(default ${SC_GREEN_AT})</span> ${q('sccolour')}</label><input type="number" id="bustr-set-scgreen" min="0" max="100"></div>
      <div class="bustr-row"><label>Success red below % <span class="bustr-default">(default ${SC_RED_BELOW})</span></label><input type="number" id="bustr-set-scred" min="0" max="100"></div>
      <div class="bustr-row"><label>Compact nav badge ${q('badge')}</label><input type="checkbox" id="bustr-set-badgesimple"></div>
      <div class="bustr-row"><label>Hold Jail for details (PDA) ${q('pdahold')}</label><input type="checkbox" id="bustr-set-pdahold"></div>
      </div>
      <hr>

      <div class="bustr-section bustr-collapsible" data-sec="model"><span class="bustr-caret">▸</span>Success % model ${q('model')}</div>
      <div class="bustr-collapse-body" data-sec-body="model">
      <div class="bustr-row"><label>Skill calibration (manual override) ${q('cal')}</label><input type="number" id="bustr-set-cal" min="0" max="2" step="0.05"></div>
      <div class="bustr-row"><label>Adaptive calibration (learn from my outcomes) ${q('selfcal')}</label><input type="checkbox" id="bustr-set-selfcal"></div>
      <div class="bustr-hint" id="bustr-set-selfcal-stats">No outcomes logged yet.</div>
      <button type="button" class="bustr-btn" id="bustr-set-selfcal-clear">Clear outcome log</button>
      <button type="button" class="bustr-btn" id="bustr-set-selfcal-check">Calibration check (to console)</button>
      <div class="bustr-row"><label>Use perk-based calibration ${q('perkcal')}</label><input type="checkbox" id="bustr-set-useperkcal"></div>
      <div class="bustr-hint" id="bustr-set-perk-impact"></div>
      <button type="button" class="bustr-btn" id="bustr-set-force-update">Force update level/perks now</button>
      </div>
      <hr>

      <div class="bustr-section bustr-collapsible" data-sec="history"><span class="bustr-caret">▸</span>Bust history ${q('history')}</div>
      <div class="bustr-collapse-body" data-sec-body="history">
      <div class="bustr-row bustr-hist-filter"><label>Show</label>
        <select id="bustr-hist-range">
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="all">All time</option>
        </select>
      </div>
      <div class="bustr-hint" id="bustr-hist-summary"></div>
      <div id="bustr-hist-list" class="bustr-hist-list"></div>
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
      <button type="button" class="bustr-btn" id="bustr-set-apikey-clear">Clear saved key</button>
      <hr>

      <div class="bustr-section bustr-collapsible" data-sec="clouddebug"><span class="bustr-caret">▸</span>Cloud sync &amp; debug ${q('cloudsync')}</div>
      <div class="bustr-collapse-body" data-sec-body="clouddebug">
      <div class="bustr-hint" id="bustr-cloud-status"></div>
      <div class="bustr-row"><label>Sync my bust history</label><input type="checkbox" id="bustr-set-cloudsync"></div>
      <div class="bustr-hint">Off by default. Backs up your bust history plus the perks, level, calibration and BUSTR settings behind your predictions, tied to your Torn ID (used to improve BUSTR's model). Never your API key. Works on desktop and on Torn PDA.</div>
      <button type="button" class="bustr-btn" id="bustr-set-cloud-delete">Delete my cloud data</button>
      <div id="bustr-debug-export-section">
      <div class="bustr-subsection">Debug export ${q('exportHelp')}</div>
      <button type="button" class="bustr-btn" id="bustr-set-export">Copy debug export</button>
      <textarea id="bustr-set-export-area" readonly style="display:none;width:100%;height:80px;margin-top:6px;background:#1a1a1a;color:#ddd;border:1px solid #444;border-radius:4px;font-size:10px;padding:4px;box-sizing:border-box;"></textarea>
      </div>
      </div>
      <hr>

      <div class="bustr-section">Reset</div>
      <div class="bustr-btn-row"><button type="button" class="bustr-btn" id="bustr-set-reset">Reset settings only</button>${q('reset')}</div>
      <div class="bustr-btn-row"><button type="button" class="bustr-btn bustr-danger" id="bustr-set-wipe">Erase all BUSTR data</button>${q('wipe')}</div>`;

    const help = document.createElement('div');
    help.id = 'bustr-help';

    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
    document.body.appendChild(help);

    panel.addEventListener('click', (e) => {
      const chip = e.target.closest ? e.target.closest('.bustr-q') : null;
      if (!chip) return;
      e.preventDefault();
      e.stopPropagation();
      showHelp(chip.dataset.help, chip);
    }, true);

    const byId = (id) => document.getElementById(id);

    populateSettingsPanelInputs(); // initial fill; also re-run every time the panel opens (see openSettings)

    panel.querySelectorAll('.bustr-collapsible').forEach((head) => {
      const id = head.getAttribute('data-sec');
      const body = panel.querySelector('[data-sec-body="' + id + '"]');
      if (!body) return;
      const apply = (collapsed) => {
        body.hidden = collapsed;
        head.classList.toggle('bustr-expanded', !collapsed);
      };
      apply(getSectionCollapsed(id));
      head.addEventListener('click', (e) => {
        if (e.target.closest && e.target.closest('.bustr-q')) return;
        const collapsed = !body.hidden; // currently expanded -> collapse, and vice versa
        apply(collapsed);
        setSectionCollapsed(id, collapsed);
        if (id === 'history' && !collapsed) renderBustHistory();
      });
    });

    const histRangeSel = byId('bustr-hist-range');
    if (histRangeSel) histRangeSel.addEventListener('change', renderBustHistory);

    byId('bustr-set-close').addEventListener('click', closeSettings);

    byId('bustr-set-refresh').addEventListener('change', (e) => { updateSetting('statsRefreshRate', Math.max(15, numOr(e.target, DEFAULT_REFRESH_SECONDS))); startRefreshLoops(); });
    byId('bustr-set-hardness').addEventListener('change', (e) => { updateSetting('showHardnessScore', e.target.checked); applySettings(); });
    byId('bustr-set-quickbail').addEventListener('change', (e) => { updateSetting('quickBail', e.target.checked); applyQuickActions(); });
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
    byId('bustr-set-textsize').addEventListener('change', (e) => {
      updateSetting('textSize', ['large', 'xlarge'].includes(e.target.value) ? e.target.value : 'normal');
      applyAppearance();
    });
    byId('bustr-set-theme').addEventListener('change', (e) => {
      updateSetting('theme', ['light', 'dark'].includes(e.target.value) ? e.target.value : 'auto');
      applyAppearance();
    });
    byId('bustr-set-badgesimple').addEventListener('change', (e) => {
      updateSetting('navBadgeDetail', e.target.checked ? 'simple' : 'full');
      applySettings();
    });
    byId('bustr-set-pdahold').addEventListener('change', (e) => {
      updateSetting('pdaHoldDetails', e.target.checked);
      applySettings();          // applyBadgeDetail: compact on PDA when on, full inline when off
      installPdaHoldPopover();  // when toggled on, make sure the popover + handlers are in place
    });
    byId('bustr-set-useperkcal').addEventListener('change', (e) => {
      updateSetting('usePerkCalibration', e.target.checked);
      skillCalibration = calibrationFromBustPerksRespectingSettings(getGlobalBustrState().bustPerks);
      applySettings();
      refreshSettingsStatus();
      refreshPerkImpactDisplay();
    });
    byId('bustr-set-force-update').addEventListener('click', (e) => forceProfileRefresh(e.target));

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

    byId('bustr-set-apikey-save').addEventListener('click', () => {
      const input = byId('bustr-set-apikey');
      const key = (input.value || '').trim();
      if (!key) return;
      setApiKey(key);
      input.value = '';
      fatalKeyError = false;
      apiKeyAccessType = null; // new key: re-probe its access level before nudging again
      apiKeyTypeLastTry = 0;   // ...right away, not after the 60s re-probe throttle
      setGlobalBustrState({ lastApiError: null });
      refreshApiKeyState();
      refreshSettingsStatus();
      loadController();
      forceProfileRefresh(); // re-read level/perks under the new key too
    });
    byId('bustr-set-apikey-clear').addEventListener('click', () => {
      deleteApiKey();
      fatalKeyError = false;
      apiKeyAccessType = null;
      apiKeyTypeLastTry = 0;
      setGlobalBustrState({ lastApiError: null });
      refreshApiKeyState();
      refreshSettingsStatus();
      loadController();
    });

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
    wireTwoStepButton(byId('bustr-set-cloud-delete'),
      'Delete my cloud data', 'Tap again to delete it',
      async () => {
        refreshCloudStatus('Deleting cloud copy...');
        try { await CloudSync.disableAndDelete(); } catch (err) { /* ignore */ }
        const cb = byId('bustr-set-cloudsync'); if (cb) cb.checked = false;
        refreshCloudStatus();
      });

    wireTwoStepButton(byId('bustr-set-reset'),
      'Reset settings only', 'Tap again to reset settings',
      () => { setUserSettings(defaultState().userSettings); window.location.reload(); });

    wireTwoStepButton(byId('bustr-set-wipe'),
      'Erase all BUSTR data', 'Tap again to erase everything',
      () => { deleteApiKey(); deleteGlobalBustrState(); window.location.reload(); });
    wireTwoStepButton(byId('bustr-set-selfcal-clear'),
      'Clear outcome log', 'Tap again to clear the log',
      () => {
        markOutcomeLogCleared(); // before the save, so the merge drops the cleared rows
        setGlobalBustrState({ outcomeLog: [], selfCalFit: null });
        refreshSettingsStatus();
      });
    const selfCalCheckBtn = byId('bustr-set-selfcal-check');
    if (selfCalCheckBtn) selfCalCheckBtn.addEventListener('click', () => {
      logSelfCalCheck(getGlobalBustrState().outcomeLog || []);
      const el = document.getElementById('bustr-set-selfcal-stats');
      if (el) el.textContent = 'Calibration check written to the browser console (open DevTools -> Console). ' + el.textContent;
    });

    refreshSettingsStatus();
  }

  function calibrationFromBustPerksRespectingSettings(bustPerks) {
    if (!getUserSettings().usePerkCalibration) return CAL_CEILING;
    if (unclassifiedBustPerks(bustPerks).some((p) => /[\d.]+\s*%/.test(p))) return CAL_CEILING;
    return calibrationFromPerks(bustPerks);
  }

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

    skillCalibration = calibrationFromBustPerksRespectingSettings(getGlobalBustrState().bustPerks);

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
      if (typeof getGlobalBustrState().playerLevel === 'number') {
        playerLevel = getGlobalBustrState().playerLevel;
      }
      sanitizeOutcomeLog(); // strip synthetic/test rows before they sync or reach the stats
      try { if (!getGlobalBustrState().selfCalFit) refitFromExistingOutcomes(); } catch (e) { /* advisory; refits on next bust / panel open */ }
      CloudSync.initFromLoad(); // pull+merge cloud history if sync is on (no-op otherwise)

      await initController();
      const onJail = window.location.pathname === '/jailview.php';
      if (SHOW_SETTINGS_PANEL) ensureSettingsUi(); // sidebar button / nav column on every page

      const inactive = applyActiveScope(onJail);

      startRefreshLoops();
      attachVisibilityResync();
      viewportResizeController();

      if (inactive) return;

      recalcLocally(); // paint the badge from cached log + decay - correct everywhere, no API call
      if (onJail) {
        try {
          await loadController();
        } catch (err) {
          console.error('[BUSTR] initial load failed (UI is already up)', err);
        }
        profileController(); // fire-and-forget: level + perks, once (daily-throttled inside)
      }

      hardnessScoreController();
      ensureBustObserver(onJail);
      if (onJail) attachBustClickListener(); // passive only - see COMPLIANCE NOTE at top of file
    } catch (err) {
      console.error('[BUSTR]', err);
    }
  })();
})();