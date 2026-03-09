(function () {
  const STORAGE_KEY = 'dvhub.apiToken';
  const LEGACY_STORAGE_KEY = ['plex', 'lite.apiToken'].join('');

  function migrateLegacyToken() {
    try {
      const currentToken = window.localStorage.getItem(STORAGE_KEY);
      if (currentToken) return currentToken;
      const legacyToken = window.localStorage.getItem(LEGACY_STORAGE_KEY) || '';
      if (legacyToken) {
        window.localStorage.setItem(STORAGE_KEY, legacyToken);
        window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
      return legacyToken;
    } catch {
      return '';
    }
  }

  function getStoredApiToken() {
    try {
      return window.localStorage.getItem(STORAGE_KEY) || migrateLegacyToken();
    } catch {
      return '';
    }
  }

  function setStoredApiToken(token) {
    try {
      if (token) window.localStorage.setItem(STORAGE_KEY, token);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore storage errors
    }
  }

  function syncTokenFromUrl() {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('token');
    if (token) setStoredApiToken(token);
  }

  function buildApiUrl(path) {
    const url = new URL(path, window.location.origin);
    const token = getStoredApiToken();
    if (token && !url.searchParams.has('token')) url.searchParams.set('token', token);
    return url.toString();
  }

  async function apiFetch(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const token = getStoredApiToken();
    if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
    const response = await fetch(buildApiUrl(path), { ...options, headers });
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('dvhub:unauthorized'));
    }
    return response;
  }

  syncTokenFromUrl();

  window.DVhubCommon = {
    apiFetch,
    buildApiUrl,
    getStoredApiToken,
    setStoredApiToken
  };
})();
