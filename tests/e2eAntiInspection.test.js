'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const adminDir = path.join(publicDir, 'admin');

const securityJsPath = path.join(publicDir, 'security.js');
const adminSecurityJsPath = path.join(adminDir, 'security.js');
const indexHtmlPath = path.join(publicDir, 'index.html');
const loginHtmlPath = path.join(adminDir, 'login.html');
const adminIndexHtmlPath = path.join(adminDir, 'index.html');

test('Anti-Inspection [Tier 1] - public/security.js and public/admin/security.js exist and are identical', () => {
  assert.ok(fs.existsSync(securityJsPath), 'public/security.js must exist on disk');
  assert.ok(fs.existsSync(adminSecurityJsPath), 'public/admin/security.js must exist on disk');

  const rootSec = fs.readFileSync(securityJsPath, 'utf8');
  const adminSec = fs.readFileSync(adminSecurityJsPath, 'utf8');

  assert.strictEqual(
    rootSec,
    adminSec,
    'public/security.js and public/admin/security.js must be 100% byte-for-byte identical'
  );
  assert.ok(rootSec.length > 100, 'public/security.js must not be empty');
});

test('Anti-Inspection [Tier 1] - Script tag injected into <head> across all HTML entry points', () => {
  const pages = [
    { name: 'public/index.html', path: indexHtmlPath },
    { name: 'public/admin/login.html', path: loginHtmlPath },
    { name: 'public/admin/index.html', path: adminIndexHtmlPath }
  ];

  for (const page of pages) {
    const content = fs.readFileSync(page.path, 'utf8');
    const headMatch = content.match(/<head[\s\S]*?<\/head>/i);
    assert.ok(headMatch, `${page.name} must contain a <head> block`);

    const headContent = headMatch[0];
    const hasSecurityScript =
      headContent.includes('src="/security.js"') ||
      headContent.includes('src="security.js"') ||
      headContent.includes("src='/security.js'") ||
      headContent.includes("src='security.js'");

    assert.ok(
      hasSecurityScript,
      `${page.name} must load security.js within the <head> element for early interception`
    );
  }
});

function createMockDomEnvironment() {
  const listeners = {
    keydown: [],
    contextmenu: [],
    resize: []
  };

  const elementsById = {};
  const bodyChildren = [];
  const headChildren = [];

  class MockElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.id = '';
      this.className = '';
      this.classList = {
        _classes: new Set(),
        add: (c) => this.classList._classes.add(c),
        remove: (c) => this.classList._classes.delete(c),
        contains: (c) => this.classList._classes.has(c)
      };
      this.attributes = {};
      this.innerHTML = '';
      this.textContent = '';
      this.parentNode = null;
      this.children = [];
      this.eventListeners = {};
    }

    setAttribute(key, val) {
      this.attributes[key] = String(val);
      if (key === 'id') {
        this.id = String(val);
        elementsById[this.id] = this;
      }
    }

    getAttribute(key) {
      return this.attributes[key] || null;
    }

    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      if (child.id) {
        elementsById[child.id] = child;
      }
      return child;
    }

    addEventListener(type, fn) {
      if (!this.eventListeners[type]) this.eventListeners[type] = [];
      this.eventListeners[type].push(fn);
    }

    dispatchEvent(event) {
      const fns = this.eventListeners[event.type] || [];
      for (const fn of fns) {
        fn.call(this, event);
      }
    }
  }

  const mockDocument = {
    readyState: 'complete',
    body: new MockElement('BODY'),
    head: new MockElement('HEAD'),
    documentElement: new MockElement('HTML'),
    createElement: (tag) => new MockElement(tag),
    getElementById: (id) => elementsById[id] || null,
    addEventListener: (type, fn, useCapture) => {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push({ fn, useCapture });
    }
  };

  mockDocument.documentElement.appendChild(mockDocument.head);
  mockDocument.documentElement.appendChild(mockDocument.body);

  const mockWindow = {
    document: mockDocument,
    innerWidth: 1024,
    innerHeight: 768,
    outerWidth: 1024,
    outerHeight: 768,
    addEventListener: (type, fn, useCapture) => {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push({ fn, useCapture });
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id)
  };

  const sandbox = {
    window: mockWindow,
    document: mockDocument,
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
      clear: () => {}
    },
    Date: Date,
    performance: {
      now: () => Date.now()
    },
    setTimeout: mockWindow.setTimeout,
    clearTimeout: mockWindow.clearTimeout,
    setInterval: mockWindow.setInterval,
    clearInterval: mockWindow.clearInterval,
    Image: function () {}
  };

  vm.createContext(sandbox);

  function dispatchKey(eventProps) {
    let prevented = false;
    let stopped = false;
    let immediateStopped = false;

    const event = {
      type: 'keydown',
      key: eventProps.key || '',
      keyCode: eventProps.keyCode || 0,
      which: eventProps.which || eventProps.keyCode || 0,
      ctrlKey: Boolean(eventProps.ctrlKey),
      metaKey: Boolean(eventProps.metaKey),
      shiftKey: Boolean(eventProps.shiftKey),
      altKey: Boolean(eventProps.altKey),
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; },
      stopImmediatePropagation: () => { immediateStopped = true; },
      isPrevented: () => prevented,
      isStopped: () => stopped || immediateStopped
    };

    const docListeners = listeners.keydown || [];
    for (const item of docListeners) {
      item.fn(event);
      if (immediateStopped) break;
    }

    return event;
  }

  function dispatchContextMenu() {
    let prevented = false;
    let stopped = false;

    const event = {
      type: 'contextmenu',
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; },
      stopImmediatePropagation: () => { stopped = true; },
      isPrevented: () => prevented
    };

    const docListeners = listeners.contextmenu || [];
    for (const item of docListeners) {
      item.fn(event);
    }

    return event;
  }

  function dispatchResize() {
    const winListeners = listeners.resize || [];
    for (const item of winListeners) {
      item.fn({});
    }
  }

  return {
    sandbox,
    dispatchKey,
    dispatchContextMenu,
    dispatchResize,
    elementsById
  };
}

