import type { CSSProperties } from 'react'

interface RangeControlProps {
  id: string
  min: number
  max: number
  step: number
  value: number
  disabled?: boolean
  ariaLabel: string
  ariaValueText?: string
  className?: string
  onChange?: (value: number) => void
  /** ドラッグ終了・キー操作終了時に呼ばれる */
  onCommit?: () => void
}

export function RangeControl({
  id,
  min,
  max,
  step,
  value,
  disabled,
  ariaLabel,
  ariaValueText,
  className,
  onChange,
  onCommit,
}: RangeControlProps) {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <input
      id={id}
      type="range"
      className={`range ${className ?? ''}`}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-valuetext={ariaValueText}
      style={{ '--fill': `${fill}%` } as CSSProperties}
      onChange={(e) => onChange?.(Number(e.target.value))}
      onPointerUp={onCommit}
      onKeyUp={onCommit}
    />
  )
}
