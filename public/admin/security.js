(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  var lastTriggerTime = 0;
  var THROTTLE_MS = 1500;
  var isModalVisible = false;
  var devToolsReported = false;

  var styleInjected = false;
  function injectStyles() {
    if (styleInjected) return;
    if (typeof document === 'undefined') return;
    var target = document.head || document.documentElement || document.body;
    if (!target) return;
    if (typeof document.getElementById === 'function' && document.getElementById('security-shield-styles')) {
      styleInjected = true;
      return;
    }

    var css = '' +
      '.security-shield-backdrop {' +
      '  position: fixed; inset: 0; width: 100vw; height: 100vh;' +
      '  background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);' +
      '  display: flex; align-items: center; justify-content: center;' +
      '  z-index: 2147483647; opacity: 0; pointer-events: none;' +
      '  transition: opacity 0.2s ease;' +
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;' +
      '}' +
      '.security-shield-backdrop.active {' +
      '  opacity: 1; pointer-events: auto;' +
      '}' +
      '.security-shield-card {' +
      '  background: #0f172a; color: #f8fafc;' +
      '  border: 1px solid rgba(239, 68, 68, 0.45); border-radius: 14px;' +
      '  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 35px rgba(239, 68, 68, 0.18);' +
      '  max-width: 440px; width: 90%; padding: 26px; text-align: center;' +
      '  transform: scale(0.95); transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);' +
      '  box-sizing: border-box;' +
      '}' +
      '.security-shield-backdrop.active .security-shield-card {' +
      '  transform: scale(1);' +
      '}' +
      '.security-shield-icon {' +
      '  width: 52px; height: 52px; margin: 0 auto 16px auto; color: #ef4444;' +
      '  background: rgba(239, 68, 68, 0.12); border-radius: 50%;' +
      '  display: flex; align-items: center; justify-content: center;' +
      '}' +
      '.security-shield-title {' +
      '  font-size: 1.15rem; font-weight: 700; color: #ffffff; margin: 0 0 10px 0;' +
      '}' +
      '.security-shield-body {' +
      '  font-size: 0.875rem; color: #94a3b8; line-height: 1.5; margin: 0 0 16px 0;' +
      '}' +
      '.security-shield-reason {' +
      '  font-size: 0.8rem; color: #f87171; background: rgba(239, 68, 68, 0.1);' +
      '  padding: 8px 12px; border-radius: 6px; margin-bottom: 20px;' +
      '  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; word-break: break-all;' +
      '}' +
      '.security-shield-btn {' +
      '  background: #ef4444; color: #ffffff; border: none; border-radius: 8px;' +
      '  padding: 12px 20px; font-size: 0.875rem; font-weight: 600;' +
      '  cursor: pointer; width: 100%; transition: background 0.15s ease, box-shadow 0.15s ease;' +
      '  outline: none;' +
      '}' +
      '.security-shield-btn:hover, .security-shield-btn:focus-visible {' +
      '  background: #dc2626; box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.4);' +
      '}';

    var style = document.createElement('style');
    style.id = 'security-shield-styles';
    style.setAttribute('id', 'security-shield-styles');
    style.textContent = css;
    target.appendChild(style);
    styleInjected = true;
  }

  var modalBackdrop = null;
  var reasonElement = null;
  var acknowledgeBtn = null;

  function ensureModalMounted() {
    if (modalBackdrop && modalBackdrop.parentNode) return modalBackdrop;
    if (typeof document === 'undefined') return null;
    var container = document.body || document.documentElement;
    if (!container) return null;

    injectStyles();

    modalBackdrop = document.createElement('div');
    modalBackdrop.id = 'security-shield-modal';
    modalBackdrop.setAttribute('id', 'security-shield-modal');
    modalBackdrop.className = 'security-shield-backdrop';
    modalBackdrop.setAttribute('role', 'alertdialog');
    modalBackdrop.setAttribute('aria-modal', 'true');
    modalBackdrop.setAttribute('aria-labelledby', 'security-shield-title');

    var card = document.createElement('div');
    card.id = 'securityWarningModal';
    card.setAttribute('id', 'securityWarningModal');
    card.className = 'security-shield-card';

    var iconWrap = document.createElement('div');
    iconWrap.className = 'security-shield-icon';
    iconWrap.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
    card.appendChild(iconWrap);

    var title = document.createElement('h3');
    title.id = 'security-shield-title';
    title.setAttribute('id', 'security-shield-title');
    title.className = 'security-shield-title';
    title.textContent = 'Security Alert: Inspection Prohibited';
    card.appendChild(title);

    var body = document.createElement('p');
    body.className = 'security-shield-body';
    body.textContent = 'Developer tools, shortcuts, and page inspection have been disabled for security and integrity.';
    card.appendChild(body);

    reasonElement = document.createElement('div');
    reasonElement.id = 'security-shield-reason';
    reasonElement.setAttribute('id', 'security-shield-reason');
    reasonElement.className = 'security-shield-reason';
    reasonElement.textContent = 'Security Violation Detected';
    card.appendChild(reasonElement);

    acknowledgeBtn = document.createElement('button');
    acknowledgeBtn.setAttribute('type', 'button');
    acknowledgeBtn.id = 'security-shield-btn';
    acknowledgeBtn.setAttribute('id', 'security-shield-btn');
    acknowledgeBtn.className = 'security-shield-btn';
    acknowledgeBtn.textContent = 'Acknowledge & Continue';
    card.appendChild(acknowledgeBtn);

    modalBackdrop.appendChild(card);
    container.appendChild(modalBackdrop);

    acknowledgeBtn.addEventListener('click', hideModal);
    modalBackdrop.addEventListener('click', function (e) {
      if (e.target === modalBackdrop) hideModal();
    });

    return modalBackdrop;
  }

  function showModal(reason) {
    var now = Date.now();
    if (modalBackdrop && !modalBackdrop.classList.contains('active')) {
      isModalVisible = false;
    }
    if (isModalVisible) {
      if (reasonElement && reason) {
        reasonElement.textContent = reason;
      }
      return;
    }
    if (now - lastTriggerTime < THROTTLE_MS) {
      return;
    }
    lastTriggerTime = now;

    var modal = ensureModalMounted();
    if (!modal) {
      if (typeof document !== 'undefined' && document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
          showModal(reason);
        });
      }
      return;
    }

    if (reasonElement) {
      reasonElement.textContent = reason || 'Unauthorized inspection attempt detected';
    }
    modal.classList.add('active');
    isModalVisible = true;
  }

  function hideModal() {
    if (modalBackdrop) {
      modalBackdrop.classList.remove('active');
    }
    isModalVisible = false;
    lastTriggerTime = 0;
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && (isModalVisible || (modalBackdrop && modalBackdrop.classList.contains('active')))) {
      hideModal();
      e.preventDefault();
      e.stopPropagation();
      return false;
    }

    var key = e.key || '';
    var keyCode = e.keyCode || e.which || 0;
    var isCtrl = Boolean(e.ctrlKey);
    var isMeta = Boolean(e.metaKey);
    var isShift = Boolean(e.shiftKey);
    var isAlt = Boolean(e.altKey);
    var isModifier = isCtrl || isMeta;

    var blocked = false;
    var reason = '';

    if (key === 'F12' || keyCode === 123) {
      blocked = true;
      reason = 'F12 Developer Tools';
    } else if (isModifier && (isShift || isAlt) && (key === 'I' || key === 'i' || keyCode === 73)) {
      blocked = true;
      reason = 'Developer Tools (Ctrl+Shift+I / Cmd+Option+I)';
    } else if (isModifier && (isShift || isAlt) && (key === 'J' || key === 'j' || keyCode === 74)) {
      blocked = true;
      reason = 'Developer Console (Ctrl+Shift+J / Cmd+Option+J)';
    } else if (isModifier && (isShift || isAlt) && (key === 'C' || key === 'c' || keyCode === 67)) {
      blocked = true;
      reason = 'Element Inspector (Ctrl+Shift+C / Cmd+Option+C)';
    } else if (isModifier && (key === 'U' || key === 'u' || keyCode === 85)) {
      blocked = true;
      reason = 'View Page Source (Ctrl+U)';
    } else if (isModifier && (isShift || isAlt) && (key === 'K' || key === 'k' || keyCode === 75)) {
      blocked = true;
      reason = 'Console Shortcut (Ctrl+Shift+K)';
    } else if (isModifier && (isShift || isAlt) && (key === 'E' || key === 'e' || keyCode === 69)) {
      blocked = true;
      reason = 'Network Inspector (Ctrl+Shift+E)';
    } else if (isModifier && (key === 'S' || key === 's' || keyCode === 83)) {
      blocked = true;
      reason = 'Save Page Source (Ctrl+S)';
    }

    if (blocked) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }
      showModal(reason);
      return false;
    }
  }, true);

  document.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') {
      e.stopImmediatePropagation();
    }
    showModal('Right-click context menu inspection disabled');
    return false;
  }, true);

  function checkDimensions() {
    if (typeof window === 'undefined') return;
    var THRESHOLD = 160;
    var outerW = typeof window.outerWidth === 'number' ? window.outerWidth : 0;
    var innerW = typeof window.innerWidth === 'number' ? window.innerWidth : 0;
    var outerH = typeof window.outerHeight === 'number' ? window.outerHeight : 0;
    var innerH = typeof window.innerHeight === 'number' ? window.innerHeight : 0;
    var widthDiff = (outerW - innerW) > THRESHOLD;
    var heightDiff = (outerH - innerH) > THRESHOLD;

    if (widthDiff || heightDiff) {
      if (!devToolsReported) {
        devToolsReported = true;
        showModal('Developer tools window detected');
      }
    } else {
      devToolsReported = false;
    }
  }
  window.addEventListener('resize', checkDimensions);
  var dimensionTimer = setInterval(checkDimensions, 1000);
  if (dimensionTimer && typeof dimensionTimer.unref === 'function') {
    dimensionTimer.unref();
  }

  function checkDebugger() {
    if (typeof window === 'undefined') return;
    if (typeof performance === 'undefined' || typeof performance.now !== 'function') return;
    var start = performance.now();
    try {
      (function () {}).constructor('debugger')();
    } catch (_) {}
    if (performance.now() - start > 100) {
      showModal('Debugger execution paused');
    }
  }
  var debuggerTimer = setInterval(checkDebugger, 1500);
  if (debuggerTimer && typeof debuggerTimer.unref === 'function') {
    debuggerTimer.unref();
  }

  window.SecurityShield = {
    triggerWarning: showModal,
    dismissWarning: hideModal,
    isShieldActive: function () { return true; }
  };
})();
