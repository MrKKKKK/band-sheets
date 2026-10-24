import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import type { AudioPlayer } from '../../hooks/useAudioPlayer';

import { initialReviewState, reviewDraft } from '../../lib/import/chordReview';
import { reviewSampleResult } from '../../lib/import/fixtures/chordResults';
import { ChordReview } from './ChordReview';

const result = reviewSampleResult();

function player(over: Partial<AudioPlayer> = {}): AudioPlayer {
  return {
    playing: false,
    currentTime: 0,
    duration: result.source.durationSec,
    failed: false,
    play: fn(),
    pause: fn(),
    seek: fn(),
    setBarResolver: fn(),
    ...over,
  };
}

const meta = {
  title: 'Import/ChordReview',
  component: ChordReview,
  parameters: { a11y: { test: 'error' }, layout: 'fullscreen' },
  args: {
    result,
    fileName: 'my-demo-take3.wav',
    player: player(),
    onCreate: fn(),
    onBack: fn(),
    say: fn(),
  },
} satisfies Meta<typeof ChordReview>;

export default meta;
type Story = StoryObj<typeof meta>;

const line = (c: ReturnType<typeof within>, firstBar: number) =>
  c.getByTestId(`review-line-${firstBar}`);

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(
      c.getByRole('heading', { level: 1, name: 'コード譜の下書きを確かめる' }),
    ).toBeVisible();
    expect(c.getByLabelText('曲名')).toHaveValue('my-demo-take3');
    expect(c.getByTestId('review-tempo')).toHaveTextContent('♩= 96');
    expect(c.getByTestId('review-meter')).toHaveTextContent('4/4');
    expect(c.getByRole('button', { name: /G 最有力/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(c.getByTestId('review-shift')).toHaveTextContent('ずれなし');
    expect(c.getByTestId('dropped-notice')).toHaveTextContent('約 0.7 秒');
    expect(c.getByTestId('chart-summary')).toHaveTextContent(
      '20 小節 ・ 3 セクション ・ 確かめたいコード 4 件',
    );
    expect(line(c, 4)).toHaveTextContent(
      '|[Em]--------|[Am?]--------|[D]--------|[G]--------|',
    );
    expect(c.getByLabelText('セクション 2 の名前')).toHaveValue('B');
    expect(c.getByText('A(8) B(8) A(4)')).toBeVisible();
  },
};

export const CandidateOpen: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(
      c.getByRole('button', { name: '6 小節目 Am?（自信がないコード）の候補' }),
    );
    const panel = within(c.getByTestId('candidate-panel'));
    expect(panel.getByText('6 小節目のコードの候補')).toBeVisible();
    const am = panel.getByRole('button', { name: /^Am 49%/ });
    expect(am).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(am).toHaveFocus());
    expect(panel.getByRole('button', { name: /Am7 21%/ })).toBeVisible();
    expect(
      panel.getByRole('button', { name: /N\.C\. コードなし/ }),
    ).toBeVisible();
    expect(panel.getByText(/正解の確率ではありません/)).toBeVisible();
    expect(
      panel.getByText(/いまは第 1 候補の Am で、\? つきです/),
    ).toBeVisible();
    // choosing drops the ?
    await userEvent.click(panel.getByRole('button', { name: /Am7 21%/ }));
    expect(c.queryByTestId('candidate-panel')).toBeNull();
    expect(line(c, 4)).toHaveTextContent('[Am7]--------');
    expect(c.getByTestId('chart-summary')).toHaveTextContent(
      '確かめたいコード 3 件',
    );
    expect(args.say).toHaveBeenCalledWith('6 小節目のコードを Am7 にしました');
    // open it again for the screenshot state
    await userEvent.click(
      c.getByRole('button', { name: '6 小節目 Am7の候補' }),
    );
    expect(c.getByTestId('candidate-panel')).toBeVisible();
  },
};

export const TempoDouble: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: /倍 192/ }));
    expect(c.getByTestId('review-tempo')).toHaveTextContent('♩= 192');
    expect(c.getByTestId('chart-summary')).toHaveTextContent('40 小節');
  },
};