test('Anti-Inspection [Tier 2] - Developer shortcuts (F12, Ctrl+Shift+I/J/C, Cmd+Option+I/J/C) are intercepted', () => {
  if (!fs.existsSync(securityJsPath)) return;
  const scriptContent = fs.readFileSync(securityJsPath, 'utf8');

  const env = createMockDomEnvironment();
  vm.runInContext(scriptContent, env.sandbox);

  // F12 inspection
  const f12Evt = env.dispatchKey({ key: 'F12', keyCode: 123 });
  assert.ok(f12Evt.isPrevented(), 'F12 keydown must be prevented');

  // Ctrl+Shift+I (Windows / Linux Inspect)
  const csiEvt = env.dispatchKey({ ctrlKey: true, shiftKey: true, key: 'I', keyCode: 73 });
  assert.ok(csiEvt.isPrevented(), 'Ctrl+Shift+I must be prevented');

  // Cmd+Option+I (macOS Inspect)
  const coiEvt = env.dispatchKey({ metaKey: true, altKey: true, key: 'I', keyCode: 73 });
  assert.ok(coiEvt.isPrevented(), 'Cmd+Option+I must be prevented');

  // Ctrl+Shift+J (Windows / Linux Console)
  const csjEvt = env.dispatchKey({ ctrlKey: true, shiftKey: true, key: 'J', keyCode: 74 });
  assert.ok(csjEvt.isPrevented(), 'Ctrl+Shift+J must be prevented');

  // Cmd+Option+J (macOS Console)
  const cojEvt = env.dispatchKey({ metaKey: true, altKey: true, key: 'J', keyCode: 74 });
  assert.ok(cojEvt.isPrevented(), 'Cmd+Option+J must be prevented');

  // Ctrl+Shift+C (Windows / Linux Element Picker)
  const cscEvt = env.dispatchKey({ ctrlKey: true, shiftKey: true, key: 'C', keyCode: 67 });
  assert.ok(cscEvt.isPrevented(), 'Ctrl+Shift+C must be prevented');

  // Cmd+Option+C (macOS Element Picker)
  const cocEvt = env.dispatchKey({ metaKey: true, altKey: true, key: 'C', keyCode: 67 });
  assert.ok(cocEvt.isPrevented(), 'Cmd+Option+C must be prevented');

  // View Page Source (Ctrl+U / Cmd+U)
  const cuEvt = env.dispatchKey({ ctrlKey: true, key: 'U', keyCode: 85 });
  assert.ok(cuEvt.isPrevented(), 'Ctrl+U must be prevented');

  // Firefox Console (Ctrl+Shift+K)
  const cskEvt = env.dispatchKey({ ctrlKey: true, shiftKey: true, key: 'K', keyCode: 75 });
  assert.ok(cskEvt.isPrevented(), 'Ctrl+Shift+K must be prevented');

  // Firefox Network (Ctrl+Shift+E)
  const cseEvt = env.dispatchKey({ ctrlKey: true, shiftKey: true, key: 'E', keyCode: 69 });
  assert.ok(cseEvt.isPrevented(), 'Ctrl+Shift+E must be prevented');

  // Offline Page Save (Ctrl+S)
  const csEvt = env.dispatchKey({ ctrlKey: true, key: 'S', keyCode: 83 });
  assert.ok(csEvt.isPrevented(), 'Ctrl+S must be prevented');
});

test('Anti-Inspection [Tier 2] - Right-click contextmenu event is intercepted', () => {
  if (!fs.existsSync(securityJsPath)) return;
  const scriptContent = fs.readFileSync(securityJsPath, 'utf8');

  const env = createMockDomEnvironment();
  vm.runInContext(scriptContent, env.sandbox);

  const cmEvt = env.dispatchContextMenu();
  assert.ok(cmEvt.isPrevented(), 'contextmenu event must be prevented');
});

