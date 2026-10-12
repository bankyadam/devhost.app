import type { DevhostConfig, ValidationIssue } from '@devhost/contract';

const BLOCK = 100;

/** Cross-field rules a JSON Schema cannot express. Returns [] when the config is consistent. */
export function validateSemantics(config: DevhostConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (path: string, message: string): number => issues.push({ path, message });

  const accounts = config.accounts ?? [];
  const environments = config.environments ?? [];

  const seenAccounts = new Map<string, number>();
  accounts.forEach((a, i) => {
    if (seenAccounts.has(a.name)) add(`/accounts/${i}/name`, `duplicate account name "${a.name}"`);
    seenAccounts.set(a.name, i);
    if (a.portRange[0] >= a.portRange[1]) add(`/accounts/${i}/portRange`, 'start must be lower than end');
    if (a.default === true && a.configDir !== null && a.configDir !== undefined) {
      add(`/accounts/${i}/configDir`, 'the default account must use Claude Code\'s default config dir (configDir: null)');
    }
    if (a.default !== true && (a.configDir === null || a.configDir === undefined)) {
      add(`/accounts/${i}/configDir`, 'a non-default account needs its own configDir, e.g. ~/.claude-<name>');
    }
  });

  const defaults = accounts.map((a, i) => ({ a, i })).filter(({ a }) => a.default === true);
  if (defaults.length > 1) {
    add(`/accounts/${defaults[1]!.i}/default`, `only one account may be the default (already: "${defaults[0]!.a.name}")`);
  }

  for (let i = 0; i < accounts.length; i++) {
    for (let j = i + 1; j < accounts.length; j++) {
      const [a, b] = [accounts[i]!, accounts[j]!];
      if (a.portRange[0] <= b.portRange[1] && b.portRange[0] <= a.portRange[1]) {
        add(`/accounts/${j}/portRange`, `overlaps the port range of account "${a.name}"`);
      }
    }
  }

  // The spec's own example has the collector (4318) inside an account range (4000-4999),
  // so that is allowed; only environment port blocks must stay clear of it.
  const collectorPort = config.collector?.port;

  const seenEnvs = new Set<string>();
  const blocks: { name: string; start: number; i: number }[] = [];
  environments.forEach((e, i) => {
    // Compose project names (devhost-<name>) and launchd labels need globally unique names.
    if (seenEnvs.has(e.name)) add(`/environments/${i}/name`, `duplicate environment name "${e.name}"`);
    seenEnvs.add(e.name);

    const accountIndex = seenAccounts.get(e.account);
    if (accountIndex === undefined) {
      add(`/environments/${i}/account`, `unknown account "${e.account}"`);
      return;
    }
    if (e.portBase !== undefined) {
      const [lo, hi] = accounts[accountIndex]!.portRange;
      if (e.portBase < lo || e.portBase + BLOCK - 1 > hi) {
        add(`/environments/${i}/portBase`, `block ${e.portBase}-${e.portBase + BLOCK - 1} is outside account "${e.account}" port range ${lo}-${hi}`);
      }
      if (collectorPort !== undefined && collectorPort >= e.portBase && collectorPort < e.portBase + BLOCK) {
        add(`/environments/${i}/portBase`, `block ${e.portBase}-${e.portBase + BLOCK - 1} contains the collector port ${collectorPort}`);
      }
      blocks.push({ name: e.name, start: e.portBase, i });
    }
  });

  for (let x = 0; x < blocks.length; x++) {
    for (let y = x + 1; y < blocks.length; y++) {
      const [a, b] = [blocks[x]!, blocks[y]!];
      if (Math.abs(a.start - b.start) < BLOCK) {
        add(`/environments/${b.i}/portBase`, `port block overlaps environment "${a.name}"`);
      }
    }
  }

  return issues;
}
