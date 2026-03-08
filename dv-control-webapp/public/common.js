(function () {
  const STORAGE_KEY = 'plexlite.apiToken';

  function getStoredApiToken() {
    try {
      return window.localStorage.getItem(STORAGE_KEY) || '';
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
      window.dispatchEvent(new CustomEvent('plexlite:unauthorized'));
    }
    return response;
  }

  syncTokenFromUrl();

  window.PlexLiteCommon = {
    apiFetch,
    buildApiUrl,
    getStoredApiToken,
    setStoredApiToken
  };
})();
