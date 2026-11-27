import { readonly, ref } from 'vue';

export type LogKind = 'user' | 'agent' | 'system' | 'tool' | 'error';

export interface LogEntry {
  id: number;
  kind: LogKind;
  text: string;
  /** Transcripts stream in; a non-final line is replaced until it becomes final. */
  final: boolean;
  time: string;
  /** Optional link shown after the text, e.g. the saved record. */
  href?: string;
}

const MAX_ENTRIES = 300;

export function useEventLog() {
  const entries = ref<LogEntry[]>([]);
  let nextId = 1;

  const now = (): string => new Date().toLocaleTimeString([], { hour12: false });

  function add(kind: LogKind, text: string, final = true, href?: string): void {
    entries.value.push({ id: nextId++, kind, text, final, time: now(), ...(href !== undefined ? { href } : {}) });
    if (entries.value.length > MAX_ENTRIES) entries.value.splice(0, entries.value.length - MAX_ENTRIES);
  }

  /** Updates the open (non-final) line of this role, or starts a new one. */
  function transcript(role: 'user' | 'agent', text: string, final: boolean): void {
    const open = entries.value.findLast((e) => e.kind === role && !e.final);
    if (open !== undefined) {
      open.text = text;
      open.final = final;
      return;
    }
    add(role, text, final);
  }

  return { entries: readonly(entries), add, transcript };
}
