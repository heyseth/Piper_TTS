// Piper TTS — Markdown preview helper.
//
// The built-in Markdown preview is a webview owned by VS Code. Extensions cannot
// message it directly (acquireVsCodeApi is already claimed by the core preview,
// see microsoft/vscode#174080), so we bridge the current selection to the
// extension host through the clipboard:
//
//   1. When the user presses the read shortcut (Alt+A) inside the preview, this
//      script copies the current selection to the clipboard (or an empty string
//      when nothing is selected, so the host can tell "no selection" apart from a
//      stale clipboard).
//   2. We do NOT preventDefault, so VS Code still forwards Alt+A to the host
//      keybinding, which runs `piper-tts.readAloudPreview`. That command reads the
//      clipboard and speaks it.
//   3. Shortly afterwards we restore whatever was on the clipboard before, so the
//      user's clipboard is left untouched.
//
// This file ships as a static asset (contributes.markdown.previewScripts) and runs
// in the preview webview, so it uses plain browser APIs only.
(function () {
  // The preview re-injects contributed scripts on every content change; guard so we
  // only ever attach one set of listeners per webview.
  if (window.__piperTtsPreviewInit) {
    return;
  }
  window.__piperTtsPreviewInit = true;

  var RESTORE_DELAY_MS = 800; // must comfortably exceed the host's clipboard read

  function getSelectedText() {
    var sel = window.getSelection ? window.getSelection() : null;
    return sel ? sel.toString() : '';
  }

  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return Promise.reject(new Error('clipboard API unavailable'));
  }

  function readClipboard() {
    if (navigator.clipboard && navigator.clipboard.readText) {
      return navigator.clipboard.readText();
    }
    return Promise.resolve(null);
  }

  function showToast(message) {
    var id = 'piper-tts-toast';
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.style.cssText = [
        'position:fixed',
        'right:16px',
        'bottom:16px',
        'z-index:2147483647',
        'padding:6px 12px',
        'border-radius:6px',
        'font-size:12px',
        'font-family:var(--vscode-font-family, sans-serif)',
        'color:var(--vscode-editorWidget-foreground, #ddd)',
        'background:var(--vscode-editorWidget-background, #333)',
        'border:1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.35))',
        'box-shadow:0 2px 8px rgba(0,0,0,.35)',
        'opacity:0',
        'transition:opacity .15s ease',
        'pointer-events:none'
      ].join(';');
      document.body.appendChild(el);
    }
    el.textContent = message;
    // force reflow so the transition runs even on a reused element
    void el.offsetWidth;
    el.style.opacity = '1';
    clearTimeout(el.__hideTimer);
    el.__hideTimer = setTimeout(function () { el.style.opacity = '0'; }, 1400);
  }

  // Read shortcut: copy the selection so the host command can pick it up.
  function handleReadShortcut() {
    var selected = getSelectedText();
    var payload = (selected && selected.trim()) ? selected : '';

    // Snapshot the existing clipboard so we can put it back afterwards.
    readClipboard().then(function (previous) {
      writeClipboard(payload).then(function () {
        if (payload) {
          showToast('🔊 Reading selection…');
        } else {
          showToast('Select some text first');
        }
        if (previous !== null && previous !== undefined) {
          setTimeout(function () {
            // Only restore if we still hold our own payload (avoid clobbering a
            // clipboard the user changed in the meantime).
            readClipboard().then(function (current) {
              if (current === payload) {
                writeClipboard(previous).catch(function () {});
              }
            }).catch(function () {
              writeClipboard(previous).catch(function () {});
            });
          }, RESTORE_DELAY_MS);
        }
      }).catch(function () {
        // Clipboard write failed (permissions). Fall back to a copy of the DOM
        // selection, which is allowed inside the keydown user gesture.
        try { document.execCommand('copy'); } catch (e) { /* ignore */ }
        showToast(payload ? '🔊 Reading selection…' : 'Select some text first');
      });
    });
  }

  document.addEventListener('keydown', function (e) {
    // Alt+A (without Shift) — read the selection. Do not preventDefault, so the
    // keybinding is still forwarded to the extension host.
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'a' || e.key === 'A')) {
      handleReadShortcut();
    }
    // Alt+Shift+A (stop) needs no clipboard work; the host keybinding handles it.
  }, true);
})();
