/**
 * Side Chat (/btw) — Frontend Application Logic
 *
 * Implements:
 * - Independent multi-turn session history within a single Side Chat session
 * - Forwarding prior Side Chat turns to the model for conversational continuity
 * - Exporting complete multi-turn logs with user note when pushing to main agent
 * - Resetting session and re-sensing main conversation context on "新会话" or new quote
 * - 3 Redundant channels for Quote-to-Side-Chat (window message, SSE /api/events, context poll)
 * - Automatic main task context sensing & live drawer inspection
 * - Streaming question answering with fallback to JSON
 * - Markdown rendering with fenced code block copy & push-to-main actions
 * - Modern Web Guidance rules (form-fields-automatically-fit-contents, color-mix, theming)
 */

// Global State
let currentConversationId = '';
let currentWorkspaceUris = [];
let activeQuote = null; // { id, conversationId, quotedText, timestamp }
let lastQuoteTimestamp = 0;
let isGenerating = false;
let currentAbortController = null;
let codeBlocksMap = new Map(); // id -> { lang, code }
let nextCodeBlockId = 1;
let sessionHistory = []; // Array of { id, role: 'user' | 'assistant', content, quotedText, timestamp, model }

// Query Params
const urlParams = new URLSearchParams(window.location.search);
const token = urlParams.get('token') || '';

// DOM Elements
const contextToggleBtn = document.getElementById('context-toggle');
const contextDot = document.getElementById('context-dot');
const contextLabel = document.getElementById('context-label');
const contextDrawer = document.getElementById('context-drawer');
const ctxDrawerClose = document.getElementById('ctx-drawer-close');
const ctxGoal = document.getElementById('ctx-goal');
const ctxWorkspace = document.getElementById('ctx-workspace');
const ctxSteps = document.getElementById('ctx-steps');
const resetBtn = document.getElementById('reset-btn');

const mainView = document.getElementById('main-view');
const emptyState = document.getElementById('empty-state');
const messagesContainer = document.getElementById('messages-container');
const messagesList = document.getElementById('messages-list');
const answerLoading = document.getElementById('answer-loading');

const threadPushActions = document.getElementById('thread-push-actions');
const pushDirectBtn = document.getElementById('push-direct-btn');
const pushNoteToggleBtn = document.getElementById('push-note-toggle-btn');
const pushNotePanel = document.getElementById('push-note-panel');
const pushNoteInput = document.getElementById('push-note-input');
const pushNoteSubmitBtn = document.getElementById('push-note-submit-btn');
const pushNoteCancelBtn = document.getElementById('push-note-cancel-btn');
const pushStatus = document.getElementById('push-status');
const pushStatusText = document.getElementById('push-status-text');

const quoteBanner = document.getElementById('quote-banner');
const quotePreviewText = document.getElementById('quote-preview-text');
const quoteClearBtn = document.getElementById('quote-clear-btn');

const questionInput = document.getElementById('question-input');
const modelSelect = document.getElementById('model-select');
const composerCtxBadge = document.getElementById('composer-ctx-badge');
const sendBtn = document.getElementById('send-btn');
const stopBtn = document.getElementById('stop-btn');
const inlineStopBtn = document.getElementById('inline-stop-btn');

// ==========================================================================
// Helper: API Fetch (supports sidecar SDK fetch and standard fetch with token)
// ==========================================================================
async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token && !headers['X-Sidecar-Token']) {
    headers['X-Sidecar-Token'] = token;
  }
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  options.headers = headers;

  if (typeof window.sidecar?.fetch === 'function') {
    return window.sidecar.fetch(path, options);
  }
  return fetch(path, options);
}

// ==========================================================================
// Conversation & Workspace Discovery
// ==========================================================================
function resolveConversationId() {
  return window.sidecar?.conversationId || urlParams.get('conversationId') || '';
}

async function initWorkspaceAndContext() {
  currentConversationId = resolveConversationId();

  try {
    if (typeof window.sidecar?.getWorkspaceUris === 'function') {
      const uris = await window.sidecar.getWorkspaceUris();
      if (Array.isArray(uris)) {
        currentWorkspaceUris = uris;
      }
    }
  } catch (err) {
    console.warn('Sidecar getWorkspaceUris unavailable:', err);
  }

  try {
    if (typeof window.sidecar?.onWorkspaceChange === 'function') {
      window.sidecar.onWorkspaceChange((uris) => {
        currentWorkspaceUris = uris || [];
        fetchContext();
      });
    }
  } catch (err) {
    console.warn('Sidecar onWorkspaceChange listener failed:', err);
  }

  // Initial fetch and periodic polling
  await fetchContext();
  setInterval(fetchContext, 12000);
}

