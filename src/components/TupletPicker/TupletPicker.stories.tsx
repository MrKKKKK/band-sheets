import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { TupletPicker } from './TupletPicker';

function Demo({
  onInsert,
  onRemove,
  canRemove,
  disabled,
}: {
  onInsert: (n: number) => void;
  onRemove: () => void;
  canRemove: boolean;
  disabled?: boolean;
}) {
  // Stand-in for the melody/drum input staff: a focusable div that `onDone`
  // should restore focus to, proving the trigger button never keeps it.
  const staffRef = useRef<HTMLDivElement>(null);
  const [removable, setRemovable] = useState(canRemove);
  return (
    <div>
      <div ref={staffRef} tabIndex={0} data-testid="staff-standin" autoFocus>
        staff
      </div>
      <TupletPicker
        onInsert={onInsert}
        onRemove={() => {
          onRemove();
          setRemovable(false);
        }}
        canRemove={removable}
        disabled={disabled}
        onDone={() => staffRef.current?.focus()}
      />
    </div>
  );
}

const meta = {
  title: 'UI/TupletPicker',
  component: Demo,
  parameters: { a11y: { test: 'error' } },
  args: { onInsert: fn(), onRemove: fn(), canRemove: false },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

async function openPopover(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: '連符' }));
  return canvas.findByRole('dialog', { name: '連符' });
}

export const Closed: Story = {};

export const ChoosePreset: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const staff = canvas.getByTestId('staff-standin');
    staff.focus();
    expect(document.activeElement).toBe(staff);

    await openPopover(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '3連符' }));

    await expect(args.onInsert).toHaveBeenCalledOnce();
    await expect(args.onInsert).toHaveBeenCalledWith(3);
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
    // onDone ran synchronously before the popover unmounted, so Popover's
    // own cleanup (which would otherwise return focus to the trigger) finds
    // the staff already focused and leaves it alone.
    await waitFor(() => expect(staff).toHaveFocus());
  },
};

export const ChooseOtherValid: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const staff = canvas.getByTestId('staff-standin');
    staff.focus();

    const dialog = await openPopover(canvasElement);
    const dialogCanvas = within(dialog);
    await userEvent.click(dialogCanvas.getByRole('button', { name: 'その他' }));
    const input =
      await dialogCanvas.findByLabelText('連符の数（3〜15、4・8を除く）');
    await userEvent.type(input, '11');
    await userEvent.click(dialogCanvas.getByRole('button', { name: '挿入' }));

    await expect(args.onInsert).toHaveBeenCalledOnce();
    await expect(args.onInsert).toHaveBeenCalledWith(11);
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(staff).toHaveFocus());
  },
};

export const OtherInvalidInputs: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const dialog = await openPopover(canvasElement);
    const dialogCanvas = within(dialog);
    await userEvent.click(dialogCanvas.getByRole('button', { name: 'その他' }));
    const input =
      await dialogCanvas.findByLabelText('連符の数（3〜15、4・8を除く）');
    const submit = () =>
      userEvent.click(dialogCanvas.getByRole('button', { name: '挿入' }));

    await userEvent.type(input, '4');
    await submit();
    await expect(dialogCanvas.getByRole('alert')).toHaveTextContent(
      '4 連符は扱えません（3〜15、4 と 8 を除く）',
    );
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(args.onInsert).not.toHaveBeenCalled();

    await userEvent.clear(input);
    await userEvent.type(input, '16');
    await submit();
    await expect(dialogCanvas.getByRole('alert')).toHaveTextContent(
      '16 連符は扱えません（3〜15、4 と 8 を除く）',
    );

    await userEvent.clear(input);
    await userEvent.type(input, 'abc');
    await submit();
    await expect(dialogCanvas.getByRole('alert')).toHaveTextContent(
      '半角の数字で入力してください',
    );

    // The dialog never closed and onInsert was never reached.
    expect(canvas.getByRole('dialog')).not.toBeNull();
    expect(args.onInsert).not.toHaveBeenCalled();
  },
};

export const EscCloses: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: '連符' });
    await openPopover(canvasElement);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
    // Nothing was chosen, so onDone never ran — Popover's own focus-return
    // sends focus back to the trigger, not the staff.
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};

export const RemoveDisabledWhenCannotRemove: Story = {
  args: { canRemove: false },
  play: async ({ canvasElement }) => {
    await openPopover(canvasElement);
    const canvas = within(canvasElement);
    const removeButton = canvas.getByRole('button', { name: '連符を削除' });
    expect(removeButton).toBeDisabled();
  },
};

export const RemoveEnabledWhenCanRemove: Story = {
  args: { canRemove: true },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const staff = canvas.getByTestId('staff-standin');
    staff.focus();

    await openPopover(canvasElement);
    const removeButton = canvas.getByRole('button', { name: '連符を削除' });
    expect(removeButton).toBeEnabled();
    await userEvent.click(removeButton);

    await expect(args.onRemove).toHaveBeenCalledOnce();
    await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(staff).toHaveFocus());
  },
};

export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole('button', { name: '連符' })).toBeDisabled();
  },
};
