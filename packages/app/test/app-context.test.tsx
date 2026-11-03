// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { AppProvider, useApp } from '../src/app-context';
import type { RunResult, Transport } from '../src/transport/types';

const reply = (name: string): RunResult => ({
  code: 0,
  stdout: `${JSON.stringify({ contractVersion: 1, ok: true, data: { cliVersion: '0.1.0', contractVersion: 1, host: { name } }, errors: [] })}\n`,
  stderr: '',
});

function fake(host: string, run: Transport['run']): Transport {
  const none = async () => undefined;
  return {
    host,
    run,
    stream: () => ({ write: () => undefined, cancel: () => undefined, done: Promise.resolve(0) }),
    openUrl: none,
    openTerminal: none,
    openVscode: none,
    detectTools: async () => ({ code: false, iterm: false }),
    listWebApps: async () => [],
    setupWebApp: async () => '',
    openWebApp: none,
    setTray: none,
    onNavigate: () => () => undefined,
  };
}

const Name = () => <div data-testid="host">{useApp().hostName}</div>;

afterEach(() => cleanup());

describe('AppProvider', () => {
  it('ignores a slow version answer from the previous host after the host changed', async () => {
    let answerOld!: (r: RunResult) => void;
    const old = fake('me@old', () => new Promise<RunResult>((r) => (answerOld = r)));
    const next = fake('me@new', async () => reply('new-name'));
    const ui = (t: Transport) => (
      <AppProvider transport={t} navigate={() => undefined}>
        <Name />
      </AppProvider>
    );
    const { rerender } = render(ui(old));
    rerender(ui(next));
    await waitFor(() => expect(screen.getByTestId('host')).toHaveTextContent('new-name'));
    await act(async () => {
      answerOld(reply('old-name'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('host')).toHaveTextContent('new-name');
  });

  it('forgets the reported name when the transport changes', async () => {
    let hang = true;
    const a = fake('me@a', async () => reply('a-name'));
    const b = fake('me@b', () => (hang ? new Promise<RunResult>(() => undefined) : Promise.resolve(reply('b'))));
    const ui = (t: Transport) => (
      <AppProvider transport={t} navigate={() => undefined}>
        <Name />
      </AppProvider>
    );
    const { rerender } = render(ui(a));
    await waitFor(() => expect(screen.getByTestId('host')).toHaveTextContent('a-name'));
    rerender(ui(b));
    await waitFor(() => expect(screen.getByTestId('host')).toHaveTextContent('b'));
    expect(screen.getByTestId('host')).not.toHaveTextContent('a-name');
    hang = false;
  });
});