// ==========================================================================
// Context Sensing & Inspector Drawer
// ==========================================================================
async function fetchContext() {
  if (!currentConversationId) {
    currentConversationId = resolveConversationId();
  }

  try {
    const q = new URLSearchParams({
      conversationId: currentConversationId,
      workspaceUris: JSON.stringify(currentWorkspaceUris)
    });
    const res = await apiFetch(`/api/context?${q.toString()}`);
    if (!res.ok) return;

    const data = await res.json();
    renderContextInfo(data);

    // Update models dropdown if returned by backend
    if (Array.isArray(data.models) && data.models.length > 0) {
      updateModelSelectOptions(data.models);
    }

    // Channel 3: Poll pending quote from backend
    if (data.pendingQuote && data.pendingQuote.quotedText) {
      handleIncomingQuote(data.pendingQuote);
    }
  } catch (err) {
    console.warn('Failed to fetch context snapshot:', err);
  }
}

function renderContextInfo(data) {
  if (data.available) {
    contextDot.className = 'status-dot status-active';
    const stepCount = data.stepCount || 0;
    contextLabel.textContent = `已感知主会话 · ${stepCount} 步`;
    contextLabel.title = `主会话已同步，共 ${stepCount} 步操作历史`;

    if (composerCtxBadge) {
      const badgeText = composerCtxBadge.querySelector('.badge-text');
      if (badgeText) badgeText.textContent = `主会话 (${stepCount} 步)`;
    }
  } else {
    contextDot.className = 'status-dot status-waiting';
    contextLabel.textContent = '等待主会话上下文';
    contextLabel.title = '尚未检测到主会话步骤，问答将基于独立上下文';

    if (composerCtxBadge) {
      const badgeText = composerCtxBadge.querySelector('.badge-text');
      if (badgeText) badgeText.textContent = '独立旁路会话';
    }
  }

  // Populate drawer
  ctxGoal.textContent = data.initialGoal || '暂未读取到主任务初始目标';
  if (Array.isArray(data.workspaceUris) && data.workspaceUris.length > 0) {
    ctxWorkspace.textContent = data.workspaceUris.join('\n');
  } else {
    ctxWorkspace.textContent = '暂无活动工作区';
  }

  if (data.latestSummary) {
    ctxSteps.textContent = data.latestSummary;
  } else if (data.stepCount) {
    ctxSteps.textContent = `主任务已累计执行 ${data.stepCount} 步操作。`;
  } else {
    ctxSteps.textContent = '主任务暂未产生交互步骤。';
  }
}

function toggleContextDrawer() {
  const isHidden = contextDrawer.classList.contains('hidden');
  if (isHidden) {
    contextDrawer.classList.remove('hidden');
    contextToggleBtn.setAttribute('aria-expanded', 'true');
  } else {
    contextDrawer.classList.add('hidden');
    contextToggleBtn.setAttribute('aria-expanded', 'false');
  }
}

// ==========================================================================
// Quote Management (3 Redundant Channels)
// ==========================================================================
function handleIncomingQuote(quote) {
  if (!quote || !quote.quotedText) return;
  const ts = Number(quote.timestamp) || Date.now();
  if (ts <= lastQuoteTimestamp) return;
  lastQuoteTimestamp = ts;

  // New quote starts a fresh Side Chat session that ONLY inherits the main context
  sessionHistory = [];
  codeBlocksMap.clear();
  nextCodeBlockId = 1;

  messagesList.innerHTML = '';
  messagesContainer.classList.add('hidden');
  emptyState.classList.remove('hidden');

  answerLoading.classList.add('hidden');
  threadPushActions.classList.add('hidden');
  pushNotePanel.classList.add('hidden');
  pushStatus.classList.add('hidden');

  if (quote.conversationId && quote.conversationId !== 'global' && quote.conversationId !== currentConversationId) {
    currentConversationId = quote.conversationId;
    fetchContext();
  }

  activeQuote = {
    id: quote.id || String(ts),
    conversationId: quote.conversationId || currentConversationId,
    quotedText: quote.quotedText.trim(),
    timestamp: ts
  };

  showQuoteBanner(activeQuote.quotedText);
  questionInput.focus();
}

function showQuoteBanner(text) {
  quotePreviewText.textContent = text;
  quoteBanner.classList.remove('hidden');
}

function hideQuoteBanner() {
  quoteBanner.classList.add('hidden');
  quotePreviewText.textContent = '';
}

async function clearActiveQuote() {
  activeQuote = null;
  hideQuoteBanner();
  try {
    await apiFetch('/api/quote/clear', {
      method: 'POST',
      body: { conversationId: currentConversationId }
    });
  } catch (err) {
    console.warn('Failed to notify backend quote clearance:', err);
  }
}

// Channel 1: Window Message from Host Renderer Bridge
window.addEventListener('message', (event) => {
  if (event.data?.type === 'side-chat-quote') {
    const p = event.data.payload || event.data;
    handleIncomingQuote({
      quotedText: p.quotedText,
      timestamp: p.timestamp || Date.now(),
      conversationId: p.conversationId || currentConversationId
    });
  } else if (event.data?.type === 'focus-input') {
    if (event.data.conversationId && event.data.conversationId !== 'global' && event.data.conversationId !== currentConversationId) {
      currentConversationId = event.data.conversationId;
      fetchContext();
    }
    if (questionInput) {
      questionInput.focus();
      try {
        questionInput.select();
      } catch (_) {}
    }
  }
});

