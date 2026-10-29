import { open, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CONV_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates a standard UUID conversation ID.
 */
export function isValidConversationId(id) {
  return typeof id === 'string' && CONV_ID_REGEX.test(id.trim());
}

/**
 * Safely extracts human-readable text from a turn's content field.
 */
function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('\n')
      .trim();
  }
  if (typeof content === 'object') {
    return content.text || JSON.stringify(content);
  }
  return String(content);
}

/**
 * Extracts tool names from tool_calls array.
 */
function extractTools(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((tc) => tc?.name || tc?.tool || 'unknown_tool').filter(Boolean);
}

/**
 * Reads the read-only context of the main conversation (Head + Tail strategy).
 */
export async function readConversationContext(conversationId, { lsClient, workspaceUris = [] } = {}) {
  const normUris = Array.isArray(workspaceUris)
    ? workspaceUris
    : typeof workspaceUris === 'string' && workspaceUris.trim()
    ? workspaceUris.split(',').map((u) => u.trim())
    : [];

  const defaultResult = {
    conversationId: conversationId || '',
    available: false,
    stepCount: 0,
    initialGoal: '',
    latestSummary: '',
    recentTurns: [],
    workspaceUris: normUris,
    formattedPromptContext: '',
  };

  if (!isValidConversationId(conversationId)) {
    defaultResult.formattedPromptContext = formatContextString(defaultResult);
    return defaultResult;
  }

  const baseLogsDir = join(
    homedir(),
    '.gemini',
    'antigravity',
    'brain',
    conversationId,
    '.system_generated',
    'logs'
  );

  let transcriptPath = join(baseLogsDir, 'transcript.jsonl');
  if (!existsSync(transcriptPath)) {
    const fullPath = join(baseLogsDir, 'transcript_full.jsonl');
    if (existsSync(fullPath)) {
      transcriptPath = fullPath;
    } else {
      transcriptPath = null;
    }
  }

  // Fallback to Language Server trajectory steps if transcript file is not yet available
  if (!transcriptPath) {
    if (lsClient && typeof lsClient.getTrajectorySteps === 'function') {
      try {
        const traj = await lsClient.getTrajectorySteps(conversationId, 0);
        if (traj && Array.isArray(traj.steps) && traj.steps.length > 0) {
          const steps = traj.steps;
          let initialGoal = '';
          const turns = [];

          for (const step of steps) {
            const isUser =
              step.type === 'CORTEX_STEP_TYPE_USER_INPUT' ||
              step.source === 'USER_EXPLICIT' ||
              step.type === 'USER_INPUT';
            const isModel =
              step.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' ||
              step.source === 'MODEL' ||
              step.type === 'PLANNER_RESPONSE';

            const text = extractText(step.content || step.userInput?.query || step.plannerResponse?.response);
            if (isUser && !initialGoal && text) {
              initialGoal = text.slice(0, 1000);
            }

            if (isUser && text) {
              turns.push({ role: 'user', text: text.slice(0, 1500), tools: [] });
            } else if (isModel) {
              const tools = extractTools(step.tool_calls || step.plannerResponse?.toolCalls);
              turns.push({
                role: 'assistant',
                text: (text || extractText(step.thinking)).slice(0, 1500),
                tools,
              });
            }
          }

          const recentTurns = turns.slice(-10);
          const latestAssistant = [...recentTurns].reverse().find((t) => t.role === 'assistant');
          const latestSummary = latestAssistant?.text
            ? latestAssistant.text.slice(0, 350)
            : recentTurns[recentTurns.length - 1]?.text?.slice(0, 350) || '';

          const result = {
            conversationId,
            available: true,
            stepCount: steps.length,
            initialGoal,
            latestSummary,
            recentTurns,
            workspaceUris: normUris,
            formattedPromptContext: '',
          };
          result.formattedPromptContext = formatContextString(result);
          return result;
        }
      } catch {
        // Fall through to defaultResult
      }
    }

    defaultResult.formattedPromptContext = formatContextString(defaultResult);
    return defaultResult;
  }

  // Read Head (16KB) and Tail (64KB) from transcript.jsonl
  let fileHandle = null;
  try {
    fileHandle = await open(transcriptPath, 'r');
    const fileStat = await fileHandle.stat();
    const fileSize = fileStat.size;

    if (fileSize === 0) {
      defaultResult.available = true;
      defaultResult.formattedPromptContext = formatContextString(defaultResult);
      return defaultResult;
    }

    // 1. Head Read (16KB) to find the initial user goal
    let initialGoal = '';
    const headLen = Math.min(16384, fileSize);
    const headBuf = Buffer.alloc(headLen);
    await fileHandle.read(headBuf, 0, headLen, 0);
    const headStr = headBuf.toString('utf-8');
    const headLines = headStr.split('\n');

    for (const line of headLines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (
          obj.type === 'USER_INPUT' ||
          (obj.source === 'USER_EXPLICIT' && obj.content) ||
          (obj.content && String(obj.content).includes('<USER_REQUEST>'))
        ) {
          const raw = extractText(obj.content);
          const match = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
          const goal = match ? match[1].trim() : raw;
          if (goal) {
            initialGoal = goal.slice(0, 1000);
            break;
          }
        }
      } catch {
        // Continue looking for valid JSON lines in head
      }
    }

    // Fallback if no explicit USER_INPUT found (e.g. subagent or system-initialized sessions)
    if (!initialGoal) {
      for (const line of headLines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          const raw = extractText(obj.content);
          if (raw && (raw.includes('Task Description') || raw.includes('Task') || raw.length > 20)) {
            const taskMatch = raw.match(/(?:# Task Description|Task Description)[\s\S]*?(?=\n\n##|\n##|$)/i);
            initialGoal = (taskMatch ? taskMatch[0].trim() : raw).slice(0, 1000);
            break;
          }
        } catch {}
      }
    }

    // 2. Tail Read (64KB) to parse the latest complete JSONL steps
    const tailLen = Math.min(65536, fileSize);
    const tailPos = fileSize - tailLen;
    const tailBuf = Buffer.alloc(tailLen);
    await fileHandle.read(tailBuf, 0, tailLen, tailPos);
    let tailStr = tailBuf.toString('utf-8');

    if (tailPos > 0) {
      // Discard partial line at the start of tail buffer
      const firstNewline = tailStr.indexOf('\n');
      if (firstNewline !== -1) {
        tailStr = tailStr.slice(firstNewline + 1);
      }
    }

    const tailLines = tailStr.split('\n');
    let maxStepIndex = -1;
    const parsedTurns = [];

    for (const line of tailLines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (typeof obj.step_index === 'number' && obj.step_index > maxStepIndex) {
          maxStepIndex = obj.step_index;
        }

        const isUser = obj.type === 'USER_INPUT' || obj.source === 'USER_EXPLICIT';
        const isModel = obj.type === 'PLANNER_RESPONSE' || obj.source === 'MODEL';

        if (isUser) {
          const text = extractText(obj.content);
          if (text) {
            parsedTurns.push({ role: 'user', text: text.slice(0, 1500), tools: [] });
          }
        } else if (isModel) {
          const tools = extractTools(obj.tool_calls);
          const text = extractText(obj.content || obj.thinking || '');
          if (text || tools.length > 0) {
            parsedTurns.push({
              role: 'assistant',
              text: text.slice(0, 1500),
              tools,
            });
          }
        }
      } catch {
        // Ignore partial or corrupted JSON lines
      }
    }

    const recentTurns = parsedTurns.slice(-10);
    const stepCount = maxStepIndex >= 0 ? maxStepIndex + 1 : parsedTurns.length;
    const latestAssistant = [...recentTurns].reverse().find((t) => t.role === 'assistant');
    const latestSummary = latestAssistant?.text
      ? latestAssistant.text.slice(0, 350)
      : recentTurns[recentTurns.length - 1]?.text?.slice(0, 350) || '';

    const result = {
      conversationId,
      available: true,
      stepCount,
      initialGoal,
      latestSummary,
      recentTurns,
      workspaceUris: normUris,
      formattedPromptContext: '',
    };
    result.formattedPromptContext = formatContextString(result);
    return result;
  } catch (err) {
    defaultResult.formattedPromptContext = formatContextString(defaultResult);
    return defaultResult;
  } finally {
    if (fileHandle) {
      try {
        await fileHandle.close();
      } catch {}
    }
  }
}

