import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { PageNav } from './PageNav';

function Demo({
  initial,
  total,
  playMode,
  onPrev,
  onNext,
}: {
  initial: number;
  total: number;
  playMode?: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const [page, setPage] = useState(initial);
  return (
    <div
      style={{
        position: 'relative',
        width: 1194,
        height: 700,
        background: 'var(--bg)',
      }}
    >
      <PageNav
        page={page}
        totalPages={total}
        playMode={playMode}
        onPrev={() => {
          onPrev();
          setPage((p) => p - 1);
        }}
        onNext={() => {
          onNext();
          setPage((p) => p + 1);
        }}
      />
    </div>
  );
}

const meta = {
  title: 'Viewer/PageNav',
  component: Demo,
  parameters: { a11y: { test: 'error' }, layout: 'centered' },
  args: { initial: 2, total: 5, onPrev: fn(), onNext: fn() },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Normal: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('page-count')).toHaveTextContent('2 / 5');
    await expect(canvas.getByText('タップで前のページ')).toBeVisible();
    await expect(canvas.getByText('タップで次のページ')).toBeVisible();

    const zone = canvas.getByTestId('tap-next');
    const root = canvas.getByTestId('page-nav').getBoundingClientRect();
    const rect = zone.getBoundingClientRect();
    await expect(Math.round((rect.width / root.width) * 100)).toBe(30);

    // Bottom buttons are the accessible controls (44px touch targets).
    const buttons = canvas.getAllByRole('button', { name: '次のページ' });
    await expect(buttons).toHaveLength(1);
    const box = buttons[0].getBoundingClientRect();
    await expect(box.width).toBeGreaterThanOrEqual(44);
    await expect(box.height).toBeGreaterThanOrEqual(44);

    await userEvent.click(buttons[0]);
    await expect(args.onNext).toHaveBeenCalledOnce();
    await expect(canvas.getByTestId('page-count')).toHaveTextContent('3 / 5');

    await userEvent.click(zone);
    await expect(args.onNext).toHaveBeenCalledTimes(2);
    await expect(canvas.getByTestId('page-count')).toHaveTextContent('4 / 5');

    await userEvent.click(canvas.getByTestId('tap-prev'));
    await expect(args.onPrev).toHaveBeenCalledOnce();
    await expect(canvas.getByTestId('page-count')).toHaveTextContent('3 / 5');
  },
};

export const FirstPage: Story = {
  args: { initial: 1 },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const prev = canvas.getByRole('button', { name: '前のページ' });
    await expect(prev).toBeDisabled();
    await expect(canvas.getByTestId('tap-prev')).toBeDisabled();
    await expect(
      canvas.getByRole('button', { name: '次のページ' }),
    ).toBeEnabled();
    await userEvent.click(canvas.getByTestId('tap-prev'));
    await expect(args.onPrev).not.toHaveBeenCalled();
  },
};

export const LastPage: Story = {
  args: { initial: 5 },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('button', { name: '次のページ' }),
    ).toBeDisabled();
    await expect(canvas.getByTestId('tap-next')).toBeDisabled();
    await userEvent.click(canvas.getByTestId('tap-next'));
    await expect(args.onNext).not.toHaveBeenCalled();
    await expect(canvas.getByTestId('page-count')).toHaveTextContent('5 / 5');
  },
};

export const PlayMode: Story = {
  args: { playMode: true },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText('タップで次のページ')).toBeNull();
    await expect(canvas.queryByTestId('page-count')).toBeNull();

    const root = canvas.getByTestId('page-nav').getBoundingClientRect();
    const rect = canvas.getByTestId('tap-prev').getBoundingClientRect();
    await expect(Math.round((rect.width / root.width) * 100)).toBe(32);

    await userEvent.click(canvas.getByRole('button', { name: '次のページ' }));
    await expect(args.onNext).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole('button', { name: '前のページ' }));
    await expect(args.onPrev).toHaveBeenCalledOnce();
  },
};

/** The arrow hints sit in the outer 32px, clear of the sheet's content. */
export const ArrowsAtScreenEdges: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const root = canvas.getByTestId('page-nav').getBoundingClientRect();
    const prev = canvas.getByTestId('tap-prev').querySelector('svg')!;
    const next = canvas.getByTestId('tap-next').querySelector('svg')!;
    const p = prev.getBoundingClientRect();
    const n = next.getBoundingClientRect();
    await expect(p.right - root.left).toBeLessThanOrEqual(32);
    await expect(root.right - n.left).toBeLessThanOrEqual(32);
  },
};
