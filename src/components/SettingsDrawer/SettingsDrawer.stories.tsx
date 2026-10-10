import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import type { ViewerSettings } from '../../lib/viewerSettings';
import { SettingsDrawer } from './SettingsDrawer';

const INITIAL: ViewerSettings = {
  layout: 'part',
  part: 'ドラム',
  scoreHidden: [],
  scoreChart: true,
  nav: 'page',
  zoom: 1,
  speedPct: 100,
  countIn: true,
  transpose: 0,
};

function Demo({
  onChange,
  initial = INITIAL,
}: {
  onChange: (s: ViewerSettings) => void;
  initial?: ViewerSettings;
}) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(initial);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <div style={{ width: 1194, height: 834 }}>
      <button ref={anchor} type="button" onClick={() => setOpen(true)}>
        設定
      </button>
      <SettingsDrawer
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        settings={settings}
        partNames={['ドラム', 'メロディ']}
        onChange={(s) => {
          onChange(s);
          setSettings(s);
        }}
      />
    </div>
  );
}

const meta = {
  title: 'Viewer/SettingsDrawer',
  component: Demo,
  parameters: { a11y: { test: 'error' } },
  args: { onChange: fn() },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

const openDrawer = async (canvasElement: HTMLElement) => {
  const body = within(canvasElement.ownerDocument.body);
  await userEvent.click(body.getByRole('button', { name: '設定' }));
  return body;
};

export const FocusAndClose: Story = {
  play: async ({ canvasElement }) => {
    const body = await openDrawer(canvasElement);
    const dialog = body.getByRole('dialog', { name: '曲・表示の設定' });
    await expect(dialog).toBeInTheDocument();
    await expect(body.getByRole('button', { name: '閉じる' })).toHaveFocus();
    await expect(
      body.getByText('この曲につき設定を記憶します'),
    ).toBeInTheDocument();
    // Tab never leaves the dialog.
    for (let i = 0; i < 25; i++) {
      await userEvent.tab();
      await expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(body.queryByRole('dialog')).toBeNull());
    await expect(body.getByRole('button', { name: '設定' })).toHaveFocus();
  },
};

export const BackdropClose: Story = {
  play: async ({ canvasElement }) => {
    const body = await openDrawer(canvasElement);
    await userEvent.click(body.getByTestId('settings-backdrop'));
    await waitFor(() => expect(body.queryByRole('dialog')).toBeNull());
    await expect(body.getByRole('button', { name: '設定' })).toHaveFocus();
  },
};

export const PartLayout: Story = {
  play: async ({ canvasElement, args }) => {
    const body = await openDrawer(canvasElement);
    await expect(body.getByRole('button', { name: 'ドラム' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(body.getByRole('button', { name: 'メロディ' }));
    await expect(args.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ part: 'メロディ' }),
    );
    await userEvent.click(body.getByRole('button', { name: 'コード譜だけ' }));
    await expect(args.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ part: null }),
    );
    await userEvent.click(body.getByRole('button', { name: /縦スクロール/ }));
    await expect(args.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ nav: 'scroll' }),
    );
  },
};

export const ScoreLayout: Story = {
  play: async ({ canvasElement, args }) => {
    const body = await openDrawer(canvasElement);
    await userEvent.click(body.getByRole('button', { name: /スコア/ }));
    await expect(args.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ layout: 'score' }),
    );
    // Parts are now show/hide toggles, plus the chart chip.
    const parts = body.getByRole('group', { name: '表示するパート' });
    const drum = within(parts).getByRole('button', { name: 'ドラム' });
    await expect(drum).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(drum);
    await expect(args.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ scoreHidden: ['ドラム'] }),
    );
    await expect(drum).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(
      within(parts).getByRole('button', { name: 'コード譜' }),
    );
    await expect(args.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ scoreChart: false }),
    );
  },
};

export const TextSize: Story = {
  play: async ({ canvasElement, args }) => {
    const body = await openDrawer(canvasElement);
    await expect(body.getByTestId('size-px')).toHaveTextContent('22px');
    await userEvent.click(body.getByRole('button', { name: '文字を大きく' }));
    await expect(args.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ zoom: 1.1 }),
    );
    await expect(body.getByTestId('size-px')).toHaveTextContent('24px');
    await userEvent.click(body.getByRole('button', { name: '文字を小さく' }));
    await userEvent.click(body.getByRole('button', { name: '文字を小さく' }));
    await userEvent.click(body.getByRole('button', { name: '文字を小さく' }));
    await expect(
      body.getByRole('button', { name: '文字を小さく' }),
    ).toBeDisabled();
    await expect(body.getByTestId('size-px')).toHaveTextContent('18px');
  },
};
