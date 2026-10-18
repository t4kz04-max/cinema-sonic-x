// 空間音響プロトタイプのモード定義と、UI パラメーター（0〜100）→ DSP 値の対応。
// 各モードで 4 つのパラメーターが何を変えるかを、UI に表示する説明文と一緒にここで定義する。

export type SpatialMode = 'off' | 'wide' | 'cinema' | 'hall'
export type ActiveSpatialMode = Exclude<SpatialMode, 'off'>

/** UI パラメーター（すべて 0〜100） */
export interface SpatialParams {
  mode: SpatialMode
  intensity: number
  roomSize: number
  depth: number
  /** 100 = 処理音のみ、0 = 原音のみ */
  wetDry: number
}

export const DEFAULT_SPATIAL_PARAMS: SpatialParams = {
  mode: 'wide',
  intensity: 60,
  roomSize: 50,
  depth: 40,
  wetDry: 100,
}

const u = (v: number) => Math.min(Math.max(v / 100, 0), 1)
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
/** 対数補間（周波数用） */
const lerpLog = (a: number, b: number, t: number) => a * Math.pow(b / a, t)

// ---------------- WIDE ----------------

/** Side 高域を持ち上げるハイシェルフの周波数（これより下の Side はほぼそのまま） */
export const WIDE_SHELF_HZ = 500
export const WIDE_AMBIENCE_HIGHPASS_HZ = 700
/**
 * Side ゲインによる Side/Mid 比の上限（dB）。擬似アンビエンスが加える Side 成分（約 +1 dB）を見込んで、
 * 最終的な S/M 比が約 -3.5 dB（位相相関 約 +0.38）を超えないようにする。
 * 原音の中高域の幅から Side ゲインの上限を決める（すでに広い音源はあまり広げない）
 */
export const WIDE_MAX_SIDE_TO_MID_DB = -4.5
export const WIDE_MAX_SIDE_GAIN_DB = 9

/** 原音の幅（中域・高域の S/M 比の大きい方）から Side ゲインの上限を求める */
export function wideSideCapDb(sourceWidthDb: number | null): number {
  if (sourceWidthDb === null || !Number.isFinite(sourceWidthDb)) return WIDE_MAX_SIDE_GAIN_DB
  return Math.min(Math.max(WIDE_MAX_SIDE_TO_MID_DB - sourceWidthDb, 0), WIDE_MAX_SIDE_GAIN_DB)
}

export interface WideSettings {
  /** Side 高域（ハイシェルフ）のゲイン（dB） */
  sideHighGainDb: number
  /** Mid から Side へ注入する擬似アンビエンスの遅延（ms）2 タップ */
  ambienceDelaysMs: [number, number]
  /** 擬似アンビエンスの量（linear、Side に加算。モノラル和では完全に打ち消される） */
  ambienceGain: number
}

export function wideSettings(p: SpatialParams, sideCapDb = WIDE_MAX_SIDE_GAIN_DB): WideSettings {
  const r = u(p.roomSize)
  return {
    // INTENSITY は上限（原音の幅に応じた安全な範囲）に対する割合
    sideHighGainDb: sideCapDb * u(p.intensity),
    ambienceDelaysMs: [lerp(7, 25, r), lerp(11, 37, r)],
    ambienceGain: 0.3 * u(p.depth),
  }
}

// ---------------- CINEMA ----------------

export interface Reflection {
  name: string
  /** 仮想スピーカー側（左 = -1 / 右 = +1）を基準にした到来方向。azSign: 1 = 同じ側, -1 = 反対側 */
  azimuthDeg: number
  azSign: 1 | -1
  elevationDeg: number
  /** 直接音からの遅れ（ms、部屋サイズ 1.0 のとき） */
  baseDelayMs: number
  gain: number
  /** 壁の吸音を模したローパス */
  lowpassHz: number
}

/**
 * ブラウザ内蔵 HRTF の音色補正（±30° の両耳パワー平均の逆特性を約 7 割だけ補正）。
 * Chrome/Edge の HRTF は 200 Hz 付近 +4 dB、1.25 kHz 付近 -6 dB、8 kHz 付近 -10 dB の傾向がある（実測）
 */
export const CINEMA_TIMBRE_EQ: { type: BiquadFilterType; frequency: number; q?: number; gainDb: number }[] = [
  { type: 'lowshelf', frequency: 300, gainDb: -3 },
  { type: 'peaking', frequency: 1250, q: 1.3, gainDb: 4.5 },
  { type: 'highshelf', frequency: 6500, gainDb: 6 },
]