// Channel 2: SSE Broadcast Stream from Backend main.mjs
function initSSE() {
  const sseUrl = `/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  try {
    const eventSource = new EventSource(sseUrl);

    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'quote') {
          handleIncomingQuote(data);
        }
      } catch (err) {}
    };

    eventSource.addEventListener('quote', (e) => {
      try {
        const data = JSON.parse(e.data);
        handleIncomingQuote(data);
      } catch (err) {}
    });

    eventSource.onerror = () => {
      // EventSource automatically handles reconnection
    };
  } catch (err) {
    console.warn('SSE EventSource initialization bypassed:', err);
  }
}

// ==========================================================================
// Question Asking & Multi-Turn Streaming Execution
// ==========================================================================
function stopGeneration() {
  if (!isGenerating) return;
  if (currentAbortController) {
    try {
      currentAbortController.abort();
    } catch (_) {}
  }
}

async function submitQuestion() {
  const question = questionInput.value.trim();
  const currentQuoteText = activeQuote?.quotedText || '';
  if (!question && !currentQuoteText) return;
  if (isGenerating) return;

  isGenerating = true;
  currentAbortController = new AbortController();
  const abortSignal = currentAbortController.signal;

  sendBtn.classList.add('hidden');
  sendBtn.disabled = true;
  stopBtn.classList.remove('hidden');

  const selectedModel = modelSelect.value || 'MODEL_PLACEHOLDER_M320';
  const selectedOption = modelSelect.options[modelSelect.selectedIndex];
  const modelText = selectedOption ? selectedOption.text.trim() : 'Gemini 3.8 Flash (Low)';

  // Calculate turn number based on prior user questions
  const priorUserCount = sessionHistory.filter((item) => item.role === 'user').length;
  const currentRound = priorUserCount + 1;

  // Prepare container
  emptyState.classList.add('hidden');
  messagesContainer.classList.remove('hidden');

  const userContent = question || '(针对引用的选中文本进行旁路分析)';

  // Append user turn to session history
  const userTurnObj = {
    id: Date.now(),
    role: 'user',
    content: userContent,
    quotedText: currentQuoteText,
    timestamp: Date.now()
  };
  sessionHistory.push(userTurnObj);

  // History to pass to LLM contains all turns prior to this new user turn
  const priorHistory = sessionHistory.slice(0, -1);

  // Create Turn DOM element
  const turnEl = document.createElement('div');
  turnEl.className = 'chat-turn';
  turnEl.dataset.turn = String(currentRound);

  // User Section
  const userMsgEl = document.createElement('div');
  userMsgEl.className = 'turn-user-msg';

  if (currentQuoteText) {
    const quoteBox = document.createElement('div');
    quoteBox.className = 'turn-quote-box';
    quoteBox.innerHTML = `
      <div class="turn-quote-box-label">
        <svg class="icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        <span>主对话选中文本引用</span>
      </div>
      <div class="turn-quote-box-content"></div>
    `;
    quoteBox.querySelector('.turn-quote-box-content').textContent = currentQuoteText;
    userMsgEl.appendChild(quoteBox);
  }

  const userBubble = document.createElement('div');
  userBubble.className = 'user-bubble';
  userBubble.innerHTML = `
    <span class="user-avatar" aria-hidden="true">我</span>
    <div class="turn-question-text"></div>
  `;
  userBubble.querySelector('.turn-question-text').textContent = userContent;
  userMsgEl.appendChild(userBubble);
  turnEl.appendChild(userMsgEl);

  // Clear input and quote attachment
  questionInput.value = '';
  if (!CSS.supports('field-sizing', 'content')) {
    questionInput.style.height = 'auto';
  }
  hideQuoteBanner();
  activeQuote = null;

  // AI Answer Placeholder
  const aiMsgEl = document.createElement('div');
  aiMsgEl.className = 'turn-ai-msg';
  aiMsgEl.innerHTML = `
    <div class="turn-ai-header">
      <div class="turn-ai-title">
        <span class="turn-ai-avatar" aria-hidden="true">⚡ /btw</span>
        <span class="turn-round-pill">第 ${currentRound} 轮</span>
      </div>
      <span class="turn-ai-model-tag">${escapeHtml(modelText)}</span>
    </div>
    <div class="answer-body">
      <div class="markdown-body"></div>
    </div>
  `;
  turnEl.appendChild(aiMsgEl);
  messagesList.appendChild(turnEl);

  const markdownTarget = aiMsgEl.querySelector('.markdown-body');

  // Move skeleton loading right after current turn and display it
  messagesContainer.insertBefore(answerLoading, threadPushActions);
  answerLoading.classList.remove('hidden');

  // Hide push actions during generation
  threadPushActions.classList.add('hidden');
  pushNotePanel.classList.add('hidden');
  pushStatus.classList.add('hidden');

  mainView.scrollTop = mainView.scrollHeight;

  let currentAnswerMarkdown = '';
  let turnSaved = false;

  const saveAssistantTurn = (content) => {
    if (turnSaved) return;
    turnSaved = true;
    sessionHistory.push({
      id: Date.now(),
      role: 'assistant',
      content,
      model: selectedModel,
      timestamp: Date.now()
    });
  };

  try {
    let streamedSuccessfully = false;

    // 1. Attempt SSE streaming endpoint first
    try {
      const streamRes = await apiFetch('/api/ask/stream', {
        method: 'POST',
        signal: abortSignal,
        body: {
          conversationId: currentConversationId,
          question: userContent,
          quotedText: currentQuoteText,
          workspaceUris: currentWorkspaceUris,
          model: selectedModel,
          history: priorHistory
        }
      });

      if (streamRes.ok && streamRes.body) {
        const reader = streamRes.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
          if (abortSignal.aborted) {
            try { await reader.cancel(); } catch (_) {}
            break;
          }

          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (abortSignal.aborted) {
              try { await reader.cancel(); } catch (_) {}
              break;
            }

            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr) continue;

            try {
              const event = JSON.parse(jsonStr);
              if (event.type === 'delta' && typeof event.text === 'string') {
                if (!answerLoading.classList.contains('hidden')) {
                  answerLoading.classList.add('hidden');
                }
                currentAnswerMarkdown += event.text;
                renderMarkdown(currentAnswerMarkdown, markdownTarget);
                mainView.scrollTop = mainView.scrollHeight;
              } else if (event.type === 'done') {
                if (event.answer && !currentAnswerMarkdown) {
                  currentAnswerMarkdown = event.answer;
                  renderMarkdown(currentAnswerMarkdown, markdownTarget);
                }
                streamedSuccessfully = true;
              } else if (event.type === 'error') {
                throw new Error(event.error || '旁路回答生成失败');
              }
            } catch (parseErr) {
              console.warn('SSE JSON parse chunk skip:', parseErr);
            }
          }
        }

        if (currentAnswerMarkdown && !abortSignal.aborted) {
          streamedSuccessfully = true;
        }
      }
    } catch (streamErr) {
      if (abortSignal.aborted || streamErr.name === 'AbortError') {
        // User stopped generation during stream fetch or read
      } else {
        console.warn('Streaming endpoint failed or unavailable, falling back to /api/ask:', streamErr);
      }
    }

    if (abortSignal.aborted) {
      if (currentAnswerMarkdown) {
        currentAnswerMarkdown += '\n\n*(已停止输出)*';
      } else {
        currentAnswerMarkdown = '*(已取消本次输出)*';
      }
      renderMarkdown(currentAnswerMarkdown, markdownTarget);
      saveAssistantTurn(currentAnswerMarkdown);
    } else {
      // 2. Fallback to standard POST /api/ask if stream failed and not aborted
      if (!streamedSuccessfully) {
        const askRes = await apiFetch('/api/ask', {
          method: 'POST',
          signal: abortSignal,
          body: {
            conversationId: currentConversationId,
            question: userContent,
            quotedText: currentQuoteText,
            workspaceUris: currentWorkspaceUris,
            model: selectedModel,
            history: priorHistory
          }
        });

        if (!askRes.ok) {
          const errText = await askRes.text();
          throw new Error(`服务端异常 (${askRes.status}): ${errText}`);
        }

        const result = await askRes.json();
        currentAnswerMarkdown = result.answer || '无有效回复内容。';
        renderMarkdown(currentAnswerMarkdown, markdownTarget);
      }

      // Save assistant response to sessionHistory
      saveAssistantTurn(currentAnswerMarkdown);
    }

    answerLoading.classList.add('hidden');
    threadPushActions.classList.remove('hidden');
    mainView.scrollTop = mainView.scrollHeight;
  } catch (err) {
    if (abortSignal.aborted || err.name === 'AbortError') {
      if (currentAnswerMarkdown) {
        currentAnswerMarkdown += '\n\n*(已停止输出)*';
      } else {
        currentAnswerMarkdown = '*(已取消本次输出)*';
      }
      renderMarkdown(currentAnswerMarkdown, markdownTarget);
      saveAssistantTurn(currentAnswerMarkdown);
      answerLoading.classList.add('hidden');
      threadPushActions.classList.remove('hidden');
      mainView.scrollTop = mainView.scrollHeight;
    } else {
      answerLoading.classList.add('hidden');
      renderMarkdown(`> ⚠️ **生成失败**：${err.message || '网络连接或服务暂时不可用，请稍后重试。'}`, markdownTarget);
    }
  } finally {
    isGenerating = false;
    currentAbortController = null;
    sendBtn.classList.remove('hidden');
    sendBtn.disabled = false;
    stopBtn.classList.add('hidden');
    answerLoading.classList.add('hidden');
    threadPushActions.classList.remove('hidden');
    questionInput.focus();
  }
}

// ==========================================================================
// Safe Markdown Parser with Fenced Code Blocks & Action Hooks
// ==========================================================================
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdown(mdText, targetEl) {
  if (!targetEl) return;
  if (!mdText) {
    targetEl.innerHTML = '';
    return;
  }

  // 步骤 1：保护代码块
  // 1a. 提取多行代码块 ```lang\n...```
  const codeBlockRegex = /```([^\n\r]*)\r?\n([\s\S]*?)```/g;
  let text = mdText.replace(codeBlockRegex, (match, lang, code) => {
    const id = nextCodeBlockId++;
    const cleanLang = (lang || 'text').trim();
    codeBlocksMap.set(id, { lang: cleanLang, code });
    return `@@@CODEBLOCK${id}@@@`;
  });

  // 1b. 提取行内代码 `...`，防止内部 $ 或数学符号被误解析
  const inlineCodeMap = new Map();
  let nextInlineCodeId = 0;
  text = text.replace(/`([^`\n\r]+)`/g, (match, code) => {
    const id = nextInlineCodeId++;
    inlineCodeMap.set(id, code);
    return `@@@INLINECODE${id}@@@`;
  });

  // 步骤 2：保护转义字符 \$ -> @@@ESCAPEDDOLLAR@@@
  text = text.replace(/\\\$/g, '@@@ESCAPEDDOLLAR@@@');

  // 步骤 3：块级公式（Display Math）
  // 支持 $$...$$ 和 \[...\]
  const mathBlockMap = new Map();
  let nextMathBlockId = 0;

  function renderMathBlock(formula) {
    const trimmed = formula.trim();
    if (typeof window !== 'undefined' && window.katex && typeof window.katex.renderToString === 'function') {
      try {
        return window.katex.renderToString(trimmed, { displayMode: true, throwOnError: false });
      } catch (err) {
        console.warn('KaTeX block render error:', err);
      }
    }
    return `<div class="katex-display-fallback"><code>${escapeHtml(trimmed)}</code></div>`;
  }

  // $$...$$
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (match, formula) => {
    const id = nextMathBlockId++;
    mathBlockMap.set(id, renderMathBlock(formula));
    return `@@@MATHBLOCK${id}@@@`;
  });

  // \[...\]
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (match, formula) => {
    const id = nextMathBlockId++;
    mathBlockMap.set(id, renderMathBlock(formula));
    return `@@@MATHBLOCK${id}@@@`;
  });

  // 步骤 4：行内公式（Inline Math）
  // 支持 $formula$ 和 \(...\)
  const mathInlineMap = new Map();
  let nextMathInlineId = 0;

  function renderMathInline(formula) {
    const trimmed = formula.trim();
    if (typeof window !== 'undefined' && window.katex && typeof window.katex.renderToString === 'function') {
      try {
        return window.katex.renderToString(trimmed, { displayMode: false, throwOnError: false });
      } catch (err) {
        console.warn('KaTeX inline render error:', err);
      }
    }
    return `<span class="katex-inline-fallback"><code>${escapeHtml(trimmed)}</code></span>`;
  }

  // \(...\)
  text = text.replace(/\\\(([^\n\r]+?)\\\)/g, (match, formula) => {
    const id = nextMathInlineId++;
    mathInlineMap.set(id, renderMathInline(formula));
    return `@@@MATHINLINE${id}@@@`;
  });

  // $formula$
  // 必须避免匹配货币（如 $100 或 $20.50），且 $ 后或 $ 前不可为纯空格边界
  const inlineMathRegex = /(?<![\w\\])\$([^\s\$](?:[^\$\n\r]*?[^\s\$])?)\$(?!\w)/g;
  text = text.replace(inlineMathRegex, (match, formula) => {
    const trimmed = formula.trim();
    // 纯数字或金额格式判定（如 100, 20.50, 1,000, 50k）
    if (/^\d[\d,.]*(?:[kKmMbB])?$/.test(trimmed)) {
      return match;
    }
    // 开头为数字且无任何数学运算符/符号/字母变量
    if (/^\d/.test(trimmed) && !/[\\+\-*\/=^_{}()<>≤≥≠±~]/.test(trimmed) && !/[a-zA-Z]/.test(trimmed)) {
      return match;
    }
    const id = nextMathInlineId++;
    mathInlineMap.set(id, renderMathInline(formula));
    return `@@@MATHINLINE${id}@@@`;
  });

  // 步骤 5：普通 Markdown 渲染
  let html = escapeHtml(text);

  // 标题
  html = html.replace(/^#### (.*$)/gim, '<h4>$1</h4>');
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

  // 引用
  html = html.replace(/^\> (.*$)/gim, '<blockquote>$1</blockquote>');

  // 粗体 & 斜体
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.*?)__/g, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  html = html.replace(/(?<!\w)_([^\s_](?:[^_\n]*?[^\s_])?)_(?!\w)/g, '<em>$1</em>');

  // 无序列表
  html = html.replace(/^\s*[-*]\s+(.*$)/gim, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/gms, '<ul>$1</ul>');
  html = html.replace(/<\/ul>\s*<ul>/g, '');

  // 段落划分与换行
  const paragraphs = html.split(/\n{2,}/);
  html = paragraphs
    .map((p) => {
      p = p.trim();
      if (!p) return '';
      if (
        p.startsWith('<h') ||
        p.startsWith('<ul>') ||
        p.startsWith('<blockquote>') ||
        p.startsWith('@@@CODEBLOCK') ||
        p.startsWith('@@@MATHBLOCK')
      ) {
        return p;
      }
      return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');

  // 步骤 6：按顺序还原所有占位符
  // 6a. 还原行内代码 @@@INLINECODE${id}@@@ -> <code>...</code>
  html = html.replace(/@@@INLINECODE(\d+)@@@/g, (match, idStr) => {
    const id = parseInt(idStr, 10);
    const code = inlineCodeMap.get(id);
    return code !== undefined ? `<code>${escapeHtml(code)}</code>` : '';
  });

  // 6b. 还原块级公式 @@@MATHBLOCK${id}@@@ -> 渲染后的 KaTeX 块
  html = html.replace(/@@@MATHBLOCK(\d+)@@@/g, (match, idStr) => {
    const id = parseInt(idStr, 10);
    return mathBlockMap.get(id) || '';
  });

  // 6c. 还原行内公式 @@@MATHINLINE${id}@@@ -> 渲染后的 KaTeX 行内 span
  html = html.replace(/@@@MATHINLINE(\d+)@@@/g, (match, idStr) => {
    const id = parseInt(idStr, 10);
    return mathInlineMap.get(id) || '';
  });

  // 6d. 还原代码块 @@@CODEBLOCK${id}@@@ -> 渲染后的代码块容器
  html = html.replace(/@@@CODEBLOCK(\d+)@@@/g, (match, idStr) => {
    const id = parseInt(idStr, 10);
    const item = codeBlocksMap.get(id);
    if (!item) return '';

    const lang = item.lang;
    const escapedCode = escapeHtml(item.code);

    return `
      <div class="code-block-wrapper" data-code-id="${id}">
        <div class="code-block-header">
          <span class="code-lang-label">${lang}</span>
          <div class="code-actions">
            <button type="button" class="code-action-btn copy-code-btn" data-code-id="${id}">复制代码</button>
            <button type="button" class="code-action-btn push-code-btn" data-code-id="${id}">插入主任务</button>
          </div>
        </div>
        <pre><code class="language-${lang}">${escapedCode}</code></pre>
      </div>
    `;
  });

  // 6e. 还原转义美元符号 @@@ESCAPEDDOLLAR@@@ -> $
  html = html.replace(/@@@ESCAPEDDOLLAR@@@/g, '$');

  targetEl.innerHTML = html;
}

// Event Delegation for Code Block Actions across any turn
messagesList.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('.copy-code-btn');
  if (copyBtn) {
    const codeId = parseInt(copyBtn.getAttribute('data-code-id'), 10);
    const item = codeBlocksMap.get(codeId);
    if (item && item.code) {
      try {
        await navigator.clipboard.writeText(item.code);
        const originalText = copyBtn.textContent;
        copyBtn.textContent = '✓ 已复制';
        setTimeout(() => {
          copyBtn.textContent = originalText;
        }, 1800);
      } catch (err) {
        console.warn('Clipboard write failed:', err);
      }
    }
    return;
  }

  const pushCodeBtn = e.target.closest('.push-code-btn');
  if (pushCodeBtn) {
    const codeId = parseInt(pushCodeBtn.getAttribute('data-code-id'), 10);
    const item = codeBlocksMap.get(codeId);
    if (item && item.code) {
      const codeSnippet = `\`\`\`${item.lang}\n${item.code}\n\`\`\``;
      await pushSnippetToMain(codeSnippet, '请参考此代码片段进行实现');
    }
  }
});

