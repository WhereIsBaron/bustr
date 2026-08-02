// ==UserScript==
// @name         BUSTR PDA Probe
// @namespace    http://torn.city.com.dot.com.com
// @version      1.0.0
// @description  Throwaway diagnostic. Prints why BUSTR is not rendering, on screen, because PDA has no reachable console.
// @match        https://www.torn.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

// Throwaway. Install alongside BUSTR, read the green box, then delete both this
// and the box. Reports environment facts and, crucially, captures console.error -
// BUSTR's bootstrap catches its own exceptions and routes them there, so a plain
// window.onerror handler would never see the thing that is actually killing it.
(function () {
  'use strict';

  var PDA_KEY = '###PDA-APIKEY###';
  var msgs = [];
  var box = null;

  // Hook console.error FIRST, before BUSTR's bootstrap can run and swallow.
  var origError = console.error;
  console.error = function () {
    try {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        parts.push(a && a.stack ? String(a.stack).split('\n').slice(0, 3).join(' | ') : String(a));
      }
      msgs.push('console.error: ' + parts.join(' '));
      render();
    } catch (e) { /* never let the probe break the page */ }
    return origError.apply(console, arguments);
  };

  window.addEventListener('error', function (e) {
    msgs.push('window.error: ' + (e.message || '?') + ' @' + String(e.filename || '?').split('/').pop() + ':' + e.lineno);
    render();
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    msgs.push('unhandled promise: ' + ((r && r.message) ? r.message : String(r)));
    render();
  });

  function q(sel) { try { return document.querySelector(sel) ? 'found' : 'MISSING'; } catch (e) { return 'ERR'; } }

  function report() {
    var keySub = /^###.+###$/.test(PDA_KEY);
    return [
      'BUSTR PDA PROBE  (tap to dismiss)',
      'readyState  : ' + document.readyState,
      'path        : ' + location.pathname,
      'visualVwprt : ' + (window.visualViewport ? Math.round(window.visualViewport.width) + 'px' : '*** UNDEFINED ***'),
      'GM_setValue : ' + (typeof GM_setValue),
      'PDA key     : ' + (keySub ? 'NOT substituted (isPDA=false)' : 'substituted, length ' + PDA_KEY.length),
      'localStorage: ' + (function () { try { localStorage.setItem('_p', '1'); localStorage.removeItem('_p'); return 'writable'; } catch (e) { return '*** BLOCKED: ' + e.name + ' ***'; } })(),
      'bustr state : ' + (function () { try { return localStorage.getItem('globalBustrState') ? 'present' : 'absent'; } catch (e) { return 'unreadable'; } })(),
      '#nav-jail   : ' + q('#nav-jail'),
      '#nav-jail a : ' + q('#nav-jail a'),
      'jail rows   : ' + (function () { try { return document.querySelectorAll('ul.user-info-list-wrap > li').length; } catch (e) { return 'ERR'; } })(),
      '--- did BUSTR render anything? ---',
      'panel       : ' + (document.getElementById('bustr-settings-panel') ? 'YES' : 'no'),
      'nav column  : ' + (document.getElementById('bustr-sidebar-btn') ? 'YES' : 'no'),
      'badge       : ' + q('.bustr-mobile-badge'),
      'stylesheet  : ' + (function () { var s = document.querySelectorAll('style'); for (var i = 0; i < s.length; i++) if (s[i].textContent.indexOf('bustr-') > -1) return 'YES'; return 'no'; })(),
      'hardness col: ' + q('.bustr-hardness-score')
    ].join('\n');
  }

  function render() {
    try {
      if (!box) {
        box = document.createElement('div');
        box.style.cssText = 'position:fixed;left:3px;right:3px;bottom:3px;z-index:2147483647;'
          + 'background:#0b0b0b;color:#5f5;font:11px/1.35 monospace;padding:7px;'
          + 'border:1px solid #5f5;border-radius:5px;max-height:60vh;overflow:auto;white-space:pre-wrap';
        box.addEventListener('click', function () { box.style.display = 'none'; });
        (document.body || document.documentElement).appendChild(box);
      }
      box.textContent = report() + '\n\n--- captured errors ---\n'
        + (msgs.length ? msgs.join('\n') : '(none captured - BUSTR is not throwing)');
    } catch (e) { /* ignore */ }
  }

  // Three passes: after BUSTR's document-end work, after its load-gated bootstrap,
  // and once more after its first refresh tick.
  setTimeout(render, 1200);
  setTimeout(render, 4000);
  setTimeout(render, 9000);
})();
