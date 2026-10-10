export interface DriveFileMeta {
  id: string;
  name: string;
  /** Drive の version（数字の文字列）。比較は文字列の一致だけ */
  version: string;
  modifiedTime: string; // RFC 3339
  appProperties?: Record<string, string>;
}

export interface BaseRecord {
  fileId: string;
  version: string;
  modifiedTime: string;
  device?: string;
  text: string;
}

export interface DraftRecord {
  v: 1;
  text: string;
  /** 編集を始めたときの base.version。Drive に無い曲は null */
  baseVersion: string | null;
  savedAt: string; // ISO
}

export type SongStatus = 'synced' | 'dirty' | 'driveNewer' | 'localOnly';

export interface SongEntry {
  songId: string;
  fileId?: string; // 無ければこの端末だけ
  title: string;
  /** 「C ・ ♩=100 ・ 4/4」。本文を読んでいなければ '' */
  summary: string;
  /** 「コード譜・メロディ・ドラム」。本文を読んでいなければ '' */
  parts: string;
  modifiedTime?: string; // Drive の更新時刻（この端末だけの曲は下書きの時刻）
  device?: string; // 最後に保存した端末
  version?: string; // Drive の今の版（一覧を取ったとき）
}

export interface SongIndex {
  v: 1;
  folderId?: string;
  listedAt?: string;
  songs: SongEntry[];
}

export type SortOrder = 'modified' | 'title';

export type SaveState =
  | { kind: 'saved'; at: string }
  /** 前回読み込んだ版のまま（期限切れ・オフラインで Drive の最新か未確認） */
  | { kind: 'unconfirmed'; at: string }
  | { kind: 'dirty'; draftAt: string }
  | { kind: 'saving' }
  | { kind: 'failed'; reason: 'network' | 'auth' | 'other' }
  | { kind: 'localOnly'; draftAt?: string }; // ログインしていない／Drive に無い

export type OpenDecision =
  | { kind: 'drive' } // A
  | { kind: 'askResume' } // B
  | { kind: 'driveNewer' } // C
  | { kind: 'draftOnly' } // Drive に無い曲
  | { kind: 'unavailable' }; // オフラインで base も下書きも無い

export type ConflictChoice = 'overwrite' | 'reloadKeepCopy' | 'reloadDiscard';

export type DriveErrorKind =
  'auth' | 'notFound' | 'rateLimit' | 'network' | 'server' | 'other';