// ==========================================================================
// Push to Main Agent Execution (Complete Multi-Turn Logs)
// ==========================================================================
function formatSessionHistoryForMain(userNote = '') {
  const rounds = [];
  let current = null;

  for (const item of sessionHistory) {
    if (item.role === 'user') {
      if (current) rounds.push(current);
      current = {
        userContent: item.content,
        quotedText: item.quotedText || '',
        assistantContent: ''
      };
    } else if (item.role === 'assistant' && current) {
      current.assistantContent = item.content;
    }
  }
  if (current) rounds.push(current);

  const totalRounds = rounds.length;
  const lines = [
    '> 💡 **Side Chat (/btw) 旁路对话总结与上下文移交**',
    '>'
  ];

  const trimmedNote = (userNote || '').trim();
  if (trimmedNote) {
    lines.push(`> 📝 **用户附言**：${trimmedNote}`, '>');
  }

  lines.push(
    '> ---',
    `> **对话全纪录（共 ${totalRounds} 轮）**：`,
    ''
  );

  rounds.forEach((rnd, idx) => {
    const roundNum = idx + 1;
    const isFollowup = roundNum > 1;
    lines.push(`**第 ${roundNum} 轮**：`);
    if (rnd.quotedText) {
      lines.push(`- 引用内容：\`${rnd.quotedText.replace(/\n+/g, ' ').slice(0, 300)}\``);
    }
    lines.push(`- 用户${isFollowup ? '追问' : '提问'}：${rnd.userContent}`);
    lines.push(`- 旁路回答：\n${rnd.assistantContent}\n`);
  });

  return lines.join('\n');
}

