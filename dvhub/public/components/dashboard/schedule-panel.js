import { html } from 'htm/preact';
import { useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import { useApi, apiFetch } from '../shared/use-api.js';
import { telemetry } from '../shared/use-signal-store.js';
import { formatTimestamp } from './dashboard-compute.js';
import { groupScheduleRulesForDashboard, collectScheduleRulesFromRowState, isSmallMarketAutomationRule } from './schedule-compute.js';

/* ── Local signals (module-level) ─────────────────────────────────── */
const editingRowIdx = signal(null);
const editBuffer = signal({});
const defaultGridSetpoint = signal('');
const defaultChargeCurrent = signal('');
const scheduleMsg = signal('');

/* ── Helpers ──────────────────────────────────────────────────────── */

function startEdit(idx, row) {
  editingRowIdx.value = idx;
  editBuffer.value = {
    start: row.start || '',
    end: row.end || '',
    grid: row.grid != null ? String(row.grid) : '',
    charge: row.charge != null ? String(row.charge) : '',
    gridEnabled: row.grid != null,
    chargeEnabled: row.charge != null,
    stopSocPct: row.stopSocPct != null ? String(row.stopSocPct) : '',
    stopSocEnabled: row.stopSocPct != null
  };
}

function cancelEdit() {
  editingRowIdx.value = null;
  editBuffer.value = {};
}

function updateBuffer(field, value) {
  editBuffer.value = { ...editBuffer.value, [field]: value };
}

async function saveEdit(groupedRows, refresh) {
  const idx = editingRowIdx.value;
  if (idx == null) return;

  const buf = editBuffer.value;
  const updated = groupedRows.map((r, i) => {
    if (i !== idx) return r;
    return {
      ...r,
      start: buf.start,
      end: buf.end,
      grid: buf.gridEnabled ? Number(buf.grid) : null,
      gridEnabled: buf.gridEnabled,
      charge: buf.chargeEnabled ? Number(buf.charge) : null,
      chargeEnabled: buf.chargeEnabled,
      stopSocPct: buf.stopSocEnabled ? Number(buf.stopSocPct) : null,
      stopSocEnabled: buf.stopSocEnabled,
      gridVal: buf.gridEnabled ? Number(buf.grid) : null,
      chargeVal: buf.chargeEnabled ? Number(buf.charge) : null,
      stopSocVal: buf.stopSocEnabled ? Number(buf.stopSocPct) : null
    };
  });

  const flatRules = collectScheduleRulesFromRowState(updated);
  try {
    const res = await apiFetch('/api/schedule/rules', {
      method: 'POST',
      body: JSON.stringify({ rules: flatRules })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cancelEdit();
    refresh();
  } catch (err) {
    scheduleMsg.value = 'Fehler: ' + (err.message || 'Speichern fehlgeschlagen');
    setTimeout(() => { scheduleMsg.value = ''; }, 3000);
  }
}

async function deleteRule(groupedRows, idx, refresh) {
  if (!window.confirm('Regel wirklich loeschen?')) return;
  const remaining = groupedRows.filter((_, i) => i !== idx);
  const flatRules = collectScheduleRulesFromRowState(remaining.map(r => ({
    ...r,
    gridEnabled: r.grid != null,
    chargeEnabled: r.charge != null,
    stopSocEnabled: r.stopSocPct != null,
    gridVal: r.grid,
    chargeVal: r.charge,
    stopSocVal: r.stopSocPct
  })));
  try {
    const res = await apiFetch('/api/schedule/rules', {
      method: 'POST',
      body: JSON.stringify({ rules: flatRules })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    refresh();
  } catch (err) {
    scheduleMsg.value = 'Fehler: ' + (err.message || 'Loeschen fehlgeschlagen');
    setTimeout(() => { scheduleMsg.value = ''; }, 3000);
  }
}

function addNewRow(groupedRows) {
  const newIdx = groupedRows.length;
  editingRowIdx.value = newIdx;
  editBuffer.value = {
    start: '',
    end: '',
    grid: '',
    charge: '',
    gridEnabled: true,
    chargeEnabled: false,
    stopSocPct: '',
    stopSocEnabled: false
  };
}

async function saveDefaultConfig(field, value) {
  const body = {};
  if (field === 'grid') body.defaultGridSetpointW = Number(value);
  if (field === 'charge') body.defaultChargeCurrentA = Number(value);
  try {
    const res = await apiFetch('/api/schedule/config', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    scheduleMsg.value = 'Gespeichert';
    setTimeout(() => { scheduleMsg.value = ''; }, 2000);
  } catch (err) {
    scheduleMsg.value = 'Fehler: ' + (err.message || 'Speichern fehlgeschlagen');
    setTimeout(() => { scheduleMsg.value = ''; }, 3000);
  }
}

/* ── Component ────────────────────────────────────────────────────── */

export function SchedulePanel() {
  const { data, loading, error, refresh } = useApi('/api/schedule');

  useEffect(() => { refresh(); }, []);

  // Initialize default values from loaded config
  useEffect(() => {
    if (data.value && data.value.config) {
      defaultGridSetpoint.value = String(data.value.config.defaultGridSetpointW ?? '');
      defaultChargeCurrent.value = String(data.value.config.defaultChargeCurrentA ?? '');
    }
  }, [data.value]);

  const rules = (data.value && data.value.rules) || [];
  const allGrouped = groupScheduleRulesForDashboard(rules);
  const manualRows = allGrouped.filter(r => !isSmallMarketAutomationRule(r));
  const smaRows = allGrouped.filter(r => isSmallMarketAutomationRule(r));

  // Include a virtual new row if editingRowIdx points beyond current manual rows
  const displayRows = editingRowIdx.value != null && editingRowIdx.value >= manualRows.length
    ? [...manualRows, { start: '', end: '', grid: null, charge: null, stopSocPct: null, enabled: true, _isNew: true }]
    : manualRows;

  // Active values from telemetry
  const schedActive = telemetry.value.schedule?.active;
  const lastWrite = telemetry.value.schedule?.lastWrite;
  const lastWriteTs = lastWrite
    ? Math.max(...Object.values(lastWrite).map(v => v?.at || 0))
    : 0;

  return html`
    <section class="panel span-6 reveal">
      <p class="card-title">Zeitplaene</p>

      ${scheduleMsg.value && html`
        <p class="meta" style="color:var(--dvhub-green);margin:4px 0">${scheduleMsg.value}</p>
      `}

      ${''/* Section 2: Default inputs */}
      <div style="display:flex;gap:8px;margin:8px 0">
        <label style="flex:1;font-size:0.8rem">
          Standard Netz-Sollwert (W)
          <input type="number" value=${defaultGridSetpoint.value}
            onInput=${e => { defaultGridSetpoint.value = e.target.value; }}
            onKeyDown=${e => { if (e.key === 'Enter') saveDefaultConfig('grid', defaultGridSetpoint.value); }}
            style="width:100%;margin-top:2px;padding:4px;font-size:0.85rem;background:var(--bg-card);color:var(--text);border:1px solid var(--line);border-radius:4px"
          />
        </label>
        <label style="flex:1;font-size:0.8rem">
          Standard Ladestrom (A)
          <input type="number" value=${defaultChargeCurrent.value}
            onInput=${e => { defaultChargeCurrent.value = e.target.value; }}
            onKeyDown=${e => { if (e.key === 'Enter') saveDefaultConfig('charge', defaultChargeCurrent.value); }}
            style="width:100%;margin-top:2px;padding:4px;font-size:0.85rem;background:var(--bg-card);color:var(--text);border:1px solid var(--line);border-radius:4px"
          />
        </label>
      </div>

      ${''/* Section 3: Active values display */}
      <div style="border:1px solid var(--line);border-radius:6px;padding:8px;margin:8px 0">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px">
          <span style="font-size:0.8rem;color:var(--text-muted)">Netz-Sollwert</span>
          <span style="font-size:0.85rem">
            ${schedActive?.gridSetpointW?.value != null ? `${schedActive.gridSetpointW.value} W` : '-'}
            ${schedActive?.gridSetpointW?.source ? html` <span style="color:var(--text-muted);font-size:0.7rem">(${schedActive.gridSetpointW.source})</span>` : ''}
          </span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px">
          <span style="font-size:0.8rem;color:var(--text-muted)">Ladestrom</span>
          <span style="font-size:0.85rem">${schedActive?.chargeCurrentA?.value != null ? `${schedActive.chargeCurrentA.value} A` : '-'}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px">
          <span style="font-size:0.8rem;color:var(--text-muted)">Min SOC</span>
          <span style="font-size:0.85rem">${schedActive?.minSocPct?.value != null ? `${schedActive.minSocPct.value} %` : '-'}</span>
        </div>
        <div style="display:flex;justify-content:space-between">
          <span style="font-size:0.8rem;color:var(--text-muted)">Letzte Aenderung</span>
          <span style="font-size:0.85rem">${lastWriteTs > 0 ? formatTimestamp(lastWriteTs) : '--'}</span>
        </div>
      </div>

      ${''/* Section 4: Rule table */}
      ${loading.value && html`<p class="meta">Lade...</p>`}
      ${error.value && html`<p class="meta" style="color:var(--dvhub-red)">${error.value}</p>`}

      ${!loading.value && !error.value && html`
        <table style="width:100%;border-collapse:collapse;font-size:0.85rem">
          <thead>
            <tr style="color:var(--text-muted);border-bottom:1px solid var(--line)">
              <th style="text-align:left;padding:4px 6px">Zeit</th>
              <th style="text-align:right;padding:4px 6px">Netz (W)</th>
              <th style="text-align:right;padding:4px 6px">Ladestrom (A)</th>
              <th style="text-align:right;padding:4px 6px">Stop-SOC (%)</th>
              <th style="text-align:center;padding:4px 6px">Aktionen</th>
            </tr>
          </thead>
          <tbody>
            ${displayRows.map((row, idx) => {
              const isEditing = editingRowIdx.value === idx;
              const isSma = isSmallMarketAutomationRule(row);

              if (isEditing) {
                const buf = editBuffer.value;
                return html`
                  <tr style="border-bottom:1px solid var(--line);background:var(--bg-card)">
                    <td style="padding:4px 6px">
                      <input type="time" value=${buf.start} onInput=${e => updateBuffer('start', e.target.value)}
                        style="width:70px;padding:2px;font-size:0.8rem;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:3px" />
                      -
                      <input type="time" value=${buf.end} onInput=${e => updateBuffer('end', e.target.value)}
                        style="width:70px;padding:2px;font-size:0.8rem;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:3px" />
                    </td>
                    <td style="padding:4px 6px;text-align:right">
                      <input type="checkbox" checked=${buf.gridEnabled} onChange=${e => updateBuffer('gridEnabled', e.target.checked)} />
                      <input type="number" value=${buf.grid} onInput=${e => updateBuffer('grid', e.target.value)}
                        disabled=${!buf.gridEnabled}
                        style="width:70px;padding:2px;font-size:0.8rem;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:3px" />
                    </td>
                    <td style="padding:4px 6px;text-align:right">
                      <input type="checkbox" checked=${buf.chargeEnabled} onChange=${e => updateBuffer('chargeEnabled', e.target.checked)} />
                      <input type="number" value=${buf.charge} onInput=${e => updateBuffer('charge', e.target.value)}
                        disabled=${!buf.chargeEnabled}
                        style="width:70px;padding:2px;font-size:0.8rem;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:3px" />
                    </td>
                    <td style="padding:4px 6px;text-align:right">
                      <input type="checkbox" checked=${buf.stopSocEnabled} onChange=${e => updateBuffer('stopSocEnabled', e.target.checked)} />
                      <input type="number" value=${buf.stopSocPct} onInput=${e => updateBuffer('stopSocPct', e.target.value)}
                        disabled=${!buf.stopSocEnabled}
                        style="width:50px;padding:2px;font-size:0.8rem;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:3px" />
                    </td>
                    <td style="padding:4px 6px;text-align:center">
                      <button onClick=${() => saveEdit(displayRows, refresh)}
                        style="padding:2px 8px;font-size:0.8rem;cursor:pointer;background:var(--dvhub-green);color:#fff;border:none;border-radius:3px;margin-right:4px">Speichern</button>
                      <button onClick=${cancelEdit}
                        style="padding:2px 8px;font-size:0.8rem;cursor:pointer;background:var(--text-muted);color:#fff;border:none;border-radius:3px">Abbrechen</button>
                    </td>
                  </tr>
                `;
              }

              return html`
                <tr style="border-bottom:1px solid var(--line);cursor:${isSma ? 'default' : 'pointer'}"
                    onClick=${() => { if (!isSma) startEdit(idx, row); }}>
                  <td style="padding:4px 6px">${row.start || '-'} - ${row.end || '-'}</td>
                  <td style="padding:4px 6px;text-align:right">${row.grid != null ? row.grid : '-'}</td>
                  <td style="padding:4px 6px;text-align:right">${row.charge != null ? row.charge : '-'}</td>
                  <td style="padding:4px 6px;text-align:right">${row.stopSocPct != null ? row.stopSocPct : '-'}</td>
                  <td style="padding:4px 6px;text-align:center">
                    ${isSma
                      ? html`<span style="background:var(--schedule-automation-yellow);color:#000;padding:1px 5px;border-radius:3px;font-size:0.7rem">Auto</span>`
                      : html`<button onClick=${e => { e.stopPropagation(); deleteRule(displayRows, idx, refresh); }}
                          style="padding:1px 6px;font-size:0.8rem;cursor:pointer;background:transparent;color:var(--dvhub-red);border:1px solid var(--dvhub-red);border-radius:3px">x</button>`
                    }
                  </td>
                </tr>
              `;
            })}

            ${''/* SMA rows (read-only) */}
            ${smaRows.map(row => html`
              <tr style="border-bottom:1px solid var(--line);opacity:0.8">
                <td style="padding:4px 6px">${row.start || '-'} - ${row.end || '-'}</td>
                <td style="padding:4px 6px;text-align:right">${row.grid != null ? row.grid : '-'}</td>
                <td style="padding:4px 6px;text-align:right">${row.charge != null ? row.charge : '-'}</td>
                <td style="padding:4px 6px;text-align:right">${row.stopSocPct != null ? row.stopSocPct : '-'}</td>
                <td style="padding:4px 6px;text-align:center">
                  <span style="background:var(--schedule-automation-yellow);color:#000;padding:1px 5px;border-radius:3px;font-size:0.7rem">Auto</span>
                </td>
              </tr>
            `)}
          </tbody>
        </table>

        ${''/* Add new rule button */}
        <div style="margin-top:8px;text-align:center">
          <button onClick=${() => addNewRow(displayRows)}
            style="padding:4px 16px;font-size:1rem;cursor:pointer;background:var(--bg-card);color:var(--text);border:1px solid var(--line);border-radius:4px"
          >+</button>
        </div>
      `}

      ${''/* SMA active message */}
      ${data.value && data.value.smallMarketAutomation && html`
        <p class="meta" style="margin-top:8px;color:var(--schedule-automation-yellow)">
          Kleine Boersenautomatik aktiv
        </p>
      `}
    </section>
  `;
}
