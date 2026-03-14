import { html } from 'htm/preact';
import { useEffect } from 'preact/hooks';
import { useApi } from '../shared/use-api.js';

/**
 * Schedule panel: displays active schedule rules from /api/schedule.
 */
export function SchedulePanel() {
  const { data, loading, error, refresh } = useApi('/api/schedule');

  useEffect(() => { refresh(); }, []);

  const rules = (data.value && data.value.rules) || [];

  return html`
    <section class="panel span-6 reveal">
      <p class="card-title">Zeitplaene</p>
      ${loading.value && html`<p class="meta">Lade...</p>`}
      ${error.value && html`<p class="meta" style="color:var(--dvhub-red)">${error.value}</p>`}
      ${!loading.value && !error.value && rules.length === 0 && html`
        <p class="meta">Keine aktiven Zeitplaene</p>
      `}
      ${rules.length > 0 && html`
        <table style="width:100%;border-collapse:collapse;font-size:0.85rem">
          <thead>
            <tr style="color:var(--text-muted);border-bottom:1px solid var(--line)">
              <th style="text-align:left;padding:4px 6px">Name</th>
              <th style="text-align:left;padding:4px 6px">Zeit</th>
              <th style="text-align:left;padding:4px 6px">Aktion</th>
              <th style="text-align:center;padding:4px 6px">Status</th>
            </tr>
          </thead>
          <tbody>
            ${rules.map(rule => html`
              <tr style="border-bottom:1px solid var(--line)">
                <td style="padding:4px 6px">${rule.name || rule.id || '-'}</td>
                <td style="padding:4px 6px;color:var(--text-muted)">${rule.time || rule.schedule || '-'}</td>
                <td style="padding:4px 6px">${rule.action || '-'}</td>
                <td style="text-align:center;padding:4px 6px">
                  <span style="color:${rule.enabled !== false ? 'var(--dvhub-green)' : 'var(--text-muted)'}">
                    ${rule.enabled !== false ? 'Aktiv' : 'Aus'}
                  </span>
                </td>
              </tr>
            `)}
          </tbody>
        </table>
      `}
      ${data.value && data.value.smallMarketAutomation && html`
        <p class="meta" style="margin-top:8px;color:var(--schedule-automation-yellow)">
          Kleine Boersenautomatik aktiv
        </p>
      `}
    </section>
  `;
}
