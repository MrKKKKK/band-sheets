import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ComponentProps } from 'react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import {
  EDITOR_MODE_KEY,
  createMemoryStorage,
  draftKey,
  type KeyValueStorage,
} from './lib/storage';

const DRAFT = `{title: きらきら星}
{key: C}

{start_of_verse: A}
きらきら[F]ひかる
{end_of_verse}
`;

function renderApp(
  storage: KeyValueStorage | null = createMemoryStorage(),
  props: Partial<ComponentProps<typeof App>> = {},
) {
  const user = userEvent.setup();
  render(<App storage={storage} {...props} />);
  return { user };
}

const savedDraft = (storage: KeyValueStorage, id = 'local') =>
  JSON.parse(storage.getItem(draftKey(id)) ?? 'null');

const textarea = () => screen.getByLabelText('ChordPro テキスト');

describe('App', () => {
  it('starts a new song at editor A step 1 when there is no draft', () => {
    renderApp();
    expect(
      screen.getByRole('heading', { level: 1, name: '無題の曲' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'かんたん入力' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('歌詞を貼り付け')).toHaveValue('');
  });

  it('works without storage', () => {
    renderApp(null);
    expect(
      screen.getByRole('heading', { level: 1, name: '無題の曲' }),
    ).toBeInTheDocument();
  });

  it('shows a restored draft', async () => {
    const storage = createMemoryStorage({ [draftKey('local')]: DRAFT });
    const { user } = renderApp(storage);
    expect(
      screen.getByRole('heading', { level: 1, name: 'きらきら星' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('line-0-0')).toHaveTextContent('F');
    await user.click(screen.getByRole('button', { name: 'テキスト入力' }));
    expect(textarea()).toHaveValue(DRAFT);
  });

  it('keeps the text unchanged when switching A ⇄ B', async () => {
    // Non-canonical text: B must show it as written, before and after A.
    const raw = '{t:きらきら星}\n\n  きらきら[F]ひかる\n';
    const storage = createMemoryStorage({
      [draftKey('local')]: raw,
      [EDITOR_MODE_KEY]: 'text',
    });
    const { user } = renderApp(storage);
    expect(textarea()).toHaveValue(raw);
    await user.click(screen.getByRole('button', { name: 'かんたん入力' }));
    expect(screen.queryByLabelText('ChordPro テキスト')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'テキスト入力' }));
    expect(textarea()).toHaveValue(raw);
  });

  it('remembers the editor mode', async () => {
    const storage = createMemoryStorage();
    const { user } = renderApp(storage);
    await user.click(screen.getByRole('button', { name: 'テキスト入力' }));
    expect(storage.getItem(EDITOR_MODE_KEY)).toBe('text');
  });

  it('updates the title from the song-info popover', async () => {
    const { user } = renderApp();
    await user.click(screen.getByRole('button', { name: '曲情報を設定' }));
    const dialog = screen.getByRole('dialog', { name: '曲情報' });
    const name = within(dialog).getByLabelText('曲名');
    await user.clear(name);
    await user.type(name, '星に願いを');
    await user.type(within(dialog).getByLabelText('キー'), 'G');
    await user.click(within(dialog).getByRole('button', { name: '適用' }));
    expect(
      screen.getByRole('heading', { level: 1, name: '星に願いを' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'テキスト入力' }));
    expect(textarea()).toHaveValue('{title: 星に願いを}\n{key: G}\n');
  });

  it('does not promote a stale duplicate {key: D} after clearing key in song info (m3-review.md F1/N5)', async () => {
    const storage = createMemoryStorage({
      [draftKey('local')]: '{title: 曲}\n{key: C}\n{key: D}\n[C]a\n',
    });
    const { user } = renderApp(storage);
    await user.click(screen.getByRole('button', { name: 'キー C' }));
    const dialog = screen.getByRole('dialog', { name: '曲情報' });
    await user.clear(within(dialog).getByLabelText('キー'));
    await user.click(within(dialog).getByRole('button', { name: '適用' }));
    await user.click(screen.getByRole('button', { name: 'テキスト入力' }));
    // The stale {key: D} must be gone from the text, not just unpromoted
    // for this render — otherwise the next parse would promote it anyway.
    expect(textarea()).toHaveValue('{title: 曲}\n\n[C]a\n');
  });

  it('autosaves the text as the draft', async () => {
    const storage = createMemoryStorage();
    const { user } = renderApp(storage);
    await user.click(screen.getByRole('button', { name: 'テキスト入力' }));
    await user.type(textarea(), 'あ');
    // Debounced: flushed by pagehide here instead of waiting 500ms.
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(savedDraft(storage)).toMatchObject({
      v: 1,
      text: '{title: 無題の曲}\nあ',
      baseVersion: null,
    });
  });

  it('keeps the editor A step-1 draft when switching to テキスト入力 and back', async () => {
    // m3-review.md R3: an unapplied step-1 draft used to be lost because
    // EasyEditor unmounts when switching to editor B.
    const { user } = renderApp();
    const textarea = screen.getByLabelText('歌詞を貼り付け');
    await user.type(textarea, 'あたらしいうた');
    await user.click(screen.getByRole('button', { name: 'テキスト入力' }));
    expect(screen.queryByLabelText('歌詞を貼り付け')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'かんたん入力' }));
    expect(screen.getByLabelText('歌詞を貼り付け')).toHaveValue(
      'あたらしいうた',
    );
    // Still step 1 (not applied), not step 2.
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent(
      '1',
    );
  });

  describe('editor A step-1 draft vs. changed lyrics (m3-review.md N1)', () => {
    const chordproTextarea = () => screen.getByLabelText('ChordPro テキスト');
    const easyTextarea = () => screen.getByLabelText('歌詞を貼り付け');
    const currentStep = () => screen.getByRole('listitem', { current: 'step' });

    it('keeps lines added in テキスト入力 when editor A step 1 was already open (no data loss)', async () => {
      // Repro: song "[C]hello"; open 「歌詞を編集」 (step 1, draft "hello");
      // switch to テキスト入力, add a line "[G]world"; switch back. The old
      // bug kept the stale "hello" draft at step 1, and 反映 then deleted
      // the new line. The draft was never touched here, so it should just
      // follow the new lyrics straight to step 2 instead.
      const storage = createMemoryStorage({
        [draftKey('local')]: '{title: t}\n\n[C]hello',
      });
      const { user } = renderApp(storage);
      await user.click(screen.getByRole('button', { name: '歌詞を編集' }));
      expect(easyTextarea()).toHaveValue('hello');

      await user.click(screen.getByRole('button', { name: 'テキスト入力' }));
      fireEvent.change(chordproTextarea(), {
        target: { value: '{title: t}\n\n[C]hello\n[G]world' },
      });

      await user.click(screen.getByRole('button', { name: 'かんたん入力' }));
      expect(screen.queryByLabelText('歌詞を貼り付け')).toBeNull();
      expect(currentStep()).toHaveTextContent('2');
      expect(screen.getByTestId('line-0-0')).toHaveTextContent('hello');
      expect(screen.getByTestId('line-0-1')).toHaveTextContent('world');
    });

    it('shows step 2 (not an empty step-1 draft) after typing lyrics in テキスト入力 on a new song', async () => {
      const { user } = renderApp();
      expect(currentStep()).toHaveTextContent('1');

      await user.click(screen.getByRole('button', { name: 'テキスト入力' }));
      fireEvent.change(chordproTextarea(), {
        target: { value: '{title: 無題の曲}\n\n[C]hello' },
      });

      await user.click(screen.getByRole('button', { name: 'かんたん入力' }));
      expect(screen.queryByLabelText('歌詞を貼り付け')).toBeNull();
      expect(currentStep()).toHaveTextContent('2');
      expect(screen.getByTestId('line-0-0')).toHaveTextContent('hello');
    });

    it('shows a notice instead of silently dropping an edited draft when B changes the lyrics underneath it', async () => {
      const storage = createMemoryStorage({
        [draftKey('local')]: '{title: t}\n\n[C]hello',
      });
      const { user } = renderApp(storage);
      await user.click(screen.getByRole('button', { name: '歌詞を編集' }));
      // The user edits the draft themselves (now diverged from its base).
      fireEvent.change(easyTextarea(), {
        target: { value: 'hello\nworld2' },
      });

      await user.click(screen.getByRole('button', { name: 'テキスト入力' }));
      fireEvent.change(chordproTextarea(), {
        target: { value: '{title: t}\n\n[C]hello\n[G]world' },
      });
      await user.click(screen.getByRole('button', { name: 'かんたん入力' }));

      // Still step 1, with the user's own edit kept, plus a notice.
      expect(currentStep()).toHaveTextContent('1');
      expect(easyTextarea()).toHaveValue('hello\nworld2');
      expect(
        screen.getByText('テキスト入力で歌詞が変更されました'),
      ).toBeVisible();

      await user.click(
        screen.getByRole('button', { name: '最新の歌詞で作り直す' }),
      );
      expect(easyTextarea()).toHaveValue('hello\nworld');
      expect(
        screen.queryByText('テキスト入力で歌詞が変更されました'),
      ).toBeNull();
    });

    it('keeps the edited draft when choosing 「この下書きを使う」, and applies it as-is', async () => {
      const storage = createMemoryStorage({
        [draftKey('local')]: '{title: t}\n\n[C]hello',
      });
      const { user } = renderApp(storage);
      await user.click(screen.getByRole('button', { name: '歌詞を編集' }));
      fireEvent.change(easyTextarea(), {
        target: { value: 'hello\nworld2' },
      });

      await user.click(screen.getByRole('button', { name: 'テキスト入力' }));
      fireEvent.change(chordproTextarea(), {
        target: { value: '{title: t}\n\n[C]hello\n[G]world' },
      });
      await user.click(screen.getByRole('button', { name: 'かんたん入力' }));

      await user.click(
        screen.getByRole('button', { name: 'この下書きを使う' }),
      );
      expect(
        screen.queryByText('テキスト入力で歌詞が変更されました'),
      ).toBeNull();
      // The draft itself is untouched, applied knowingly.
      expect(easyTextarea()).toHaveValue('hello\nworld2');
      await user.click(screen.getByRole('button', { name: '反映' }));
      expect(currentStep()).toHaveTextContent('2');
      expect(screen.getByTestId('line-0-1')).toHaveTextContent('world2');
    });
  });

  describe('melody tab (M4 T17)', () => {
    const melodyStaff = () =>
      screen.getByRole('application', { name: 'セクション A のメロディ' });

    it('typing on the staff updates the text, switching tabs keeps it, and autosave still works', async () => {
      const storage = createMemoryStorage({ [draftKey('local')]: DRAFT });
      const { user } = renderApp(storage);
      await user.click(screen.getByRole('tab', { name: 'メロディ' }));

      const staff = melodyStaff();
      staff.focus();
      fireEvent.keyDown(staff, { code: 'KeyA' });
      fireEvent.keyDown(staff, { code: 'KeyS' });
      fireEvent.keyDown(staff, { code: 'KeyD' });

      // Switching tabs (melody → chart) keeps the updated text.
      await user.click(screen.getByRole('tab', { name: 'コード譜' }));
      await user.click(screen.getByRole('button', { name: 'テキスト入力' }));
      expect(textarea()).toHaveValue(
        `{title: きらきら星}
{key: C}

{start_of_verse: A}
きらきら[F]ひかる
{end_of_verse}

{start_of_part: Vocal}
\\section "A"
:4 C4 D4 E4 |
{end_of_part}
`,
      );

      // Autosave (debounced, flushed by pagehide here) still works.
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(savedDraft(storage).text).toContain('C4 D4 E4');
    });

    it('offers to switch to テキスト入力 for a read-only section', async () => {
      const storage = createMemoryStorage({
        [draftKey('local')]: `${DRAFT}
{start_of_part: Vocal}
\\section "A"
:4 (C4 E4) D4 |
{end_of_part}
`,
      });
      const { user } = renderApp(storage);
      await user.click(screen.getByRole('tab', { name: 'メロディ' }));
      await expect(
        screen.findByText(/アプリでは編集できません/),
      ).resolves.toBeVisible();

      await user.click(
        screen.getByRole('button', { name: 'テキスト入力で編集する' }),
      );
      expect(screen.getByRole('tab', { name: 'コード譜' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(textarea()).toBeVisible();
    });
  });

  describe('drums tab (M5 T22)', () => {
    const drumStaff = () =>
      screen.getByRole('application', { name: 'セクション A のドラム' });

    it('typing on the staff updates the text, switching tabs keeps it, and autosave still works', async () => {
      const storage = createMemoryStorage({ [draftKey('local')]: DRAFT });
      const { user } = renderApp(storage);
      await user.click(screen.getByRole('tab', { name: 'ドラム' }));

      const staff = drumStaff();
      staff.focus();
      // H = ハイハット, F = スネア, J = バスドラム: three 8分 beats.
      fireEvent.keyDown(staff, { code: 'KeyH' });
      fireEvent.keyDown(staff, { code: 'KeyF' });
      fireEvent.keyDown(staff, { code: 'KeyJ' });

      // Switching tabs (drums → chart) keeps the updated text.
      await user.click(screen.getByRole('tab', { name: 'コード譜' }));
      await user.click(screen.getByRole('button', { name: 'テキスト入力' }));
      const updated = (textarea() as HTMLTextAreaElement).value;
      expect(updated).toContain(
        '{start_of_part: Drums}\n\\instrument percussion',
      );
      expect(updated).toContain(':8 HH SD BD |');

      // Autosave (debounced, flushed by pagehide here) still works.
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(savedDraft(storage).text).toContain(':8 HH SD BD |');
    });

    it('offers to switch to テキスト入力 for a read-only section', async () => {
      const storage = createMemoryStorage({
        [draftKey('local')]: `${DRAFT}
{start_of_part: Drums}
\\instrument percussion
\\section "A"
:4 (HH HH) |
{end_of_part}
`,
      });
      const { user } = renderApp(storage);
      await user.click(screen.getByRole('tab', { name: 'ドラム' }));
      await expect(
        screen.findByText(/アプリでは編集できません/),
      ).resolves.toBeVisible();

      await user.click(
        screen.getByRole('button', { name: 'テキスト入力で編集する' }),
      );
      expect(screen.getByRole('tab', { name: 'コード譜' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(textarea()).toBeVisible();
    });
  });

  describe('a barMismatch section that crosses a NEW barline (m5-review.md R1)', () => {
    const MISMATCH = /拍子が変わったため小節が合いません/;
    const withPart = (time: string, part: string) =>
      `${DRAFT.replace('{key: C}', `{key: C}\n{time: ${time}}`)}${part}`;
    const drums = (body: string) =>
      `{start_of_part: Drums}\n\\instrument percussion\n\\section "A"\n${body}\n{end_of_part}\n`;
    const vocal = (body: string) =>
      `{start_of_part: Vocal}\n${body}\n{end_of_part}\n`;
    const TRIPLET_ACROSS =
      '\\section "A"\n:8 C4 :4 C4 C4 :8 C4{tu 3} C4{tu 3} C4{tu 3} :8 C4 |';

    async function expectNotice(tab: string, draft: string) {
      const storage = createMemoryStorage({ [draftKey('local')]: draft });
      const { user } = renderApp(storage);
      await user.click(screen.getByRole('tab', { name: tab }));
      expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
      const panel = screen.getByRole('tabpanel', { name: tab });
      expect(within(panel).getByText(MISMATCH)).toBeVisible();
      expect(within(panel).queryByTestId('editor-crash')).toBeNull();
    }

    it('drums in 3/4: `:2 SD SD |`', async () => {
      await expectNotice('ドラム', withPart('3/4', drums(':2 SD SD |')));
    });

    it('drums typed in テキスト入力 in 4/4: `:4 SD :2 SD SD |`', async () => {
      const { user } = renderApp(
        createMemoryStorage({ [draftKey('local')]: DRAFT }),
      );
      await user.click(screen.getByRole('button', { name: 'テキスト入力' }));
      fireEvent.change(textarea(), {
        target: { value: `${DRAFT}${drums(':4 SD :2 SD SD |')}` },
      });
      await user.click(screen.getByRole('tab', { name: 'ドラム' }));
      expect(
        within(screen.getByRole('tabpanel', { name: 'ドラム' })).getByText(
          MISMATCH,
        ),
      ).toBeVisible();
    });

    it('melody tuplet after a song time change to 3/4', async () => {
      await expectNotice('メロディ', withPart('3/4', vocal(TRIPLET_ACROSS)));
    });

    it('melody tuplet after a part \\ts 3 4', async () => {
      await expectNotice(
        'メロディ',
        withPart('4/4', vocal(`\\ts 3 4\n${TRIPLET_ACROSS}`)),
      );
    });
  });

  it('has instrument tabs with arrow-key navigation', async () => {
    const { user } = renderApp();
    const chart = screen.getByRole('tab', { name: 'コード譜' });
    expect(chart).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'コード譜' })).toBeVisible();

    chart.focus();
    await user.keyboard('{ArrowRight}');
    const melody = screen.getByRole('tab', { name: 'メロディ' });
    expect(melody).toHaveFocus();
    expect(melody).toHaveAttribute('aria-selected', 'true');
    expect(
      within(screen.getByRole('tabpanel', { name: 'メロディ' })).getByTestId(
        'melody-staff-svg',
      ),
    ).toBeVisible();

    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'ドラム' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(chart).toHaveFocus();
    expect(chart).toHaveAttribute('aria-selected', 'true');
  });

  describe('viewer mode (controlled by the caller)', () => {
    const viewButton = () => screen.getByRole('button', { name: '閲覧モード' });

    it('asks the caller to enter / exit the viewer and shows the custom back label', async () => {
      const onEnterView = vi.fn();
      const onExitView = vi.fn();
      const storage = createMemoryStorage({ [draftKey('local')]: DRAFT });
      const user = userEvent.setup();
      const { rerender } = render(
        <App
          storage={storage}
          viewing={false}
          onEnterView={onEnterView}
          onExitView={onExitView}
          viewBackLabel="‹ 曲の一覧"
        />,
      );
      await user.click(viewButton());
      expect(onEnterView).toHaveBeenCalledTimes(1);
      // Controlled: nothing changes until the caller says so.
      expect(
        screen.queryByRole('button', { name: /曲の一覧/ }),
      ).not.toBeInTheDocument();
      rerender(
        <App
          storage={storage}
          viewing
          onEnterView={onEnterView}
          onExitView={onExitView}
          viewBackLabel="‹ 曲の一覧"
        />,
      );
      await user.click(
        await screen.findByRole('button', { name: '‹ 曲の一覧' }),
      );
      expect(onExitView).toHaveBeenCalledTimes(1);
      expect(document.title).toBe('きらきら星 - 閲覧 - band-sheets');
      rerender(
        <App storage={storage} viewing={false} onExitView={onExitView} />,
      );
      expect(document.title).toBe('きらきら星 - band-sheets');
    });

    it('can open directly in the viewer', async () => {
      render(
        <App
          storage={createMemoryStorage()}
          initialText={DRAFT}
          viewing
          viewBackLabel="‹ 曲の一覧"
        />,
      );
      expect(
        await screen.findByRole('button', { name: '‹ 曲の一覧' }),
      ).toBeInTheDocument();
      expect(document.title).toBe('きらきら星 - 閲覧 - band-sheets');
    });

    it('exits via the viewer button after entering from the editor', async () => {
      const { user } = renderApp(
        createMemoryStorage({ [draftKey('local')]: DRAFT }),
      );
      await user.click(viewButton());
      await user.click(
        await screen.findByRole('button', { name: /編集に戻る/ }),
      );
      await waitFor(() => expect(viewButton()).toBeVisible());
    });

    it('keeps editor state across a view round trip and does not leak keys to the editor', async () => {
      const { user } = renderApp(
        createMemoryStorage({ [draftKey('local')]: DRAFT }),
      );
      await user.click(screen.getByRole('button', { name: 'テキスト入力' }));
      await user.click(textarea());
      await user.keyboard('X');
      const typed = (textarea() as HTMLTextAreaElement).value;
      expect(typed).toContain('X');

      await user.click(viewButton());
      await screen.findByRole('button', { name: /編集に戻る/ });
      // Editors are hidden, not unmounted; keys go to the viewer only.
      expect(textarea()).toBeInTheDocument();
      expect(textarea()).not.toBeVisible();
      await user.keyboard('{PageDown}{Space}Y');
      expect((textarea() as HTMLTextAreaElement).value).toBe(typed);

      await user.click(screen.getByRole('button', { name: /編集に戻る/ }));
      await waitFor(() => expect(textarea()).toBeVisible());
      expect((textarea() as HTMLTextAreaElement).value).toBe(typed);
    });

    it('keeps the EasyEditor step-1 draft across a view round trip', async () => {
      const { user } = renderApp();
      await user.type(screen.getByLabelText('歌詞を貼り付け'), 'ひかる');
      await user.click(viewButton());
      await user.click(
        await screen.findByRole('button', { name: /編集に戻る/ }),
      );
      await waitFor(() => expect(viewButton()).toBeVisible());
      expect(screen.getByLabelText('歌詞を貼り付け')).toHaveValue('ひかる');
    });
  });

  describe('as a one-song editor (M7)', () => {
    it('opens with initialText (ignoring the stored draft) and reports edits', async () => {
      const storage = createMemoryStorage({ [draftKey('s1')]: 'OLD' });
      const onTextChange = vi.fn();
      const { user } = renderApp(storage, {
        songId: 's1',
        initialText: DRAFT,
        baseVersion: '7',
        onTextChange,
      });
      expect(
        screen.getByRole('heading', { level: 1, name: 'きらきら星' }),
      ).toBeInTheDocument();
      expect(onTextChange).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'テキスト入力' }));
      await user.type(textarea(), 'X');
      expect(onTextChange).toHaveBeenLastCalledWith(DRAFT + 'X');
    });

    it('reports an edit back to the opened text (not only diverged text)', async () => {
      const onTextChange = vi.fn();
      const { user } = renderApp(createMemoryStorage(), {
        songId: 's1',
        initialText: DRAFT,
        baseVersion: '7',
        onTextChange,
      });
      await user.click(screen.getByRole('button', { name: 'テキスト入力' }));
      await user.type(textarea(), 'X');
      expect(onTextChange).toHaveBeenLastCalledWith(DRAFT + 'X');
      await user.type(textarea(), '{Backspace}');
      expect(onTextChange).toHaveBeenLastCalledWith(DRAFT);
    });

    it('autosaves a draft record with baseVersion under songId', async () => {
      const storage = createMemoryStorage();
      const { user } = renderApp(storage, {
        songId: 's1',
        initialText: DRAFT,
        baseVersion: '7',
      });
      await user.click(screen.getByRole('button', { name: 'テキスト入力' }));
      await user.type(textarea(), 'X');
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(savedDraft(storage, 's1')).toMatchObject({
        v: 1,
        text: DRAFT + 'X',
        baseVersion: '7',
      });
      expect(storage.getItem(draftKey('local'))).toBeNull();
    });

    it('does not write a draft when nothing was edited', () => {
      const storage = createMemoryStorage();
      renderApp(storage, { songId: 's1', initialText: DRAFT });
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(storage.getItem(draftKey('s1'))).toBeNull();
    });

    it('renders the header slots', () => {
      renderApp(createMemoryStorage(), {
        headerStart: <button type="button">‹ 曲の一覧</button>,
        headerEnd: <span>保存済み</span>,
      });
      expect(
        screen.getByRole('button', { name: '‹ 曲の一覧' }),
      ).toBeInTheDocument();
      expect(screen.getByText('保存済み')).toBeInTheDocument();
    });
  });
});