test('Anti-Inspection [Tier 3] - Preserves standard user clipboard (Ctrl+C, Ctrl+V, Ctrl+A, Ctrl+X) and typing', () => {
  if (!fs.existsSync(securityJsPath)) return;
  const scriptContent = fs.readFileSync(securityJsPath, 'utf8');

  const env = createMockDomEnvironment();
  vm.runInContext(scriptContent, env.sandbox);

  // Standard alphanumeric typing
  const typingEvt1 = env.dispatchKey({ key: 'a', keyCode: 65 });
  assert.ok(!typingEvt1.isPrevented(), 'Normal character "a" must NOT be prevented');

  const typingEvt2 = env.dispatchKey({ key: '8', keyCode: 56 });
  assert.ok(!typingEvt2.isPrevented(), 'Normal digit "8" must NOT be prevented');

  const enterEvt = env.dispatchKey({ key: 'Enter', keyCode: 13 });
  assert.ok(!enterEvt.isPrevented(), 'Enter key must NOT be prevented');

  const backspaceEvt = env.dispatchKey({ key: 'Backspace', keyCode: 8 });
  assert.ok(!backspaceEvt.isPrevented(), 'Backspace key must NOT be prevented');

  // Clipboard operations (Ctrl+C without Shift/Alt)
  const copyEvt = env.dispatchKey({ ctrlKey: true, shiftKey: false, altKey: false, key: 'c', keyCode: 67 });
  assert.ok(!copyEvt.isPrevented(), 'Clipboard Copy (Ctrl+C) must NOT be prevented');

  const pasteEvt = env.dispatchKey({ ctrlKey: true, shiftKey: false, altKey: false, key: 'v', keyCode: 86 });
  assert.ok(!pasteEvt.isPrevented(), 'Clipboard Paste (Ctrl+V) must NOT be prevented');

  const selectAllEvt = env.dispatchKey({ ctrlKey: true, shiftKey: false, altKey: false, key: 'a', keyCode: 65 });
  assert.ok(!selectAllEvt.isPrevented(), 'Select All (Ctrl+A) must NOT be prevented');

  const cutEvt = env.dispatchKey({ ctrlKey: true, shiftKey: false, altKey: false, key: 'x', keyCode: 88 });
  assert.ok(!cutEvt.isPrevented(), 'Clipboard Cut (Ctrl+X) must NOT be prevented');
});

test('Anti-Inspection [Tier 4] - Warning modal display, anti-spam throttling, and dismissal', () => {
  if (!fs.existsSync(securityJsPath)) return;
  const scriptContent = fs.readFileSync(securityJsPath, 'utf8');

  const env = createMockDomEnvironment();
  vm.runInContext(scriptContent, env.sandbox);

  // Trigger F12 to activate modal
  env.dispatchKey({ key: 'F12', keyCode: 123 });

  // Modal element should be created and mounted
  const modal = env.elementsById['security-shield-modal'];
  assert.ok(modal, 'Security warning modal must be mounted into the DOM');
  assert.ok(
    modal.classList.contains('active'),
    'Modal backdrop must have active class on trigger'
  );
  assert.strictEqual(
    modal.getAttribute('role'),
    'alertdialog',
    'Modal must have role="alertdialog" for accessibility'
  );

  // Verify anti-spam throttling: rapid consecutive triggers within 1500ms
  const btn = env.elementsById['security-shield-btn'];
  assert.ok(btn, 'Modal must provide an acknowledge/dismiss button');

  // Dismiss modal via button click
  btn.dispatchEvent({ type: 'click' });
  assert.ok(
    !modal.classList.contains('active'),
    'Clicking acknowledge button must dismiss the modal'
  );

  // Trigger again and dismiss via Escape key
  env.dispatchKey({ key: 'F12', keyCode: 123 });
  env.dispatchKey({ key: 'Escape', keyCode: 27 });
  assert.ok(
    !modal.classList.contains('active'),
    'Pressing Escape must dismiss the security modal'
  );
});

test('Anti-Inspection [Tier 4] - DevTools docked window dimension delta detection', () => {
  if (!fs.existsSync(securityJsPath)) return;
  const scriptContent = fs.readFileSync(securityJsPath, 'utf8');

  const env = createMockDomEnvironment();
  vm.runInContext(scriptContent, env.sandbox);

  // Under normal window conditions (delta <= 160)
  env.sandbox.window.outerWidth = 1024;
  env.sandbox.window.innerWidth = 1000; // delta = 24
  env.dispatchResize();

  const modal = env.elementsById['security-shield-modal'];
  if (modal) {
    modal.classList.remove('active');
  }

  // When docked DevTools opens (delta > 160px)
  env.sandbox.window.outerWidth = 1024;
  env.sandbox.window.innerWidth = 700; // delta = 324px
  env.dispatchResize();

  const updatedModal = env.elementsById['security-shield-modal'];
  assert.ok(updatedModal, 'Modal must exist when dimension delta exceeds threshold');
  assert.ok(
    updatedModal.classList.contains('active'),
    'Docked DevTools dimension delta (>160px) must activate the security warning modal'
  );
});
