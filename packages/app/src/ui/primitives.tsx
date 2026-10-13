import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

export function StatusDot({ tone }: { tone: 'good' | 'warn' | 'bad' | 'none' }) {
  return <span className={`dot ${tone === 'none' ? '' : tone}`} aria-hidden="true" />;
}

/** Status is never color alone: the badge always carries a word. */
export function Badge({ tone = 'none', children }: { tone?: 'good' | 'warn' | 'bad' | 'none'; children: ReactNode }) {
  return (
    <span className={`badge ${tone === 'none' ? '' : tone}`}>
      {tone !== 'none' && <StatusDot tone={tone} />}
      {children}
    </span>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && !error && <span className="hint">{hint}</span>}
      {error && <span className="error" role="alert">{error}</span>}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Dialog({ title, onClose, children, footer, wide }: { title: string; onClose?: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // Callers pass an inline onClose, a new function on every render; keep the latest one in a ref so
  // neither effect re-runs. Re-focusing on every render pulled focus out of the field being typed in.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    // Unless a field inside already took focus (a wizard's first field), focus the dialog itself.
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="overlay">
      <div className={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
        <h2>{title}</h2>
        {children}
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

const FIELDS = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled])';

/**
 * The fields of one wizard step. Each step opens with its first field focused; Enter in a field moves
 * to the step's next field, and from its last field to the next step when the step is valid. The
 * final step (the review) has no fields, so Enter never starts the run itself.
 */
export function WizardStep({ step, canNext, onNext, children }: { step: number; canNext: boolean; onNext: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Once per step, as soon as its first field exists (a step's data may still be loading when it opens).
  const focusedStep = useRef<number | null>(null);
  useEffect(() => {
    if (focusedStep.current === step) return;
    const first = ref.current?.querySelector<HTMLElement>(FIELDS);
    if (!first) return;
    first.focus();
    focusedStep.current = step;
  });
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
    const target = e.target as HTMLElement;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    e.preventDefault();
    const fields = [...e.currentTarget.querySelectorAll<HTMLElement>(FIELDS)];
    const next = fields[fields.indexOf(target) + 1];
    if (next) next.focus();
    else if (canNext) onNext();
  };
  return (
    <div ref={ref} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

/** A destructive action always shows what will happen and waits for an explicit yes (spec B5). */
export function ConfirmDialog({ title, children, confirmLabel, danger, onConfirm, onCancel, requireText }: { title: string; children: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onCancel: () => void; requireText?: string }) {
  const [typed, setTyped] = useState('');
  const ok = requireText === undefined || typed === requireText;
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={!ok} onClick={onConfirm}>{confirmLabel}</button>
        </>
      }
    >
      {children}
      {requireText !== undefined && (
        <Field label={`Type "${requireText}" to confirm`}>
          {(id) => <input id={id} className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />}
        </Field>
      )}
    </Dialog>
  );
}

export interface MenuItem { label: string; onSelect: () => void; hidden?: boolean; disabled?: boolean; danger?: boolean }

export function Menu({ label, items, ariaLabel, caret = true }: { label: string; items: MenuItem[]; ariaLabel?: string; caret?: boolean }) {
  const [open, setOpen] = useState(false);
  const visible = items.filter((i) => !i.hidden);
  useEffect(() => {
    if (!open) return;
    const close = (): void => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);
  return (
    <div className="menu">
      <button className="btn sm" aria-haspopup="menu" aria-expanded={open} aria-label={ariaLabel} title={ariaLabel} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>{caret ? `${label} ▾` : label}</button>
      {open && (
        <div className="items" role="menu">
          {visible.map((i) => (
            <button key={i.label} role="menuitem" className={i.danger ? 'danger' : undefined} disabled={i.disabled} onClick={() => { setOpen(false); i.onSelect(); }}>{i.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setDone(true), () => undefined);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
