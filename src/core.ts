/**
 * Assert core: the pure, node-free interpretation layer shared by the CLI and
 * any client (e.g. a web UI). It turns raw session data into a normalized,
 * self-linked model and resolves line -> turn -> prompt/reasoning lookups.
 *
 * No fs, git, or clock — everything here is a deterministic function of data
 * the caller already has (blame records + session `.jsonl` text). The CLI owns
 * the IO (computing blame, locating/reading session files); this owns the
 * associating. Exported at `@assertlabs/cli/core`.
 */

import type { SessionEvent, SessionSource } from './schema';

/** One line of blame: its content plus who authored it. */
export interface BlameLine {
  line: number; // 1-indexed
  content: string;
  source: 'agent' | 'human' | 'unknown';
  sessionId?: string;
  turnId?: string;
  agent?: SessionSource;
  modelId?: string;
  provider?: string;
}

export interface Prompt {
  turnId: string; // the human_turn id
  text: string;
  timestamp: string;
}

export interface ReasoningStep {
  text: string;
  timestamp: string;
}

export interface ToolCall {
  toolCallId: string;
  name: string;
  input: unknown;
  output?: string;
  error?: string;
  timestamp: string;
}

/** An assistant turn, with its triggering prompt linked (not reconstructed). */
export interface Turn {
  turnId: string;
  sessionId: string;
  prompt?: Prompt;
  reasoning: ReasoningStep[];
  text: string[]; // assistant message segments
  toolCalls: ToolCall[];
  modelId?: string;
  provider?: string;
  agent?: SessionSource;
  startedAt: string;
  changedCode: boolean; // authored ≥1 surviving line (powers turnContext)
}

export interface Session {
  sessionId: string;
  source: SessionSource;
  turns: Turn[]; // ordered by start time
  events: SessionEvent[]; // raw stream, for a client that wants the unmodeled log
  turnAliases?: Record<string, string>; // native assistant id -> logical prompt turn id
}

/** Parse a session `.jsonl` (transcript, plus attribution when present) into the
 * normalized model. Prompts are linked by `assistant_turn_start.promptTurnId`,
 * so no ordering heuristic is needed. */
export function parseSession(jsonl: string): Session {
  const events: SessionEvent[] = [];
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as SessionEvent);
    } catch {
      /* skip malformed lines */
    }
  }
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  let sessionId = '';
  let source: SessionSource = 'unknown';
  const prompts = new Map<string, Prompt>();
  const promptRef = new Map<string, string>(); // assistant turnId -> prompt turnId
  const turns = new Map<string, Turn>();
  const changed = new Set<string>();
  const turnIdByPrompt = new Map<string, string>();
  const turnAliases = new Map<string, string>();
  const promptAliases = new Map<string, string>();
  const logicalTurnId = (turnId: string) => turnAliases.get(turnId) ?? turnId;

  const promptIdByContent = new Map<string, string>();
  for (const event of events) {
    if (event.type !== 'human_turn') continue;
    const key = `${event.timestamp}\0${event.content}`;
    const logicalId = promptIdByContent.get(key) ?? event.turnId;
    promptIdByContent.set(key, logicalId);
    promptAliases.set(event.turnId, logicalId);
    if (!prompts.has(logicalId)) {
      prompts.set(logicalId, {
        turnId: logicalId,
        text: event.content,
        timestamp: event.timestamp,
      });
    }
  }

  // Resolve aliases before consuming child events. Continuation files and
  // historical captures are independently timestamped, so a child event can
  // otherwise sort before the assistant-start block that defines its alias.
  for (const event of events) {
    if (event.type !== 'assistant_turn_start') continue;
    const promptId = event.promptTurnId
      ? (promptAliases.get(event.promptTurnId) ?? event.promptTurnId)
      : undefined;
    const logicalId = promptId
      ? (turnIdByPrompt.get(promptId) ?? event.turnId)
      : event.turnId;
    if (promptId) turnIdByPrompt.set(promptId, logicalId);
    turnAliases.set(event.turnId, logicalId);
  }

  const turn = (turnId: string, at: string): Turn => {
    let t = turns.get(turnId);
    if (!t) {
      t = { turnId, sessionId, reasoning: [], text: [], toolCalls: [], startedAt: at, changedCode: false };
      turns.set(turnId, t);
    }
    return t;
  };

  for (const ev of events) {
    if (ev.sessionId && !sessionId) sessionId = ev.sessionId;
    switch (ev.type) {
      case 'session_start':
        source = ev.source;
        break;
      case 'human_turn':
        break;
      case 'assistant_turn_start': {
        const logicalId = logicalTurnId(ev.turnId);
        const t = turn(logicalId, ev.timestamp);
        if (ev.timestamp < t.startedAt) t.startedAt = ev.timestamp;
        if (ev.model) t.modelId = ev.model;
        if (ev.provider) t.provider = ev.provider;
        if (ev.promptTurnId) {
          promptRef.set(
            logicalId,
            promptAliases.get(ev.promptTurnId) ?? ev.promptTurnId,
          );
        }
        break;
      }
      case 'assistant_reasoning':
        turn(logicalTurnId(ev.turnId), ev.timestamp).reasoning.push({ text: ev.text, timestamp: ev.timestamp });
        break;
      case 'assistant_text':
        turn(logicalTurnId(ev.turnId), ev.timestamp).text.push(ev.text);
        break;
      case 'tool_call': {
        const t = turn(logicalTurnId(ev.turnId), ev.timestamp);
        if (!t.toolCalls.some((call) => call.toolCallId === ev.toolCallId)) {
          t.toolCalls.push({
            toolCallId: ev.toolCallId,
            name: ev.toolName,
            input: ev.input,
            timestamp: ev.timestamp,
          });
        }
        break;
      }
      case 'tool_result': {
        const tc = turns.get(logicalTurnId(ev.turnId))?.toolCalls.find((c) => c.toolCallId === ev.toolCallId);
        if (tc) {
          tc.output = ev.output;
          tc.error = ev.error;
        }
        break;
      }
      case 'line_attribution':
        for (const l of ev.lines) if (l.turnId) changed.add(logicalTurnId(l.turnId));
        break;
    }
  }

  for (const [turnId, promptId] of promptRef) {
    const p = prompts.get(promptId);
    const t = turns.get(turnId);
    if (p && t) t.prompt = p;
  }
  for (const t of turns.values()) {
    t.sessionId = sessionId;
    t.agent = source;
    if (changed.has(t.turnId)) t.changedCode = true;
  }

  const ordered = [...turns.values()].sort((a, b) =>
    a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0,
  );
  return {
    sessionId,
    source,
    turns: ordered,
    events,
    turnAliases: Object.fromEntries(turnAliases),
  };
}

