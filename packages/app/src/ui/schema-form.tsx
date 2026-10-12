import { useState } from 'react';
import { deleteAt, readAt, toPointer, writeAt } from '../lib/yamlEdit';
import { Field } from './primitives';

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema | JsonSchema[];
  enum?: (string | number)[];
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
  pattern?: string;
}

/** The default for a node: its own, or the corresponding part of an ancestor's default object. */
export function schemaDefault(root: JsonSchema, tokens: string[]): unknown {
  let node: JsonSchema | undefined = root;
  let inherited: unknown;
  for (const t of tokens) {
    node = node?.properties?.[t];
    inherited = inherited && typeof inherited === 'object' ? (inherited as Record<string, unknown>)[t] : undefined;
    if (node?.default !== undefined && inherited === undefined) inherited = node.default;
    if (!node) return inherited;
  }
  return node?.default !== undefined ? node.default : inherited;
}

/** memoryGiB → "Memory GiB", wakeOnLan → "Wake on lan": split camelCase, keep acronym-like words, lowercase the rest. */
export const labelOf = (key: string): string =>
  key
    .replace(/([a-z])(?=[A-Z][a-z])/g, '$1 ')
    .split(' ')
    .map((w, i) => (/[A-Z].*[A-Z]/.test(w) ? w : i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w.toLowerCase()))
    .join(' ');
const typeOf = (s: JsonSchema): string => (Array.isArray(s.type) ? (s.type.find((t) => t !== 'null') ?? 'string') : (s.type ?? 'string'));

interface Props {
  root: JsonSchema;
  text: string;
  onText: (t: string) => void;
  /** JSON pointer → message, from the CLI's validation. */
  issues: Record<string, string>;
  /** Top-level keys not edited here (managed by wizards). */
  skip: string[];
  /** Short descriptions for skipped keys. */
  summaries?: Record<string, string>;
}

/** A form generated from the config JSON Schema; edits go into the YAML text (comments survive). */
export function SchemaForm({ root, text, onText, issues, skip, summaries = {} }: Props) {
  const set = (tokens: string[], v: unknown): void => onText(writeAt(text, tokens, v));
  // Absent → the schema default; present but empty stays empty (so clearing a field does not snap back).
  const value = (tokens: string[]): unknown => {
    const v = readAt(text, tokens);
    return v === undefined ? schemaDefault(root, tokens) : v;
  };

  const node = (schema: JsonSchema, tokens: string[], key: string): JSX.Element | null => {
    const ptr = toPointer(tokens);
    const err = issues[ptr] ?? null;
    const label = labelOf(key);
    const t = typeOf(schema);

    if (t === 'object' && schema.properties) {
      return (
        <fieldset key={ptr}>
          <legend>{label}</legend>
          {Object.entries(schema.properties).map(([k, s]) => node(s, [...tokens, k], k))}
        </fieldset>
      );
    }
    if (t === 'object' && schema.additionalProperties && typeof schema.additionalProperties === 'object' && typeOf(schema.additionalProperties) === 'string') {
      return <KeyValues key={ptr} label={label} value={(value(tokens) as Record<string, string>) ?? {}} onChange={(v) => set(tokens, v)} error={err} hint={schema.description} />;
    }
    if (t === 'object') {
      return <JsonField key={ptr} label={label} value={value(tokens) ?? {}} onChange={(v) => set(tokens, v)} error={err} hint={schema.description} />;
    }
    if (t === 'array') {
      const lines = Array.isArray(value(tokens)) ? (value(tokens) as unknown[]).map(String) : [];
      const items = schema.items;
      if (items && !Array.isArray(items) && typeOf(items) !== 'string') return null; // lists of objects are managed elsewhere
      return (
        <Field key={ptr} label={label} hint={schema.description ?? 'One entry per line.'} error={err}>
          {(id) => <textarea id={id} className="textarea" rows={Math.min(8, Math.max(2, lines.length + 1))} value={lines.join('\n')} onChange={(e) => set(tokens, e.target.value.split('\n').map((l) => l.trim()).filter(Boolean))} aria-invalid={!!err} spellCheck={false} />}
        </Field>
      );
    }
    if (t === 'boolean') {
      return (
        <div className="field" key={ptr}>
          <label className="check"><input type="checkbox" checked={value(tokens) === true} onChange={(e) => set(tokens, e.target.checked)} /> {label}</label>
          {err && <span className="error" role="alert">{err}</span>}
        </div>
      );
    }
    if (schema.enum) {
      return (
        <Field key={ptr} label={label} error={err}>
          {(id) => <select id={id} className="select" value={String(value(tokens) ?? '')} onChange={(e) => set(tokens, e.target.value)}>{schema.enum!.map((o) => <option key={o}>{o}</option>)}</select>}
        </Field>
      );
    }
    if (t === 'integer' || t === 'number') {
      return (
        <Field key={ptr} label={label} hint={schema.description} error={err}>
          {(id) => <input id={id} className="input" type="number" min={schema.minimum} max={schema.maximum} value={value(tokens) === undefined ? '' : String(value(tokens))} onChange={(e) => (e.target.value === '' ? onText(deleteAt(text, tokens)) : set(tokens, Number(e.target.value)))} aria-invalid={!!err} />}
        </Field>
      );
    }
    return (
      <Field key={ptr} label={label} hint={schema.description} error={err}>
        {(id) => <input id={id} className="input" value={String(value(tokens) ?? '')} onChange={(e) => set(tokens, e.target.value)} aria-invalid={!!err} autoComplete="off" spellCheck={false} />}
      </Field>
    );
  };

  return (
    <div className="stack" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {Object.entries(root.properties ?? {}).map(([k, s]) =>
        skip.includes(k) ? (
          <fieldset key={k}>
            <legend>{labelOf(k)}</legend>
            <p className="note">{summaries[k] ?? 'Managed on its own screen.'}</p>
          </fieldset>
        ) : (
          node(s, [k], k)
        ),
      )}
    </div>
  );
}

