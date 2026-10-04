/* Visit ping (site owner's request, 2026-10-04): one ntfy.sh notification per browser session with page, referrer,
   browser/OS, language, timezone, screen, plus the visitor's IP and approximate (city-level) location from geojs.io. No
   cookies or fingerprinting; the footer says so. A text/plain POST is a CORS "simple" request, so no preflight. If the
   location lookup fails or is blocked, the ping still goes out without it. */
(function () {
  try {
    if (navigator.webdriver || /bot|crawl|spider|preview|lighthouse/i.test(navigator.userAgent)) return;
    var key = 'trl_ping_' + location.pathname;
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch (e) {}
    var ua = navigator.userAgent, os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
      : /Mac OS/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'other';
    var br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
      : /Safari\//.test(ua) ? 'Safari' : 'other';
    var r = document.referrer, ref = !r ? 'direct (typed, bookmark or app link)'
      : r.indexOf(location.origin) === 0 ? 'internal (from ' + (r.slice(location.origin.length) || '/') + ')' : r;
    var tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
    var msg = 'Page: ' + location.pathname + '\nFrom: ' + ref + '\nDevice: ' + br + ' on ' + os +
      (/Mobi|Android|iPhone/.test(ua) ? ' (mobile)' : '') + '\nScreen: ' + screen.width + 'x' + screen.height +
      '\nLanguage: ' + (navigator.language || '?') + '\nTimezone: ' + (tz || '?');
    function send(extra, where) {
      fetch('https://ntfy.sh/terminalrl-visits-3a4d2b861d006748?title=' + encodeURIComponent('Visit: ' + location.pathname +
        (where ? ' from ' + where : '')) + '&tags=eyes', { method: 'POST', body: msg + extra, keepalive: true, mode: 'no-cors' })
        .catch(function () {});
    }
    var done = false, timer = setTimeout(function () { if (!done) { done = true; send('\nLocation: (lookup timed out)', ''); } }, 4000);
    fetch('https://get.geojs.io/v1/ip/geo.json').then(function (r) { return r.json(); }).then(function (g) {
      if (done) return; done = true; clearTimeout(timer);
      var where = [g.city, g.region, g.country].filter(Boolean).join(', ');
      send('\nLocation: ' + (where || '?') + '\nIP: ' + (g.ip || '?') + '\nNetwork: ' + (g.organization_name || g.organization || '?'), where);
    }).catch(function () { if (!done) { done = true; clearTimeout(timer); send('\nLocation: (lookup failed)', ''); } });
  } catch (e) {}
})();
