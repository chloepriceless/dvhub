import { html } from 'htm/preact';

/**
 * Generic config field renderer supporting multiple input types.
 * @param {object} props
 * @param {string} props.type - 'text'|'number'|'select'|'toggle'|'password'|'textarea'
 * @param {string} props.name - Field identifier
 * @param {string} props.label - Display label
 * @param {*} props.value - Current value
 * @param {function} props.onChange - Callback({name, value})
 * @param {Array<{value, label}>} [props.options] - Options for select type
 * @param {number} [props.min] - Min for number type
 * @param {number} [props.max] - Max for number type
 * @param {number} [props.step] - Step for number type
 * @param {string} [props.hint] - Help text below the field
 */
export function SettingsField({ type, name, label, value, onChange, options, min, max, step, hint }) {
  const handleChange = (val) => {
    if (onChange) onChange({ name, value: val });
  };

  const fieldStyle = 'width: 100%; padding: 0.5rem; background: var(--dvhub-bg, #1a1a2e); color: inherit; border: 1px solid var(--dvhub-dim, #444); border-radius: 4px;';

  let input;

  switch (type) {
    case 'number':
      input = html`<input
        class="input-field" type="number" name=${name}
        value=${value ?? ''} min=${min} max=${max} step=${step}
        style=${fieldStyle}
        onInput=${(e) => handleChange(Number(e.target.value))}
      />`;
      break;

    case 'select':
      input = html`<select
        class="input-field" name=${name}
        value=${value ?? ''}
        style=${fieldStyle}
        onChange=${(e) => handleChange(e.target.value)}
      >
        ${(options || []).map(opt => html`<option value=${opt.value}>${opt.label}</option>`)}
      </select>`;
      break;

    case 'toggle':
      input = html`<label style="display: inline-flex; align-items: center; gap: 0.5rem; cursor: pointer;">
        <input
          type="checkbox"
          checked=${!!value}
          onChange=${(e) => handleChange(e.target.checked)}
        />
        <span class="meta">${value ? 'Aktiv' : 'Inaktiv'}</span>
      </label>`;
      break;

    case 'password':
      input = html`<input
        class="input-field" type="password" name=${name}
        value=${value ?? ''}
        style=${fieldStyle}
        onInput=${(e) => handleChange(e.target.value)}
      />`;
      break;

    case 'textarea':
      input = html`<textarea
        class="input-field" name=${name}
        style=${fieldStyle + ' min-height: 80px; resize: vertical;'}
        onInput=${(e) => handleChange(e.target.value)}
      >${value ?? ''}</textarea>`;
      break;

    default: // text
      input = html`<input
        class="input-field" type="text" name=${name}
        value=${value ?? ''}
        style=${fieldStyle}
        onInput=${(e) => handleChange(e.target.value)}
      />`;
      break;
  }

  return html`
    <div class="settings-field" style="margin-bottom: 0.75rem;">
      ${label && html`<label class="input-label" style="display: block; margin-bottom: 0.25rem; font-size: 0.85rem; font-weight: 500;">${label}</label>`}
      ${input}
      ${hint && html`<p class="input-hint meta" style="margin-top: 0.2rem; font-size: 0.75rem; opacity: 0.7;">${hint}</p>`}
    </div>
  `;
}
