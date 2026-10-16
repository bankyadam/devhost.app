import { useEffect, useRef, type ReactNode } from 'react';
import type { LongResult, LongRun } from '../client/client';
import type { TerminalRequest } from '../transport/types';
import { OperationView, useOperation } from './operation';
import { Dialog } from './primitives';

interface Props<T> {
  title: string;
  /** Starts the command; called once when the dialog opens. */
  begin: (h: Parameters<Parameters<ReturnType<typeof useOperation<T>>['start']>[0]>[0]) => LongRun<T>;
  /** Where "Open in Terminal" goes when the command needs a human (sudo password). */
  terminal?: TerminalRequest;
  onClose: () => void;
  onFinished?: (result: LongResult<T> | null) => void;
  children?: ReactNode;
  /** Extra content shown after the command ended successfully. */
  after?: (result: LongResult<T>) => ReactNode;
  /** Offer "Try again" after a failure: for commands that continue where they stopped (env create, apply). */
  retry?: boolean;
}

/** A modal that runs one long devhost command with its live log; closing is blocked while it runs unless cancelled. */
export function RunDialog<T>({ title, begin, terminal, onClose, onFinished, children, after, retry }: Props<T>) {
  const op = useOperation<T>();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void op.start(begin).then((r) => onFinished?.(r));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const running = op.state.phase === 'running';
  const failed = op.state.phase === 'done' && op.state.result?.ok === false;
  return (
    <Dialog
      title={title}
      wide
      footer={
        running ? (
          <button className="btn" onClick={op.cancel}>Cancel</button>
        ) : (
          <>
            {retry && failed && <button className="btn" onClick={() => void op.start(begin).then((r) => onFinished?.(r))}>Try again</button>}
            <button className="btn primary" onClick={onClose}>Close</button>
          </>
        )
      }
    >
      {children}
      <OperationView op={op} terminal={terminal} />
      {op.state.result?.ok && after?.(op.state.result)}
    </Dialog>
  );
}
