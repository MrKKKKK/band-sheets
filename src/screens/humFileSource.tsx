import type { Ref } from 'react';
import {
  AudioFileField,
  type PickedFile,
} from '../components/AudioFileField/AudioFileField';
import type { HumSource } from '../components/HumSetup/HumSetup';

/** S2's source when the singing comes from a picked recording file. */
export function fileHumSource({
  pickedFile,
  onPick,
  inputRef,
  tempo,
  beats,
}: {
  pickedFile: PickedFile | null;
  onPick: (file: File) => void;
  inputRef: Ref<HTMLInputElement> & { current: HTMLInputElement | null };
  /** The steps name the song's tempo and the count-in length. */
  tempo: number;
  beats: number;
}): HumSource {
  return {
    field: (
      <AudioFileField
        file={pickedFile}
        onPick={onPick}
        inputRef={inputRef}
        hint="wav・mp3・m4a など、ブラウザで開ける形式。10 分まで。"
      />
    ),
    ready: !!pickedFile && !pickedFile.probing,
    summaryLabel: 'ファイル',
    summary: pickedFile ? pickedFile.name : 'まだ選んでいません',
    startLabel: '解析する',
    startNote:
      'ふつうは 1 小節目の 1 拍目のままで大丈夫です。曲が途中から始まるとき（たとえば 4 拍目から歌い始める）は、そこに合わせてください。録音の中で歌い始めた時間は、自動で見つけます。',
    hint: pickedFile
      ? '数秒かかります。'
      : '先に録音ファイルを選んでください。',
    retake: {
      label: '別のファイルを選ぶ',
      onClick: () => inputRef.current?.click(),
    },
    how: (
      <>
        <li>
          <strong>ヘッドホンをつけます。</strong>
          クリック（メトロノーム）の音が、マイクに入らないようにするためです。
        </li>
        <li>
          録音アプリで録音を始め、曲のテンポ（♩= {tempo}）で
          <strong>クリックを鳴らします</strong>。
        </li>
        <li>
          <strong>1 小節（{beats} 拍）数えてから</strong>
          歌い始めます。最初の数えの 1 小節は、小節の数に入れません。
        </li>
        <li>
          「ラ」や「ん〜」で、1
          つの音をはっきり歌います。録れたファイルを上で選んでください。
        </li>
      </>
    ),
  };
}
