/* Aurora theme controller (AURORA-02). Ported verbatim from
   .planning/DESIGN-2026-05-10-aurora/assets/theme.js.
   localStorage key: 'dvhub.theme', values: 'dark'|'auto'|'light'. */
/* DVhub theme controller — auto/light/dark */
(function(){
  const KEY = 'dvhub.theme'; // 'dark' (default) | 'auto' | 'light'
  const get = () => localStorage.getItem(KEY) || 'dark';
  const apply = (mode) => {
    const html = document.documentElement;
    if(mode === 'auto'){
      html.removeAttribute('data-theme-explicit');
      const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
      html.setAttribute('data-theme', prefersLight ? 'light' : 'dark');
    } else {
      html.setAttribute('data-theme-explicit', 'true');
      html.setAttribute('data-theme', mode);
    }
  };
  // Apply ASAP to avoid flash
  apply(get());

  // React to OS changes when in auto
  try {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if(get() === 'auto') apply('auto');
    });
  } catch(e){}

  function icon(mode){
    if(mode === 'light') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
    if(mode === 'dark')  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/></svg>';
  }
  function label(mode){ return mode === 'auto' ? 'Auto' : (mode === 'light' ? 'Hell' : 'Dunkel'); }

  function paint(btn){
    const m = get();
    btn.dataset.themeMode = m;
    btn.innerHTML = icon(m) + '<span class="theme-label">' + label(m) + '</span>';
    btn.setAttribute('title', 'Theme: ' + label(m) + ' — klicken für Auto / Hell / Dunkel');
    btn.setAttribute('aria-label', 'Theme wechseln, aktuell ' + label(m));
  }

  function cycle(){
    const order = ['dark','auto','light'];
    const next = order[(order.indexOf(get()) + 1) % order.length];
    localStorage.setItem(KEY, next);
    apply(next);
    document.querySelectorAll('.theme-toggle').forEach(paint);
  }

  function mount(){
    document.querySelectorAll('.theme-toggle').forEach(btn => {
      paint(btn);
      btn.addEventListener('click', cycle);
    });
    // Inject into nav if no explicit slot
    if(!document.querySelector('.theme-toggle')){
      const nav = document.querySelector('.nav .nav-spacer');
      if(nav){
        const btn = document.createElement('button');
        btn.className = 'theme-toggle btn';
        btn.type = 'button';
        nav.parentNode.insertBefore(btn, nav.nextSibling);
        paint(btn);
        btn.addEventListener('click', cycle);
      }
    }
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', mount);
  } else mount();
})();
