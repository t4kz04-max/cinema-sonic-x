// 処理計画のキャッシュ（同じ音源・同じ設定なら解析し直さない）。古いものから捨てる（LRU）。
// 解析 1 回ごとに Chrome が解放しない OfflineAudioContext が残るため、同じ設定の再解析を避けることがメモリ対策になる。

export class PlanCache<T> {
  private readonly map = new Map<string, T>()
  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  get size(): number {
    return this.map.size
  }

  get(key: string): T | undefined {
    const v = this.map.get(key)
    if (v !== undefined) {
      // 最近使ったものを末尾へ
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }

  set(key: string, value: T): void {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value!)
  }

  clear(): void {
    this.map.clear()
  }
}