export const TempoHalf: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    // a chosen chord survives the rebuild
    await userEvent.click(
      c.getByRole('button', { name: '6 小節目 Am?（自信がないコード）の候補' }),
    );
    await userEvent.click(
      within(c.getByTestId('candidate-panel')).getByRole('button', {
        name: /C 14%/,
      }),
    );
    await userEvent.click(c.getByRole('button', { name: /半分 48/ }));
    expect(c.getByTestId('review-tempo')).toHaveTextContent('♩= 48');
    expect(c.getByTestId('chart-summary')).toHaveTextContent('10 小節');
    expect(line(c, 0)).toHaveTextContent('|[Em]----[C]----|');
  },
};

export const KeyChanged: Story = {
  args: {
    result: {
      ...result,
      key: { tonic: 'D', mode: 'minor', confidence: 0.6 },
      keys: undefined,
    },
  },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    // D minor (one flat): the analyzer's A# is not used anyway; choose F major
    await userEvent.click(c.getByRole('button', { name: /F 平行調/ }));
    expect(c.getByRole('button', { name: /F 平行調/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(args.say).toHaveBeenCalledWith(
      'キー F。コード名をこのキーの書き方にしました',
    );
    expect(c.getByText(/F ・ ♩= 96/)).toBeVisible();
  },
};

const bars = reviewDraft(result, initialReviewState(result, 't')).bars;

export const Playing: Story = {
  args: {
    player: player({
      playing: true,
      currentTime: (bars[5].startSec + bars[5].endSec) / 2,
    }),
  },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const current = canvasElement.querySelectorAll('[data-current]');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute('data-bar', '5');
    expect(c.getByRole('button', { name: '録音を止める' })).toBeVisible();
    await userEvent.click(c.getByRole('button', { name: '9 小節目から再生' }));
    expect(args.player.play).toHaveBeenCalledWith(bars[8].startSec);
  },
};

export const BackAsksAfterChange: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: '1 拍後へ ›' }));
    expect(c.getByTestId('review-shift')).toHaveTextContent('1 拍後へ');
    await userEvent.click(c.getByRole('button', { name: '‹ やめて戻る' }));
    const dialog = within(document.body).getByRole('dialog', {
      name: 'ここでの直しを捨てて戻りますか？',
    });
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'キャンセル' }),
    );
    expect(args.onBack).not.toHaveBeenCalled();
  },
};

/** 「? 書き方」 (T4-3): the shared dash-notation help opens, Esc closes and returns focus. */
export const DashHelpOpens: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const button = c.getByRole('button', { name: '? 書き方' });
    await userEvent.click(button);
    const dialog = await c.findByRole('dialog', {
      name: 'コードだけの行の書き方',
    });
    expect(dialog).toHaveTextContent('八分音符');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(c.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(button).toHaveFocus());
  },
};

/** An open candidate panel is closed when the bars are redrawn (tempo / shift / key). */
export const PanelClosesOnRebuild: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const open = async () => {
      await userEvent.click(
        c.getByRole('button', {
          name: /^6 小節目 Am\??.*の候補/,
        }),
      );
      expect(c.getByTestId('candidate-panel')).toBeVisible();
    };
    await open();
    await userEvent.click(c.getByRole('button', { name: /倍 192/ }));
    expect(c.queryByTestId('candidate-panel')).toBeNull();
    await userEvent.click(c.getByRole('button', { name: /解析のまま 96/ }));
    await open();
    await userEvent.click(c.getByRole('button', { name: '1 拍後へ ›' }));
    expect(c.queryByTestId('candidate-panel')).toBeNull();
  },
};

/** An emptied section name goes back to the analyzer's on blur and is no change. */
export const EmptySectionNameReverts: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const input = c.getByLabelText('セクション 2 の名前');
    await userEvent.clear(input);
    expect(input).toHaveValue('');
    await userEvent.tab();
    expect(input).toHaveValue('B');
    // not an edit: going back does not ask
    await userEvent.click(c.getByRole('button', { name: '‹ やめて戻る' }));
    expect(within(document.body).queryByRole('dialog')).toBeNull();
  },
};
