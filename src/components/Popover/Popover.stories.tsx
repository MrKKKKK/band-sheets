import { useId, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '../Button/Button';
import { Chip } from '../Button/Chip';
import { Popover, PopoverAnchor } from './Popover';

function Demo() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  return (
    <div style={{ padding: 'var(--space-4)', minHeight: 280 }}>
      <PopoverAnchor>
        <Button
          ref={anchorRef}
          variant="primary"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((o) => !o)}
        >
          コードを追加
        </Button>
        <Popover
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={anchorRef}
          aria-labelledby={titleId}
        >
          <h2
            id={titleId}
            style={{ margin: 0, fontSize: 'var(--font-size-md)' }}
          >
            パレット
          </h2>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--space-2)',
              margin: 'var(--space-3) 0',
            }}
          >
            <Chip>C</Chip>
            <Chip>Am7</Chip>
            <Chip>F#m7(b5)</Chip>
          </div>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            閉じる
          </Button>
        </Popover>
      </PopoverAnchor>
      <p>
        <Button variant="secondary">外のボタン</Button>
      </p>
    </div>
  );
}

const meta = {
  title: 'UI/Popover',
  parameters: { a11y: { test: 'error' } },
  component: Demo,
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const EscClosesAndReturnsFocus: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'コードを追加' });
    await userEvent.click(trigger);
    const dialog = await canvas.findByRole('dialog', { name: 'パレット' });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'C' })).toHaveFocus(),
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};

export const OutsideClickCloses: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'コードを追加' }));
    await canvas.findByRole('dialog');
    const outside = canvas.getByRole('button', { name: '外のボタン' });
    await userEvent.click(outside);
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
    // Focus stays where the user clicked, not yanked back to the trigger.
    await waitFor(() => expect(outside).toHaveFocus());
  },
};

export const EscDuringImeCompositionStaysOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'コードを追加' }));
    const dialog = await canvas.findByRole('dialog', { name: 'パレット' });
    // IME conversion in progress: Escape cancels the conversion, not the
    // dialog (R4). isComposing: true is the standard signal; some browsers
    // also send keyCode 229 for the same event.
    fireEvent.keyDown(dialog, { key: 'Escape', isComposing: true });
    expect(canvas.queryByRole('dialog')).not.toBeNull();
    // A normal Escape (composition finished) still closes it.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
  },
};

export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'コードを追加' }));
    await canvas.findByRole('dialog');
  },
};
