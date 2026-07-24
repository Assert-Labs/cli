import * as os from 'os';
import * as path from 'path';
import type { SessionEvent } from './schema';

export type RedactionTarget = 'last-tool-input' | 'last-tool-output' | 'current-turn';
export interface RedactionDirective {
  target: RedactionTarget;
  toolCallId?: string;
  toolOrdinal?: number;
  promptTurnId?: string;
  promptOrdinal?: number;
  turnIds?: string[];
}

const SENSITIVE_KEY = /^(?:apikey|accesskey|accesstoken|refreshtoken|secret|token|password|passwd|authorization|cookie|privatekey|clientsecret)$/i;
const FILE_PATH_KEYS = new Set(['file_path', 'filePath', 'path', 'file', 'filename']);
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:PRIVATE_KEY]'],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]+)\b/g, '[REDACTED:API_TOKEN]'],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED:TOKEN]'],
  [/<assert-redact>[\s\S]*?<\/assert-redact>/gi, '[REDACTED:AGENT]'],
];

function sanitizeString(value: string, gitRoot: string): string {
  let sanitized = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  const home = os.homedir();
  if (gitRoot) sanitized = sanitized.split(gitRoot).join('$REPO');
  if (home) sanitized = sanitized.split(home).join('$HOME');
  return sanitized;
}

function normalizeToolInput(input: Record<string, unknown>, gitRoot: string) {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      if (!FILE_PATH_KEYS.has(key) || typeof value !== 'string') return [key, value];
      const absolute = path.resolve(gitRoot, value.replaceAll('\\', '/'));
      const relative = path.relative(gitRoot, absolute);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return [key, value];
      return [key, relative.replaceAll(path.sep, '/')];
    }),
  );
}

function sanitizeValue(value: unknown, gitRoot: string, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key.replace(/[^a-z0-9]/gi, ''))) {
    return '[REDACTED:SENSITIVE_FIELD]';
  }
  if (typeof value === 'string') return sanitizeString(value, gitRoot);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, gitRoot));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeValue(childValue, gitRoot, childKey),
      ]),
    );
  }
  return value;
}

export function sanitizeSessionEvents(
  events: SessionEvent[],
  gitRoot: string,
  directives: RedactionDirective[] = [],
): SessionEvent[] {
  const normalized = events.map((event) =>
    event.type === 'tool_call'
      ? { ...event, input: normalizeToolInput(event.input, gitRoot) }
      : event,
  );
  const projected = normalized.map(
    (event) => sanitizeValue(event, gitRoot) as SessionEvent,
  );
  const redactionCallIds = new Set(
    projected
      .filter(
        (event) =>
          event.type === 'tool_call' &&
          JSON.stringify(event.input).includes('assert redact'),
      )
      .map((event) => (event.type === 'tool_call' ? event.toolCallId : '')),
  );
  const publishableCalls = projected.filter(
    (event) =>
      event.type === 'tool_call' && !redactionCallIds.has(event.toolCallId),
  );
  for (const directive of directives) {
    const call =
      projected.find(
        (event) =>
          event.type === 'tool_call' && event.toolCallId === directive.toolCallId,
      ) ??
      (directive.toolOrdinal != null
        ? publishableCalls[directive.toolOrdinal]
        : undefined);
    if (directive.target === 'last-tool-input') {
      if (call?.type === 'tool_call') call.input = { redacted: '[REDACTED:AGENT]' };
    }
    if (directive.target === 'last-tool-output') {
      const result = projected.find(
        (event) =>
          event.type === 'tool_result' &&
          event.toolCallId ===
            (call?.type === 'tool_call' ? call.toolCallId : directive.toolCallId),
      );
      if (result?.type === 'tool_result') {
        result.output = '[REDACTED:AGENT]';
        result.error = result.error ? '[REDACTED:AGENT]' : undefined;
      }
    }
    if (directive.target !== 'current-turn') continue;
    const humans = projected.filter((event) => event.type === 'human_turn');
    const human =
      humans.find(
        (event) =>
          event.type === 'human_turn' && event.turnId === directive.promptTurnId,
      ) ??
      (directive.promptOrdinal != null ? humans[directive.promptOrdinal] : undefined);
    const promptTurnId = human?.type === 'human_turn' ? human.turnId : undefined;
    const turnIds = new Set([
      ...(directive.turnIds ?? []),
      ...projected
        .filter(
          (event) =>
            event.type === 'assistant_turn_start' &&
            event.promptTurnId === promptTurnId,
        )
        .map((event) => ('turnId' in event ? event.turnId : '')),
    ]);
    for (const event of projected) {
      if (
        event.type === 'human_turn' &&
        event.turnId === promptTurnId
      ) {
        event.content = '[REDACTED:AGENT]';
      }
      if (!('turnId' in event) || !turnIds.has(event.turnId)) continue;
      if (event.type === 'assistant_text') event.text = '[REDACTED:AGENT]';
      if (event.type === 'assistant_reasoning') event.text = '[REDACTED:AGENT]';
      if (event.type === 'tool_call') event.input = { redacted: '[REDACTED:AGENT]' };
      if (event.type === 'tool_result') {
        event.output = '[REDACTED:AGENT]';
        event.error = event.error ? '[REDACTED:AGENT]' : undefined;
      }
    }
  }
  return projected;
}

export function sanitizeSessionJsonl(
  jsonl: string,
  gitRoot: string,
  directives: RedactionDirective[] = [],
): string {
  const events = jsonl
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as SessionEvent];
      } catch {
        return [];
      }
    });
  return `${sanitizeSessionEvents(events, gitRoot, directives)
    .map((event) => JSON.stringify(event))
    .join('\n')}\n`;
}
