/**
 * Host Renderer Text-Selection Quote Bridge for Antigravity Side Chat
 *
 * Connects to the Antigravity 2.x host renderer via Chrome DevTools Protocol (CDP),
 * detects text selection popups (.selection-quote-popup & .selection-popup) or provides
 * a fallback floating popup when native popups do not mount, injects a native
 * "Side Chat" action button, and orchestrates:
 * 1. Text selection capture & dismissal (including inline code pills, KaTeX, terminal blocks)
 * 2. Bi-directional delivery via CDP runtime binding (__agSideChatQuoteBindingV1)
 * 3. Aux Pane activation (Direct tab click + React Fiber openAuxTab / autoOpenSidecarLink / onSidecarLinkClick)
 * 4. Multi-stage iframe postMessage dispatch (0ms, 120ms, 300ms, 600ms, 1000ms)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

// Ensure loopback CDP HTTP & WebSocket connections never route through system HTTP proxies (e.g. Clash)
process.env.NO_PROXY = '127.0.0.1,localhost,::1';
process.env.no_proxy = '127.0.0.1,localhost,::1';
delete process.env.NODE_USE_ENV_PROXY;
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

const BINDING_NAME = '__agSideChatQuoteBindingV1';

/**
 * Client-side script injected into the Antigravity host renderer window.
 */
