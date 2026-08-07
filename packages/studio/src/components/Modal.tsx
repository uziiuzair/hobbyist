import type { ReactNode } from 'react'
import { useCallback, useEffect, useRef } from 'react'

// Forms live in modals, always. An inline form pushes the page around as it
// opens and closes, which loses the reader's place, and it competes with the
// content it sits inside instead of taking the one decision being made.

export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  labelledBy = 'modal-title',
}: {
  title: string
  description?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  labelledBy?: string
}) {
  const panel = useRef<HTMLDivElement>(null)
  const restoreTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // Focus the first thing worth typing into, not the dialog container, so a
    // keyboard user is already where they need to be.
    const focusable = panel.current?.querySelector<HTMLElement>(
      'input, textarea, select, button:not([data-autofocus="false"])',
    )
    focusable?.focus()

    return () => {
      document.body.style.overflow = previousOverflow
      restoreTo.current?.focus?.()
    }
  }, [])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      // Keep Tab inside the dialog. Without this the focus ring walks off into
      // the page behind, which for a destructive confirmation means the user
      // can be typing somewhere they cannot see.
      const nodes = panel.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])',
      )
      if (nodes === undefined || nodes.length === 0) return
      const list = Array.from(nodes)
      const first = list[0]
      const last = list[list.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    },
    [onClose],
  )

  return (
    <div
      className="modal-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        ref={panel}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          <h2 className="modal-title" id={labelledBy}>
            {title}
          </h2>
          {description !== undefined && <p className="modal-desc">{description}</p>}
        </div>
        <div className="modal-body">{children}</div>
        {footer !== undefined && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}
