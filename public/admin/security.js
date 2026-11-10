(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  var lastTriggerTime = 0;
  var THROTTLE_MS = 1500;
  var isModalVisible = false;
  var isDevToolsLocked = false;
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
      '  background: rgba(15, 23, 42, 0.92); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);' +
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
      '  border: 1.5px solid rgba(239, 68, 68, 0.55); border-radius: 14px;' +
      '  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.8), 0 0 35px rgba(239, 68, 68, 0.25);' +
      '  max-width: 480px; width: 90%; padding: 28px; text-align: center;' +
      '  transform: scale(0.95); transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);' +
      '  box-sizing: border-box;' +
      '}' +
      '.security-shield-backdrop.active .security-shield-card {' +
      '  transform: scale(1);' +
      '}' +
      '.security-shield-icon {' +
      '  width: 56px; height: 56px; margin: 0 auto 16px auto; color: #ef4444;' +
      '  background: rgba(239, 68, 68, 0.15); border-radius: 50%;' +
      '  display: flex; align-items: center; justify-content: center;' +
      '}' +
      '.security-shield-title {' +
      '  font-size: 1.25rem; font-weight: 700; color: #ffffff; margin: 0 0 10px 0;' +
      '}' +
      '.security-shield-body {' +
      '  font-size: 0.9rem; color: #cbd5e1; line-height: 1.55; margin: 0 0 16px 0;' +
      '}' +
      '.security-shield-reason {' +
      '  font-size: 0.825rem; color: #fca5a5; background: rgba(239, 68, 68, 0.14);' +
      '  padding: 10px 14px; border-radius: 8px; margin-bottom: 20px;' +
      '  border: 1px solid rgba(239, 68, 68, 0.25);' +
      '  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; word-break: break-word;' +
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
  var titleElement = null;
  var bodyElement = null;
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
    iconWrap.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
    card.appendChild(iconWrap);

    titleElement = document.createElement('h3');
    titleElement.id = 'security-shield-title';
    titleElement.setAttribute('id', 'security-shield-title');
    titleElement.className = 'security-shield-title';
    titleElement.textContent = 'Security Alert: Inspection Prohibited';
    card.appendChild(titleElement);

    bodyElement = document.createElement('p');
    bodyElement.className = 'security-shield-body';
    bodyElement.textContent = 'Developer tools, shortcuts, and page inspection have been disabled for security and integrity.';
    card.appendChild(bodyElement);

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

    acknowledgeBtn.addEventListener('click', function () {
      if (isDevToolsCurrentlyOpen() || isDevToolsLocked) {
        if (reasonElement) {
          reasonElement.textContent = 'Developer Tools are still open. Please close Developer Tools (or press F12) to continue.';
        }
        return;
      }
      hideModal(true);
    });

    modalBackdrop.addEventListener('click', function (e) {
      if (e.target === modalBackdrop) {
        if (isDevToolsCurrentlyOpen() || isDevToolsLocked) {
          if (reasonElement) {
            reasonElement.textContent = 'Developer Tools are still open. Please close Developer Tools (or press F12) to continue.';
          }
          return;
        }
        hideModal(true);
      }
    });

    return modalBackdrop;
  }

  function checkDimensions() {
    if (typeof window === 'undefined') return false;
    var THRESHOLD = 160;
    var outerW = typeof window.outerWidth === 'number' ? window.outerWidth : 0;
    var innerW = typeof window.innerWidth === 'number' ? window.innerWidth : 0;
    var outerH = typeof window.outerHeight === 'number' ? window.outerHeight : 0;
    var innerH = typeof window.innerHeight === 'number' ? window.innerHeight : 0;
    return (outerW - innerW > THRESHOLD) || (outerH - innerH > THRESHOLD);
  }

  function checkDebugger() {
    if (typeof window === 'undefined') return false;
    if (typeof performance === 'undefined' || typeof performance.now !== 'function') return false;
    var start = performance.now();
    try {
      (function () {}).constructor('debugger')();
    } catch (_) {}
    return (performance.now() - start > 100);
  }

  function isDevToolsCurrentlyOpen() {
    return checkDimensions() || checkDebugger();
  }

  function showModal(reason, isDevTools) {
    var now = Date.now();
    if (modalBackdrop && !modalBackdrop.classList.contains('active')) {
      isModalVisible = false;
    }

    var devToolsActive = Boolean(isDevTools) || isDevToolsCurrentlyOpen();

    if (isModalVisible && !devToolsActive) {
      if (reasonElement && reason) {
        reasonElement.textContent = reason;
      }
      return;
    }

    if (!devToolsActive && (now - lastTriggerTime < THROTTLE_MS)) {
      return;
    }
    lastTriggerTime = now;

    var modal = ensureModalMounted();
    if (!modal) {
      if (typeof document !== 'undefined' && document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
          showModal(reason, isDevTools);
        });
      }
      return;
    }

    if (devToolsActive) {
      isDevToolsLocked = true;
      if (titleElement) {
        titleElement.textContent = 'Developer Tools Detected';
      }
      if (bodyElement) {
        bodyElement.textContent = 'Access to this website is blocked while Developer Tools or inspect mode are open. For security and data integrity, you cannot use this website until Developer Tools are completely closed.';
      }
      if (reasonElement) {
        reasonElement.textContent = reason || 'Developer Tools are active. Please close Developer Tools (or press F12) to continue.';
      }
      if (acknowledgeBtn) {
        acknowledgeBtn.textContent = 'Close Developer Tools to Continue';
      }
      if (typeof document !== 'undefined' && document.body && document.body.style) {
        document.body.style.overflow = 'hidden';
      }
    } else {
      if (titleElement) {
        titleElement.textContent = 'Security Alert: Inspection Prohibited';
      }
      if (bodyElement) {
        bodyElement.textContent = 'Developer tools, shortcuts, and page inspection have been disabled for security and integrity.';
      }
      if (reasonElement) {
        reasonElement.textContent = reason || 'Unauthorized inspection attempt detected';
      }
      if (acknowledgeBtn) {
        acknowledgeBtn.textContent = 'Acknowledge & Continue';
      }
    }

    modal.classList.add('active');
    isModalVisible = true;
  }

  function hideModal(force) {
    if (!force && (isDevToolsCurrentlyOpen() || isDevToolsLocked)) {
      if (reasonElement) {
        reasonElement.textContent = 'Developer Tools are still open. Please close Developer Tools to continue.';
      }
      return;
    }
    if (modalBackdrop) {
      modalBackdrop.classList.remove('active');
    }
    isModalVisible = false;
    isDevToolsLocked = false;
    devToolsReported = false;
    lastTriggerTime = 0;
    if (typeof document !== 'undefined' && document.body && document.body.style) {
      document.body.style.overflow = '';
    }
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (isDevToolsCurrentlyOpen() || isDevToolsLocked) {
        e.preventDefault();
        e.stopPropagation();
        if (reasonElement) {
          reasonElement.textContent = 'Developer Tools are still open. Please close Developer Tools to continue.';
        }
        return false;
      }
      if (isModalVisible || (modalBackdrop && modalBackdrop.classList.contains('active'))) {
        hideModal(true);
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
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

  function checkDevTools() {
    if (typeof window === 'undefined') return;
    var isOpen = isDevToolsCurrentlyOpen();
    if (isOpen) {
      if (!devToolsReported || !isDevToolsLocked) {
        devToolsReported = true;
        isDevToolsLocked = true;
        showModal('Developer Tools window detected. Please close Developer Tools to continue.', true);
      }
    } else if (isDevToolsLocked) {
      devToolsReported = false;
      isDevToolsLocked = false;
      hideModal(true);
    }
  }

  window.addEventListener('resize', checkDevTools);
  window.addEventListener('focus', checkDevTools);

  var pollTimer = setInterval(checkDevTools, 400);
  if (pollTimer && typeof pollTimer.unref === 'function') {
    pollTimer.unref();
  }

  window.SecurityShield = {
    triggerWarning: showModal,
    dismissWarning: function () { hideModal(true); },
    isShieldActive: function () { return true; },
    isDevToolsOpen: isDevToolsCurrentlyOpen
  };
})();
