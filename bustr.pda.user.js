// ==UserScript==
// @name         BUSTR: Jail Bust Assistant + PDA (Baron)
// @namespace    http://torn.city.com.dot.com.com
// @version      2.12.2
// @description  Shows your success odds on every jailed target, and how many busts you can make before failure gets likely
// @author       Adobi & Ironhydedragon
// @author       The_Baron [1467784] - added bust success % prediction, penalty weighting fitted to real outcomes, self-calibration from logged outcomes, a full settings panel, and reliability/storage hardening
// @match        https://www.torn.com/*
// @license      MIT
// @run-at       document-end
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// ==/UserScript==


(() => {
  'use strict';


  const DEBUG = false; // set true while debugging to re-enable console logs
  const SCRIPT_VERSION = '2.12.2'; // keep in sync with the @version header above - stamped into diagnostic exports

  const PENALTY_PER_BUST = 128;
  const PENALTY_WINDOW_HOURS = 72;
  const PENALTY_DECAY_C = 0.1; // per hour -> half the penalty gone at t = 10h
  const RECENT_HISTORY_WINDOW_DAYS = 30;

  const SHOW_SUCCESS_CHANCE = true;
  const SHOW_SETTINGS_PANEL = true;        // floating settings panel on the jail page
  const PLAYER_INFO_TTL_MS = 24 * 60 * 60 * 1000; // re-read level/perks from the API at most daily
  const PLAYER_LEVEL_FALLBACK = 100;       // used only until the API fills it in
  const SKILL_CALIBRATION_OVERRIDE = null; // set a number (e.g. 0.9) to force it; null = auto from perks
  const FULL_BUST_SKILL_BONUS = 115;       // full stack: faction 50% + education 65%
  const CAL_CEILING = 1.0;                 // clamp ceiling for the auto calibration
  const CAL_FLOOR = 0.4;                   // clamp floor
  const CAL_NO_PERKS = 0.85;               // fallback when the API returns no bust perks at all
  const SUCCESS_A = 266.6;           // guide constant (level/perk independent)
  const SUCCESS_B = 0.28;            // chart-derived slope (per minute)
  const PENALTY_PCT_ANCHOR = 1037;   // P0% * level (level-61 tester showed ~17% fresh)
  const SC_GREEN_AT = 66;
  const SC_RED_BELOW = 33;

  const PENALTY_WEIGHT = 2.0;

  const PRED_SHRINK_K = 0.65;    // fraction of the raw spread that survives
  const PRED_SHRINK_CENTER = 45; // %, the pivot predictions are pulled toward

  const OUTCOME_LOG_MAX = 500;           // cap on stored attempts (oldest dropped first) - this, not
  const SELF_CAL_MIN_SAMPLES = 100;     // don't trust a fit smaller than this (was 15: far too few, it overfit)
  const SELF_CAL_FLOOR = 0.6;           // search/clamp range for the fitted calibration (was 0.3: allowed a pathological collapse)
  const SELF_CAL_CEILING = 1.4;         // stays near the physically plausible perk range
  const SELF_CAL_STEP = 0.02;           // grid-search resolution
  const PENDING_ATTEMPT_TIMEOUT_MS = 20 * 1000; // discard a click if no result follows in time

  const API_KEY_SELECTIONS = 'basic,log,perks';
  const API_KEY_CREATE_URL =
    'https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=BUSTR&user=' + API_KEY_SELECTIONS;

  const OUTCOME_MODEL_VERSION = 2;

  const PLAYSTYLE_MAXCOUNT_BUST_OFFSET = -3;    // redLimit shifts 3 lower (tolerates a deeper deficit before red)
  const PLAYSTYLE_MAXCOUNT_SUCCESS_OFFSET = -20; // success colour bands both shift 20pts lower

  const DEFAULT_REFRESH_SECONDS = 30;        // tick cadence (local recompute runs every tick)
  const JAIL_MIN_FETCH_GAP_MS = 35 * 1000;   // min spacing between API fetches on the jail page (dodges Torn's ~30s cache)
  const IDLE_REFETCH_MS = 30 * 60 * 1000;    // API refetch cadence when NOT on the jail page
  const FETCH_TIMEOUT_MS = 10000;

  const STATE_KEY = 'globalBustrState';
  const API_KEY_NAME = 'bustrApiKey';
  const LEGACY_API_KEY_NAME = 'bustrApiKey'; // same name, but in localStorage pre-v2

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
        usePerkCalibration: false,     // off by default (baseline 1.0); opt in to apply the perk-derived estimate
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
      outcomeLog: [],                     // logged bust attempts: {h, pred, pen, success, jailed, ts, m}, capped at OUTCOME_LOG_MAX
      selfCalibrationValue: null,         // last fitted calibration from outcomeLog, or null if not enough samples
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

  function getPenaltySkillCalibration() {
    const override = getUserSettings().skillCalibrationOverride;
    if (typeof override === 'number' && override > 0) return override;
    return skillCalibration;
  }

  function successChanceEnabled() {
    return getUserSettings().showSuccessChance !== false;
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
    const effectivePenalty = PENALTY_WEIGHT * penaltyPct;
    const raw = SUCCESS_A - (SUCCESS_B * 60 / skill) * hardness - effectivePenalty;
    const clamped = Math.max(1, Math.min(100, raw));
    const shrunk = PRED_SHRINK_CENTER + PRED_SHRINK_K * (clamped - PRED_SHRINK_CENTER);
    return Math.max(1, Math.min(100, shrunk));
  }

  function calcSuccessChance(hardness, penaltyPct) {
    return Math.round(calcSuccessChanceRaw(hardness, penaltyPct, getSkillCalibration()));
  }


  function fittableOutcomes(outcomeLog) {
    if (!Array.isArray(outcomeLog)) return [];
    return outcomeLog.filter((o) => o && o.m === OUTCOME_MODEL_VERSION);
  }

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
      modelConstants: {
        SUCCESS_A, SUCCESS_B,
        PENALTY_PER_BUST, PENALTY_WINDOW_HOURS, PENALTY_DECAY_C, PENALTY_PCT_ANCHOR, RECENT_HISTORY_WINDOW_DAYS,
        CAL_CEILING, CAL_FLOOR, CAL_NO_PERKS, FULL_BUST_SKILL_BONUS,
        PENALTY_WEIGHT, PRED_SHRINK_K, PRED_SHRINK_CENTER, OUTCOME_MODEL_VERSION,
        SELF_CAL_MIN_SAMPLES, SELF_CAL_FLOOR, SELF_CAL_CEILING, SELF_CAL_STEP, OUTCOME_LOG_MAX,
      },
    };
  }

  let pendingAttempt = null;

  function recordPendingAttempt(hardness, predictedChance) {
    pendingAttempt = {
      hardness,
      predictedChance,
      penaltyPct: calcPenaltyPct(getTimestampsArray()),
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
      ts: Date.now(),
      m: OUTCOME_MODEL_VERSION, // marks this pen as recorded under the corrected penalty model
    });
    while (outcomeLog.length > OUTCOME_LOG_MAX) outcomeLog.shift();

    const fittedCalibration = computeSelfCalibration(outcomeLog);
    setGlobalBustrState({ outcomeLog, selfCalibrationValue: fittedCalibration });

    const outcomeLabel = success ? 'success' : (jailed ? 'failure (jailed)' : 'failure (clean)');
    console.log(`[BUSTR] Self-calibration: logged ${outcomeLabel} (hardness ${attempt.hardness}, predicted ${attempt.predictedChance}%) - ${outcomeLog.length} sample(s) recorded.`);
  }


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
      setLastFetchTimestampMs();
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

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
  function clearSortOrder(playerEl) {
    playerEl.style.order = '';
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

          setPenaltyScore(getPenaltyScore() + PENALTY_PER_BUST);
          setAvailableBusts(calcAvailableBusts(getPenaltyScore(), getPenaltyThreshold()));
          renderBustrStats({ availableBusts: getAvailableBusts(), penaltyScore: getPenaltyScore() });
          renderBustrColorClass(getAvailableBusts());

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

      recordPendingAttempt(hardness, predicted);
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
  background: #333; color: #ddd; border: 1px solid #111; border-radius: 8px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.7); padding: 10px 12px;
  font-size: 11px; line-height: 1.45;
}
#bustr-help.bustr-open {display: block;}
#bustr-help h4 {margin: 0 0 5px; font-size: 11px; color: #8ca05a; text-transform: uppercase;
  letter-spacing: 0.03em; display: flex; justify-content: space-between; align-items: center;}
