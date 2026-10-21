import type { ReactNode } from 'react'

interface PanelProps {
  /** 機器パネル風の番号ラベル（例: "01"） */
  index: string
  label: string
  title: string
  aside?: ReactNode
  className?: string
  /** STUDIO MODE のセクションへのリンク先 */
  id?: string
  children: ReactNode
}

export function Panel({ index, label, title, aside, className, id, children }: PanelProps) {
  return (
    <section className={`panel ${className ?? ''}`} aria-label={title} id={id}>
      <header className="panel__head">
        <div className="panel__heading">
          <span className="panel__index">{index}</span>
          <span className="panel__label">{label}</span>
          <h2 className="panel__title">{title}</h2>
        </div>
        {aside && <div className="panel__aside">{aside}</div>}
      </header>
      <div className="panel__body">{children}</div>
    </section>
  )
}

interface BadgeProps {
  tone: 'live' | 'pending' | 'locked' | 'idle'
  children: ReactNode
}

export function Badge({ tone, children }: BadgeProps) {
  return <span className={`badge badge--${tone}`}>{children}</span>
}
