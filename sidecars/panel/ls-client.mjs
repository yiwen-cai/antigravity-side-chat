import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import http from 'node:http';

const SERVICE_BASE = '/exa.language_server_pb.LanguageServerService/';

export const DEFAULT_MODELS = [
  { id: 'MODEL_PLACEHOLDER_M320', label: 'Gemini 3.8 Flash (Low)', tag: 'Fast', family: 'Gemini Flash', remainingFraction: 1.0 },
  { id: 'MODEL_PLACEHOLDER_M319', label: 'Gemini 3.8 Flash (Medium)', tag: 'Fast', family: 'Gemini Flash', remainingFraction: 1.0 },
  { id: 'MODEL_PLACEHOLDER_M318', label: 'Gemini 3.8 Flash (High)', tag: 'Fast', family: 'Gemini Flash', remainingFraction: 1.0 },
  { id: 'MODEL_PLACEHOLDER_M419', label: 'Gemini 4 Argon (Low)', tag: 'New', family: 'Gemini 4', remainingFraction: 1.0 },
  { id: 'MODEL_PLACEHOLDER_M418', label: 'Gemini 4 Argon (Medium)', tag: 'New', family: 'Gemini 4', remainingFraction: 1.0 },
  { id: 'MODEL_PLACEHOLDER_M417', label: 'Gemini 4 Argon (High)', tag: 'New', family: 'Gemini 4', remainingFraction: 1.0 },
  { id: 'MODEL_PLACEHOLDER_M403', label: 'Claude Sonnet 5.5 (Low)', tag: 'New', family: 'Claude', remainingFraction: 1.0 },
  { id: 'MODEL_PLACEHOLDER_M404', label: 'Claude Sonnet 5.5 (Medium)', tag: 'New', family: 'Claude', remainingFraction: 1.0 },
  { id: 'MODEL_PLACEHOLDER_M405', label: 'Claude Sonnet 5.5 (High)', tag: 'New', family: 'Claude', remainingFraction: 1.0 },
  { id: 'MODEL_PLACEHOLDER_M400', label: 'Claude Opus 5.5 (Low)', tag: 'New', family: 'Claude', remainingFraction: 1.0 },
  { id: 'MODEL_PLACEHOLDER_M401', label: 'Claude Opus 5.5 (Medium)', tag: 'New', family: 'Claude', remainingFraction: 1.0 },
  { id: 'MODEL_PLACEHOLDER_M402', label: 'Claude Opus 5.5 (High)', tag: 'New', family: 'Claude', remainingFraction: 1.0 },
  { id: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM', label: 'GPT-OSS 120B (Medium)', tag: 'Notice', family: 'Other', remainingFraction: 1.0 },
];

/**
 * Infers model family category from display label.
 */
export function inferFamily(label = '') {
  const l = String(label);
  if (l.includes('Flash')) return 'Gemini Flash';
  if (l.includes('Gemini 4') || l.includes('Argon')) return 'Gemini 4';
  if (l.includes('Claude')) return 'Claude';
  return 'Other';
}

/**
 * Sorts models so Gemini Flash appears first (Low -> Medium -> High),
 * followed by Gemini 4, Claude (Sonnet -> Opus), and Other.
 */
export function sortModels(models) {
  const familyRank = {
    'Gemini Flash': 1,
    'Gemini 4': 2,
    'Claude': 3,
    'Other': 4,
  };

  const intensityRank = (label = '') => {
    if (label.includes('(Low)')) return 1;
    if (label.includes('(Medium)')) return 2;
    if (label.includes('(High)')) return 3;
    return 4;
  };

  const claudeSubtypeRank = (label = '') => {
    if (label.includes('Sonnet')) return 1;
    if (label.includes('Opus')) return 2;
    return 3;
  };

  return [...models].sort((a, b) => {
    const fA = familyRank[a.family] || 99;
    const fB = familyRank[b.family] || 99;
    if (fA !== fB) return fA - fB;

    if (a.family === 'Claude' && b.family === 'Claude') {
      const sA = claudeSubtypeRank(a.label);
      const sB = claudeSubtypeRank(b.label);
      if (sA !== sB) return sA - sB;
    }

    const iA = intensityRank(a.label);
    const iB = intensityRank(b.label);
    if (iA !== iB) return iA - iB;

    return (a.label || '').localeCompare(b.label || '');
  });
}

export class LanguageServerClient {
  #endpoint = null;
  #cachedModels = null;
  #modelsCachedAt = 0;

  constructor(options = {}) {
    if (options.port && options.csrf) {
      this.#endpoint = { port: Number(options.port), csrf: String(options.csrf) };
    }
  }

  /**
   * Discovers or returns the active Antigravity Language Server address and CSRF token.
   */
  async getEndpoint(forceRefresh = false) {
    if (this.#endpoint && !forceRefresh) {
      return this.#endpoint;
    }

    // 1. Check environment variables first
    if (!forceRefresh) {
      const envAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
      const envCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
      if (envAddr && envCsrf) {
        const portMatch = envAddr.match(/:(\d+)$/);
        const port = portMatch ? Number(portMatch[1]) : Number(envAddr);
        if (Number.isInteger(port) && port > 0) {
          this.#endpoint = { port, csrf: envCsrf };
          return this.#endpoint;
        }
      }
    }

    // 2. Dynamic discovery fallback
    const discovered = this.#discoverFromSystem();
    if (discovered) {
      this.#endpoint = discovered;
      return this.#endpoint;
    }

    throw new Error('Unable to discover Antigravity Language Server port or CSRF token.');
  }

  #discoverFromSystem() {
    let csrf = null;
    const isWin = process.platform === 'win32';

    // A. Find CSRF token from running process command line
    try {
      if (isWin) {
        const cmd = 'powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter \\"Name LIKE \'language_server%\'\\" | Select-Object CommandLine | ConvertTo-Json -Compress"';
        const stdout = execSync(cmd, { encoding: 'utf-8', timeout: 5000, windowsHide: true });
        const match = stdout.match(/--csrf_token(?:=|\s+)"?([a-zA-Z0-9_-]+)/);
        if (match) csrf = match[1];
      } else {
        const stdout = execSync('ps -ax -o pid=,command=', { encoding: 'utf-8', timeout: 5000 });
        for (const line of stdout.split('\n')) {
          if (line.includes('language_server') && line.includes('--standalone')) {
            const match = line.match(/--csrf_token(?:=|\s+)"?([a-zA-Z0-9_-]+)/);
            if (match) {
              csrf = match[1];
              break;
            }
          }
        }
      }
    } catch {
      // Continue to next probe
    }

    // B. Find port from log files
    const home = homedir();
    const candidateLogPaths = [
      join(home, 'Library', 'Logs', 'Antigravity', 'language_server.log'),
      join(home, '.gemini', 'antigravity', 'logs', 'language_server.log'),
    ];

    if (isWin && process.env.APPDATA) {
      candidateLogPaths.push(join(process.env.APPDATA, 'Antigravity', 'logs', 'language_server.log'));
    }

    let port = null;
    for (const logPath of candidateLogPaths) {
      if (!existsSync(logPath)) continue;
      try {
        const content = readFileSync(logPath, 'utf-8');
        const matches = [...content.matchAll(/listening on random port at (\d+) for HTTP(?:\s|$)/g)];
        if (matches.length > 0) {
          port = Number(matches[matches.length - 1][1]);
          break;
        }
      } catch {
        // Continue checking other candidates
      }
    }

    if (port && csrf) {
      return { port, csrf };
    }

    return null;
  }

  /**
   * Invokes an RPC method on LanguageServerService.
   */
  async call(method, body = {}) {
    let retried = false;

    const executeCall = async () => {
      const endpoint = await this.getEndpoint(retried);
      const data = JSON.stringify(body);

      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: endpoint.port,
            path: SERVICE_BASE + method,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Connect-Protocol-Version': '1',
              'x-codeium-csrf-token': endpoint.csrf,
              'Content-Length': Buffer.byteLength(data),
            },
            timeout: 60000,
          },
          (res) => {
            let resBody = '';
            res.setEncoding('utf-8');
            res.on('data', (chunk) => {
              resBody += chunk;
            });
            res.on('end', () => {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                try {
                  const parsed = resBody ? JSON.parse(resBody) : {};
                  resolve(parsed);
                } catch (err) {
                  reject(new Error(`Failed to parse LanguageServer response: ${err.message}`));
                }
              } else {
                const err = new Error(
                  `LanguageServer RPC failed (${method}): HTTP ${res.statusCode} ${resBody}`
                );
                err.statusCode = res.statusCode;
                reject(err);
              }
            });
          }
        );

        req.on('error', (err) => {
          reject(err);
        });

        req.on('timeout', () => {
          req.destroy(new Error(`LanguageServer RPC timed out (${method})`));
        });

        req.write(data);
        req.end();
      });
    };

    try {
      return await executeCall();
    } catch (err) {
      const isAuthError = err.statusCode === 401 || err.statusCode === 403;
      const isConnRefused = err.code === 'ECONNREFUSED';
      if (!retried && (isAuthError || isConnRefused)) {
        retried = true;
        this.#endpoint = null;
        return await executeCall();
      }
      throw err;
    }
  }

  /**
   * Dynamically retrieves available models from Antigravity Language Server,
   * cached for 60 seconds, with fallback to DEFAULT_MODELS.
   */
  async getAvailableModels(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this.#cachedModels && now - this.#modelsCachedAt < 60000) {
      return this.#cachedModels;
    }

    try {
      const res = await this.call('GetCascadeModelConfigData', {});
      if (res && Array.isArray(res.clientModelConfigs) && res.clientModelConfigs.length > 0) {
        const rawList = res.clientModelConfigs
          .map((item) => {
            const id = item.modelOrAlias?.model || item.model || '';
            const label = item.label || id;
            if (!id) return null;
            return {
              id,
              label,
              tag: item.tagTitle || null,
              family: inferFamily(label),
              remainingFraction: item.quotaInfo?.remainingFraction ?? null,
            };
          })
          .filter(Boolean);

        if (rawList.length > 0) {
          const sorted = sortModels(rawList);
          this.#cachedModels = sorted;
          this.#modelsCachedAt = now;
          return sorted;
        }
      }
    } catch (err) {
      console.warn('[ls-client] GetCascadeModelConfigData failed, fallback to DEFAULT_MODELS:', err.message);
    }

    return DEFAULT_MODELS;
  }

  /**
   * Calls GetModelResponse with Gemini Flash models, cascading through fallbacks.
   */
  async askFlash({ prompt, model = 'MODEL_PLACEHOLDER_M320' }) {
    const fallbackChain = [
      model,
      'MODEL_PLACEHOLDER_M320',
      'MODEL_PLACEHOLDER_M318',
      'MODEL_GOOGLE_GEMINI_2_5_FLASH',
    ];

    // Deduplicate preserving order
    const candidateModels = [];
    for (const m of fallbackChain) {
      if (m && !candidateModels.includes(m)) {
        candidateModels.push(m);
      }
    }

    let lastError = null;
    for (const candidate of candidateModels) {
      try {
        const res = await this.call('GetModelResponse', { prompt, model: candidate });
        if (res && typeof res.response === 'string') {
          return { response: res.response, modelUsed: candidate };
        }
      } catch (err) {
        lastError = err;
        // If it's a model not found / unsupported enum error, try next in chain
        const msg = String(err.message || '');
        if (
          msg.includes('not_found') ||
          msg.includes('unknown model') ||
          msg.includes('INVALID_ARGUMENT') ||
          msg.includes('unsupported')
        ) {
          continue;
        }
        // If it's a general connection or service error, rethrow or continue
        continue;
      }
    }

    throw lastError || new Error('All model candidates failed in askFlash');
  }

  /**
   * Retrieves trajectory steps for the given cascade / conversation ID.
   */
  async getTrajectorySteps(conversationId, stepOffset = 0) {
    return await this.call('GetCascadeTrajectorySteps', {
      cascadeId: conversationId,
      stepOffset,
      trajectoryVerbosity: 0,
    });
  }

  /**
   * Sends a message to the main conversation using agentapi CLI.
   */
  async sendToMainConversation(conversationId, message, { title, projectId } = {}) {
    const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
    const file = exe || 'agentapi';
    const subArgs = ['send-message'];
    if (title) {
      subArgs.push('--title', title);
    }
    subArgs.push(conversationId, message);

    const execArgs = exe ? ['agentapi', ...subArgs] : subArgs;
    const env = { ...process.env };
    if (projectId) {
      env.ANTIGRAVITY_PROJECT_ID = projectId;
    }

    const out = execFileSync(file, execArgs, {
      encoding: 'utf-8',
      env,
    });

    try {
      return out.trim() ? JSON.parse(out) : { ok: true };
    } catch {
      return { ok: true, output: out.trim() };
    }
  }
}
