/**
 * Normalize an agent's native transcript into Assert's consistent event schema,
 * preserving reasoning (thinking). This is what lets every agent's session be
 * stored in one schema and translated (e.g. to agent-trace) on demand.
 */

import { type SessionEvent, createTurnId } from './schema';

/** Normalize a raw model string to the models.dev convention (provider/model). */
export function normalizeModelId(raw?: string): string | undefined {
  if (!raw || raw === '<synthetic>') return undefined;
  if (raw.includes('/')) return raw;
  if (raw.startsWith('claude')) return `anthropic/${raw}`;
  if (raw.startsWith('gpt') || raw.startsWith('o1') || raw.startsWith('o3')) return `openai/${raw}`;
  return raw;
}

function asText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : typeof (b as any)?.text === 'string' ? (b as any).text : ''))
      .join('');
  }
  return '';
}

/**
 * Convert a Claude Code transcript (JSONL) into Assert events. Maps thinking →
 * assistant_reasoning, text → assistant_text, tool_use → tool_call, and user
 * tool_result blocks → tool_result; ignores Claude-internal line types.
 */
export function normalizeClaudeTranscript(jsonl: string, sessionId: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  let turnId = '';

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp: string = o.timestamp || '';
    const msg = o.message;

    if (o.type === 'user' && msg) {
      const content = msg.content;
      const toolResults = Array.isArray(content) ? content.filter((b: any) => b?.type === 'tool_result') : [];
      if (toolResults.length) {
        for (const b of toolResults) {
          events.push({ type: 'tool_result', timestamp, sessionId, turnId, toolCallId: b.tool_use_id, output: asText(b.content) });
        }
      } else {
        const text = asText(content);
        if (text) events.push({ type: 'human_turn', timestamp, sessionId, turnId: createTurnId(), content: text });
      }
    } else if (o.type === 'assistant' && msg) {
      turnId = msg.id || o.uuid || createTurnId();
      const model = normalizeModelId(msg.model);
      events.push({ type: 'assistant_turn_start', timestamp, sessionId, turnId, model });
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b?.type === 'thinking') {
          events.push({ type: 'assistant_reasoning', timestamp, sessionId, turnId, text: b.thinking ?? '', signature: b.signature });
        } else if (b?.type === 'text') {
          events.push({ type: 'assistant_text', timestamp, sessionId, turnId, text: b.text ?? '' });
        } else if (b?.type === 'tool_use') {
          events.push({ type: 'tool_call', timestamp, sessionId, turnId, toolCallId: b.id, toolName: b.name, input: b.input ?? {} });
        }
      }
    }
  }

  return events;
}