async function pushThreadToMain(userNote = '') {
  if (sessionHistory.length === 0) return;
  const formatted = formatSessionHistoryForMain(userNote);
  await executePush(formatted);
}

async function pushSnippetToMain(snippet, userNote = '') {
  const trimmedSnippet = (snippet || '').trim();
  const trimmedNote = (userNote || '').trim();
  if (!trimmedSnippet) return;

  const formatted = [
    '**[Side Chat (/btw) 代码片段回填]**',
    trimmedNote ? `\n**用户指令**：${trimmedNote}\n` : '',
    trimmedSnippet
  ]
    .filter(Boolean)
    .join('\n');

  await executePush(formatted);
}

async function executePush(formattedMessage) {
  let success = false;

  // 1. Try host SDK agent.sendMessage first
  if (typeof window.sidecar?.agent?.sendMessage === 'function') {
    try {
      await window.sidecar.agent.sendMessage(formattedMessage, currentConversationId);
      success = true;
    } catch (err) {
      console.warn('window.sidecar.agent.sendMessage threw, falling back to /api/push-to-main:', err);
    }
  }

  // 2. Fallback to backend POST /api/push-to-main
  if (!success) {
    try {
      const res = await apiFetch('/api/push-to-main', {
        method: 'POST',
        body: {
          conversationId: currentConversationId,
          message: formattedMessage
        }
      });
      if (res.ok) {
        success = true;
      }
    } catch (err) {
      console.error('Failed to push to main via /api/push-to-main:', err);
    }
  }

  if (success) {
    showPushFeedback('✓ 已将完整旁路上下文推入主会话', true);
    pushNotePanel.classList.add('hidden');
    pushNoteInput.value = '';
    if (!CSS.supports('field-sizing', 'content')) {
      pushNoteInput.style.height = 'auto';
    }
  } else {
    showPushFeedback('⚠️ 推入主会话失败，请检查网络或稍后重试', false);
  }
}

