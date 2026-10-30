import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import http from 'node:http';

// Ensure loopback connections (LS & CDP) never route through system/env HTTP proxies
process.env.NO_PROXY = '127.0.0.1,localhost,::1';
process.env.no_proxy = '127.0.0.1,localhost,::1';
delete process.env.NODE_USE_ENV_PROXY;
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

import { LanguageServerClient } from './ls-client.mjs';
import { readConversationContext, buildSideChatPrompt } from './context-reader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize Language Server Client
const lsClient = new LanguageServerClient();

// In-memory state for quotes and SSE clients
const pendingQuotes = new Map(); // conversationId | 'global' -> quoteObj
const connectedSSEClients = new Set(); // Set of http.ServerResponse

/**
 * Broadcasts an SSE event to all connected listeners.
 */
function broadcastEvent(eventObj) {
  const payload = `data: ${JSON.stringify(eventObj)}\n\n`;
  for (const client of connectedSSEClients) {
    try {
      client.write(payload);
    } catch {
      connectedSSEClients.delete(client);
    }
  }
}

/**
 * Handles incoming quote from QuoteBridge or POST /api/quote.
 */
function handleIncomingQuote({ conversationId, quotedText, timestamp = Date.now(), id = randomUUID() }) {
  if (!quotedText || !String(quotedText).trim()) return null;

  const quote = {
    id,
    conversationId: conversationId || 'global',
    quotedText: String(quotedText).trim(),
    timestamp,
  };

  if (conversationId) {
    pendingQuotes.set(conversationId, quote);
  }
  pendingQuotes.set('global', quote);

  broadcastEvent({
    type: 'quote',
    ...quote,
  });

  return quote;
}

// Dynamically load QuoteBridge if present
let quoteBridge = null;
try {
  const bridgeModule = await import('./quote-bridge.mjs');
  if (bridgeModule && bridgeModule.QuoteBridge) {
    quoteBridge = new bridgeModule.QuoteBridge({
      onQuote: ({ conversationId, quotedText, timestamp }) => {
        handleIncomingQuote({ conversationId, quotedText, timestamp });
      },
    });
    if (typeof quoteBridge.start === 'function') {
      quoteBridge.start();
    }
    console.log('[side-chat] QuoteBridge initialized successfully');
  }
} catch (err) {
  console.log('[side-chat] quote-bridge.mjs dynamic import deferred or not available:', err.message);
}