#bustr-help h4 .bustr-help-close {cursor: pointer; color: #999; font-size: 15px; line-height: 1;}
#bustr-help h4 .bustr-help-close:hover {color: #fff;}
/* No room beside the panel on a phone or PDA, so dock it to the bottom instead. */
@media (max-width: 780px) {
  #bustr-help {
    top: auto; bottom: 8px; left: 50%; transform: translateX(-50%);
    width: 280px; max-height: 38vh;
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


      if (getMyViewportWidthType() === 'Desktop') {
        await renderBustrDesktopView();
        setRenderedView('Desktop');
      } else {
        await renderBustrMobileView();
        setRenderedView('Mobile');
      }

      if (getApiKey() !== undefined) return;

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

    const onJail = window.location.pathname === '/jailview.php';
    if (SHOW_SETTINGS_PANEL) ensureSettingsUi(); // keep the trigger reachable regardless of scope

    const jailOnly = getUserSettings().activeScope === 'jailOnly';
    const inactive = jailOnly && !onJail;
    document.body.classList.toggle('bustr-inactive', inactive);
    if (inactive) {
      clearBustrPageColoring(); // don't show stale colour/badge while "inactive" off the jail page
      return;
    }

    recalcPenaltyScoreOnly();

    if (onJail) renderJailRows();
    if (fatalKeyError || isLoading) return;
    const since = Date.now() - getLastFetchTimestampMs();
    if (onJail) {
      if (since >= JAIL_MIN_FETCH_GAP_MS) loadController();
    } else if (since >= IDLE_REFETCH_MS) {
      loadController();
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
          await loadController();
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

  function refreshSuccessChances() {
    if (window.location.pathname !== '/jailview.php') return;
    renderHardnessJailView();
    applyJailVisibility();
    renderJailRows();
  }


  function updateSetting(key, value) {
    setUserSettings({ ...getUserSettings(), [key]: value });
  }
  function updateLimit(key, value) {
    const us = getUserSettings();
    setUserSettings({ ...us, reminderLimits: { ...us.reminderLimits, [key]: value } });
  }
  const clampPct = (v) => Math.max(0, Math.min(100, v));
  const numOr = (el, fallback) => { const v = parseFloat(el.value); return isNaN(v) ? fallback : v; };

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

  function refitFromExistingOutcomes() {
    const state = getGlobalBustrState();
    const log = state.outcomeLog || [];
    if (log.length === 0) return;
    const fittedCalibration = computeSelfCalibration(log);
    if (fittedCalibration !== state.selfCalibrationValue) {
      setGlobalBustrState({ selfCalibrationValue: fittedCalibration });
    }
  }

  function refreshApiKeyState() {
    const el = document.getElementById('bustr-set-apikey-state');
    if (!el) return;
    const k = describeApiKey();
    const saved = k.source === 'user override';
    let msg;
    if (saved) msg = 'API key is saved.';
    else if (k.source === 'PDA injected') msg = 'Using the key supplied by the PDA app. Paste one here to override it.';
    else if (k.pdaTokenSubstituted) msg = 'The PDA app supplied an EMPTY key, so BUSTR has no key to use. Create one below.';
    else msg = 'No API key set. Create one below.';
    if (k.source !== 'none' && !k.looksValid) {
      msg += ` Warning: it is ${k.resolvedLength} characters, but a Torn key is ${k.expectedLength}. Torn will reject it as "Incorrect key". Re-paste it carefully.`;
    }
    el.textContent = msg;

    const entry = document.getElementById('bustr-set-apikey-entry');
    const clearBtn = document.getElementById('bustr-set-apikey-clear');
    if (entry) entry.style.display = saved ? 'none' : '';
    if (clearBtn) clearBtn.style.display = saved ? '' : 'none';
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
      const log = getGlobalBustrState().outcomeLog || [];
      const stats = selfCalibrationStats(log);
      if (!stats) {
        statsEl.textContent = 'No outcomes logged yet. Logging starts the moment this is enabled.';
      } else {
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
    refreshPerkImpactDisplay();
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
        recalcPenaltyScoreOnly();
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
    budget: ['Bust budget', 'How many more busts BUSTR thinks you can make before failure gets likely. This is the number on the Jail nav badge. It is completely separate from the per-target success %: nothing in this section ever changes a prisoner’s odds, only the budget count and the colours.'],
    green: ['Green at', 'The nav badge and page tint turn green when your available-bust count is this number or higher. Default is 3.'],
    red: ['Red at / below', 'They turn red at this number or below. Default is 0, so red means the budget is spent. Anything between the red and green numbers shows orange.'],
    threshold: ['Custom threshold', 'Your penalty ceiling: how much bust penalty you can carry before BUSTR calls the budget spent. Leave it at 0 and BUSTR works this out from your own bust history, by finding the longest run of busts you have actually sustained. Set a number only if you want to override that estimate.'],
    refresh: ['Refresh rate', 'How often the on-screen numbers redraw, in seconds. This does NOT control how often BUSTR calls the Torn API. Those calls are throttled separately, to at most once every 35 seconds on the jail page and once every 30 minutes elsewhere, so lowering this costs you nothing in API usage. Minimum 15.'],
    scope: ['Active on', 'Anywhere: the nav badge and colours appear on every Torn page. Jail page only: hides them and pauses background checks everywhere except the jail page. Use it if the badge distracts you while doing other things.'],
    display: ['Jail list display', 'These change only what the jail list shows and how it is sorted. The hardness score and the odds underneath are always calculated the same way regardless.'],
    hardness: ['Hardness number', 'Shows each prisoner’s hardness score, which is their level multiplied by their remaining jail time plus three hours. Higher means harder to bust.'],
    sort: ['Sort easiest-first', 'Reorders the jail list so the easiest targets sit at the top. Torn’s own order is by time remaining instead.'],
    success: ['Show success %', 'Shows your estimated chance of busting each prisoner, from their hardness and your current penalty.'],
    sccolour: ['Success % colours', 'Colour thresholds for the per-target percentage: green at or above the first number, red below the second, orange in between. Display only, they never change the percentage itself.'],
    model: ['Success % model', 'These change the actual predicted number. When more than one applies the priority is: manual override wins, then self-calibration once it has enough data, then the perk baseline.'],
    cal: ['Skill calibration', 'Scales how skilled BUSTR assumes you are at busting. 1.0 means the full perk stack the model was built on (faction Bust Skill plus all LAW courses). Lower it if you have fewer perks, roughly 0.70 for faction perks only. Leave blank for automatic. Worth knowing: this only scales the target-difficulty half of the model, so it cannot compensate for penalty, and forcing it very low to "fix" failures will distort the odds on easy targets.'],
    selfcal: ['Self-calibration', 'Learns your real success curve from your own results. It records which prisoner you clicked Bust on and whether it worked, entirely on your own machine. It stays inactive until 100 usable samples exist, because fitting on fewer was measured to make predictions worse rather than better. Only used when the manual override above is blank.'],
    perkcal: ['Perk-based calibration', 'Off means the plain baseline of 1.0. On means BUSTR estimates your calibration from the bust perks it detects on your account. Torn does not publish how perks map to bust skill, so this is a grounded estimate rather than a measurement.'],
    playstyle: ['Play style', 'Changes when the colours flip, not the numbers underneath. Safety uses your thresholds as set. Max count shifts the bands so you spend longer in the orange zone, which raises daily bust volume at the cost of more failures and more jail time. Nothing is ever busted for you either way.'],
    exportHelp: ['Debug export', 'Copies a snapshot for the script maintainer to debug with: your level, settings, detected perks, current penalty, calibration, and logged bust history. Your API key is never included, and this script never reads your username, ID, or faction.'],
    apikey: ['API key', 'BUSTR needs three things from Torn: your level, your bust perks, and your own bust history. "Create a key for BUSTR" opens Torn’s API page with exactly those (' + API_KEY_SELECTIONS + ') pre-ticked and nothing else, so the key cannot touch your money, mail, or faction. Generate it there, paste it here. The key is stored on this device only and sent nowhere except Torn’s own API. On PDA the app supplies its own key; saving one here overrides it.'],
    reset: ['Reset settings', 'Puts every setting in this panel back to its default. Your saved API key and your logged bust history are both kept.'],
    wipe: ['Clear all data', 'Removes everything BUSTR has stored on this device: settings, saved API key, and your entire logged bust history. This cannot be undone.'],
  };

  function hideHelp() {
    const card = document.getElementById('bustr-help');
    if (card) card.classList.remove('bustr-open');
    document.querySelectorAll('#bustr-settings-panel .bustr-q.bustr-q-on')
      .forEach((el) => el.classList.remove('bustr-q-on'));
  }

  function showHelp(key, chipEl) {
    const card = document.getElementById('bustr-help');
    const entry = HELP[key];
    if (!card || !entry) return;
    const alreadyOpen = card.classList.contains('bustr-open') && chipEl.classList.contains('bustr-q-on');
    hideHelp();
    if (alreadyOpen) return;
    card.innerHTML = `<h4>${entry[0]}<span class="bustr-help-close" id="bustr-help-close">×</span></h4><div>${entry[1]}</div>`;
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
        <input type="password" id="bustr-set-apikey" placeholder="Paste your API key" autocomplete="off" style="width:100%;box-sizing:border-box;margin:4px 0;">
        <button type="button" class="bustr-btn" id="bustr-set-apikey-save">Save key</button>
      </div>
      <button type="button" class="bustr-btn" id="bustr-set-apikey-clear">Clear saved key</button>
      <hr>

      <div class="bustr-section">Debug export ${q('exportHelp')}</div>
      <button type="button" class="bustr-btn" id="bustr-set-export">Copy debug export</button>
      <textarea id="bustr-set-export-area" readonly style="display:none;width:100%;height:80px;margin-top:6px;background:#1a1a1a;color:#ddd;border:1px solid #444;border-radius:4px;font-size:10px;padding:4px;box-sizing:border-box;"></textarea>
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

    byId('bustr-set-close').addEventListener('click', closeSettings);

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
      setGlobalBustrState({ lastApiError: null });
      refreshApiKeyState();
      refreshSettingsStatus();
      loadController();
      forceProfileRefresh(); // re-read level/perks under the new key too
    });
    byId('bustr-set-apikey-clear').addEventListener('click', () => {
      deleteApiKey();
      fatalKeyError = false;
      setGlobalBustrState({ lastApiError: null });
      refreshApiKeyState();
      refreshSettingsStatus();
      loadController();
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
        setGlobalBustrState({ outcomeLog: [], selfCalibrationValue: null });
        refreshSettingsStatus();
      });

    refreshSettingsStatus();
  }

  function calibrationFromBustPerksRespectingSettings(bustPerks) {
    if (!getUserSettings().usePerkCalibration) return CAL_CEILING;
    return calibrationFromPerks(bustPerks);
  }

  async function fetchAndApplyProfile() {
    const data = await fetchProfileData(getApiKey());
    if (data.level) setPlayerLevel(data.level);

    const bustPerks = extractBustPerks(data);
    skillCalibration = calibrationFromBustPerksRespectingSettings(bustPerks);
    setGlobalBustrState({ bustPerks, lastProfileFetchMs: Date.now() });
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

      await initController();
      if (SHOW_SETTINGS_PANEL) ensureSettingsUi(); // sidebar button / nav column on every page

      recalcLocally();
      try {
        await loadController();
      } catch (err) {
        console.error('[BUSTR] initial load failed (UI is already up)', err);
      }
      profileController(); // fire-and-forget: level + perks, once

      hardnessScoreController();
      successfulBustUpdateController();
      attachBustClickListener(); // passive only - see COMPLIANCE NOTE at top of file
      startRefreshLoops();
      attachVisibilityResync();
      viewportResizeController();
    } catch (err) {
      console.error('[BUSTR]', err);
    }
  })();
})();