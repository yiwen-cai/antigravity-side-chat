/**
 * Host Renderer Text-Selection Quote Bridge for Antigravity Side Chat
 *
 * Connects to the Antigravity 2.0 host renderer via Chrome DevTools Protocol (CDP),
 * detects text selection popups (.selection-quote-popup), injects a native
 * "Side Chat" action button, and orchestrates:
 * 1. Text selection capture & dismissal
 * 2. Bi-directional delivery via CDP runtime binding (__agSideChatQuoteBindingV1)
 * 3. Aux Pane activation (Direct tab click + React Fiber onSidecarLinkClick fallback)
 * 4. Multi-stage iframe postMessage dispatch (0ms, 120ms, 300ms, 600ms, 1000ms)
 * 5. Auto-pin and auto-open on app startup
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BINDING_NAME = '__agSideChatQuoteBindingV1';

/**
 * Client-side script injected into the Antigravity host renderer window.
 */
const CLIENT_INJECT_SCRIPT = `(() => {
  if (window.__agSideChatBridgeInstalled) {
    try { window.__agSideChatBridgeUninstall?.(); } catch (_) {}
  }
  window.__agSideChatBridgeInstalled = true;

  // 1. Inject persistent stylesheet so .selection-quote-popup fits both Quote and Side Chat buttons
  try {
    let styleEl = document.getElementById('__ag-sidechat-quote-style');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = '__ag-sidechat-quote-style';
      styleEl.textContent = [
        '.selection-quote-popup {',
        '  width: auto !important;',
        '  min-width: 168px !important;',
        '}'
      ].join('\\n');
      (document.head || document.documentElement).appendChild(styleEl);
    }
  } catch (err) {
    console.error('[SideChatBridge] Failed to inject popup style:', err);
  }

  // 2. Track selection changes to reliably cache user text selection
  let lastCachedSelection = '';
  function updateCachedSelection() {
    try {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      if (text) {
        lastCachedSelection = text;
      }
    } catch (_) {}
  }
  document.addEventListener('selectionchange', updateCachedSelection, { passive: true });

  // 3. Resolve active conversation ID from DOM or location pathname
  function getConversationId() {
    try {
      const cascadeEl = document.querySelector('[data-cascade-id]');
      const attrId = cascadeEl ? cascadeEl.getAttribute('data-cascade-id') : null;
      if (attrId) return attrId;

      const match = location.pathname.match(/\\/c\\/([0-9a-f-]{36})/i);
      if (match && match[1]) return match[1];
    } catch (_) {}
    return '';
  }

  // Helper: Safely unpin Side Chat (/btw) if it was previously auto-pinned
  function unpinSideChatIfPinned() {
    try {
      const root = document.getElementById('root');
      if (!root) return false;
      const fiberKey = Object.keys(root).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'));
      if (!fiberKey) return false;

      const queue = [root[fiberKey]];
      let visited = 0;
      let storageService = null;
      while (queue.length > 0 && visited < 4000) {
        const node = queue.shift();
        visited++;
        if (!node) continue;
        if (node.memoizedProps?.value?.core?.storageService) {
          storageService = node.memoizedProps.value.core.storageService;
          break;
        }
        if (node.child) queue.push(node.child);
        if (node.sibling) queue.push(node.sibling);
      }

      if (!storageService || typeof storageService.get !== 'function' || typeof storageService.store !== 'function') {
        return false;
      }

      let list = [];
      try {
        const raw = storageService.get('aux-pane-v2-pinned-tabs', 0, '[]');
        list = JSON.parse(raw);
        if (!Array.isArray(list)) list = [];
      } catch (_) {
        list = [];
      }

      const filtered = list.filter(t => !(t && t.kind === 'sidecar' && t.sidecarId === 'side-chat/panel'));
      if (filtered.length !== list.length) {
        storageService.store('aux-pane-v2-pinned-tabs', JSON.stringify(filtered), 0, 0);
      }
      return true;
    } catch (err) {
      console.error('[SideChatBridge] unpinSideChatIfPinned error:', err);
      return false;
    }
  }

  // Run cleanup once on load to ensure Side Chat is not auto-pinned to top
  try { unpinSideChatIfPinned(); } catch (_) {}

  // Helper: Activate Side Chat (/btw) Tab
  function activateSideChatTab() {
    try {
      const activeTabId = document.querySelector('[data-active-tab-id]')?.getAttribute('data-active-tab-id');
      if (activeTabId === 'sidecar__side-chat/panel__/') {
        return true;
      }

      // Check tab button in tab bar
      const tabBtn = document.querySelector('[data-tab-id="sidecar__side-chat/panel__/"]')
        || document.querySelector('[data-testid="aux-pane-tab-sidecar__side-chat/panel__/"]')
        || document.querySelector('[data-tab-id*="side-chat"]');

      if (tabBtn) {
        tabBtn.click();
        return true;
      }

      // Check card button in new tab view
      const cardBtn = Array.from(document.querySelectorAll('button')).find(
        b => (b.title && b.title.includes('Side Chat')) || (b.innerText && b.innerText.includes('Side Chat'))
      );
      if (cardBtn) {
        cardBtn.click();
        return true;
      }

      // Fallback: React Fiber onSidecarLinkClick with full scheme
      const root = document.getElementById('root');
      if (root) {
        const fiberKey = Object.keys(root).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'));
        if (fiberKey) {
          const queue = [root[fiberKey]];
          let visited = 0;
          while (queue.length > 0 && visited < 4000) {
            const node = queue.shift();
            visited++;
            if (!node) continue;
            if (node.memoizedProps && typeof node.memoizedProps.onSidecarLinkClick === 'function') {
              node.memoizedProps.onSidecarLinkClick('sidecar://side-chat/panel/');
              return true;
            }
            if (node.child) queue.push(node.child);
            if (node.sibling) queue.push(node.sibling);
          }
        }
      }
    } catch (err) {
      console.error('[SideChatBridge] activateSideChatTab error:', err);
    }
    return false;
  }

  // 4. Open and activate Side Chat Aux Pane tab and notify iframe
  function openAndActivateSideChat(quotePayloadOrConvId, quotedText, quoteTimestamp) {
    let quotePayload = null;
    if (quotePayloadOrConvId && typeof quotePayloadOrConvId === 'object' && quotePayloadOrConvId.quotedText) {
      quotePayload = quotePayloadOrConvId;
    } else if (quotedText) {
      quotePayload = {
        conversationId: (typeof quotePayloadOrConvId === 'string' ? quotePayloadOrConvId : '') || getConversationId(),
        quotedText: quotedText,
        timestamp: quoteTimestamp || Date.now()
      };
    }

    // Open Aux Pane & Activate Side Chat (/btw) Tab (without forcing it to be pinned):
    try {
      const auxPane = document.querySelector('[data-aux-pane-open]');
      const isClosed = !auxPane || auxPane.getAttribute('data-aux-pane-open') === 'false';
      if (isClosed) {
        const toggleBtn = document.querySelector('[data-testid="toggle-aux-sidebar"]')
          || document.querySelector('[aria-label="Toggle Auxiliary Pane"]');
        if (toggleBtn) {
          try { toggleBtn.click(); } catch (_) {}
        }
      }

      activateSideChatTab();
      const delays = [60, 180, 360, 600, 1000];
      for (const d of delays) {
        setTimeout(activateSideChatTab, d);
      }
    } catch (err) {
      console.error('[SideChatBridge] open/activate error:', err);
    }

    // Dispatch focus-input at multiple stages
    const focusDelays = [80, 200, 400];
    for (const delay of focusDelays) {
      setTimeout(broadcastFocusInput, delay);
    }

    // Step C (Deliver quote payload via postMessage to Side Chat iframe(s) when quotePayload is provided):
    if (quotePayload) {
      function broadcastQuote() {
        try {
          const postData = {
            type: 'side-chat-quote',
            ...quotePayload,
            payload: quotePayload
          };
          const iframes = document.querySelectorAll(
            'iframe[src*="side-chat"], iframe[title*="Side Chat"], [data-sidecar-id="side-chat/panel"] iframe, iframe[data-testid="sidecar-iframe"]'
          );
          for (const iframe of iframes) {
            try {
              iframe.contentWindow?.postMessage(postData, '*');
            } catch (_) {}
          }
        } catch (_) {}
      }

      const delays = [0, 120, 300, 600, 1000];
      for (const delay of delays) {
        if (delay === 0) {
          broadcastQuote();
        } else {
          setTimeout(broadcastQuote, delay);
        }
      }
    }
  }

  // Helper: Broadcast focus-input event to Side Chat iframe(s)
  function broadcastFocusInput() {
    try {
      const iframes = document.querySelectorAll(
        'iframe[src*="side-chat"], iframe[title*="Side Chat"], [data-sidecar-id="side-chat/panel"] iframe, iframe[data-testid="sidecar-iframe"]'
      );
      for (const iframe of iframes) {
        try {
          iframe.contentWindow?.postMessage({ type: 'focus-input' }, '*');
        } catch (_) {}
      }
    } catch (_) {}
  }

  // 5. Global shortcut handler (Shift+Command+S on macOS, Shift+Ctrl+S on Windows/Linux)
  function handleGlobalKeydown(e) {
    const isShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 's' || e.key === 'S' || e.code === 'KeyS' || e.keyCode === 83);
    if (!isShortcut) return;

    e.preventDefault();
    e.stopPropagation();

    const currentSel = window.getSelection()?.toString()?.trim();
    const quotedText = currentSel || lastCachedSelection || '';
    const conversationId = getConversationId();
    const quoteTimestamp = Date.now();

    if (quotedText) {
      // Dismiss native selection popup
      try {
        const sel = window.getSelection();
        if (sel && sel.removeAllRanges) {
          sel.removeAllRanges();
        }
      } catch (_) {}

      lastCachedSelection = '';

      const quotePayload = {
        conversationId,
        quotedText,
        timestamp: quoteTimestamp
      };

      // Send quote back to Node.js via CDP binding
      if (typeof window.__agSideChatQuoteBindingV1 === 'function') {
        try {
          window.__agSideChatQuoteBindingV1(JSON.stringify({
            type: 'quote',
            ...quotePayload
          }));
        } catch (bindingErr) {
          console.error('[SideChatBridge] Failed to call CDP binding:', bindingErr);
        }
      }

      openAndActivateSideChat(quotePayload);
    } else {
      openAndActivateSideChat(conversationId);
    }

    const focusDelays = [80, 200, 400];
    for (const delay of focusDelays) {
      setTimeout(broadcastFocusInput, delay);
    }
  }

  // Register in capture phase so shortcut is captured before page editors/default actions
  document.addEventListener('keydown', handleGlobalKeydown, true);

  // 6. Handle Side Chat button click
  function handleSideChatClick() {
    try {
      const currentSel = window.getSelection()?.toString()?.trim();
      const quotedText = currentSel || lastCachedSelection || '';
      const conversationId = getConversationId();
      const quoteTimestamp = Date.now();

      // Dismiss native selection popup
      try {
        const sel = window.getSelection();
        if (sel && sel.removeAllRanges) {
          sel.removeAllRanges();
        }
      } catch (_) {}

      lastCachedSelection = '';

      // Quote payload
      const quotePayload = {
        conversationId,
        quotedText,
        timestamp: quoteTimestamp
      };

      // Send quote back to Node.js via CDP binding
      if (typeof window.__agSideChatQuoteBindingV1 === 'function') {
        try {
          window.__agSideChatQuoteBindingV1(JSON.stringify({
            type: 'quote',
            ...quotePayload
          }));
        } catch (bindingErr) {
          console.error('[SideChatBridge] Failed to call CDP binding:', bindingErr);
        }
      }

      // Open/activate Side Chat aux pane
      openAndActivateSideChat(quotePayload);
    } catch (err) {
      console.error('[SideChatBridge] Click handler error:', err);
    }
  }

  // 7. Inject button into native quote popup
  function injectSideChatButton() {
    try {
      const popups = document.querySelectorAll('.selection-quote-popup');
      for (const popup of popups) {
        const quoteBtn = popup.querySelector('[data-testid="selection-quote-button"]');
        if (!quoteBtn) continue;
        if (popup.querySelector('[data-testid="selection-sidechat-button"]')) continue;

        // Ensure popup container width is auto and min-width is 168px
        popup.style.setProperty('width', 'auto', 'important');
        popup.style.setProperty('min-width', '168px', 'important');

        const sideChatBtn = document.createElement('button');
        sideChatBtn.type = 'button';
        sideChatBtn.setAttribute('data-testid', 'selection-sidechat-button');
        sideChatBtn.className = quoteBtn.className || 'flex items-center gap-1 justify-center px-2 py-1 transition-colors cursor-pointer hover:bg-secondary text-xs flex-1 min-w-0';
        sideChatBtn.style.borderLeft = '1px solid var(--border, rgba(128, 128, 128, 0.25))';
        sideChatBtn.style.whiteSpace = 'nowrap';
        sideChatBtn.innerHTML = [
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="flex-none opacity-80" style="display:inline-block;vertical-align:middle;margin-right:3px;">',
          '  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>',
          '</svg>',
          '<span class="text-xs font-medium">Side Chat</span>'
        ].join('');

        // Prevent selection loss when clicking inside the popup
        sideChatBtn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        sideChatBtn.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });

        sideChatBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          handleSideChatClick();
        });

        quoteBtn.parentNode.insertBefore(sideChatBtn, quoteBtn.nextSibling);
      }
    } catch (err) {
      console.error('[SideChatBridge] Error injecting sidechat button:', err);
    }
  }

  // 8. Observe DOM mutations for popup mounting
  const observer = new MutationObserver(() => {
    injectSideChatButton();
  });

  const targetNode = document.body || document.documentElement;
  if (targetNode) {
    observer.observe(targetNode, {
      childList: true,
      subtree: true
    });
  }

  // Run immediate injection check
  injectSideChatButton();

  // Teardown / uninstall function
  window.__agSideChatBridgeUninstall = () => {
    try {
      if (typeof autoOpenTimer !== 'undefined' && autoOpenTimer) {
        clearInterval(autoOpenTimer);
        autoOpenTimer = null;
      }
      observer.disconnect();
      document.removeEventListener('selectionchange', updateCachedSelection);
      document.removeEventListener('keydown', handleGlobalKeydown, true);
      const styleEl = document.getElementById('__ag-sidechat-quote-style');
      if (styleEl) styleEl.remove();
      const injectedBtns = document.querySelectorAll('[data-testid="selection-sidechat-button"]');
      injectedBtns.forEach(btn => btn.remove());
      window.__agSideChatBridgeInstalled = false;
      delete window.__agSideChatBridgeUninstall;
    } catch (_) {}
  };
})();`;