/**
 * Formats XML-structured <workspace_context> and <main_session_context>.
 */
function formatContextString(ctx) {
  const parts = [];

  // Workspace context
  if (Array.isArray(ctx.workspaceUris) && ctx.workspaceUris.length > 0) {
    parts.push('<workspace_context>');
    parts.push('Active Workspaces:');
    for (const uri of ctx.workspaceUris) {
      parts.push(`- ${uri}`);
    }
    parts.push('</workspace_context>');
  }

  // Main session context
  parts.push('<main_session_context>');
  if (ctx.conversationId) {
    parts.push(`Conversation ID: ${ctx.conversationId}`);
  }
  parts.push(`Session Status: ${ctx.available ? `Active (Step ${ctx.stepCount})` : 'Standalone / No active session attached'}`);

  if (ctx.initialGoal) {
    parts.push(`\nInitial User Goal:\n${ctx.initialGoal}`);
  }

  if (Array.isArray(ctx.recentTurns) && ctx.recentTurns.length > 0) {
    parts.push('\nRecent Turns (Main Agent Trajectory):');
    for (const turn of ctx.recentTurns) {
      const toolStr = turn.tools && turn.tools.length > 0 ? ` [Used tools: ${turn.tools.join(', ')}]` : '';
      const speaker = turn.role === 'user' ? 'User' : 'Main Assistant';
      parts.push(`[${speaker}]${toolStr}: ${turn.text.replace(/\n+/g, ' ')}`);
    }
  }

  parts.push('</main_session_context>');
  return parts.join('\n');
}