function showPushFeedback(msg, isSuccess) {
  pushStatusText.textContent = msg;
  pushStatus.className = isSuccess ? 'push-status' : 'push-status error';
  pushStatus.classList.remove('hidden');
}

// Push Buttons Event Handlers
pushDirectBtn.addEventListener('click', () => {
  pushThreadToMain();
});

pushNoteToggleBtn.addEventListener('click', () => {
  const isHidden = pushNotePanel.classList.contains('hidden');
  if (isHidden) {
    pushNotePanel.classList.remove('hidden');
    pushNoteInput.focus();
  } else {
    pushNotePanel.classList.add('hidden');
  }
});

pushNoteSubmitBtn.addEventListener('click', () => {
  const note = pushNoteInput.value.trim();
  pushThreadToMain(note);
});

pushNoteCancelBtn.addEventListener('click', () => {
  pushNotePanel.classList.add('hidden');
  pushNoteInput.value = '';
});

// ==========================================================================
// View Reset / New Session (新会话：清空旁路历史，重新感知主会话)
// ==========================================================================
function resetSession() {
  if (isGenerating) {
    stopGeneration();
  }

  sessionHistory = [];
  activeQuote = null;
  codeBlocksMap.clear();
  nextCodeBlockId = 1;

  messagesList.innerHTML = '';
  messagesContainer.classList.add('hidden');
  emptyState.classList.remove('hidden');

  answerLoading.classList.add('hidden');
  threadPushActions.classList.add('hidden');
  pushNotePanel.classList.add('hidden');
  pushStatus.classList.add('hidden');

  hideQuoteBanner();
  questionInput.value = '';
  if (!CSS.supports('field-sizing', 'content')) {
    questionInput.style.height = 'auto';
  }

  // Re-fetch the latest main conversation context
  fetchContext();
  questionInput.focus();
}