/**
 * Resolves the platform-specific DevToolsActivePort file path.
 */
function getDevToolsActivePortPath() {
  const platform = process.platform;
  const home = os.homedir();
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort');
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Antigravity', 'DevToolsActivePort');
  }
  // Linux & others
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(configHome, 'Antigravity', 'DevToolsActivePort');
}

/**
 * Checks if a given URL string points to loopback.
 */
function isLoopback(urlStr) {
  if (!urlStr) return false;
  try {
    const parsed = new URL(urlStr);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * Represents an active CDP session connected to a specific Host page target.
 */
class PageSession {
  constructor({ target, onQuote = () => {}, onClose = () => {} }) {
    this.target = target;
    this.onQuote = onQuote;
    this.onClose = onClose;

    this._ws = null;
    this._msgId = 0;
    this._pending = new Map();
    this._scriptId = null;
    this._closed = false;
  }

  get isOpen() {
    return Boolean(this._ws && this._ws.readyState === 1 /* WebSocket.OPEN */ && !this._closed);
  }

  async connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { this._ws?.close(); } catch (_) {}
          reject(new Error(`CDP connection timed out for target ${this.target.id}`));
        }
      }, 5000);

      try {
        this._ws = new globalThis.WebSocket(this.target.webSocketDebuggerUrl);
      } catch (err) {
        clearTimeout(timeout);
        return reject(err);
      }

      this._ws.onopen = async () => {
        try {
          await this._initCDP();
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve();
          }
        } catch (err) {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            this.close().catch(() => {});
            reject(err);
          }
        }
      };

      this._ws.onmessage = (event) => {
        this._handleMessage(event.data);
      };

      this._ws.onerror = (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(err);
        }
      };

      this._ws.onclose = () => {
        this._cleanup();
        this.onClose(this.target.id);
      };
    });
  }

  async send(method, params = {}) {
    if (!this._ws || this._ws.readyState !== 1 /* WebSocket.OPEN */) {
      return Promise.reject(new Error('WebSocket is not open'));
    }
    const id = ++this._msgId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`CDP command ${method} timed out`));
        }
      }, 10000);

      this._pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });

      try {
        this._ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  async _initCDP() {
    // 1. Enable Runtime & Page domains
    await this.send('Runtime.enable');
    await this.send('Page.enable');

    // 2. Add native binding for quote callback
    await this.send('Runtime.addBinding', { name: BINDING_NAME }).catch(() => {});

    // 3. Register bridge injection script to evaluate on any future navigation
    if (this._scriptId) {
      try {
        await this.send('Page.removeScriptToEvaluateOnNewDocument', {
          identifier: this._scriptId
        });
      } catch (_) {}
    }
    const res = await this.send('Page.addScriptToEvaluateOnNewDocument', {
      source: CLIENT_INJECT_SCRIPT
    }).catch(() => null);
    if (res && res.identifier) {
      this._scriptId = res.identifier;
    }

    // 4. Immediately evaluate in the current page
    await this.send('Runtime.evaluate', {
      expression: CLIENT_INJECT_SCRIPT,
      returnByValue: false
    });
  }

  _handleMessage(rawData) {
    let msg;
    try {
      msg = JSON.parse(rawData);
    } catch {
      return;
    }

    // Correlation for send() promises
    if (msg.id && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error.message || 'CDP Error'));
      } else {
        resolve(msg.result);
      }
      return;
    }

    // Re-inject on navigation or execution context cleared
    if (
      msg.method === 'Runtime.executionContextsCleared' ||
      (msg.method === 'Page.frameNavigated' && !msg.params?.frame?.parentId)
    ) {
      this.send('Runtime.addBinding', { name: BINDING_NAME })
        .catch(() => {})
        .then(() => {
          return this.send('Runtime.evaluate', {
            expression: CLIENT_INJECT_SCRIPT,
            returnByValue: false
          });
        })
        .catch(() => {});
    }

    // Handle binding called from host renderer
    if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === BINDING_NAME) {
      let payload = msg.params.payload;
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch (_) {}
      }
      this.onQuote(payload);
    }
  }

  async close() {
    if (this._closed) return;
    this._closed = true;

    if (this._ws && this._ws.readyState === 1 /* WebSocket.OPEN */) {
      if (this._scriptId) {
        try {
          await this.send('Page.removeScriptToEvaluateOnNewDocument', {
            identifier: this._scriptId
          });
        } catch (_) {}
      }

      try {
        await this.send('Runtime.evaluate', {
          expression: 'if (typeof window.__agSideChatBridgeUninstall === "function") window.__agSideChatBridgeUninstall();',
          returnByValue: false
        });
      } catch (_) {}

      try {
        this._ws.close();
      } catch (_) {}
    }

    this._cleanup();
  }

  _cleanup() {
    for (const [, { reject }] of this._pending) {
      reject(new Error('Session closed'));
    }
    this._pending.clear();
  }
}

