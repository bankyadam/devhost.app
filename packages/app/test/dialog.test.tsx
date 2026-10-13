// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Dialog } from '../src/ui/primitives';

/** A parent that re-renders on demand and, like every screen, passes an inline onClose. */
let bump: () => void = () => undefined;
function Parent({ onClose }: { onClose: () => void }) {
  const [n, setN] = useState(0);
  bump = () => setN((x) => x + 1);
  return (
    <Dialog title="Edit" onClose={() => onClose()}>
      <span data-testid="renders">{n}</span>
      <input aria-label="Name" />
    </Dialog>
  );
}

describe('Dialog', () => {
  it('keeps focus in the field being typed in when the screen behind it re-renders', async () => {
    const user = userEvent.setup();
    let closed = 0;
    render(<Parent onClose={() => closed++} />);
    // Opening focuses the dialog itself.
    expect(document.activeElement).toBe(screen.getByRole('dialog'));

    const input = screen.getByLabelText('Name');
    await user.type(input, 'ab');
    act(() => bump()); // e.g. a dashboard refresh or the connection heartbeat
    expect(screen.getByTestId('renders')).toHaveTextContent('1');
    expect(document.activeElement).toBe(input);
    await user.type(input, 'c');
    expect(input).toHaveValue('abc');

    // Escape still reaches the latest onClose.
    await user.keyboard('{Escape}');
    expect(closed).toBe(1);
  });
});