resetBtn.addEventListener('click', () => {
  resetSession();
});

// ==========================================================================
// Quick Prompt Chips
// ==========================================================================
document.querySelectorAll('.prompt-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const prompt = chip.getAttribute('data-prompt');
    if (prompt) {
      questionInput.value = prompt;
      submitQuestion();
    }
  });
});

// ==========================================================================
// Input & Keyboard Handling (with complete IME Composition protection)
// ==========================================================================
let isComposing = false;

questionInput.addEventListener('compositionstart', () => {
  isComposing = true;
});

questionInput.addEventListener('compositionend', () => {
  isComposing = false;
});

questionInput.addEventListener('keydown', (e) => {
  // Prevent sending while IME (Chinese/Japanese Pinyin/Wubi etc.) is active
  if (e.isComposing || isComposing || e.keyCode === 229) {
    return;
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitQuestion();
  }
});

let isNoteComposing = false;
pushNoteInput?.addEventListener('compositionstart', () => {
  isNoteComposing = true;
});

pushNoteInput?.addEventListener('compositionend', () => {
  isNoteComposing = false;
});

pushNoteInput?.addEventListener('keydown', (e) => {
  if (e.isComposing || isNoteComposing || e.keyCode === 229) {
    return;
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const note = pushNoteInput.value.trim();
    pushThreadToMain(note);
  }
});

sendBtn.addEventListener('click', () => {
  submitQuestion();
});

stopBtn?.addEventListener('click', () => {
  stopGeneration();
});

inlineStopBtn?.addEventListener('click', () => {
  stopGeneration();
});

