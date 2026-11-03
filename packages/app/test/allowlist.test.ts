import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The desktop shell refuses any `devhost` subcommand not in its list (core/src/lib.rs). The JS tests run
// against the CLI directly, so a command the client uses but the list lacks only fails in the real app.
describe('the shell lets the app run every command the client uses', () => {
  it('lists each first argument of a client call', async () => {
    const rust = await readFile(join(__dirname, '..', 'core', 'src', 'lib.rs'), 'utf8');
    const block = /ALLOWED_SUBCOMMANDS: &\[&str\] = &\[([^\]]*)\]/.exec(rust)![1]!;
    const allowed = new Set([...block.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]));
    const client = await readFile(join(__dirname, '..', 'src', 'client', 'client.ts'), 'utf8');
    const used = new Set([...client.matchAll(/(?:short|run|call)(?:<[^>]*>)?\(\s*\[\s*'([a-z-]+)'/g)].map((m) => m[1]!));
    expect(used.size).toBeGreaterThan(8);
    expect([...used].filter((c) => !allowed.has(c))).toEqual([]);
    // The list is exactly what the client calls: nothing extra stays reachable from the webview.
    expect([...allowed].filter((c) => !used.has(c!))).toEqual([]);
  });
});
