import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Mustache from 'mustache';
import { templatesDir } from './paths.js';

// Templates produce YAML, Ruby (Brewfile) and shell, never HTML: no escaping.
Mustache.escape = (s: string): string => s;

export async function renderTemplate(name: string, view: Record<string, unknown>, dir = templatesDir): Promise<string> {
  const source = await readFile(join(dir, `${name}.mustache`), 'utf8');
  return Mustache.render(source, view);
}
