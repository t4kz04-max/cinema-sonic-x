import type { AudioSource } from '../types/audio'

/**
 * 公式デモ音源（Spatial Showcase）の定義。React 非依存の定数と純粋関数だけを置く。
 *
 * 音源は public/audio/ の静的ファイルで、利用者がボタンを押したときだけ同じサイトから取得する
 * （初回の表示で大きな WAV を読み込まない）。取得は「受け取る」だけで、利用者の音声をどこかへ送ることはない。
 */

export type DemoId = 'spatial-showcase'

/** 区間（秒）。音源は分割せず 1 つのまま持ち、区間は再生位置の目安としてだけ使う */
export interface DemoSection {
  id: string
  label: string
  start: number
  end: number
  /** 聴きどころ（SIMPLE / STUDIO で共通の UI の文言） */
  focus: string
}

export interface DemoTrack {
  id: DemoId
  title: string
  /** 同じオリジンの静的ファイル（Vite の public/ → dist/ のルート） */
  url: string
  /** 読み込んだときのファイル名（拡張子で形式を判定するため .wav にする。書き出しのファイル名の元にもなる） */
  fileName: string
  /** 取得前に表示する目安（バイト）。実際の大きさは応答で決まる */
  approxBytes: number
  /** 期待する長さ（秒）。区間はこの長さを前提にしているため、読み込んだ音源の長さが違えば失敗として扱う */
  durationSeconds: number
  description: string
  sections: readonly DemoSection[]
}

export const SPATIAL_SHOWCASE: DemoTrack = Object.freeze({
  id: 'spatial-showcase',
  title: 'Spatial Showcase',
  url: '/audio/spatial-showcase.wav',
  fileName: 'CINEMA_SONIC_X_Spatial_Showcase_40s_24bit.wav',
  approxBytes: 11_520_044,
  durationSeconds: 40,
  description: 'CINEMA SONIC X のオリジナル電子音楽（40 秒・ステレオ・48 kHz・24-bit WAV）',
  sections: Object.freeze([
    { id: 'intro', label: 'Intro', start: 0, end: 4, focus: '前方の定位・奥行き' },
    { id: 'groove', label: 'Groove', start: 4, end: 12, focus: '低域・CENTER LOCK' },
    { id: 'main', label: 'Main', start: 12, end: 28, focus: '360° MOTION・没入感' },
    { id: 'space', label: 'Space', start: 28, end: 36, focus: '広がり・残響' },
    { id: 'outro', label: 'Outro', start: 36, end: 40, focus: '余韻・減衰' },
  ]),
})

export const DEMO_TRACKS: Readonly<Record<DemoId, DemoTrack>> = Object.freeze({ 'spatial-showcase': SPATIAL_SHOWCASE })

export const getDemo = (id: DemoId): DemoTrack => DEMO_TRACKS[id]

/** 長さの許容差（秒）。デコードはサンプル単位なので、40 秒の音源なら差は 1 サンプル未満 */
export const DEMO_DURATION_TOLERANCE = 0.05

/**
 * 再生位置（秒）が含まれる区間の番号。各区間は [start, end)、最後の区間だけ終わり（= 音源の終わり）を含む。
 * 範囲の外（負・最後の区間より後）は -1
 */
export function sectionIndexAt(sections: readonly DemoSection[], seconds: number): number {
  if (!Number.isFinite(seconds)) return -1
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]
    const last = i === sections.length - 1
    if (seconds >= s.start && (seconds < s.end || (last && seconds <= s.end))) return i
  }
  return -1
}

/** 区間が隙間・重なりなく 0 秒から音源の長さまでを覆っているか（自己確認用） */
export function sectionsCover(sections: readonly DemoSection[], duration: number): boolean {
  if (sections.length === 0 || sections[0].start !== 0) return false
  for (let i = 1; i < sections.length; i++) if (sections[i].start !== sections[i - 1].end) return false
  return sections.every((s) => s.end > s.start) && Math.abs(sections[sections.length - 1].end - duration) < 1e-9
}

/** 音源の出どころが公式デモ音源ならその定義（アップロードしたファイルは null。ファイル名では判定しない） */
export function demoOfSource(source: AudioSource | null | undefined): DemoTrack | null {
  return source?.kind === 'demo' ? getDemo(source.demoId) : null
}
