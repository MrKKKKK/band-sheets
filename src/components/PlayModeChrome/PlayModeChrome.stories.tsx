import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { PlayModeChrome } from './PlayModeChrome';

const onExit = fn();

function Demo({ autoHideMs = 4000 }: { autoHideMs?: number }) {
  const [visible, setVisible] = useState(false);
  const [zoom, setZoom] = useState(2);
  return (
    <div
      style={{
        position: 'relative',
        width: 1194,
        height: 834,
        background: 'var(--surface)',
        overflow: 'hidden',
      }}
    >
      <PlayModeChrome
        title="きらきら星"
        page={3}
        pageCount={5}
        visible={visible}
        onVisibleChange={setVisible}
        onExit={onExit}
        onZoomOut={() => setZoom((z) => z - 1)}
        onZoomIn={() => setZoom((z) => z + 1)}
        zoomOutDisabled={zoom <= 0}
        zoomInDisabled={zoom >= 4}
        autoHideMs={autoHideMs}
      />
      <output data-testid="zoom">{zoom}</output>
    </div>
  );
}

const meta = {
  title: 'Viewer/PlayModeChrome',
  component: Demo,
  parameters: { a11y: { test: 'error' } },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RevealAndHide: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByTestId('play-mode-bar')).toBeNull();
    await userEvent.click(
      canvas.getByRole('button', { name: '操作バーを表示' }),
    );
    await expect(canvas.getByTestId('play-mode-bar')).toBeInTheDocument();
    await expect(canvas.getByTestId('play-mode-page')).toHaveTextContent(
      '3 / 5',
    );
    await userEvent.click(
      canvas.getByRole('button', { name: '操作バーを隠す' }),
    );
    await expect(canvas.queryByTestId('play-mode-bar')).toBeNull();
  },
};

export const ZoomAndExit: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', { name: '操作バーを表示' }),
    );
    await userEvent.click(canvas.getByRole('button', { name: '文字を大きく' }));
    await expect(canvas.getByTestId('zoom')).toHaveTextContent('3');
    await userEvent.click(canvas.getByRole('button', { name: '文字を大きく' }));
    await expect(
      canvas.getByRole('button', { name: '文字を大きく' }),
    ).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: '文字を小さく' }));
    await expect(canvas.getByTestId('zoom')).toHaveTextContent('3');
    await userEvent.click(
      canvas.getByRole('button', { name: '演奏モードを終了' }),
    );
    await expect(onExit).toHaveBeenCalled();
  },
};

export const AutoHides: Story = {
  args: { autoHideMs: 300 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', { name: '操作バーを表示' }),
    );
    await expect(canvas.getByTestId('play-mode-bar')).toBeInTheDocument();
    await waitFor(
      () => expect(canvas.queryByTestId('play-mode-bar')).toBeNull(),
      { timeout: 2000 },
    );
  },
};

export const InteractionKeepsBarOpen: Story = {
  args: { autoHideMs: 500 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', { name: '操作バーを表示' }),
    );
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 300));
      await userEvent.click(
        canvas.getByRole('button', { name: '文字を大きく' }),
      );
      if (i === 0)
        await expect(canvas.getByTestId('play-mode-bar')).toBeInTheDocument();
    }
    await expect(canvas.getByTestId('play-mode-bar')).toBeInTheDocument();
    await waitFor(
      () => expect(canvas.queryByTestId('play-mode-bar')).toBeNull(),
      { timeout: 2000 },
    );
  },
};
