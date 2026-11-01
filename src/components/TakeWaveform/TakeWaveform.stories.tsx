import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { makeTake } from '../MicRecorder/micStoryFixtures';
import { TakeWaveform } from './TakeWaveform';

const take = makeTake();

const meta = {
  title: 'Mic/TakeWaveform',
  component: TakeWaveform,
  parameters: { a11y: { test: 'error' } },
  args: {
    peaks: take.peaks,
    durationSec: take.durationSec,
    bar1Sec: take.bar1Sec,
    label: '録音の波形',
  },
  decorators: [
    (Story) => (
      <div style={{ width: 800 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TakeWaveform>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByRole('img', { name: '録音の波形' })).toBeVisible();
    expect(c.queryByTestId('waveform-playhead')).toBeNull();
  },
};

export const Playing: Story = {
  args: { playheadSec: 8 },
  play: ({ canvasElement }) => {
    expect(
      within(canvasElement).getByTestId('waveform-playhead'),
    ).toBeInTheDocument();
  },
};