/**
 * QuoteBridge manages discovery of the active Antigravity Host window via CDP,
 * maintains WebSocket sessions with renderer targets, injects the DOM bridge,
 * and passes incoming quote events to the provided callback.
 */
export class QuoteBridge {
  constructor({ onQuote = () => {}, interval = 3000 } = {}) {
    this.onQuote = typeof onQuote === 'function' ? onQuote : () => {};
    this.interval = Math.max(1000, Number(interval) || 3000);

    this._running = false;
    this._timer = null;
    this._connections = new Map(); // targetId -> PageSession
    this._activePort = null;
    this._lastError = null;
    this._lastSuccessTime = null;
    this._quotesReceived = 0;
  }

  /**
   * Current health and connection status of the bridge.
   */
  get health() {
    const isConnected = this._connections.size > 0;
    return {
      status: isConnected ? 'connected' : (this._running ? 'searching' : 'stopped'),
      running: this._running,
      activePort: this._activePort,
      connectedPages: this._connections.size,
      quotesReceived: this._quotesReceived,
      lastError: this._lastError ? String(this._lastError.message || this._lastError) : null,
      lastSuccessTime: this._lastSuccessTime,
      targets: Array.from(this._connections.values()).map(s => ({
        id: s.target.id,
        title: s.target.title,
        url: s.target.url
      }))
    };
  }