// Helpers for loading static assets safely
function getHtml() {
  const file = join(__dirname, 'index.html');
  if (existsSync(file)) {
    return readFileSync(file, 'utf-8');
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Side Chat (/btw)</title></head><body><div style="font-family:sans-serif;padding:24px;"><h2>Side Chat (/btw)</h2><p>Loading UI assets...</p></div></body></html>`;
}

function getCss() {
  const file = join(__dirname, 'styles.css');
  if (existsSync(file)) {
    return readFileSync(file, 'utf-8');
  }
  return `/* Side Chat Styles Loading */ body { font-family: system-ui, -apple-system, sans-serif; }`;
}

function getJs() {
  const file = join(__dirname, 'app.js');
  if (existsSync(file)) {
    return readFileSync(file, 'utf-8');
  }
  return `console.log("[side-chat] app.js loading...");`;
}

function getKatexCss() {
  const file = join(__dirname, 'katex.min.css');
  if (existsSync(file)) {
    return readFileSync(file, 'utf-8');
  }
  return `/* KaTeX CSS placeholder */`;
}

function getKatexJs() {
  const file = join(__dirname, 'katex.min.js');
  if (existsSync(file)) {
    return readFileSync(file, 'utf-8');
  }
  return `console.warn("[side-chat] katex.min.js not found");`;
}

/**
 * Parses JSON request body from incoming HTTP request.
 */
function parseRequestBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        req.destroy();
        resolve({});
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

// Shared API Handlers
async function handleApiContext(params = {}) {
  const conversationId = params.conversationId || '';
  let workspaceUris = params.workspaceUris || [];
  if (typeof workspaceUris === 'string') {
    try {
      const parsed = JSON.parse(workspaceUris);
      workspaceUris = Array.isArray(parsed) ? parsed : [workspaceUris];
    } catch {
      workspaceUris = workspaceUris.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  const [context, models] = await Promise.all([
    readConversationContext(conversationId, { lsClient, workspaceUris }),
    lsClient.getAvailableModels(),
  ]);
  const pendingQuote = (conversationId ? pendingQuotes.get(conversationId) : null) || pendingQuotes.get('global') || null;

  return {
    ...context,
    models,
    pendingQuote,
    bridgeHealth: quoteBridge ? quoteBridge.health : null,
  };
}

async function handleApiModels() {
  const models = await lsClient.getAvailableModels();
  return {
    models,
    defaultModel: 'MODEL_PLACEHOLDER_M320',
  };
}

function handleApiQuote(data = {}) {
  const conversationId = data.conversationId || 'global';
  const quotedText = data.quotedText || '';
  const quote = handleIncomingQuote({ conversationId, quotedText });
  return { ok: true, quote };
}

function handleApiQuoteClear(data = {}) {
  const conversationId = data.conversationId;
  if (conversationId && pendingQuotes.has(conversationId)) {
    pendingQuotes.delete(conversationId);
  }
  if (pendingQuotes.has('global')) {
    pendingQuotes.delete('global');
  }
  broadcastEvent({
    type: 'quote_cleared',
    conversationId: conversationId || 'global',
  });
  return { ok: true };
}

async function handleApiAsk(data = {}) {
  const conversationId = data.conversationId || '';
  const question = data.question || '';
  const quotedText = data.quotedText || '';
  const workspaceUris = data.workspaceUris || [];
  const model = data.model || 'MODEL_PLACEHOLDER_M320';
  const history = Array.isArray(data.history) ? data.history : [];

  const context = await readConversationContext(conversationId, { lsClient, workspaceUris });
  const prompt = buildSideChatPrompt({ context, quotedText, question, history });

  const result = await lsClient.askFlash({ prompt, model });

  // Clear consumed quote
  if (conversationId && pendingQuotes.has(conversationId)) {
    pendingQuotes.delete(conversationId);
  }
  if (pendingQuotes.has('global')) {
    pendingQuotes.delete('global');
  }

  return {
    answer: result.response,
    modelUsed: result.modelUsed,
    contextMeta: {
      stepCount: context.stepCount,
      available: context.available,
    },
  };
}

async function handleApiPushToMain(data = {}, app = null) {
  const conversationId = data.conversationId;
  const message = data.message;
  const title = data.title;
  const projectId = data.projectId;

  if (!conversationId || !message) {
    throw new Error('Missing conversationId or message for push-to-main');
  }

  if (app && typeof app.sendMessage === 'function') {
    try {
      const res = await app.sendMessage(conversationId, message, { title, projectId });
      return { ok: true, result: res };
    } catch {
      // Fallback to lsClient sendToMainConversation
    }
  }

  const res = await lsClient.sendToMainConversation(conversationId, message, { title, projectId });
  return { ok: true, result: res };
}

/**
 * Handles GET /api/events SSE stream.
 */
function handleEventsSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(': connected\n\n');
  connectedSSEClients.add(res);

  // Send current pending quote if present
  const latestQuote = pendingQuotes.get('global');
  if (latestQuote) {
    res.write(`data: ${JSON.stringify({ type: 'quote', ...latestQuote })}\n\n`);
  }

  req.on('close', () => {
    connectedSSEClients.delete(res);
  });
}

/**
 * Handles POST /api/ask/stream SSE streaming endpoint.
 */
async function handleAskStreamSSE(req, res, preParsedData = null) {
  const data = preParsedData || (await parseRequestBody(req));
  const conversationId = data.conversationId || '';
  const question = data.question || '';
  const quotedText = data.quotedText || '';
  const workspaceUris = data.workspaceUris || [];
  const model = data.model || 'MODEL_PLACEHOLDER_M320';
  const history = Array.isArray(data.history) ? data.history : [];

  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
  });
  res.on('close', () => {
    clientDisconnected = true;
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  try {
    const context = await readConversationContext(conversationId, { lsClient, workspaceUris });
    const prompt = buildSideChatPrompt({ context, quotedText, question, history });

    if (clientDisconnected) {
      res.end();
      return;
    }

    const result = await lsClient.askFlash({ prompt, model });
    const fullText = result.response || '';

    // Stream tokens / words with slight cadence for a smooth generative experience
    const tokens = fullText.match(/(\s+|\S+)/g) || [fullText];
    for (let i = 0; i < tokens.length; i += 3) {
      if (clientDisconnected) break;
      const delta = tokens.slice(i, i + 3).join('');
      res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`);
      if (tokens.length > 10) {
        await new Promise((r) => setTimeout(r, 12));
      }
    }

    if (clientDisconnected) {
      res.end();
      return;
    }

    // Clear consumed quote
    if (conversationId && pendingQuotes.has(conversationId)) {
      pendingQuotes.delete(conversationId);
    }
    if (pendingQuotes.has('global')) {
      pendingQuotes.delete('global');
    }

    const donePayload = {
      type: 'done',
      answer: fullText,
      modelUsed: result.modelUsed,
      contextMeta: {
        stepCount: context.stepCount,
        available: context.available,
      },
    };
    res.write(`data: ${JSON.stringify(donePayload)}\n\n`);
    res.end();
  } catch (err) {
    if (!clientDisconnected) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      res.end();
    }
  }
}

