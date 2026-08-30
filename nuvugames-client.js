/**
 * NuvuGames backend client -- one file, no build step, no dependencies.
 *
 * Include it before the game code:
 *   <script src="nuvugames-client.js"></script>
 *   <script>NuvuBackend.configure({ baseUrl: 'https://<game>-backend.up.railway.app' });</script>
 *
 * Everything degrades to offline: if the backend is unreachable the game keeps
 * running on localStorage exactly as it does today. Nothing here is allowed to
 * throw into the game loop.
 */
(function (global) {
  'use strict';

  var cfg = { baseUrl: '', debug: false, googleWebClientId: '', appleServiceId: '', appleRedirectUri: '' };
  var token = null;
  var playerId = null;
  var identity = null; // 'apple' | 'google' | null
  var sessionPromise = null;

  var LS_DEVICE = 'nuvu.device_id';
  var LS_TOKEN = 'nuvu.token';
  var LS_PLAYER = 'nuvu.player_id';
  var LS_IDENTITY = 'nuvu.identity';

  function log() {
    if (cfg.debug) console.log.apply(console, ['[nuvu]'].concat([].slice.call(arguments)));
  }

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  function deviceId() {
    var id = lsGet(LS_DEVICE);
    if (!id) {
      id = (global.crypto && global.crypto.randomUUID)
        ? global.crypto.randomUUID()
        : 'dev-' + Date.now() + '-' + Math.random().toString(36).slice(2, 12);
      lsSet(LS_DEVICE, id);
    }
    return id;
  }

  function api(path, opts) {
    opts = opts || {};
    if (!cfg.baseUrl) return Promise.reject(new Error('backend_not_configured'));
    var headers = { 'Content-Type': 'application/json' };
    if (opts.auth !== false && token) headers.Authorization = 'Bearer ' + token;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, opts.timeout || 8000) : null;
    return fetch(cfg.baseUrl + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) {
          var err = new Error(json.error || ('http_' + res.status));
          err.status = res.status;
          err.payload = json;
          throw err;
        }
        return json;
      });
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function ensureSession() {
    if (token && playerId) return Promise.resolve({ token: token, player_id: playerId });
    if (sessionPromise) return sessionPromise;

    token = lsGet(LS_TOKEN);
    playerId = lsGet(LS_PLAYER);
    identity = lsGet(LS_IDENTITY) || null;

    // A signed-in player already has a real token; keep using it (the game
    // routes retry on 401 and a re-auth needs a fresh provider token anyway).
    if (token && playerId && identity) {
      sessionPromise = Promise.resolve({ token: token, player_id: playerId });
      return sessionPromise;
    }

    sessionPromise = api('/v1/session', {
      method: 'POST',
      auth: false,
      body: { device_id: deviceId() }
    }).then(function (res) {
      token = res.token;
      playerId = res.player_id;
      lsSet(LS_TOKEN, token);
      lsSet(LS_PLAYER, playerId);
      log('session ok', playerId);
      return res;
    }).catch(function (err) {
      sessionPromise = null;
      log('session failed', err.message);
      throw err;
    });
    return sessionPromise;
  }

  // --- identity sign-in (Apple / Google) -----------------------------------
  // Optional. Play works fully signed-out; signing in only makes the save
  // survive a reinstall or move to another device.
  function isNative() {
    return !!(global.Capacitor && typeof global.Capacitor.isNativePlatform === 'function' &&
      global.Capacitor.isNativePlatform());
  }
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[data-nuvu-ext="' + src + '"]')) return resolve();
      var s = document.createElement('script');
      s.src = src; s.async = true; s.setAttribute('data-nuvu-ext', src);
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('script_load_failed')); };
      document.head.appendChild(s);
    });
  }

  // Native path stays dormant until a game ships a Capacitor wrapper with the
  // plugins installed; these calls simply reject on web so we use the web flow.
  function nativeGoogleIdToken() {
    if (!isNative() || !global.Capacitor.Plugins || !global.Capacitor.Plugins.GoogleSignIn) {
      return Promise.reject(new Error('native_google_unavailable'));
    }
    // @capawesome/capacitor-google-sign-in : serverClientId = the WEB client id,
    // so Google returns an idToken the backend can verify against GOOGLE_WEB_CLIENT_ID.
    return global.Capacitor.Plugins.GoogleSignIn
      .signIn({ scopes: ['email'], serverClientId: cfg.googleWebClientId, forceRefreshToken: true })
      .then(function (r) { return (r && (r.idToken || (r.authentication && r.authentication.idToken))) || null; });
  }
  function nativeAppleIdToken() {
    if (!isNative() || !global.Capacitor.Plugins || !global.Capacitor.Plugins.SignInWithApple) {
      return Promise.reject(new Error('native_apple_unavailable'));
    }
    return global.Capacitor.Plugins.SignInWithApple
      .authorize({ requestedScopes: ['email'] })
      .then(function (r) { return (r && r.response && r.response.identityToken) || null; });
  }

  function webGoogleIdToken() {
    if (!cfg.googleWebClientId) return Promise.reject(new Error('google_web_client_id_missing'));
    return loadScript('https://accounts.google.com/gsi/client').then(function () {
      return new Promise(function (resolve, reject) {
        var done = false;
        try {
          global.google.accounts.id.initialize({
            client_id: cfg.googleWebClientId,
            auto_select: false,
            callback: function (resp) {
              done = true;
              resp && resp.credential ? resolve(resp.credential) : reject(new Error('no_credential'));
            }
          });
          global.google.accounts.id.prompt(function (notif) {
            if (!done && (notif.isNotDisplayed() || notif.isSkippedMoment() || notif.isDismissedMoment())) {
              reject(new Error('google_prompt_unavailable'));
            }
          });
        } catch (e) { reject(e); }
      });
    });
  }
  function webAppleIdToken() {
    if (!cfg.appleServiceId || !cfg.appleRedirectUri) return Promise.reject(new Error('apple_web_not_configured'));
    return loadScript('https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js').then(function () {
      global.AppleID.auth.init({
        clientId: cfg.appleServiceId, scope: 'email', redirectURI: cfg.appleRedirectUri,
        usePopup: true
      });
      return global.AppleID.auth.signIn().then(function (r) {
        return (r && r.authorization && r.authorization.id_token) || null;
      });
    });
  }

  function postIdentity(provider, providerToken) {
    var field = provider === 'apple' ? 'identityToken' : 'idToken';
    var body = { deviceId: deviceId() };
    body[field] = providerToken;
    return api('/v1/auth/' + provider, { method: 'POST', auth: false, body: body })
      .then(function (res) {
        token = res.token;
        playerId = res.playerId;
        identity = provider;
        sessionPromise = Promise.resolve({ token: token, player_id: playerId });
        lsSet(LS_TOKEN, token);
        lsSet(LS_PLAYER, playerId);
        lsSet(LS_IDENTITY, provider);
        log('signed in via', provider, playerId, 'isNew=' + res.isNew);
        return { isNew: !!res.isNew, save: res.save || { version: 0, blob: {} } };
      });
  }

  function signIn(provider) {
    var getToken = provider === 'apple'
      ? function () { return nativeAppleIdToken().catch(webAppleIdToken); }
      : function () { return nativeGoogleIdToken().catch(webGoogleIdToken); };
    return getToken().then(function (pt) {
      if (!pt) throw new Error('no_provider_token');
      return postIdentity(provider, pt);
    });
  }

  // Retry once on 401: a token can expire or the secret can be rotated.
  function authed(fn) {
    return ensureSession().then(fn).catch(function (err) {
      if (err && err.status === 401) {
        token = null; playerId = null; sessionPromise = null;
        return ensureSession().then(fn);
      }
      throw err;
    });
  }

  var NuvuBackend = {
    configure: function (options) {
      cfg.baseUrl = (options.baseUrl || '').replace(/\/+$/, '');
      cfg.debug = !!options.debug;
      if (options.googleWebClientId) cfg.googleWebClientId = options.googleWebClientId;
      if (options.appleServiceId) cfg.appleServiceId = options.appleServiceId;
      if (options.appleRedirectUri) cfg.appleRedirectUri = options.appleRedirectUri;
      return NuvuBackend;
    },

    isConfigured: function () { return !!cfg.baseUrl; },
    playerId: function () { return playerId; },
    ready: function () { return ensureSession(); },

    /** 'apple' | 'google' | null */
    signedInWith: function () { return identity; },

    /**
     * Sign in with Apple / Google. Resolves to { isNew, save:{version,blob} }.
     * Rejects if the user cancels or the flow is unavailable - the caller should
     * surface that (login toasts stay in English). Play works fine without this.
     */
    signInApple: function () { return signIn('apple'); },
    signInGoogle: function () { return signIn('google'); },

    /** Drop the identity token and fall back to the anonymous device session. */
    signOut: function () {
      identity = null; token = null; playerId = null; sessionPromise = null;
      try { localStorage.removeItem(LS_IDENTITY); localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_PLAYER); } catch (e) {}
      return ensureSession();
    },

    setName: function (name) {
      return authed(function () {
        return api('/v1/profile', { method: 'PATCH', body: { display_name: name } });
      });
    },

    /** -> { version, blob } ; resolves to null when offline so the caller uses local state */
    loadSave: function () {
      return authed(function () { return api('/v1/save'); })
        .catch(function (err) { log('loadSave failed', err.message); return null; });
    },

    /**
     * Push local state. Pass the version you got from loadSave.
     * On a 409 the server state is returned as { conflict: true, current }.
     */
    saveState: function (version, blob) {
      return authed(function () {
        return api('/v1/save', { method: 'PUT', body: { version: version, blob: blob } });
      }).catch(function (err) {
        if (err && err.status === 409) return { conflict: true, current: err.payload.current };
        log('saveState failed', err.message);
        return null;
      });
    },

    submitScore: function (score, board) {
      return authed(function () {
        return api('/v1/score', { method: 'POST', body: { score: score, board: board || 'default' } });
      }).catch(function (err) { log('submitScore failed', err.message); return null; });
    },

    leaderboard: function (board, limit) {
      var q = '?board=' + encodeURIComponent(board || 'default') + '&limit=' + (limit || 50);
      return api('/v1/leaderboard' + q, { auth: false })
        .catch(function (err) { log('leaderboard failed', err.message); return { entries: [] }; });
    },

    /**
     * Rewarded-ad options to hand to the AdMob plugin, so Google's signed
     * server-side-verification callback can be tied back to this player.
     * Returns null when there is no session -- caller should then fall back to
     * the client-side reward path.
     */
    ssvOptions: function (customData) {
      if (!playerId) return null;
      return { userId: playerId, customData: customData || '' };
    },

    /**
     * Ask the server which rewarded impressions Google actually verified.
     * Each reward is returned exactly once, ever.
     * -> [{ transaction_id, ad_unit, reward_item, reward_amount }]
     */
    claimAdRewards: function () {
      return authed(function () {
        return api('/v1/ads/claim', { method: 'POST' });
      }).then(function (res) { return (res && res.rewards) || []; })
        .catch(function (err) { log('claimAdRewards failed', err.message); return []; });
    },

    /**
     * Poll for a verified reward after an ad closes. Google's callback is
     * out-of-band and usually lands within a second or two, so wait briefly
     * rather than failing the player instantly.
     */
    waitForAdReward: function (timeoutMs) {
      var deadline = Date.now() + (timeoutMs || 6000);
      function attempt() {
        return NuvuBackend.claimAdRewards().then(function (rewards) {
          if (rewards.length) return rewards;
          if (Date.now() >= deadline) return [];
          return new Promise(function (r) { setTimeout(r, 750); }).then(attempt);
        });
      }
      return attempt();
    },

    entitlements: function () {
      return authed(function () { return api('/v1/revenuecat/entitlements'); })
        .then(function (res) { return (res && res.entitlements) || []; })
        .catch(function () { return []; });
    }
  };

  global.NuvuBackend = NuvuBackend;

  // Self-configure from the script tag, so a deferred include needs no second
  // inline script (an inline script cannot be deferred, so it would otherwise
  // run before this file has even loaded):
  //   <script defer src="nuvugames-client.js" data-base-url="https://..."></script>
  try {
    var tag = document.currentScript ||
      document.querySelector('script[data-base-url][src*="nuvugames-client"]');
    if (tag && tag.getAttribute('data-base-url')) {
      NuvuBackend.configure({
        baseUrl: tag.getAttribute('data-base-url'),
        debug: tag.getAttribute('data-debug') === 'true'
      });
      // Open the session immediately so a player id exists before the first
      // rewarded ad is prepared.
      ensureSession().catch(function () {});
    }
  } catch (e) { /* non-browser context */ }
})(typeof window !== 'undefined' ? window : globalThis);
