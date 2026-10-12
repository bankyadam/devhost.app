import { validateConfig, type DevhostConfig, type ValidationIssue } from '@devhost/contract';
import YAML from 'yaml';
import { ConfigError } from '../errors.js';
import { readTextIfExists } from '../fsutil.js';
import { validateSemantics } from './semantic.js';

export interface LoadedConfig {
  path: string;
  /** Effective config: schema defaults applied. */
  config: DevhostConfig;
  raw: string;
}

/** Parse + schema-validate + semantic-validate a config document. Throws ConfigError. */
export function parseConfig(raw: string, path: string): DevhostConfig {
  const doc = YAML.parseDocument(raw);
  if (doc.errors.length > 0) {
    const issues: ValidationIssue[] = doc.errors.map((e) => ({
      path: '',
      message: `${e.message.split('\n')[0]}`,
    }));
    throw new ConfigError(`${path} is not valid YAML`, issues);
  }
  return validateData(doc.toJS(), path);
}

export function validateData(data: unknown, path: string): DevhostConfig {
  const schema = validateConfig(data ?? {});
  if (!schema.ok) throw new ConfigError(`${path} is invalid`, schema.issues);
  const semantic = validateSemantics(schema.value);
  if (semantic.length > 0) throw new ConfigError(`${path} is inconsistent`, semantic);
  return schema.value;
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
  const raw = await readTextIfExists(path);
  if (raw === null) {
    throw new ConfigError(`config not found: ${path}`, [], 'Run `devhost init` first.');
  }
  return { path, raw, config: parseConfig(raw, path) };
}
