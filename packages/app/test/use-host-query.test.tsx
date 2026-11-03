// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const app = { connection: { kind: 'connected' }, reportUnreachable: vi.fn() };
vi.mock('../src/app-context', () => ({ useApp: () => app }));
const { useHostQuery } = await import('../src/use-host-query');

describe('useHostQuery', () => {
  it('runs one load at a time and reloads once after overlapping refreshes', async () => {
    const resolvers: Array<(v: number) => void> = [];
    const fetcher = vi.fn(() => new Promise<number>((r) => resolvers.push(r)));
    const { result } = renderHook(() => useHostQuery(fetcher));
    expect(fetcher).toHaveBeenCalledTimes(1);
    void result.current.refresh();
    void result.current.refresh();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { resolvers[0]!(1); await Promise.resolve(); });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await act(async () => { resolvers[1]!(2); });
    await vi.waitFor(() => expect(result.current.data).toBe(2));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('drops the answer after unmount', async () => {
    let answer!: (v: number) => void;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetcher = vi.fn(() => new Promise<number>((r) => (answer = r)));
    const { result, unmount } = renderHook(() => useHostQuery(fetcher));
    unmount();
    await act(async () => { answer(5); });
    expect(result.current.data).toBeNull();
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
