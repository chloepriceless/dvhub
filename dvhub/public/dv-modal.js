/* DVhub branded modal — replaces native alert() / confirm() / prompt().
   Plan 08-11 Task 1: enables CSP `style-src 'self'` (no inline styles, no
   native dialogs that bypass branding/CSS).

   Exposes:
     window.dvAlert(message, opts) -> Promise<void>
     window.dvConfirm(message, opts) -> Promise<boolean>
     window.dvPrompt(message, opts) -> Promise<string|null>

   opts (all optional):
     title       string  — dialog title; defaults to 'Hinweis' / 'Bestätigung' / 'Eingabe'
     okLabel     string  — primary button label (default 'OK' / 'Bestätigen' / 'Übernehmen')
     cancelLabel string  — cancel button label (default 'Abbrechen')
     variant     'primary' | 'danger' | 'default' — primary button style
     defaultValue string — for dvPrompt initial input value
*/
(function () {
  'use strict';

  function el(tag, className, attrs) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) {
      for (var key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) {
          node.setAttribute(key, attrs[key]);
        }
      }
    }
    return node;
  }

  function createBackdrop() {
    return el('div', 'dv-modal-backdrop', { role: 'presentation' });
  }

  function createDialog(opts) {
    var dlg = el('div', 'dv-modal', {
      role: 'alertdialog',
      'aria-modal': 'true'
    });

    var titleEl = el('h2', 'dv-modal-title');
    titleEl.textContent = opts.title;
    dlg.appendChild(titleEl);

    var bodyEl = el('div', 'dv-modal-body');
    if (opts.body && typeof opts.body !== 'string' && opts.body.nodeType) {
      bodyEl.appendChild(opts.body);
    } else {
      bodyEl.textContent = String(opts.body == null ? '' : opts.body);
    }
    dlg.appendChild(bodyEl);

    if (opts.input) {
      bodyEl.appendChild(opts.input);
    }

    var actions = el('div', 'dv-modal-actions');
    (opts.buttons || []).forEach(function (b) {
      var btn = el('button', 'dv-modal-btn dv-modal-btn-' + (b.variant || 'default'));
      btn.type = 'button';
      btn.textContent = b.label;
      btn.addEventListener('click', b.onClick);
      actions.appendChild(btn);
    });
    dlg.appendChild(actions);

    return dlg;
  }

  function dismiss(backdrop, keyHandler) {
    try { backdrop.remove(); } catch (e) { /* ignore */ }
    try { document.body.classList.remove('dv-modal-open'); } catch (e) { /* ignore */ }
    if (keyHandler) {
      try { document.removeEventListener('keydown', keyHandler); } catch (e) { /* ignore */ }
    }
  }

  function mount(backdrop, dlg, focusSelector) {
    backdrop.appendChild(dlg);
    document.body.appendChild(backdrop);
    document.body.classList.add('dv-modal-open');
    var focusEl = dlg.querySelector(focusSelector || '.dv-modal-btn');
    if (focusEl && typeof focusEl.focus === 'function') {
      try { focusEl.focus(); } catch (e) { /* ignore */ }
    }
  }

  window.dvAlert = function dvAlert(message, opts) {
    opts = opts || {};
    var title = opts.title || 'Hinweis';
    return new Promise(function (resolve) {
      var back = createBackdrop();
      var dlg;
      function done() { dismiss(back, keyHandler); resolve(); }
      function keyHandler(e) {
        if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); done(); }
      }
      dlg = createDialog({
        title: title,
        body: message,
        buttons: [
          { label: opts.okLabel || 'OK', variant: opts.variant || 'primary', onClick: done }
        ]
      });
      back.addEventListener('click', function (e) { if (e.target === back) done(); });
      document.addEventListener('keydown', keyHandler);
      mount(back, dlg);
    });
  };

  window.dvConfirm = function dvConfirm(message, opts) {
    opts = opts || {};
    var title = opts.title || 'Bestätigung';
    var okLabel = opts.okLabel || 'Bestätigen';
    var cancelLabel = opts.cancelLabel || 'Abbrechen';
    var variant = opts.variant || 'primary';
    return new Promise(function (resolve) {
      var back = createBackdrop();
      var dlg;
      function ok() { dismiss(back, keyHandler); resolve(true); }
      function cancel() { dismiss(back, keyHandler); resolve(false); }
      function keyHandler(e) {
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        if (e.key === 'Enter') { e.preventDefault(); ok(); }
      }
      dlg = createDialog({
        title: title,
        body: message,
        buttons: [
          { label: cancelLabel, variant: 'ghost', onClick: cancel },
          { label: okLabel, variant: variant, onClick: ok }
        ]
      });
      back.addEventListener('click', function (e) { if (e.target === back) cancel(); });
      document.addEventListener('keydown', keyHandler);
      // Focus the primary (second) button so default Enter accepts.
      mount(back, dlg, '.dv-modal-btn:last-child');
    });
  };

  window.dvPrompt = function dvPrompt(message, opts) {
    opts = opts || {};
    var title = opts.title || 'Eingabe';
    var okLabel = opts.okLabel || 'Übernehmen';
    var cancelLabel = opts.cancelLabel || 'Abbrechen';
    var defaultValue = opts.defaultValue == null ? '' : String(opts.defaultValue);
    var input = el('input', 'config-input u-w-full u-mt-3');
    input.type = 'text';
    input.value = defaultValue;
    return new Promise(function (resolve) {
      var back = createBackdrop();
      var dlg;
      function ok() { dismiss(back, keyHandler); resolve(input.value); }
      function cancel() { dismiss(back, keyHandler); resolve(null); }
      function keyHandler(e) {
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        if (e.key === 'Enter') { e.preventDefault(); ok(); }
      }
      dlg = createDialog({
        title: title,
        body: message,
        input: input,
        buttons: [
          { label: cancelLabel, variant: 'ghost', onClick: cancel },
          { label: okLabel, variant: opts.variant || 'primary', onClick: ok }
        ]
      });
      back.addEventListener('click', function (e) { if (e.target === back) cancel(); });
      document.addEventListener('keydown', keyHandler);
      mount(back, dlg);
      // Focus the input rather than a button so the user can type immediately.
      try { input.focus(); input.select(); } catch (e) { /* ignore */ }
    });
  };
})();
