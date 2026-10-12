import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { parseConfig } from '../src/config/load.js';
import { getByPointer, parsePointer, parseValue, setByPointer } from '../src/config/pointer.js';
import { validateSemantics } from '../src/config/semantic.js';
import { ConfigError, UsageError } from '../src/errors.js';

const base = `
machine: { hostname: macmini }
notify: { topic: devhost-abcdefgh }
`;

const account = (name: string, extra = '') => `
  - name: ${name}
    configDir: ~/.claude-${name}
    root: ~/work/${name}
    portRange: [4000, 4999]
    git: { name: A, email: a@b.c }
${extra}`;

describe('parseConfig', () => {
  it('rejects broken YAML as a ConfigError', () => {
    expect(() => parseConfig('machine: [', '/x')).toThrow(ConfigError);
  });
  it('reports schema issues with JSON pointer paths', () => {
    try {
      parseConfig('machine: { hostname: "no way" }\nnotify: { topic: devhost-abcdefgh }', '/x');
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigError).issues[0]?.path).toBe('/machine/hostname');
    }
  });
});

describe('validateSemantics', () => {
  const cfg = (extra: string) => parseConfigLoose(base + extra);
  function parseConfigLoose(text: string) {
    // Schema-valid but possibly inconsistent: skip semantic validation by calling it ourselves.
    const doc = YAML.parse(text);
    return doc;
  }

  it('accepts a consistent config', () => {
    expect(() => parseConfig(base + 'accounts:' + account('business'), '/x')).not.toThrow();
  });

  it('flags a duplicate account name', () => {
    const c = cfg('accounts:' + account('a') + account('a').replace('4000', '5000').replace('4999', '5999'));
    c.accounts.forEach((a: { default?: boolean }) => (a.default ??= false));
    const issues = validateSemantics(c);
    expect(issues.some((i) => i.message.includes('duplicate account'))).toBe(true);
  });

  it('allows at most one default account, and the default has no configDir', () => {
    const c = cfg('accounts:' + account('a', '    default: true\n') + account('b', '    default: true\n').replace('4000', '5000').replace('4999', '5999'));
    const messages = validateSemantics(c).map((i) => i.message).join('|');
    expect(messages).toContain('only one account may be the default');
    expect(messages).toContain('default account must use');
  });

  it('flags overlapping port ranges', () => {
    const c = cfg('accounts:' + account('a') + account('b'));
    expect(validateSemantics(c).map((i) => i.message).join('|')).toContain('overlaps the port range');
  });

  it('allows the collector port inside an account range but not inside an environment block', () => {
    const ok = cfg('accounts:' + account('a') + '\ncollector: { port: 4318 }\n');
    expect(validateSemantics(ok)).toEqual([]);
    const bad = cfg('accounts:' + account('a') + '\ncollector: { port: 4318 }\nenvironments:\n  - { name: x, account: a, portBase: 4300 }\n');
    expect(validateSemantics(bad).map((i) => i.message).join('|')).toContain('contains the collector port 4318');
  });

  it('flags environments with unknown accounts, duplicate names and overlapping or out-of-range blocks', () => {
    const c = cfg(
      'accounts:' + account('a') +
        '\nenvironments:\n' +
        '  - { name: x, account: ghost }\n' +
        '  - { name: y, account: a, portBase: 4100 }\n' +
        '  - { name: y, account: a, portBase: 4150 }\n' +
        '  - { name: z, account: a, portBase: 4950 }\n',
    );
    const messages = validateSemantics(c).map((i) => i.message).join('|');
    expect(messages).toContain('unknown account "ghost"');
    expect(messages).toContain('duplicate environment name "y"');
    expect(messages).toContain('port block overlaps');
    expect(messages).toContain('outside account');
  });
});

describe('pointers', () => {
  it('parses and escapes', () => {
    expect(parsePointer('/a/b~1c/d~0e')).toEqual(['a', 'b/c', 'd~e']);
    expect(parsePointer('')).toEqual([]);
    expect(() => parsePointer('machine')).toThrow(UsageError);
  });

  it('gets nested values and list items', () => {
    const data = { a: { b: [{ c: 1 }] } };
    expect(getByPointer(data, ['a', 'b', '0', 'c'])).toEqual({ found: true, value: 1 });
    expect(getByPointer(data, ['a', 'x']).found).toBe(false);
    expect(getByPointer(data, ['a', 'b', '5']).found).toBe(false);
  });

  it('parses values as YAML/JSON, falling back to strings', () => {
    expect(parseValue('true')).toBe(true);
    expect(parseValue('42')).toBe(42);
    expect(parseValue('[a, b]')).toEqual(['a', 'b']);
    expect(parseValue('macmini')).toBe('macmini');
  });

  it('sets values in place and keeps comments', () => {
    const doc = YAML.parseDocument('# top\nmachine:\n  hostname: old # why\nlist: [a]\n');
    setByPointer(doc, ['machine', 'hostname'], 'new');
    setByPointer(doc, ['list', '-'], 'b');
    setByPointer(doc, ['deep', 'er'], 1);
    const text = doc.toString();
    expect(text).toContain('# top');
    expect(text).toContain('hostname: new # why');
    expect(doc.toJS()).toEqual({ machine: { hostname: 'new' }, list: ['a', 'b'], deep: { er: 1 } });
  });

  it('refuses to replace the whole document and bad list indexes', () => {
    const doc = YAML.parseDocument('list: [a]\n');
    expect(() => setByPointer(doc, [], 1)).toThrow(UsageError);
    expect(() => setByPointer(doc, ['list', 'x'], 1)).toThrow(UsageError);
    expect(() => setByPointer(doc, ['list', '9'], 1)).toThrow(UsageError);
  });
});