window.addEventListener('keydown', (e) => {
  // Global shortcut inside Side Chat iframe (Shift+Command+S / Shift+Ctrl+S)
  const isShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 's' || e.key === 'S' || e.code === 'KeyS' || e.keyCode === 83);
  if (isShortcut) {
    e.preventDefault();
    e.stopPropagation();
    if (questionInput) {
      questionInput.focus();
      try {
        questionInput.select();
      } catch (_) {}
    }
    return;
  }

  if (e.key === 'Escape' && isGenerating) {
    e.preventDefault();
    stopGeneration();
  }
}, true);

quoteClearBtn.addEventListener('click', () => {
  clearActiveQuote();
});

contextToggleBtn.addEventListener('click', () => {
  toggleContextDrawer();
});

ctxDrawerClose.addEventListener('click', () => {
  toggleContextDrawer();
});

// ==========================================================================
// Dynamic Model Selector & Persistence
// ==========================================================================
let lastModelsSignature = '';

function restoreSavedModel() {
  try {
    const saved = localStorage.getItem('side-chat-model');
    if (saved && [...modelSelect.options].some((opt) => opt.value === saved)) {
      modelSelect.value = saved;
    } else if ([...modelSelect.options].some((opt) => opt.value === 'MODEL_PLACEHOLDER_M320')) {
      modelSelect.value = 'MODEL_PLACEHOLDER_M320';
    }
  } catch (err) {
    console.warn('Failed to restore saved model from localStorage:', err);
  }
}

function getFamilyGroupMeta(family) {
  const f = (family || '').trim();
  const lower = f.toLowerCase();
  if (lower.includes('flash')) {
    return { key: 'gemini-flash', label: '⚡ Gemini Flash (极速推荐)', order: 1 };
  }
  if (lower.includes('gemini') || lower.includes('argon')) {
    return { key: 'gemini-4', label: '✨ Gemini 4', order: 2 };
  }
  if (lower.includes('claude')) {
    return { key: 'claude', label: '🧠 Claude', order: 3 };
  }
  return { key: 'other', label: '🌐 其他模型', order: 4 };
}

function updateModelSelectOptions(models) {
  if (!Array.isArray(models) || models.length === 0) return;

  const sig = JSON.stringify(models.map((m) => (m.id || '') + (m.label || '') + (m.family || '')));
  if (sig === lastModelsSignature) {
    return;
  }
  lastModelsSignature = sig;

  // Preserve user's current selection or localStorage preference
  const activeVal = modelSelect.value || localStorage.getItem('side-chat-model') || 'MODEL_PLACEHOLDER_M320';

  // Group by family
  const groups = new Map();
  for (const m of models) {
    if (!m || !m.id) continue;
    const meta = getFamilyGroupMeta(m.family);
    if (!groups.has(meta.key)) {
      groups.set(meta.key, { label: meta.label, order: meta.order, items: [] });
    }
    groups.get(meta.key).items.push(m);
  }

  const sortedGroups = [...groups.values()].sort((a, b) => a.order - b.order);

  modelSelect.innerHTML = '';
  for (const group of sortedGroups) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.label;
    for (const item of group.items) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.label || item.id;
      optgroup.appendChild(option);
    }
    modelSelect.appendChild(optgroup);
  }

  // Restore selection
  if ([...modelSelect.options].some((opt) => opt.value === activeVal)) {
    modelSelect.value = activeVal;
  } else if ([...modelSelect.options].some((opt) => opt.value === 'MODEL_PLACEHOLDER_M320')) {
    modelSelect.value = 'MODEL_PLACEHOLDER_M320';
  }
}

async function fetchModels() {
  try {
    const res = await apiFetch('/api/models');
    if (res.ok) {
      const data = await res.json();
      const models = Array.isArray(data) ? data : data.models;
      if (Array.isArray(models) && models.length > 0) {
        updateModelSelectOptions(models);
      }
    }
  } catch (err) {
    console.warn('Failed to fetch /api/models:', err);
  }
}

modelSelect.addEventListener('change', () => {
  try {
    localStorage.setItem('side-chat-model', modelSelect.value);
  } catch (err) {
    console.warn('Failed to persist model selection:', err);
  }
});

// ==========================================================================
// Progressive Enhancement Fallback for field-sizing: content
// Modern Web Guidance: form-fields-automatically-fit-contents
// ==========================================================================
function initFieldSizingFallback() {
  if (!CSS.supports('field-sizing', 'content')) {
    const autoResize = (el) => {
      el.style.height = 'auto';
      const lineHeight = parseFloat(window.getComputedStyle(el).lineHeight) || 20;
      const minHeight = lineHeight * 2.5;
      const maxHeight = lineHeight * 8;
      const newHeight = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
      el.style.height = `${newHeight}px`;
    };

    [questionInput, pushNoteInput].forEach((ta) => {
      if (ta) {
        ta.addEventListener('input', () => autoResize(ta));
        autoResize(ta);
      }
    });
  }
}

// ==========================================================================
// Initialization
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  initFieldSizingFallback();
  restoreSavedModel();
  fetchModels();
  initWorkspaceAndContext();
  initSSE();
});
