/* gauzzaDocs landing page: pick the right installer, fill in the latest release, start the demo video
   and keep the outline in step with the page. The only network call is the GitHub releases API. */
(function () {
  'use strict';

  var RELEASES = 'https://github.com/mattgauzza/gauzzaDocs/releases/latest';
  var API = 'https://api.github.com/repos/mattgauzza/gauzzaDocs/releases/latest';
  var CACHE_KEY = 'gauzzadocs-latest-release';
  var CACHE_MS = 30 * 60 * 1000;

  var PLATFORMS = {
    windows: { asset: 'win', label: 'Download for Windows', note: '' },
    mac: { asset: 'mac', label: 'Download for macOS', note: 'For Macs with Apple Silicon' },
    linux: { asset: 'appimage', label: 'Download for Linux', note: 'AppImage' },
    mobile: { asset: null, label: 'See downloads on GitHub', note:'gauzzaDocs is a desktop app for Windows, macOS and Linux' },
    other: { asset: null, label: 'Download from GitHub', note: 'For Windows, macOS and Linux' }
  };

  function detectOS() {
    var ua = navigator.userAgent || '';
    var uaData = navigator.userAgentData;
    var platform = (uaData && uaData.platform) || navigator.platform || '';
    if ((uaData && uaData.mobile) || /android|iphone|ipad|ipod/i.test(ua)) return 'mobile';
    if (/mac/i.test(platform) || /macintosh|mac os x/i.test(ua)) {
      // iPadOS reports itself as a Mac but has a touch screen.
      return navigator.maxTouchPoints > 1 ? 'mobile' : 'mac';
    }
    if (/win/i.test(platform) || /windows/i.test(ua)) return 'windows';
    if (/linux|x11|cros/i.test(platform + ' ' + ua)) return 'linux';
    return 'other';
  }

  function each(selector, fn) {
    Array.prototype.forEach.call(document.querySelectorAll(selector), fn);
  }

  var os = detectOS();
  var plat = PLATFORMS[os];
  var version = '';

  var primary = document.getElementById('dl-primary');
  var label = document.getElementById('dl-label');
  var meta = document.getElementById('dl-meta');

  function renderMeta() {
    if (!meta) return;
    var parts = [];
    if (version) parts.push('Version ' + version);
    if (plat.note) parts.push(plat.note);
    meta.textContent = parts.length ? parts.join('. ') + '.' : '';
  }

  if (label) label.textContent = plat.label;
  renderMeta();

  // The detected platform is the big button, so take it out of the list of other downloads.
  each('.dl-alt [data-os="' + os + '"]', function (li) { li.hidden = true; });

  // Keep only the install note that matches this computer. Phones don't need one.
  var note = document.getElementById('install-note');
  if (note) {
    if (os === 'mobile') {
      note.hidden = true;
    } else if (os !== 'other') {
      each('#install-note [data-os]', function (p) {
        if (p.getAttribute('data-os') !== os) p.hidden = true;
      });
    }
  }

  // ---------- latest release ----------

  function isGitHubUrl(u) {
    return typeof u === 'string' && /^https:\/\/github\.com\//.test(u);
  }

  function pickAssets(list) {
    var exes = [];
    var dmgs = [];
    var found = {};
    (Array.isArray(list) ? list : []).forEach(function (a) {
      var name = String((a && a.name) || '');
      var url = a && a.browser_download_url;
      if (!isGitHubUrl(url) || /\.blockmap$/i.test(name)) return;
      if (/\.exe$/i.test(name)) exes.push(a);
      else if (/\.dmg$/i.test(name)) dmgs.push(a);
      else if (/\.appimage$/i.test(name)) found.appimage = found.appimage || url;
      else if (/\.deb$/i.test(name)) found.deb = found.deb || url;
    });
    var exe = exes.filter(function (a) { return /setup/i.test(a.name); })[0] || exes[0];
    var dmg = dmgs.filter(function (a) { return /arm64/i.test(a.name); })[0] || dmgs[0];
    if (exe) found.win = exe.browser_download_url;
    if (dmg) found.mac = dmg.browser_download_url;
    return found;
  }

  function apply(info) {
    if (!info || !info.assets) return;
    version = info.version || '';
    renderMeta();
    each('a[data-asset]', function (a) {
      var url = info.assets[a.getAttribute('data-asset')];
      if (url) a.href = url;
    });
    if (primary) primary.href = (plat.asset && info.assets[plat.asset]) || RELEASES;
  }

  function readCache() {
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var cached = JSON.parse(raw);
      if (cached && Date.now() - cached.time < CACHE_MS) return cached.info;
    } catch (e) {}
    return null;
  }

  function writeCache(info) {
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ time: Date.now(), info: info })); } catch (e) {}
  }

  function loadRelease() {
    var cached = readCache();
    if (cached) { apply(cached); return; }
    if (!window.fetch) return;

    var controller = window.AbortController ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 8000) : null;

    fetch(API, controller ? { signal: controller.signal } : undefined)
      .then(function (res) {
        if (!res.ok) throw new Error('GitHub answered ' + res.status);
        return res.json();
      })
      .then(function (release) {
        var tag = String(release.tag_name || release.name || '').trim();
        var info = {
          version: tag.replace(/^v(?=\d)/i, ''),
          assets: pickAssets(release.assets)
        };
        writeCache(info);
        apply(info);
      })
      .catch(function () {
        // Every link already points at the releases page, so there's nothing else to do.
      })
      .then(function () { if (timer) clearTimeout(timer); });
  }

  loadRelease();

  // ---------- demo video ----------

  var video = document.getElementById('demo');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (video && document.body.contains(video) && !reduceMotion) {
    video.autoplay = true;
    var playing = video.play();
    if (playing && playing.catch) playing.catch(function () {});
  }

  // ---------- outline ----------

  var links = Array.prototype.slice.call(document.querySelectorAll('.outline a[href^="#"]'));
  if ('IntersectionObserver' in window && links.length) {
    var byId = {};
    links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });

    var setActive = function (id) {
      links.forEach(function (a) { a.removeAttribute('aria-current'); });
      if (byId[id]) byId[id].setAttribute('aria-current', 'true');
    };

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) setActive(entry.target.id);
      });
    }, { rootMargin: '-30% 0px -65% 0px' });

    Object.keys(byId).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) observer.observe(el);
    });
  }
})();
