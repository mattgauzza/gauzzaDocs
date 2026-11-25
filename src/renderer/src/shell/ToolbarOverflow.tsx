import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './icons'

/**
 * Makes every `.toolbar` in the app (doc, sheet, PDF) behave like Google Docs when the window is narrow: the tools
 * that don't fit are hidden and a "more" button appears at the right end; clicking it lets the toolbar wrap onto a
 * second row with everything. Works on the DOM the editors already render (data attributes React leaves alone), so
 * the editors need no changes. Re-measures on resize (ResizeObserver) and picks up toolbars as editors mount.
 */
interface Btn { el: HTMLElement; top: number; left: number; expanded: boolean }
const MORE = 40 // room kept for the button

export function ToolbarOverflow() {
  const [btns, setBtns] = useState<Btn[]>([])

  useEffect(() => {
    const seen = new WeakSet<HTMLElement>()
    let raf = 0
    const ro = new ResizeObserver(() => schedule())
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(update)
    }
    const update = () => {
      const out: Btn[] = []
      for (const el of document.querySelectorAll<HTMLElement>('.toolbar')) {
        if (!seen.has(el)) {
          seen.add(el)
          ro.observe(el)
        }
        if (!el.offsetParent) continue // in a hidden tab
        const kids = [...el.children] as HTMLElement[]
        const expanded = el.hasAttribute('data-expanded')
        for (const k of kids) k.removeAttribute('data-tb-hidden')
        el.removeAttribute('data-tb-overflow')
        // Only act when the tools really don't fit. A stretchy spacer makes the last tool touch the right edge even
        // when everything fits, so compare the content width, not item positions.
        const tooWide = el.scrollWidth > el.clientWidth + 1
        if (tooWide && !expanded) el.setAttribute('data-tb-overflow', '') // reserves room for the button
        let cut = -1
        if (tooWide && !expanded) {
          // Hide tools from the right until the row fits, but never the pinned ones (the Edit/Read/Split/Source
          // switch and anything marked data-tb-keep): those matter more than the last formatting buttons.
          const pinned = (k: HTMLElement) => k.classList.contains('tb-extra') || k.hasAttribute('data-tb-keep')
          for (let i = kids.length - 1; i >= 0 && el.scrollWidth > el.clientWidth + 1; i--) {
            if (pinned(kids[i])) continue
            kids[i].setAttribute('data-tb-hidden', '')
            cut = i
          }
          // A separator left dangling before the hidden run goes too.
          for (let i = kids.length - 1; i > 0; i--) {
            if (kids[i].hasAttribute('data-tb-hidden') && !kids[i - 1].hasAttribute('data-tb-hidden') && kids[i - 1].classList.contains('tb-sep')) {
              kids[i - 1].setAttribute('data-tb-hidden', '')
              break
            }
          }
        }
        const overflowing = expanded || cut >= 0
        el.toggleAttribute('data-tb-overflow', overflowing)
        if (expanded && !fitsInOneRow(el)) {
          /* stays expanded */
        } else if (expanded) {
          el.removeAttribute('data-expanded') // the window grew back: one row again
          schedule()
          continue
        }
        if (overflowing) {
          const b = el.getBoundingClientRect()
          out.push({ el, top: b.top + 4, left: b.right - MORE + 2, expanded })
        }
      }
      setBtns(prev => (same(prev, out) ? prev : out))
    }
    // Editors mount lazily and tabs switch; a light poll finds new toolbars and catches content changes.
    const iv = window.setInterval(schedule, 800)
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      window.clearInterval(iv)
      window.removeEventListener('resize', schedule)
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return createPortal(
    <>
      {btns.map((b, i) => (
        <button
          key={i}
          className={`tb tb-more${b.expanded ? ' on' : ''}`}
          style={{ position: 'fixed', top: b.top, left: b.left, zIndex: 40 }}
          title={b.expanded ? 'Fewer tools' : 'More tools'}
          onMouseDown={e => e.preventDefault()} // keep the editor's selection
          onClick={() => {
            b.el.toggleAttribute('data-expanded')
            window.dispatchEvent(new Event('resize'))
          }}
        >
          <Icon name="more" size={18} />
        </button>
      ))}
    </>,
    document.body
  )
}

/** Would every tool fit on one row? (used to fold an expanded toolbar back when the window widens) */
function fitsInOneRow(el: HTMLElement) {
  const kids = [...el.children] as HTMLElement[]
  const total = kids.reduce((n, k) => n + k.getBoundingClientRect().width + 2, 0)
  return total < el.clientWidth - MORE - 16
}

const same = (a: Btn[], b: Btn[]) =>
  a.length === b.length && a.every((x, i) => x.el === b[i].el && x.expanded === b[i].expanded && Math.abs(x.top - b[i].top) < 1 && Math.abs(x.left - b[i].left) < 1)
