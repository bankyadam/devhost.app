import type { DevhostConfig } from '@devhost/contract';
import type { Account } from './config/accounts.js';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function hookUrl(config: DevhostConfig, account: string, token?: string): string {
  return `http://127.0.0.1:${config.collector?.port ?? 4318}/hooks?account=${account}${token ? `&token=${token}` : ''}`;
}

/** True for hook groups devhost wrote: they all point at the local collector. */
function isDevhostGroup(group: unknown, port: number): boolean {
  if (!isObject(group) || !Array.isArray(group['hooks'])) return false;
  const marker = `127.0.0.1:${port}/hooks`;
  return group['hooks'].some((h) => isObject(h) && (String(h['url'] ?? '').includes(marker) || String(h['command'] ?? '').includes(marker)));
}

/**
 * The part of an account's user settings.json that devhost owns (spec A7.5, A10.2).
 * SessionStart only supports command hooks (verified against the hooks docs), so
 * it posts the hook payload with curl; the other events use HTTP hooks.
 */
export function managedSettings(config: DevhostConfig, account: Pick<Account, 'name'>, token?: string): Json {
  const port = config.collector?.port ?? 4318;
  const url = hookUrl(config, account.name, token);
  const http = { type: 'http', url, timeout: 5 };
  const command = {
    type: 'command',
    command: `curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- '${url}' >/dev/null 2>&1 || true`,
  };
  const group = (hook: Json): Json => ({ hooks: [hook] });
  return deepMerge(structuredClone((config.claude?.settings ?? {}) as Json), {
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
      OTEL_METRIC_EXPORT_INTERVAL: '15000',
      ...(token ? { OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${token}` } : {}),
    },
    allowedHttpHookUrls: [`http://127.0.0.1:${port}/hooks*`],
    hooks: {
      SessionStart: [group(command)],
      UserPromptSubmit: [group(http)],
      Notification: [group(http)],
      Stop: [group(http)],
      SessionEnd: [group(http)],
      // Subagents for the dashboard; posted like SessionStart (command hook), which every event takes.
      SubagentStart: [group(command)],
      SubagentStop: [group(command)],
    },
  });
}

function deepMerge(base: Json, add: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(add)) {
    const cur = out[k];
    if (isObject(cur) && isObject(v)) out[k] = deepMerge(cur, v);
    else if (Array.isArray(cur) && Array.isArray(v)) out[k] = [...cur, ...v.filter((x) => !cur.some((c) => same(c, x)))];
    else out[k] = structuredClone(v);
  }
  return out;
}

/** Merge devhost's settings into the user's, keeping every key and hook that is not ours. */
export function mergeSettings(existing: Json, managed: Json, port: number): Json {
  const { hooks: managedHooks, ...rest } = managed;
  const merged = deepMerge(existing, rest);
  const hooks: Json = isObject(existing['hooks']) ? { ...(existing['hooks'] as Json) } : {};
  for (const [event, groups] of Object.entries((managedHooks ?? {}) as Json)) {
    const kept = (Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []).filter((g) => !isDevhostGroup(g, port));
    hooks[event] = [...kept, ...(groups as unknown[])];
  }
  if (Object.keys(hooks).length > 0) merged['hooks'] = hooks;
  return merged;
}

/**
 * Remove what `mergeSettings` added. Values are only removed when they still equal
 * what devhost wrote, so edits the user made afterwards survive.
 */
export function removeManaged(existing: Json, managed: Json, port: number): Json {
  const out = structuredClone(existing);
  const strip = (target: Json, mine: Json): void => {
    for (const [k, v] of Object.entries(mine)) {
      if (k === 'hooks' && target === out) continue;
      const cur = target[k];
      if (isObject(cur) && isObject(v)) {
        strip(cur, v);
        if (Object.keys(cur).length === 0) delete target[k];
      } else if (Array.isArray(cur) && Array.isArray(v)) {
        const left = cur.filter((c) => !v.some((x) => same(c, x)));
        if (left.length === 0) delete target[k];
        else target[k] = left;
      } else if (same(cur, v)) {
        delete target[k];
      }
    }
  };
  strip(out, managed);
  if (isObject(out['hooks'])) {
    const hooks = out['hooks'] as Json;
    for (const event of Object.keys(hooks)) {
      const left = (Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []).filter((g) => !isDevhostGroup(g, port));
      if (left.length === 0) delete hooks[event];
      else hooks[event] = left;
    }
    if (Object.keys(hooks).length === 0) delete out['hooks'];
  }
  return out;
}

export function parseSettings(text: string | null, file: string): Json {
  if (text === null || text.trim() === '') return {};
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}); fix it by hand, devhost will not overwrite it`);
  }
  if (!isObject(data)) throw new Error(`${file} must contain a JSON object`);
  return data;
}

export const stringifySettings = (s: Json): string => `${JSON.stringify(s, null, 2)}\n`;
