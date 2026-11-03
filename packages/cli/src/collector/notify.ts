import type { DevhostConfig } from '@devhost/contract';

export type Priority = 'min' | 'low' | 'default' | 'high' | 'urgent';

export interface Notification {
  title: string;
  message: string;
  priority?: Priority;
  tags?: string[];
}

/** Notification provider interface (spec A10.5: ntfy in v1, others later). */
export interface Notifier {
  readonly provider: string;
  send(n: Notification): Promise<void>;
}

export type FetchLike = (url: string, init: { method: string; body: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export class NtfyNotifier implements Notifier {
  readonly provider = 'ntfy';
  constructor(
    private readonly server: string,
    private readonly topic: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  async send(n: Notification): Promise<void> {
    const res = await this.fetchImpl(`${this.server.replace(/\/$/, '')}/${encodeURIComponent(this.topic)}`, {
      method: 'POST',
      // A dead ntfy server must not hold anything up for long.
      signal: AbortSignal.timeout(5000),
      body: n.message,
      headers: {
        Title: n.title,
        Priority: n.priority ?? 'default',
        ...(n.tags && n.tags.length > 0 ? { Tags: n.tags.join(',') } : {}),
      },
    });
    if (!res.ok) throw new Error(`ntfy answered HTTP ${res.status}`);
  }
}

export function createNotifier(config: DevhostConfig, fetchImpl?: FetchLike): Notifier {
  const n = config.notify;
  return new NtfyNotifier(n.server ?? 'https://ntfy.sh', n.topic, fetchImpl);
}

/** The topic works like a password, so show only its start. */
export const maskTopic = (topic: string): string => `${topic.slice(0, 4)}…`;