// Load sidecar_sdk dynamically
let SidecarApp = null;
let SdkResponse = null;

try {
  const sdk = await import('sidecar_sdk');
  SidecarApp = sdk.SidecarApp;
  SdkResponse = sdk.Response;
} catch {
  try {
    const sdkPath = pathToFileURL(
      join(homedir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'index.mjs')
    ).href;
    const sdk = await import(sdkPath);
    SidecarApp = sdk.SidecarApp;
    SdkResponse = sdk.Response;
  } catch (err) {
    console.log('[side-chat] sidecar_sdk not found, will use standalone HTTP mode:', err.message);
  }
}

const isSidecarEnv = !!(
  SidecarApp &&
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT &&
  process.env.ANTIGRAVITY_LS_ADDRESS &&
  process.env.ANTIGRAVITY_CSRF_TOKEN
);

if (isSidecarEnv) {
  console.log('[side-chat] Launching in SidecarApp mode...');
  const app = new SidecarApp();

  // Register HTML pages with Cache-Control: no-store
  app.page('/', () => {
    if (SdkResponse) {
      return new SdkResponse(getHtml(), {
        contentType: 'text/html; charset=utf-8',
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    return getHtml();
  });
  if (SdkResponse) {
    app.page('/styles.css', () => new SdkResponse(getCss(), { contentType: 'text/css', headers: { 'Cache-Control': 'no-store' } }));
    app.page('/app.js', () => new SdkResponse(getJs(), { contentType: 'application/javascript', headers: { 'Cache-Control': 'no-store' } }));
    app.page('/katex.min.css', () => new SdkResponse(getKatexCss(), { contentType: 'text/css', headers: { 'Cache-Control': 'no-store' } }));
    app.page('/katex.min.js', () => new SdkResponse(getKatexJs(), { contentType: 'application/javascript', headers: { 'Cache-Control': 'no-store' } }));
    app.api('/styles.css', () => new SdkResponse(getCss(), { contentType: 'text/css', headers: { 'Cache-Control': 'no-store' } }), 'GET');
    app.api('/app.js', () => new SdkResponse(getJs(), { contentType: 'application/javascript', headers: { 'Cache-Control': 'no-store' } }), 'GET');
    app.api('/katex.min.css', () => new SdkResponse(getKatexCss(), { contentType: 'text/css', headers: { 'Cache-Control': 'no-store' } }), 'GET');
    app.api('/katex.min.js', () => new SdkResponse(getKatexJs(), { contentType: 'application/javascript', headers: { 'Cache-Control': 'no-store' } }), 'GET');
  }

  // Register JSON API routes
  app.api('/api/context', async (data) => await handleApiContext(data), 'GET');
  app.api('/api/models', async () => await handleApiModels(), 'GET');
  app.api('/api/quote', (data) => handleApiQuote(data), 'POST');
  app.api('/api/quote/clear', (data) => handleApiQuoteClear(data), 'POST');
  app.api('/api/ask', async (data) => await handleApiAsk(data), 'POST');
  app.api('/api/push-to-main', async (data) => await handleApiPushToMain(data, app), 'POST');

  const server = await app.run();

  // Wrap server.emit to intercept SSE streams, dynamic model route, and static assets
  const originalEmit = server.emit;
  server.emit = function (event, req, res) {
    if (event === 'request') {
      const url = new URL(req.url, 'http://127.0.0.1');

      if (url.pathname === '/api/events' && req.method === 'GET') {
        handleEventsSSE(req, res);
        return true;
      }
      if (url.pathname === '/api/ask/stream' && req.method === 'POST') {
        handleAskStreamSSE(req, res);
        return true;
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(getHtml());
        return true;
      }
      if (url.pathname === '/styles.css' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/css; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(getCss());
        return true;
      }
      if (url.pathname === '/app.js' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(getJs());
        return true;
      }
      if (url.pathname === '/katex.min.css' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/css; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(getKatexCss());
        return true;
      }
      if (url.pathname === '/katex.min.js' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(getKatexJs());
        return true;
      }
      if (url.pathname === '/api/models' && req.method === 'GET') {
        handleApiModels().then((data) => {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(data));
        }).catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        return true;
      }
    }
    return originalEmit.apply(this, arguments);
  };
} else {
  // Standalone HTTP Preview Mode
  const port = Number(process.env.SIDE_CHAT_PORT || 17895);
  console.log(`[side-chat] Launching in Standalone HTTP mode on port ${port}...`);

  const server = http.createServer(async (req, res) => {
    // Enable CORS for local preview
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-sidecar-token');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const host = req.headers.host || `127.0.0.1:${port}`;
    const url = new URL(req.url, `http://${host}`);

    try {
      // 1. Static Assets with Cache-Control: no-store
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(getHtml());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/styles.css') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(getCss());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/app.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(getJs());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/katex.min.css') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(getKatexCss());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/katex.min.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(getKatexJs());
        return;
      }

      // 2. SSE Streams
      if (req.method === 'GET' && url.pathname === '/api/events') {
        handleEventsSSE(req, res);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/ask/stream') {
        await handleAskStreamSSE(req, res);
        return;
      }

      // 3. API Endpoints
      if (req.method === 'GET' && url.pathname === '/api/models') {
        const data = await handleApiModels();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/context') {
        const params = {};
        for (const [key, value] of url.searchParams.entries()) {
          params[key] = value;
        }
        const data = await handleApiContext(params);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/quote') {
        const body = await parseRequestBody(req);
        const data = handleApiQuote(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/quote/clear') {
        const body = await parseRequestBody(req);
        const data = handleApiQuoteClear(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/ask') {
        const body = await parseRequestBody(req);
        const data = await handleApiAsk(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/push-to-main') {
        const body = await parseRequestBody(req);
        const data = await handleApiPushToMain(body, null);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      // Fallback
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[side-chat] Standalone server running at http://127.0.0.1:${port}`);
  });
}