  /**
   * Starts discovery and polling for active Antigravity renderer targets.
   */
  start() {
    if (this._running) return this;
    this._running = true;

    // Run first discovery immediately
    this._poll().catch((err) => {
      this._lastError = err;
    });

    // Schedule periodic discovery & health reconciliation
    this._timer = setInterval(() => {
      if (!this._running) return;
      this._poll().catch((err) => {
        this._lastError = err;
      });
    }, this.interval);

    // Unref timer so it does not block node process exit
    if (this._timer && typeof this._timer.unref === 'function') {
      this._timer.unref();
    }

    return this;
  }

  /**
   * Stops discovery and cleanly disconnects all CDP sessions.
   */
  async stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }

    const closePromises = [];
    for (const session of this._connections.values()) {
      closePromises.push(session.close().catch(() => {}));
    }
    await Promise.allSettled(closePromises);

    this._connections.clear();
    this._activePort = null;
  }

  /**
   * Discovers the active DevTools port and reconciles page sessions.
   * Completely resilient: all failures are captured into this._lastError without crashing.
   */
  async _poll() {
    try {
      const port = await this._discoverPort();
      if (!port) {
        this._activePort = null;
        this._pruneDeadConnections();
        return;
      }

      this._activePort = port;

      // Fetch active targets from DevTools HTTP endpoint
      const listUrl = `http://127.0.0.1:${port}/json/list`;
      const res = await fetch(listUrl, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) {
        throw new Error(`DevTools HTTP endpoint returned status ${res.status}`);
      }

      const targets = await res.json();
      if (!Array.isArray(targets)) {
        throw new Error('DevTools returned non-array targets response');
      }

      // Filter for target.type === 'page' where target.url and target.webSocketDebuggerUrl are on loopback
      const validTargets = targets.filter(t => {
        if (t.type !== 'page' || !t.webSocketDebuggerUrl) return false;
        return isLoopback(t.webSocketDebuggerUrl) && isLoopback(t.url);
      });

      const validTargetIds = new Set(validTargets.map(t => t.id));

      // 1. Close and remove stale sessions
      for (const [id, session] of this._connections.entries()) {
        if (!validTargetIds.has(id) || !session.isOpen) {
          session.close().catch(() => {});
          this._connections.delete(id);
        }
      }

      // Check existing open sessions to ensure bridge is still mounted
      const healthChecks = [];
      for (const [, session] of this._connections.entries()) {
        if (session.isOpen) {
          healthChecks.push(
            session.send('Runtime.evaluate', {
              expression: 'Boolean(window.__agSideChatBridgeInstalled)',
              returnByValue: true
            }).then((res) => {
              const installed = res?.result?.value === true;
              if (!installed) {
                return session._initCDP().catch(() => {});
              }
            }).catch(() => {
              return session._initCDP().catch(() => {});
            })
          );
        }
      }
      if (healthChecks.length > 0) {
        await Promise.allSettled(healthChecks);
      }

      // 2. Connect to new targets
      for (const target of validTargets) {
        if (!this._connections.has(target.id) && this._running) {
          const session = new PageSession({
            target,
            onQuote: (payload) => {
              this._quotesReceived++;
              try {
                this.onQuote(payload);
              } catch (quoteErr) {
                console.error('[QuoteBridge] Error in onQuote callback:', quoteErr);
              }
            },
            onClose: (id) => {
              this._connections.delete(id);
            }
          });

          this._connections.set(target.id, session);
          session.connect().catch((connErr) => {
            this._connections.delete(target.id);
            this._lastError = connErr;
          });
        }
      }

      this._lastSuccessTime = Date.now();
      this._lastError = null;
    } catch (err) {
      this._lastError = err;
      this._pruneDeadConnections();
    }
  }

  /**
   * Locates and reads the active DevTools port from disk or environment.
   */
  async _discoverPort() {
    if (process.env.ANTIGRAVITY_DEVTOOLS_PORT) {
      const parsed = parseInt(process.env.ANTIGRAVITY_DEVTOOLS_PORT, 10);
      if (parsed > 0) return parsed;
    }

    const portPath = getDevToolsActivePortPath();
    try {
      const content = await fs.promises.readFile(portPath, 'utf8');
      const lines = content.trim().split(/\r?\n/);
      const port = parseInt(lines[0], 10);
      if (port > 0) return port;
    } catch (_) {
      // File not yet present or locked
    }
    return null;
  }

  /**
   * Prunes any dead or disconnected page sessions.
   */
  _pruneDeadConnections() {
    for (const [id, session] of this._connections.entries()) {
      if (!session.isOpen) {
        session.close().catch(() => {});
        this._connections.delete(id);
      }
    }
  }
}