/**
 * Builds the complete prompt for Gemini Flash.
 */
export function buildSideChatPrompt({ context, quotedText, question, history = [] }) {
  const promptSections = [
    'You are Antigravity Side Chat, a fast, lightweight, and parallel advisory assistant inspired by Claude Code\'s /btw command.',
    'You run in the auxiliary side pane to answer quick questions, explain code, and provide second opinions WITHOUT interrupting or altering the main agent session.',
    '',
    'Core Guidelines:',
    '- Answer concisely, directly, and accurately in the same language the user uses.',
    '- You are an advisory side channel: do not attempt to invoke tools or pretend to edit files directly.',
    '- Use the provided main session context and quoted selection to understand the user\'s background context.',
  ];

  if (context?.formattedPromptContext) {
    promptSections.push('', context.formattedPromptContext);
  }

  if (Array.isArray(history) && history.length > 0) {
    const historyLines = [
      '<side_chat_conversation_history>',
      'The following is the ongoing multi-turn dialogue within this Side Chat session. Maintain full conversational continuity, remembering previous explanations, code snippets, and clarifications:'
    ];

    let turnCount = 0;
    for (const item of history) {
      if (!item) continue;
      if (item.role === 'user') {
        turnCount++;
        const quotePart = item.quotedText && String(item.quotedText).trim()
          ? ` [Selected Quote: "${String(item.quotedText).trim().replace(/\s+/g, ' ').slice(0, 300)}"]`
          : '';
        historyLines.push(`User (Turn ${turnCount}):${quotePart} ${item.content || ''}`);
      } else if (item.role === 'assistant') {
        historyLines.push(`Assistant (Turn ${turnCount || 1}): ${item.content || ''}`);
      }
    }

    historyLines.push('</side_chat_conversation_history>');
    promptSections.push('', historyLines.join('\n'));
  }

  if (quotedText && String(quotedText).trim()) {
    promptSections.push(
      '',
      '<selected_quote>',
      'The user specifically highlighted the following excerpt from their workspace or conversation to ask about:',
      '"""',
      String(quotedText).trim(),
      '"""',
      '</selected_quote>'
    );
  }

  promptSections.push(
    '',
    '<user_question>',
    String(question || '').trim(),
    '</user_question>'
  );

  return promptSections.join('\n');
}
