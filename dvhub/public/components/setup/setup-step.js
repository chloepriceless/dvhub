import { html } from 'htm/preact';

/**
 * A collapsible step panel for the setup wizard.
 * @param {object} props
 * @param {number} props.stepNumber - Step number (1-based)
 * @param {string} props.title - Step title
 * @param {string} props.description - Step description
 * @param {boolean} props.active - Whether this step is currently active
 * @param {boolean} props.completed - Whether this step has been completed
 * @param {*} props.children - Child content to render when active
 */
export function SetupStep({ stepNumber, title, description, active, completed, children }) {
  return html`
    <div class="panel reveal setup-step" style="margin-bottom: 0.75rem; overflow: hidden;">
      <div class="panel-head" style="display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem 1rem;">
        <span class="step-badge" style=${`
          display: inline-flex; align-items: center; justify-content: center;
          width: 32px; height: 32px; min-width: 32px; border-radius: 50%;
          font-weight: 600; font-size: 0.875rem;
          background: ${completed ? 'var(--dvhub-green, #4ade80)' : active ? 'var(--dvhub-blue, #60a5fa)' : 'var(--dvhub-dim, #444)'};
          color: ${completed || active ? '#000' : '#aaa'};
        `}>
          ${completed ? '\u2713' : stepNumber}
        </span>
        <div style="flex: 1;">
          <p class="card-title" style="margin: 0;">${title}</p>
          ${description && html`<p class="meta" style="margin: 0.25rem 0 0; font-size: 0.8rem;">${description}</p>`}
        </div>
        ${completed && !active && html`<span class="meta" style="color: var(--dvhub-green, #4ade80);">Abgeschlossen</span>`}
      </div>
      ${active && html`
        <div class="setup-step-content" style="padding: 0 1rem 1rem;">
          ${children}
        </div>
      `}
    </div>
  `;
}
