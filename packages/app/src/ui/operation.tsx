import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { Event } from '@devhost/contract/lite';
import { useApp } from '../app-context';
import type { LongResult, LongRun, PromptEvent } from '../client/client';
import { UnreachableError, errorMessage } from '../client/errors';
import type { TerminalRequest } from '../transport/types';
import { Field } from './primitives';

type StepStatus = 'start' | 'ok' | 'changed' | 'skipped' | 'failed';
export interface OpStep { id: string; status: StepStatus; message?: string }

export interface OpState<T> {
  phase: 'idle' | 'running' | 'done';
  steps: OpStep[];
  logs: { level: string; message: string }[];
  prompt: PromptEvent | null;
  result: LongResult<T> | null;
  error: string | null;
}

const idle = <T,>(): OpState<T> => ({ phase: 'idle', steps: [], logs: [], prompt: null, result: null, error: null });

/**
 * Drives one long-running devhost command: collects step/log events for the live log,
 * surfaces prompt events (workspace trust, login URL + code, typed confirmations) and keeps the
 * final result. Prompt answers go to the command's stdin, never onto a command line (spec B5).
 */
export function useOperation<T = unknown>() {
  const { reportUnreachable } = useApp();
  const [state, setState] = useState<OpState<T>>(idle<T>());
  const running = useRef<LongRun<T> | null>(null);
  const answer = useRef<((v: string | boolean) => void) | null>(null);

  const onEvent = useCallback((e: Event) => {
    if (e.type === 'step') {
      setState((s) => {
        const prev = s.steps.find((x) => x.id === e.id);
        const next: OpStep = { id: e.id, status: e.status, message: e.message ?? prev?.message };
        // A step keeps its position in the log when its status changes.
        return { ...s, steps: prev ? s.steps.map((x) => (x.id === e.id ? next : x)) : [...s.steps, next] };
      });
    } else if (e.type === 'log') {
      setState((s) => ({ ...s, logs: [...s.logs, { level: e.level, message: e.message }] }));
    }
  }, []);

  const onPrompt = useCallback(
    (p: PromptEvent) =>
      new Promise<string | boolean>((resolve) => {
        answer.current = (v) => {
          answer.current = null;
          setState((s) => ({ ...s, prompt: null }));
          resolve(v);
        };
        setState((s) => ({ ...s, prompt: p }));
      }),
    [],
  );

  const start = useCallback(
    async (begin: (h: { onEvent: typeof onEvent; onPrompt: typeof onPrompt }) => LongRun<T>): Promise<LongResult<T> | null> => {
      setState({ ...idle<T>(), phase: 'running' });
      try {
        const run = begin({ onEvent, onPrompt });
        running.current = run;
        const result = await run.promise;
        setState((s) => ({ ...s, phase: 'done', result, prompt: null }));
        return result;
      } catch (e) {
        reportUnreachable(e);
        setState((s) => ({ ...s, phase: 'done', prompt: null, error: e instanceof UnreachableError ? `${e.message} Nothing was lost: re-run when it is back; every step is safe to repeat.` : errorMessage(e) }));
        return null;
      } finally {
        running.current = null;
      }
    },
    [onEvent, onPrompt, reportUnreachable],
  );

  return {
    state,
    start,
    answer: (v: string | boolean) => answer.current?.(v),
    cancel: () => running.current?.cancel(),
    reset: () => setState(idle<T>()),
  };
}

const SYMBOL: Record<StepStatus, string> = { start: '…', ok: '✓', changed: '●', skipped: '–', failed: '✕' };

/** The live step log plus whatever the command is asking for right now. */
export function OperationView<T>({ op, terminal, children }: { op: ReturnType<typeof useOperation<T>>; terminal?: TerminalRequest; children?: ReactNode }) {
  const { transport } = useApp();
  const { state } = op;
  const needsHuman = state.result?.exit === 3 || state.result?.errors.some((e) => e.code === 'human-action-required');
  return (
    <div className="stack" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {(state.steps.length > 0 || state.logs.length > 0) && (
        <div className="oplog" aria-label="Progress" aria-live="polite">
          {state.steps.map((s) => (
            <div className="line" key={s.id}>
              <span aria-label={s.status}>{SYMBOL[s.status]}</span>
              <span className="id">{s.id}</span>
              {s.message && <span className="msg">{s.message}</span>}
            </div>
          ))}
          {state.logs.map((l, i) => (
            <div className="line" key={`l${i}`}>
              <span>{l.level === 'info' ? '·' : l.level === 'warn' ? '!' : '✕'}</span>
              <span className="msg">{l.message}</span>
            </div>
          ))}
        </div>
      )}
      {state.prompt && <PromptView prompt={state.prompt} onAnswer={op.answer} openUrl={(u) => void transport.openUrl(u)} />}
      {state.phase === 'running' && !state.prompt && <p className="note">Working on the Mac mini…</p>}
      {state.error && <div className="notice bad" role="alert">{state.error}</div>}
      {state.phase === 'done' && state.result && !state.result.ok && !needsHuman && (
        <div className="notice bad" role="alert">
          {state.result.errors.map((e, i) => (
            <div key={i}>
              {e.message}
              {e.hint && <div className="note">{e.hint}</div>}
            </div>
          ))}
        </div>
      )}
      {needsHuman && (
        <div className="notice" role="alert">
          <div>This needs you at a keyboard: devhost needs the <b>sudo password</b> (or another manual step). The app never handles the password itself.</div>
          {state.result?.errors[0]?.hint && <div className="note">{state.result.errors[0].hint}</div>}
          {terminal && <div><button className="btn primary" onClick={() => void transport.openTerminal(terminal)}>Open in Terminal</button></div>}
        </div>
      )}
      {state.phase === 'done' && state.result?.ok && <div className="notice" style={{ borderColor: 'var(--good)' }} role="status">Done.</div>}
      {children}
    </div>
  );
}

function PromptView({ prompt, onAnswer, openUrl }: { prompt: PromptEvent; onAnswer: (v: string | boolean) => void; openUrl: (u: string) => void }) {
  const [text, setText] = useState('');
  return (
    <div className="prompt" role="group" aria-label="Question from devhost">
      <div>{prompt.message}</div>
      {prompt.kind === 'confirm' && (
        <div className="row">
          <button className="btn primary" onClick={() => onAnswer(true)}>Yes</button>
          <button className="btn" onClick={() => onAnswer(false)}>No</button>
        </div>
      )}
      {prompt.kind === 'input' && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); onAnswer(text); }}>
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} aria-label="Answer" autoComplete="off" spellCheck={false} autoFocus />
          <button className="btn primary" type="submit">Continue</button>
        </form>
      )}
      {prompt.kind === 'open-url' && (
        <>
          {prompt.url && <div><button className="btn" onClick={() => openUrl(prompt.url!)}>Open in my browser</button></div>}
          <Field label="Code from the browser" hint="Paste the code it shows. Leave empty if the browser already finished by itself.">
            {(id) => (
              <form className="row" onSubmit={(e) => { e.preventDefault(); onAnswer(text); }}>
                <input id={id} className="input" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false} />
                <button className="btn primary" type="submit">Continue</button>
              </form>
            )}
          </Field>
        </>
      )}
    </div>
  );
}
