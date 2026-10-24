import type { AgentDef } from './catalog.js';

/** First line inside the frontmatter of every file devhost writes: its mark, so other agent files are left alone. */
export const MANAGED_MARK = '# managed by devhost: change `agents:` in config.yaml';

const quote = (s: string): string => JSON.stringify(s.replace(/\s+/g, ' ').trim());

/** The Claude Code agent file (markdown with YAML frontmatter) for an agent. */
export function agentFile(a: AgentDef): string {
  return [
    '---',
    MANAGED_MARK,
    `name: ${a.name}`,
    `description: ${quote(a.description)}`,
    ...(a.model ? [`model: ${a.model}`] : []),
    ...(a.tools?.length ? [`tools: ${a.tools.join(', ')}`] : []),
    '---',
    '',
    a.prompt.trim(),
    '',
  ].join('\n');
}