export const CINEMA_REFLECTIONS: Reflection[] = [
  { name: '床', azimuthDeg: 0, azSign: 1, elevationDeg: -25, baseDelayMs: 2.2, gain: 0.55, lowpassHz: 7000 },
  { name: '天井', azimuthDeg: 0, azSign: 1, elevationDeg: 35, baseDelayMs: 4.8, gain: 0.4, lowpassHz: 6000 },
  { name: '近い側壁', azimuthDeg: 75, azSign: 1, elevationDeg: 0, baseDelayMs: 6.5, gain: 0.5, lowpassHz: 8000 },
  { name: '遠い側壁', azimuthDeg: 65, azSign: -1, elevationDeg: 0, baseDelayMs: 11.5, gain: 0.35, lowpassHz: 6000 },
  { name: '後壁', azimuthDeg: 150, azSign: 1, elevationDeg: 10, baseDelayMs: 19, gain: 0.3, lowpassHz: 4500 },
]

export interface CinemaSettings {
  /** 仮想スピーカーの開き角（±deg） */
  speakerAngleDeg: number
  /** 初期反射全体のレベル（linear） */
  reflectionLevel: number
  /** 反射遅延の倍率（部屋の大きさ） */
  roomScale: number
  /** 仮想スピーカーまでの距離（m） */
  distanceM: number
  /** 直接音のゲイン（基準距離 1.5 m に対する逆二乗則の振幅） */
  directGain: number
  /** 空気吸収を模した直接音のローパス（Hz） */
  airLowpassHz: number
  /** 遠いほど直接音と反射音の到達時間差（ITDG）が縮むことを模した反射遅延の倍率（1 = 縮まない） */
  itdgScale: number
}

export function cinemaSettings(p: SpatialParams): CinemaSettings {
  const d = u(p.depth)
  const distanceM = lerp(1.5, 6, d)
  return {
    speakerAngleDeg: lerp(20, 45, u(p.intensity)),
    reflectionLevel: lerp(0.2, 0.8, u(p.intensity)),
    roomScale: lerp(0.6, 1.6, u(p.roomSize)),
    distanceM,
    directGain: 1.5 / distanceM,
    airLowpassHz: lerpLog(20000, 8000, d),
    itdgScale: lerp(1, 0.6, d),
  }
}

// ---------------- HALL ----------------

/** 残響に送る帯域（低域の濁りと高域のざらつきを避ける） */
export const HALL_SEND_HIGHPASS_HZ = 180
export const HALL_SEND_LOWPASS_HZ = 9000
/** 初期反射タップの基準遅延（ms、部屋サイズ倍率 1.0） */
export const HALL_ER_TAPS_MS = [9, 14, 21, 27, 34, 43, 52, 64]

export interface HallSettings {
  /** 後期残響の残響時間 RT60（秒） */
  rt60: number
  /** 初期反射の遅延倍率 */
  erScale: number
  /** 後期残響の開始までのプリディレイ（ms） */
  preDelayMs: number
  /** 初期反射の合計レベル（linear） */
  erGain: number
  /** 後期残響のレベル（dB、IR はエネルギー 1 に正規化） */
  lateGainDb: number
  /** 直接音のレベル（dB）。遠いほど下がる */
  directGainDb: number
  /** 直接音の高域減衰（Hz） */
  directLowpassHz: number
}

export function hallSettings(p: SpatialParams): HallSettings {
  const r = u(p.roomSize)
  const d = u(p.depth)
  const i = u(p.intensity)
  return {
    rt60: lerp(0.9, 3.2, r),
    erScale: lerp(0.6, 1.6, r),
    preDelayMs: lerp(12, 40, r) * (1 - 0.6 * d),
    erGain: lerp(0.25, 0.8, i),
    lateGainDb: lerp(-20, -6, i),
    directGainDb: -9 * d,
    directLowpassHz: lerpLog(20000, 7000, d),
  }
}

// ---------------- UI 説明 ----------------

export type SpatialParamKey = 'intensity' | 'roomSize' | 'depth' | 'wetDry'

export interface ModeDoc {
  label: string
  summary: string
  /** 処理内容（信号経路）の説明 */
  processing: string[]
  params: Record<SpatialParamKey, string>
  caveats: string[]
}