const CLIENT_INJECT_SCRIPT = `(() => {
  if (window.__agSideChatBridgeInstalled) {
    try { window.__agSideChatBridgeUninstall?.(); } catch (_) {}
  }
  window.__agSideChatBridgeInstalled = true;

  const FALLBACK_POPUP_ID = '__ag-sidechat-fallback-popup';

  // 1. Inject persistent stylesheet so native popups fit Side Chat button and inline pills are selectable
  try {
    let styleEl = document.getElementById('__ag-sidechat-quote-style');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = '__ag-sidechat-quote-style';
      (document.head || document.documentElement).appendChild(styleEl);
    }
    styleEl.textContent = [
      '.selection-quote-popup, .selection-popup {',
      '  width: auto !important;',
      '  min-width: 168px !important;',
      '}',
      '[data-quotable] .inline-pill, [data-quotable] .inline-pill *, [data-quotable-inline], [data-quotable-inline] * {',
      '  user-select: text !important;',
      '  -webkit-user-select: text !important;',
      '}',
      '#' + FALLBACK_POPUP_ID + ' {',
      '  position: fixed !important;',
      '  z-index: 99999 !important;',
      '  width: auto !important;',
      '  min-width: 96px !important;',
      '  pointer-events: auto !important;',
      '  user-select: none !important;',
      '  -webkit-user-select: none !important;',
      '}'
    ].join('\\n');
  } catch (err) {
    console.error('[SideChatBridge] Failed to inject popup style:', err);
  }

  // 2. Track selection changes to reliably cache user text selection
  let lastCachedSelection = '';
  let fallbackCheckTimer = null;

  function extractSelectionText(sel) {
    try {
      const s = sel || window.getSelection();
      if (!s || s.rangeCount === 0 || s.isCollapsed) return '';
      const direct = s.toString().trim();
      if (direct) return direct;
      const frag = s.getRangeAt(0).cloneContents();
      return (frag.textContent || '').trim();
    } catch (_) {
      return '';
    }
  }

  function isEditableTarget(node) {
    try {
      const el = node?.nodeType === 1 ? node : node?.parentElement;
      if (!el || typeof el.closest !== 'function') return false;
      return Boolean(
        el.closest(
          'input, textarea, [contenteditable="true"], [data-testid="agent-input-box"], [data-testid="new-tab-search-input"], .lexical-editor'
        )
      );
    } catch (_) {
      return false;
    }
  }

  function hasNativeSelectionPopup() {
    try {
      const popups = document.querySelectorAll('.selection-quote-popup, .selection-popup');
      for (const p of popups) {
        if (p.id === FALLBACK_POPUP_ID) continue;
        if (p.offsetParent !== null || p.getClientRects().length > 0) {
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  function hideFallbackPopup() {
    try {
      const el = document.getElementById(FALLBACK_POPUP_ID);
      if (el) el.remove();
    } catch (_) {}
  }

  function showFallbackPopup(rect) {
    try {
      if (hasNativeSelectionPopup()) {
        hideFallbackPopup();
        return;
      }
      let popup = document.getElementById(FALLBACK_POPUP_ID);
      if (!popup) {
        popup = document.createElement('div');
        popup.id = FALLBACK_POPUP_ID;
        popup.className = 'selection-popup selection-quote-popup shadow rounded-md overflow-visible z-50';

        const inner = document.createElement('div');
        inner.className = 'flex rounded-md bg-muted text-foreground border border-border shadow-sm overflow-hidden';
        inner.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        }, true);
        inner.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        }, true);

        const btn = createSideChatButtonElement(
          'flex items-center gap-1 justify-center px-2.5 py-1 transition-colors cursor-pointer hover:bg-secondary text-xs flex-1 min-w-0',
          false
        );
        inner.appendChild(btn);
        popup.appendChild(inner);
        (document.body || document.documentElement).appendChild(popup);
      }

      const popupWidth = 104;
      const popupHeight = 30;
      const left = Math.min(
        Math.max(8, Math.round(rect.right - popupWidth)),
        Math.max(8, window.innerWidth - popupWidth - 12)
      );
      const top = (rect.bottom + popupHeight + 10 < window.innerHeight)
        ? Math.round(rect.bottom + 6)
        : Math.max(8, Math.round(rect.top - popupHeight - 6));

      popup.style.left = left + 'px';
      popup.style.top = top + 'px';
    } catch (err) {
      console.error('[SideChatBridge] Failed to show fallback popup:', err);
    }
  }

  function scheduleFallbackPopupCheck(delayMs = 35) {
    if (fallbackCheckTimer) {
      clearTimeout(fallbackCheckTimer);
    }
    fallbackCheckTimer = setTimeout(() => {
      fallbackCheckTimer = null;
      try {
        // First ensure any mounted native popups have the Side Chat button injected
        injectSideChatButton();
        if (hasNativeSelectionPopup()) {
          hideFallbackPopup();
          return;
        }

        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
          hideFallbackPopup();
          return;
        }

        if (isEditableTarget(sel.anchorNode) || isEditableTarget(sel.focusNode)) {
          hideFallbackPopup();
          return;
        }

        const text = extractSelectionText(sel);
        if (!text) {
          hideFallbackPopup();
          return;
        }
        lastCachedSelection = text;

        const range = sel.getRangeAt(0);
        const clientRects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
        const rect = clientRects.length > 0 ? clientRects[clientRects.length - 1] : range.getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) {
          hideFallbackPopup();
          return;
        }

        showFallbackPopup(rect);
      } catch (_) {}
    }, delayMs);
  }

  function updateCachedSelection() {
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        hideFallbackPopup();
        return;
      }
      const text = extractSelectionText(sel);
      if (text) {
        lastCachedSelection = text;
      }
    } catch (_) {}
  }

  function handleMouseUpCapture(e) {
    try {
      if (e.target && e.target.closest && e.target.closest('#' + FALLBACK_POPUP_ID + ', .selection-popup, .selection-quote-popup')) {
        return;
      }
      scheduleFallbackPopupCheck(35);
    } catch (_) {}
  }

  function handleKeyUpCapture(e) {
    try {
      if (e.key === 'Escape') {
        hideFallbackPopup();
        return;
      }
      if (e.shiftKey || e.key.startsWith('Arrow')) {
        scheduleFallbackPopupCheck(35);
      }
    } catch (_) {}
  }

  function handleScrollCapture() {
    hideFallbackPopup();
  }

  document.addEventListener('selectionchange', updateCachedSelection, { passive: true });
  document.addEventListener('mouseup', handleMouseUpCapture, true);
  document.addEventListener('keyup', handleKeyUpCapture, true);
  document.addEventListener('scroll', handleScrollCapture, { capture: true, passive: true });

  // 3. Resolve active conversation ID from location pathname or main conversation view
  function getConversationId() {
    try {
      const match = location.pathname.match(/\\/c\\/([0-9a-f-]{36})/i);
      if (match && match[1]) return match[1];

      const convViewEl = document.querySelector('[data-testid="conversation-view"][data-cascade-id]');
      const viewId = convViewEl ? convViewEl.getAttribute('data-cascade-id') : null;
      if (viewId && viewId !== 'conversation') return viewId;
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

  // Helper: Resolve current AuxPane treeId from Yvc Fiber or active conversationId
  function getAuxPaneTreeId() {
    try {
      const auxEl = document.querySelector('[data-aux-pane-open]');
      if (auxEl) {
        const afk = Object.keys(auxEl).find(k => k.startsWith('__reactFiber'));
        if (afk) {
          const aq = [auxEl[afk]];
          let steps = 0;
          while (aq.length > 0 && steps < 200) {
            const n = aq.shift();
            steps++;
            if (!n) continue;
            if (n.memoizedProps && n.memoizedProps.treeId) {
              return n.memoizedProps.treeId;
            }
            if (n.child) aq.push(n.child);
            if (n.sibling) aq.push(n.sibling);
          }
        }
      }
    } catch (_) {}
    const cid = getConversationId();
    return cid ? { kind: 'cascadeId', cascadeId: cid } : { kind: 'home' };
  }

  // Helper: Activate Side Chat (/btw) Tab
  function activateSideChatTab(allowFiberOpen = true) {
    try {
      const auxPane = document.querySelector('[data-aux-pane-open]');
      const isPaneOpen = auxPane && auxPane.getAttribute('data-aux-pane-open') === 'true';
      const activeTabId = document.querySelector('[data-active-tab-id]')?.getAttribute('data-active-tab-id');

      if (isPaneOpen && activeTabId === 'sidecar__side-chat/panel__/') {
        return true;
      }

      // 1. Check if tab button already exists in the Aux Pane tab bar
      const tabBtn = document.querySelector('[data-tab-id="sidecar__side-chat/panel__/"]')
        || document.querySelector('[data-testid="aux-pane-tab-sidecar__side-chat/panel__/"]')
        || document.querySelector('[data-tab-id*="side-chat"]');

      if (tabBtn) {
        if (!isPaneOpen) {
          const toggleBtn = document.querySelector('[data-testid="toggle-aux-sidebar"]')
            || document.querySelector('[aria-label="Toggle Auxiliary Pane"]');
          if (toggleBtn) {
            try { toggleBtn.click(); } catch (_) {}
          }
        }
        if (activeTabId !== 'sidecar__side-chat/panel__/') {
          tabBtn.click();
        }
        return true;
      }

      if (!allowFiberOpen) {
        return false;
      }

      // 2. React Fiber activation (handles creating the tab + opening Aux Pane + selecting tab)
      const root = document.getElementById('root');
      if (root) {
        const fiberKey = Object.keys(root).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'));
        if (fiberKey) {
          const queue = [root[fiberKey]];
          let visited = 0;
          let openAuxTabFn = null;
          let autoOpenSidecarFn = null;
          let sidecarClickFn = null;
          let resolveSidecarFn = null;

          while (queue.length > 0 && visited < 15000) {
            const node = queue.shift();
            visited++;
            if (!node) continue;

            // Check props & Context.Provider values for onSidecarLinkClick / autoOpenSidecarLink
            const p = node.memoizedProps;
            if (p && typeof p === 'object') {
              if (typeof p.onSidecarLinkClick === 'function' && !sidecarClickFn) {
                sidecarClickFn = p.onSidecarLinkClick;
                resolveSidecarFn = typeof p.resolveSidecarLink === 'function' ? p.resolveSidecarLink : null;
              }
              if (p.value && typeof p.value === 'object' && typeof p.value.onSidecarLinkClick === 'function' && !sidecarClickFn) {
                sidecarClickFn = p.value.onSidecarLinkClick;
                resolveSidecarFn = typeof p.value.resolveSidecarLink === 'function' ? p.value.resolveSidecarLink : null;
              }
            }

            // Check hooks for wP (openAuxTab) and P_b (autoOpenSidecarLink)
            let s = node.memoizedState;
            while (s) {
              const ms = s.memoizedState;
              const fn = Array.isArray(ms) ? ms[0] : ms;
              if (typeof fn === 'function') {
                const fnStr = fn.toString();
                if (!openAuxTabFn && fnStr.includes('OPEN_AUX_PANE_TAB') && fnStr.includes('auxTabInterceptor')) {
                  openAuxTabFn = fn;
                }
                if (!autoOpenSidecarFn && fnStr.includes('d?.forceReload') && fnStr.includes('dashboard')) {
                  autoOpenSidecarFn = fn;
                }
              }
              s = s.next;
            }

            if (openAuxTabFn && (autoOpenSidecarFn || sidecarClickFn)) break;
            if (node.child) queue.push(node.child);
            if (node.sibling) queue.push(node.sibling);
          }

          // Priority A: autoOpenSidecarFn('side-chat/panel/', { forceReload: false })
          if (autoOpenSidecarFn) {
            try {
              const ok = autoOpenSidecarFn('side-chat/panel/', { forceReload: false });
              if (ok) return true;
            } catch (_) {}
          }

          // Priority B: openAuxTabFn (wP) with explicit overrideTabId & treeId (works at visited ~44 even on empty conversations!)
          if (openAuxTabFn) {
            try {
              const sidecarHolder = document.querySelector('[data-sidecar-id="side-chat/panel"]');
              const sidecarUrl = sidecarHolder?.getAttribute('data-sidecar-url') || '';
              const treeId = getAuxPaneTreeId();
              openAuxTabFn(
                {
                  type: 'sidecarView',
                  sidecarView: {
                    sidecarId: 'side-chat/panel',
                    path: '/',
                    url: sidecarUrl,
                    title: 'Side Chat (/btw)'
                  }
                },
                'sidecar__side-chat/panel__/',
                { treeId, source: 'side_chat_bridge' }
              );
              return true;
            } catch (_) {}
          }

          // Priority C: sidecarClickFn('side-chat/panel/') (without 'sidecar://' prefix)
          if (sidecarClickFn) {
            try {
              let targetUri = 'side-chat/panel/';
              if (resolveSidecarFn) {
                if (resolveSidecarFn('side-chat/panel/')) targetUri = 'side-chat/panel/';
                else if (resolveSidecarFn('sidecar://side-chat/panel/')) targetUri = 'sidecar://side-chat/panel/';
              }
              sidecarClickFn(targetUri);
              return true;
            } catch (_) {}
          }
        }
      }

      // 3. Fallback: If Aux Pane is still closed, toggle it open
      if (!isPaneOpen) {
        const toggleBtn = document.querySelector('[data-testid="toggle-aux-sidebar"]')
          || document.querySelector('[aria-label="Toggle Auxiliary Pane"]');
        if (toggleBtn) {
          try { toggleBtn.click(); } catch (_) {}
        }
      }
    } catch (err) {
      console.error('[SideChatBridge] activateSideChatTab error:', err);
    }
    return false;
  }

  // 4. Open and activate Side Chat Aux Pane tab and notify iframe
  function openAndActivateSideChat(quotePayloadOrConvId, quotedText, quoteTimestamp) {
    const activeConvId = getConversationId();
    let quotePayload = null;
    if (quotePayloadOrConvId && typeof quotePayloadOrConvId === 'object' && quotePayloadOrConvId.quotedText) {
      quotePayload = {
        ...quotePayloadOrConvId,
        conversationId: quotePayloadOrConvId.conversationId || activeConvId
      };
    } else if (quotedText) {
      quotePayload = {
        conversationId: (typeof quotePayloadOrConvId === 'string' && quotePayloadOrConvId ? quotePayloadOrConvId : '') || activeConvId,
        quotedText: quotedText,
        timestamp: quoteTimestamp || Date.now()
      };
    }

    // Activate Side Chat (/btw) Tab & Open Aux Pane
    try {
      activateSideChatTab(true);
      setTimeout(() => activateSideChatTab(false), 60);
      setTimeout(() => activateSideChatTab(true), 180);
      setTimeout(() => activateSideChatTab(false), 360);
      setTimeout(() => activateSideChatTab(false), 600);
    } catch (err) {
      console.error('[SideChatBridge] open/activate error:', err);
    }

    // Dispatch focus-input at multiple stages
    const focusDelays = [80, 200, 400];
    for (const delay of focusDelays) {
      setTimeout(() => broadcastFocusInput(activeConvId), delay);
    }

    // Deliver quote payload via postMessage to Side Chat iframe(s) when quotePayload is provided
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
  function broadcastFocusInput(conversationId) {
    try {
      const cid = conversationId || getConversationId();
      const iframes = document.querySelectorAll(
        'iframe[src*="side-chat"], iframe[title*="Side Chat"], [data-sidecar-id="side-chat/panel"] iframe, iframe[data-testid="sidecar-iframe"]'
      );
      for (const iframe of iframes) {
        try {
          iframe.contentWindow?.postMessage({ type: 'focus-input', conversationId: cid }, '*');
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

    const currentSel = extractSelectionText(window.getSelection());
    const quotedText = currentSel || lastCachedSelection || '';
    const conversationId = getConversationId();
    const quoteTimestamp = Date.now();

    hideFallbackPopup();

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
      setTimeout(() => broadcastFocusInput(conversationId), delay);
    }
  }

  // Register in capture phase so shortcut is captured before page editors/default actions
  document.addEventListener('keydown', handleGlobalKeydown, true);

  // 6. Handle Side Chat button click
  function handleSideChatClick() {
    try {
      const currentSel = extractSelectionText(window.getSelection());
      const quotedText = currentSel || lastCachedSelection || '';
      const conversationId = getConversationId();
      const quoteTimestamp = Date.now();

      hideFallbackPopup();

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

  function createSideChatButtonElement(className, withLeftBorder = true) {
    const sideChatBtn = document.createElement('button');
    sideChatBtn.type = 'button';
    sideChatBtn.setAttribute('data-testid', 'selection-sidechat-button');
    sideChatBtn.className = className || 'flex items-center gap-1 justify-center px-2 py-1 transition-colors cursor-pointer hover:bg-secondary text-xs flex-1 min-w-0';
    if (withLeftBorder) {
      sideChatBtn.style.borderLeft = '1px solid var(--border, rgba(128, 128, 128, 0.25))';
    }
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

    return sideChatBtn;
  }

  // 7. Inject button into native quote popups (.selection-quote-popup AND .selection-popup)
  function injectSideChatButton() {
    try {
      const popups = document.querySelectorAll('.selection-quote-popup, .selection-popup');
      let foundNative = false;
      for (const popup of popups) {
        if (popup.id === FALLBACK_POPUP_ID) continue;
        foundNative = true;

        if (popup.querySelector('[data-testid="selection-sidechat-button"]')) continue;

        const refBtn = popup.querySelector(
          '[data-testid="selection-quote-button"], [data-testid="selection-popup-quote-button"], [data-testid="selection-comment-button"]'
        );
        if (!refBtn || !refBtn.parentNode) continue;

        // Ensure popup container width is auto and min-width is 168px
        popup.style.setProperty('width', 'auto', 'important');
        popup.style.setProperty('min-width', '168px', 'important');

        const sideChatBtn = createSideChatButtonElement(refBtn.className, true);
        refBtn.parentNode.appendChild(sideChatBtn);
      }

      if (foundNative) {
        hideFallbackPopup();
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
      if (fallbackCheckTimer) {
        clearTimeout(fallbackCheckTimer);
        fallbackCheckTimer = null;
      }
      hideFallbackPopup();
      observer.disconnect();
      document.removeEventListener('selectionchange', updateCachedSelection);
      document.removeEventListener('mouseup', handleMouseUpCapture, true);
      document.removeEventListener('keyup', handleKeyUpCapture, true);
      document.removeEventListener('scroll', handleScrollCapture, true);
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
  if (process.env.AGY_BROWSER_ACTIVE_PORT_FILE && fs.existsSync(process.env.AGY_BROWSER_ACTIVE_PORT_FILE)) {
    return process.env.AGY_BROWSER_ACTIVE_PORT_FILE;
  }
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
 * Direct loopback HTTP GET bypassing any global fetch/undici env proxy.
 */
function httpGetJson(port, urlPath, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`DevTools HTTP status ${res.statusCode}`));
        }
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('DevTools HTTP request timed out'));
    });
    req.on('error', reject);
  });
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

      // Fetch active targets from DevTools HTTP endpoint via direct loopback socket
      const targets = await httpGetJson(port, '/json/list', 2000);
      if (!Array.isArray(targets)) {
        throw new Error('DevTools returned non-array targets response');
      }

      // Filter for target.type === 'page' where target.webSocketDebuggerUrl is on loopback
      const validTargets = targets.filter(t => {
        if (t.type !== 'page' || !t.webSocketDebuggerUrl) return false;
        if (t.url && (t.url.startsWith('devtools://') || t.url.startsWith('chrome-extension://'))) return false;
        return isLoopback(t.webSocketDebuggerUrl);
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
