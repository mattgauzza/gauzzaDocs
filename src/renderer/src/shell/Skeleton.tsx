import type { Kind } from '../../../shared/kinds'

/** One shimmering placeholder bar. `w` is a percentage of the line, or any CSS width. */
const Bar = ({ w, h = 10, page }: { w: number | string; h?: number; page?: boolean }) => (
  <span className={`sk${page ? ' sk-on-page' : ''}`} style={{ width: typeof w === 'number' ? `${w}%` : w, height: h }} />
)

// Fixed line lengths, so the outline doesn't jump around between renders.
const PROSE = [94, 89, 96, 62, 0, 91, 86, 93, 97, 48, 0, 88, 95, 71]
const CODE: [number, number][] = [[0, 34], [2, 52], [2, 41], [4, 63], [4, 28], [2, 12], [0, 8], [0, 0], [0, 44], [2, 58], [4, 37], [2, 22], [0, 8]]

function Page({ title = true }: { title?: boolean }) {
  return (
    <div className="sk-page">
      {title && <Bar w={46} h={22} page />}
      {PROSE.map((w, i) => (w ? <Bar key={i} w={w} page /> : <span key={i} className="sk-gap" />))}
    </div>
  )
}

/**
 * What a tab shows while its editor or its file loads: the outline of that kind of editor (a page for docs and PDFs,
 * a grid for sheets, a filmstrip and slide for decks, lines for text), so switching tabs never flashes "Loading".
 */
export function EditorSkeleton({ kind }: { kind: Kind | 'large' }) {
  return (
    <div className={`sk-editor sk-${kind}`} role="status" aria-busy="true" aria-label="Loading">
      <div className="sk-toolbar">
        <Bar w={34} h={28} />
      </div>
      {kind === 'doc' && (
        <div className="sk-canvas">
          <Page />
        </div>
      )}
      {kind === 'pdf' && (
        <div className="sk-canvas">
          <Page title={false} />
          <Page title={false} />
        </div>
      )}
      {kind === 'sheet' && (
        <div className="sk-sheet">
          <div className="sk-formula"><Bar w={42} h={14} /></div>
          <div className="sk-grid">
            {Array.from({ length: 6 }, (_, r) => (
              <div key={r} className="sk-grid-row">
                {[60, 45, 70, 38, 55].map((w, c) => <Bar key={c} w={w + ((r * 7 + c * 3) % 15)} h={9} />)}
              </div>
            ))}
          </div>
        </div>
      )}
      {kind === 'slides' && (
        <div className="sk-slides">
          <div className="sk-strip">
            {Array.from({ length: 5 }, (_, i) => <span key={i} className="sk-thumb" />)}
          </div>
          <div className="sk-stage">
            <div className="sk-slide">
              <Bar w={52} h={30} page />
              <span className="sk-gap" />
              {[78, 66, 72].map((w, i) => <Bar key={i} w={w} h={14} page />)}
            </div>
          </div>
        </div>
      )}
      {(kind === 'text' || kind === 'large') && (
        <div className="sk-code">
          {CODE.map(([indent, w], i) => (
            <div key={i} className="sk-code-line" style={{ paddingLeft: 56 + indent * 14 }}>
              <span className="sk-ln">{i + 1}</span>
              {w ? <Bar w={`${w}%`} h={9} /> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Placeholder rows while a list loads: the project rail, the folder browser and the file explorer. */
export function RowSkeleton({ rows = 3, className = 'sk-row' }: { rows?: number; className?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={className}>
          <span className="sk sk-icon" />
          <Bar w={`${[62, 48, 70, 55, 66, 44][i % 6]}%`} h={10} />
        </div>
      ))}
    </div>
  )
}
