import { html } from 'htm/preact';
import { useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import { useApi } from '../shared/use-api.js';

/**
 * Log panel: recent log entries from /api/log, auto-refreshing every 10s.
 */
export function LogPanel() {
  const { data, loading, error, refresh } = useApi('/api/log?limit=20');

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 10000);
    return () => clearInterval(iv);
  }, []);

  const rows = (data.value && data.value.rows) || [];

  return html`
    <section class="panel span-12 reveal">
      <p class="card-title">Protokoll</p>
      ${loading.value && rows.length === 0 && html`<p class="meta">Lade...</p>`}
      ${error.value && html`<p class="meta" style="color:var(--dvhub-red)">${error.value}</p>`}
      ${rows.length === 0 && !loading.value && !error.value && html`
        <p class="meta">Keine Eintraege</p>
      `}
      ${rows.length > 0 && html`
        <div style="max-height:220px;overflow-y:auto;font-size:0.8rem;font-family:monospace">
          ${rows.slice().reverse().map(entry => html`
            <div style="padding:2px 0;border-bottom:1px solid var(--line);display:flex;gap:8px">
              <span style="color:var(--text-muted);white-space:nowrap;min-width:140px">${entry.ts || ''}</span>
              <span>${entry.event || ''} ${entry.details ? JSON.stringify(entry.details) : ''}</span>
            </div>
          `)}
        </div>
      `}
    </section>
  `;
}
