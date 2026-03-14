import { html } from 'htm/preact';
import { buildModuleConfig } from './module-config.js';

// Re-export pure function for convenience
export { buildModuleConfig };

/**
 * Toggle switch for enabling/disabling a module.
 * @param {object} props
 * @param {string} props.moduleName - Module identifier
 * @param {string} props.label - Display label
 * @param {string} props.description - Description text
 * @param {boolean} props.enabled - Current state
 * @param {function} props.onToggle - Callback(moduleName, newEnabled)
 */
export function ModuleToggle({ moduleName, label, description, enabled, onToggle }) {
  const handleChange = (e) => {
    if (onToggle) onToggle(moduleName, e.target.checked);
  };

  return html`
    <div class="module-toggle panel reveal" style="padding: 1rem; margin-bottom: 0.75rem;">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 1rem;">
        <div>
          <p class="card-title" style="margin: 0;">${label}</p>
          <p class="meta" style="margin: 0.25rem 0 0;">${description}</p>
        </div>
        <label class="toggle-switch" style="position: relative; display: inline-block; width: 52px; min-width: 52px; height: 28px;">
          <input
            type="checkbox"
            checked=${enabled}
            onChange=${handleChange}
            style="opacity: 0; width: 0; height: 0;"
          />
          <span class="toggle-slider" style=${`
            position: absolute; cursor: pointer; inset: 0;
            background-color: ${enabled ? 'var(--dvhub-green, #4ade80)' : 'var(--dvhub-dim, #444)'};
            border-radius: 28px; transition: background-color 0.2s;
          `}>
            <span style=${`
              position: absolute; height: 22px; width: 22px;
              left: ${enabled ? '27px' : '3px'}; bottom: 3px;
              background-color: white; border-radius: 50%;
              transition: left 0.2s;
            `}></span>
          </span>
        </label>
      </div>
    </div>
  `;
}
