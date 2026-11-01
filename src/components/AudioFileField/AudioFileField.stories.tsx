import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef } from 'react';
import { expect, fn, within } from 'storybook/test';
import { AudioFileField, type AudioFileFieldProps } from './AudioFileField';

function Field(props: Omit<AudioFileFieldProps, 'inputRef'>) {
  const ref = useRef<HTMLInputElement>(null);
  return <AudioFileField {...props} inputRef={ref} />;
}

const meta = {
  title: 'Import/AudioFileField',
  component: Field,
  parameters: { a11y: { test: 'error' } },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 760, padding: 24 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    file: null,
    onPick: fn(),
    hint: 'WAV・MP3・M4A の音声ファイル。10 分まで。',
  },
} satisfies Meta<typeof Field>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByTestId('drop-zone')).toHaveTextContent('10 分まで');
    expect(c.getByRole('button', { name: 'ファイルを選ぶ' })).toBeVisible();
  },
};

export const Picked: Story = {
  args: { file: { name: 'hum-take2.wav', size: 3_200_000, duration: 38 } },
  play: async ({ canvasElement }) => {
    expect(within(canvasElement).getByTestId('picked-file')).toHaveTextContent(
      'hum-take2.wav長さ 0:38 ・ 3.2 MB',
    );
  },
};
