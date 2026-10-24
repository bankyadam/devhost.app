export interface AgentDef {
  name: string;
  description: string;
  prompt: string;
  model?: string;
  tools?: string[];
}

/** Agents devhost ships; an account or environment lists the names it wants (`agents:`). */
export const BUILTIN_AGENTS: AgentDef[] = [
  {
    name: 'explorer',
    description: 'Use proactively for broad searches across many files or directories (where is X defined, how does Y work, what uses Z). Returns the answer, not file dumps.',
    model: 'haiku',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    prompt: 'You search the codebase and report. Read only what the question needs. Answer in a few lines with file_path:line references. Never edit files.',
  },
  {
    name: 'reviewer',
    description: 'Use after a change is made: reviews the current diff for bugs, missing tests and surprises, in a fresh context.',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    prompt: 'Review the uncommitted diff (git diff, git diff --cached). Report only real problems: wrong behaviour, missed callers, missing tests. One line each with file_path:line. Say so if there is nothing. Never edit files.',
  },
  {
    name: 'test-runner',
    description: 'Use to run the test suite, linters or a build: returns only what failed and why, so long output stays out of the main context.',
    model: 'haiku',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    prompt: 'Run the commands you are given (or the project\'s test, lint and typecheck commands). Report pass or fail per command; for failures the first relevant error lines and the file:line. Never edit files.',
  },
  {
    name: 'docs',
    description: 'Use to bring README, SPEC and other docs in line with a code change.',
    prompt: 'Update the documentation that describes the changed behaviour, in the style of the surrounding text. Change nothing but docs. Report which files you changed.',
  },
];

export const agentCatalog = (custom: AgentDef[] = []): Map<string, AgentDef> => new Map([...BUILTIN_AGENTS, ...custom].map((a) => [a.name, a]));