function KeyValues({ label, value, onChange, error, hint }: { label: string; value: Record<string, string>; onChange: (v: Record<string, string>) => void; error: string | null; hint?: string }) {
  const entries = Object.entries(value);
  const [draft, setDraft] = useState('');
  return (
    <fieldset aria-label={label}>
      <legend>{label}</legend>
      {hint && <p className="note">{hint}</p>}
      {entries.map(([k, v]) => (
        <div className="row" key={k}>
          <span className="mono" style={{ width: 90 }}>{k}</span>
          <input className="input" aria-label={`${k} version`} value={v} onChange={(e) => onChange({ ...value, [k]: e.target.value })} />
          <button className="btn sm" type="button" aria-label={`Remove ${k}`} onClick={() => onChange(Object.fromEntries(entries.filter(([x]) => x !== k)))}>Remove</button>
        </div>
      ))}
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (draft && !(draft in value)) { onChange({ ...value, [draft]: 'latest' }); setDraft(''); } }}>
        <input className="input" aria-label={`New ${label} entry`} placeholder="tool, e.g. go" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button className="btn sm" type="submit">Add</button>
      </form>
      {error && <span className="error" role="alert">{error}</span>}
    </fieldset>
  );
}

function JsonField({ label, value, onChange, error, hint }: { label: string; value: unknown; onChange: (v: unknown) => void; error: string | null; hint?: string }) {
  const pretty = JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState<string | null>(null);
  const bad = draft !== null && (() => { try { JSON.parse(draft); return false; } catch { return true; } })();
  return (
    <Field label={label} hint={hint ?? 'JSON'} error={bad ? 'Not valid JSON yet.' : error}>
      {(id) => (
        <textarea
          id={id}
          className="textarea"
          rows={10}
          spellCheck={false}
          aria-invalid={bad || !!error}
          value={draft ?? pretty}
          onChange={(e) => {
            setDraft(e.target.value);
            try {
              onChange(JSON.parse(e.target.value));
            } catch {
              /* wait until it parses */
            }
          }}
          onBlur={() => setDraft(null)}
        />
      )}
    </Field>
  );
}
