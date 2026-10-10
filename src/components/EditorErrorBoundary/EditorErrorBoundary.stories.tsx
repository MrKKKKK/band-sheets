import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { Button } from '../Button/Button';
import { EditorErrorBoundary } from './EditorErrorBoundary';

let broken = true;

/** Throws while `broken` is set (a stand-in for a layout exception). */
function Fragile({ text }: { text: string }) {
  if (broken) throw new RangeError('layout failed');
  return <p>表示できました: {text}</p>;
}

/** Holds a resetKey like App's song text, with a button that changes it. */
function Demo({ onRequestTextEdit }: { onRequestTextEdit?: () => void }) {
  const [text, setText] = useState('v1');
  return (
    <div>
      <Button
        onClick={() => {
          broken = false;
          setText('v2');
        }}
      >
        テキストを直す
      </Button>
      <EditorErrorBoundary
        resetKey={text}
        onRequestTextEdit={onRequestTextEdit}
      >
        <Fragile text={text} />
      </EditorErrorBoundary>
    </div>
  );
}

const meta = {
  title: 'UI/EditorErrorBoundary',
  component: Demo,
  parameters: { a11y: { test: 'error' }, layout: 'padded' },
  beforeEach: () => {
    broken = true;
  },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

const onRequestTextEdit = fn();

/** A crash shows the Japanese fallback; a new resetKey recovers. */
export const RecoversWhenTextChanges: Story = {
  args: { onRequestTextEdit },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole('alert')).toHaveTextContent(
      'この画面を表示できませんでした。テキスト入力で内容を確認してください。',
    );
    await userEvent.click(
      canvas.getByRole('button', { name: 'テキスト入力で確認する' }),
    );
    expect(onRequestTextEdit).toHaveBeenCalledOnce();

    await userEvent.click(
      canvas.getByRole('button', { name: 'テキストを直す' }),
    );
    expect(canvas.getByText('表示できました: v2')).toBeVisible();
    expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
  },
};

/** 「もう一度表示する」 retries; still failing keeps the fallback. */
export const Retry: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(
      canvas.queryByRole('button', { name: 'テキスト入力で確認する' }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole('button', { name: 'もう一度表示する' }),
    );
    expect(canvas.getByTestId('editor-crash')).toBeVisible();
    broken = false;
    await userEvent.click(
      canvas.getByRole('button', { name: 'もう一度表示する' }),
    );
    expect(canvas.getByText('表示できました: v1')).toBeVisible();
  },
};
