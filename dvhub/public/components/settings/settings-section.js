import { html } from 'htm/preact';
import { signal } from '@preact/signals';

/**
 * Collapsible settings section grouping related fields.
 * @param {object} props
 * @param {string} props.title - Section title
 * @param {string} [props.description] - Section description
 * @param {boolean} [props.collapsible=true] - Whether section can be collapsed
 * @param {*} props.children - Child content (SettingsField components)
 */
export function SettingsSection({ title, description, collapsible = true, children }) {
  const collapsed = signal(false);

  const toggle = () => {
    if (collapsible) collapsed.value = !collapsed.value;
  };

  return html`
    <section class="panel reveal settings-section" style="margin-bottom: 1rem;">
      <div
        class="panel-head"
        style=${`display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 1rem; ${collapsible ? 'cursor: pointer;' : ''}`}
        onClick=${toggle}
      >
        <div>
          <p class="card-title" style="margin: 0;">${title}</p>
          ${description && html`<p class="meta" style="margin: 0.2rem 0 0; font-size: 0.8rem;">${description}</p>`}
        </div>
        ${collapsible && html`<span style="font-size: 1.2rem; opacity: 0.5;">${collapsed.value ? '\u25B6' : '\u25BC'}</span>`}
      </div>
      ${!collapsed.value && html`
        <div class="settings-section-body" style="padding: 0.5rem 1rem 1rem;">
          ${children}
        </div>
      `}
    </section>
  `;
}