export function getTurn(session: Session, turnId: string): Turn | undefined {
  const logicalId = session.turnAliases?.[turnId] ?? turnId;
  return session.turns.find((t) => t.turnId === logicalId);
}

export function promptForLine(line: BlameLine, session: Session): Prompt | undefined {
  return line.turnId ? getTurn(session, line.turnId)?.prompt : undefined;
}

export function reasoningForLine(line: BlameLine, session: Session): ReasoningStep[] {
  return (line.turnId && getTurn(session, line.turnId)?.reasoning) || [];
}

/** The turn plus the run of immediately-preceding turns that changed no code —
 * the "dig back" context when a prompt like "now implement" is too shallow.
 * Stops at (and excludes) the previous code-producing turn or session start. */
export function turnContext(
  session: Session,
  turnId: string,
  opts: { maxTurns?: number } = {},
): Turn[] {
  const max = opts.maxTurns ?? Infinity;
  const logicalId = session.turnAliases?.[turnId] ?? turnId;
  const idx = session.turns.findIndex((t) => t.turnId === logicalId);
  if (idx < 0) return [];
  const chain: Turn[] = [session.turns[idx]];
  for (let i = idx - 1; i >= 0 && chain.length < max; i--) {
    if (session.turns[i].changedCode) break;
    chain.unshift(session.turns[i]);
  }
  return chain;
}

export interface DiffProvenance {
  turn: Turn;
  context: Turn[]; // turnContext(turn)
  lines: number[]; // blame line numbers attributed to this turn
}

/** For a set of blame lines (e.g. a diff), the distinct turns behind them, each
 * with its context chain and the lines it produced. */
export function diffProvenance(blame: BlameLine[], session: Session): DiffProvenance[] {
  const byTurn = new Map<string, number[]>();
  for (const l of blame) {
    if (l.source !== 'agent' || !l.turnId) continue;
    const turnId = session.turnAliases?.[l.turnId] ?? l.turnId;
    const lines = byTurn.get(turnId) ?? [];
    lines.push(l.line);
    byTurn.set(turnId, lines);
  }
  const out: DiffProvenance[] = [];
  for (const [turnId, lines] of byTurn) {
    const turn = getTurn(session, turnId);
    if (turn) out.push({ turn, context: turnContext(session, turnId), lines });
  }
  return out;
}

export function linesForTurn(
  blame: BlameLine[],
  turnId: string,
  session?: Session,
): BlameLine[] {
  const logicalId = session?.turnAliases?.[turnId] ?? turnId;
  return blame.filter(
    (line) =>
      line.turnId != null &&
      (session?.turnAliases?.[line.turnId] ?? line.turnId) === logicalId,
  );
}

export function turnsForFile(blame: BlameLine[], session: Session): Turn[] {
  const ids = new Set<string>();
  for (const l of blame) {
    if (l.turnId) ids.add(session.turnAliases?.[l.turnId] ?? l.turnId);
  }
  return [...ids].map((id) => getTurn(session, id)).filter((t): t is Turn => !!t);
}
