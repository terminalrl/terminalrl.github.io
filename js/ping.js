/* Visit ping (site owner's request, 2026-10-04): one ntfy.sh notification per browser session with coarse, non-identifying
   details only (page, referrer, browser/OS, language, timezone, screen). No IP lookup, cookies or fingerprinting; the
   footer says so. A text/plain POST is a CORS "simple" request, so no preflight; keepalive lets it finish on navigation. */
(function () {
  try {
    if (navigator.webdriver || /bot|crawl|spider|preview|lighthouse/i.test(navigator.userAgent)) return;
    var key = 'trl_ping_' + location.pathname;
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch (e) {}
    var ua = navigator.userAgent, os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
      : /Mac OS/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'other';
    var br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
      : /Safari\//.test(ua) ? 'Safari' : 'other';
    var ref = document.referrer && document.referrer.indexOf(location.origin) !== 0 ? document.referrer : '(direct/internal)';
    var tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
    var msg = 'Page: ' + location.pathname + '\nFrom: ' + ref + '\nDevice: ' + br + ' on ' + os +
      (/Mobi|Android|iPhone/.test(ua) ? ' (mobile)' : '') + '\nScreen: ' + screen.width + 'x' + screen.height +
      '\nLanguage: ' + (navigator.language || '?') + '\nTimezone: ' + (tz || '?');
    fetch('https://ntfy.sh/terminalrl-visits-3a4d2b861d006748?title=' + encodeURIComponent('Visit: ' + location.pathname) +
      '&tags=eyes', { method: 'POST', body: msg, keepalive: true, mode: 'no-cors' }).catch(function () {});
  } catch (e) {}
})();
