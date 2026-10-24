import type { AgentsListData } from '@devhost/contract';
import { BUILTIN_AGENTS } from './agents/catalog.js';
import { short, type GlobalOptions } from './command-support.js';
import { loadConfig } from './config/load.js';
import type { Deps } from './deps.js';
import { agentTargets } from './steps/agents.js';
import { accountsOf, environmentsOf } from './config/accounts.js';

/** `devhost agents list`: the catalog (built-in and custom) and what each account and environment has configured. */
export function agentsListCommand(deps: Deps, g: GlobalOptions): Promise<number> {
  return short<AgentsListData>(deps, g, async () => {
    const { config } = await loadConfig(g.configPath);
    const custom = config.agents?.custom ?? [];
    const agents: AgentsListData['agents'] = [
      ...BUILTIN_AGENTS.map((a) => ({ name: a.name, description: a.description, model: a.model ?? null, tools: a.tools ?? null, builtin: true })),
      ...custom.map((a) => ({ name: a.name, description: a.description, model: a.model ?? null, tools: a.tools ?? null, builtin: false })),
    ];
    const dirs = agentTargets(config, deps.home);
    const accounts = accountsOf(config);
    const targets: AgentsListData['targets'] = [
      ...accounts.map((a, i) => ({ scope: 'account' as const, account: a.name, env: null, dir: dirs[i]!.dir, agents: a.agents ?? [] })),
      ...environmentsOf(config)
        .filter((e) => accounts.some((a) => a.name === e.account))
        .map((e, i) => ({ scope: 'environment' as const, account: e.account, env: e.name, dir: dirs[accounts.length + i]!.dir, agents: e.agents ?? [] })),
    ];
    const human = [
      `AGENTS${config.agents?.delegation ? ' (delegation rule on)' : ''}`,
      ...agents.map((a) => `  ${a.name}${a.builtin ? '' : ' (custom)'}\t${a.description}`),
      '',
      ...targets.map((t) => `${t.scope === 'account' ? t.account : `${t.account}/${t.env}`}\t${t.agents.join(', ') || '–'}`),
    ].join('\n');
    return { data: { delegation: config.agents?.delegation === true, agents, targets }, human };
  });
}