export const MODE_DOCS: Record<ActiveSpatialMode, ModeDoc> = {
  wide: {
    label: 'WIDE',
    summary: 'Mid/Side 処理でステレオ音場を広げる。中央定位・低域・モノラル和は変えない',
    processing: [
      'L/R → Mid=(L+R)/2・Side=(L−R)/2 に変換',
      `Side にだけ ${WIDE_SHELF_HZ} Hz のハイシェルフを掛けて中高域を広げる（低域の Side と Mid はそのまま）`,
      `Side ゲインの上限は原音の幅から自動決定（S/M 比 ${WIDE_MAX_SIDE_TO_MID_DB} dB まで＝位相相関 約 +0.38 以上を保つ）`,
      `Mid の ${WIDE_AMBIENCE_HIGHPASS_HZ} Hz 以上を 2 タップ遅延して逆相で Side にのみ加える（擬似アンビエンス）`,
      'L=Mid+Side・R=Mid−Side に戻す（Side に加えた成分はモノラル和で完全に打ち消される）',
    ],
    params: {
      intensity: 'Side 高域のゲイン 0〜上限（上限は原音の幅から自動で決定、最大 +9 dB）',
      roomSize: '擬似アンビエンスの遅延 7〜37 ms（広がりの質感）',
      depth: '擬似アンビエンスの量 0〜0.3（奥行き感）',
      wetDry: '処理音と原音の比率',
    },
    caveats: [
      'もともとモノラルに近い音源（Side が少ない）では Side ゲインの効果が小さい',
      '擬似アンビエンスは各チャンネル単体ではコムフィルター状の色付けを生む（モノラル和では消える）',
    ],
  },
  cinema: {
    label: 'CINEMA',
    summary: 'HRTF で左右の音を前方の仮想スピーカーとして再生し、部屋の初期反射を加える（ヘッドホン向け）',
    processing: [
      'HRTF の音色の癖を補正 EQ（低域 -3 dB / 1.25 kHz +4.5 dB / 6.5 kHz 以上 +6 dB）で部分的に打ち消す',
      'L・R をそれぞれ HRTF（PannerNode）で前方 ±20〜45° の仮想スピーカーに配置。反対側の耳へ届く成分（両耳間の時間差・レベル差）が自然なクロスフィードになる',
      '各スピーカーにつき 5 つの初期反射（床・天井・近い側壁・遠い側壁・後壁）を、遅延・吸音ローパス付きで反射方向の HRTF に配置',
      '距離（DEPTH）は直接音のレベル・空気吸収・直接音と反射音の時間差で表現',
    ],
    params: {
      intensity: 'スピーカーの開き角 ±20〜45° と初期反射の量',
      roomSize: '初期反射の遅延（部屋の大きさ）0.6〜1.6 倍',
      depth: '仮想スピーカーまでの距離 1.5〜6 m',
      wetDry: '処理音と原音の比率（中間値は HRTF の位相差によるコムフィルターが出やすい）',
    },
    caveats: [
      'HRTF はブラウザ内蔵の汎用データ（個人の耳の形に合わせていない）。前方定位は人によって成立しない（頭の中・後方に聞こえる）場合がある',
      'ヘッドホン再生が前提。スピーカー再生ではクロストークにより効果が成立しない',
      'HRTF のフィルタリングで音色が変わる（補正は部分的。測定値を参照）',
      'バイノーラル信号をモノラルに混ぜると両耳間時間差による大きなくし形の欠けが出る（モノラル互換性は低い）',
    ],
  },
  hall: {
    label: 'HALL',
    summary: '直接音・初期反射・後期残響を分けて処理し、広い会場の響きを作る',
    processing: [
      `直接音: DEPTH に応じてレベルと高域を下げる（遠い席）`,
      `残響への送り: ${HALL_SEND_HIGHPASS_HZ} Hz〜${HALL_SEND_LOWPASS_HZ / 1000} kHz に帯域制限（低域の濁り防止）`,
      '初期反射: 左右それぞれ 8 タップの遅延（9〜64 ms × 部屋サイズ）を左右交互に配置',
      '後期残響: 合成インパルス応答（左右無相関のノイズ、高域ほど早く減衰）との畳み込み。プリディレイ付き',
    ],
    params: {
      intensity: '初期反射と後期残響の量（空間の濃さ）',
      roomSize: '残響時間 RT60 0.9〜3.2 秒・反射の間隔・プリディレイ',
      depth: '客席の距離（直接音 0〜−9 dB、高域減衰、プリディレイ短縮）',
      wetDry: '処理音と原音の比率',
    },
    caveats: [
      '残響は合成インパルス応答で、実在のホールの測定データではない',
      'ROOM SIZE の変更時はインパルス応答を再生成し、クロスフェードで切り替える',
    ],
  },
}
