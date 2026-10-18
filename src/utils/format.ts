/** 秒を "MM:SS" / "H:MM:SS" 形式に変換する。withFraction で 1/100 秒まで表示 */
export function formatTime(seconds: number, withFraction = false): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const totalCs = Math.floor(safe * 100)
  const cs = totalCs % 100
  const totalSec = Math.floor(totalCs / 100)
  const s = totalSec % 60
  const m = Math.floor(totalSec / 60) % 60
  const h = Math.floor(totalSec / 3600)
  const pad = (n: number) => n.toString().padStart(2, '0')
  const base = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
  return withFraction ? `${base}.${pad(cs)}` : base
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

export function formatHz(hz: number): string {
  return `${(hz / 1000).toLocaleString('ja-JP', { maximumFractionDigits: 3 })} kHz`
}

export function formatChannels(channels: number): string {
  if (channels === 1) return '1 ch（モノラル）'
  if (channels === 2) return '2 ch（ステレオ）'
  return `${channels} ch`
}

export function gainToDb(gain: number): number {
  return gain > 0 ? 20 * Math.log10(gain) : -Infinity
}

export function formatDb(db: number): string {
  if (!Number.isFinite(db)) return '-∞ dB'
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`
}
