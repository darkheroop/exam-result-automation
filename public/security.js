(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  var lastTriggerTime = 0;
  var THROTTLE_MS = 1500;
  var isModalVisible = false;
  var isDevToolsLocked = false;
  var autoDismissTimer = null;

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
      '  background: rgba(15, 23, 42, 0.94); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);' +
      '  display: flex; align-items: center; justify-content: center;' +
      '  z-index: 2147483647; opacity: 0; pointer-events: none;' +
      '  transition: opacity 0.25s ease;' +
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;' +
      '}' +
      '.security-shield-backdrop.active {' +
      '  opacity: 1; pointer-events: auto;' +
      '}' +
      '.security-shield-card {' +
      '  background: #0f172a; color: #f8fafc;' +
      '  border: 1.5px solid rgba(239, 68, 68, 0.6); border-radius: 16px;' +
      '  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.9), 0 0 40px rgba(239, 68, 68, 0.3);' +
      '  max-width: 480px; width: 90%; padding: 32px 24px; text-align: center;' +
      '  transform: scale(0.95); transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);' +
      '  box-sizing: border-box;' +
      '}' +
      '.security-shield-backdrop.active .security-shield-card {' +
      '  transform: scale(1);' +
      '}' +
      '.security-shield-icon {' +
      '  width: 64px; height: 64px; margin: 0 auto 18px auto; color: #ef4444;' +
      '  background: rgba(239, 68, 68, 0.15); border-radius: 50%;' +
      '  display: flex; align-items: center; justify-content: center;' +
      '}' +
      '.security-shield-title {' +
      '  font-size: 1.35rem; font-weight: 800; color: #ef4444; margin: 0 0 16px 0;' +
      '  letter-spacing: 0.5px; text-transform: uppercase;' +
      '}' +
      '.security-shield-body {' +
      '  font-size: 1.15rem; font-weight: 700; color: #f8fafc; line-height: 1.7;' +
      '  letter-spacing: 0.3px; background: rgba(239, 68, 68, 0.12); padding: 18px 22px;' +
      '  border-radius: 12px; border: 1px solid rgba(239, 68, 68, 0.3); margin: 0;' +
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
    iconWrap.innerHTML = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
    card.appendChild(iconWrap);

    titleElement = document.createElement('h3');
    titleElement.id = 'security-shield-title';
    titleElement.setAttribute('id', 'security-shield-title');
    titleElement.className = 'security-shield-title';
    titleElement.textContent = 'Restriction Prohbiated';
    card.appendChild(titleElement);

    bodyElement = document.createElement('p');
    bodyElement.id = 'security-shield-body';
    bodyElement.setAttribute('id', 'security-shield-body');
    bodyElement.className = 'security-shield-body';
    bodyElement.innerHTML = 'Beta Jab Mai Pheli Mai Tha<br>Tabb Tuu Theli Mai Tha';
    card.appendChild(bodyElement);

    modalBackdrop.appendChild(card);
    container.appendChild(modalBackdrop);

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

  function showModal(isDevTools) {
    var now = Date.now();
    if (modalBackdrop && !modalBackdrop.classList.contains('active')) {
      isModalVisible = false;
    }

    var devToolsActive = Boolean(isDevTools) || isDevToolsCurrentlyOpen();

    if (isModalVisible && !devToolsActive) {
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
          showModal(isDevTools);
        });
      }
      return;
    }

    if (titleElement) {
      titleElement.textContent = 'Restriction Prohbiated';
    }
    if (bodyElement) {
      bodyElement.innerHTML = 'Beta Jab Mai Pheli Mai Tha<br>Tabb Tuu Theli Mai Tha';
    }

    if (devToolsActive) {
      isDevToolsLocked = true;
      if (autoDismissTimer) {
        clearTimeout(autoDismissTimer);
        autoDismissTimer = null;
      }
      if (typeof document !== 'undefined' && document.body && document.body.style) {
        document.body.style.overflow = 'hidden';
      }
    } else {
      if (autoDismissTimer) clearTimeout(autoDismissTimer);
      autoDismissTimer = setTimeout(function () {
        if (!isDevToolsCurrentlyOpen() && !isDevToolsLocked) {
          hideModal(true);
        }
      }, 3500);
    }

    modal.classList.add('active');
    isModalVisible = true;
  }

  function hideModal(force) {
    if (!force && (isDevToolsCurrentlyOpen() || isDevToolsLocked)) {
      return;
    }
    if (autoDismissTimer) {
      clearTimeout(autoDismissTimer);
      autoDismissTimer = null;
    }
    if (modalBackdrop) {
      modalBackdrop.classList.remove('active');
    }
    isModalVisible = false;
    isDevToolsLocked = false;
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

    if (key === 'F12' || keyCode === 123) {
      blocked = true;
    } else if (isModifier && (isShift || isAlt) && (key === 'I' || key === 'i' || keyCode === 73)) {
      blocked = true;
    } else if (isModifier && (isShift || isAlt) && (key === 'J' || key === 'j' || keyCode === 74)) {
      blocked = true;
    } else if (isModifier && (isShift || isAlt) && (key === 'C' || key === 'c' || keyCode === 67)) {
      blocked = true;
    } else if (isModifier && (key === 'U' || key === 'u' || keyCode === 85)) {
      blocked = true;
    } else if (isModifier && (isShift || isAlt) && (key === 'K' || key === 'k' || keyCode === 75)) {
      blocked = true;
    } else if (isModifier && (isShift || isAlt) && (key === 'E' || key === 'e' || keyCode === 69)) {
      blocked = true;
    } else if (isModifier && (key === 'S' || key === 's' || keyCode === 83)) {
      blocked = true;
    }

    if (blocked) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }
      showModal(false);
      return false;
    }
  }, true);

  document.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') {
      e.stopImmediatePropagation();
    }
    showModal(false);
    return false;
  }, true);

  function checkDevTools() {
    if (typeof window === 'undefined') return;
    var isOpen = isDevToolsCurrentlyOpen();
    if (isOpen) {
      isDevToolsLocked = true;
      showModal(true);
    } else if (isDevToolsLocked) {
      isDevToolsLocked = false;
      hideModal(true);
    }
  }

  window.addEventListener('resize', checkDevTools);
  window.addEventListener('focus', checkDevTools);

  var pollTimer = setInterval(checkDevTools, 350);
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
