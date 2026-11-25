import { Icon as DocIcon } from '../doc/icons'

// Slide editor icons on a 24px grid, drawn with currentColor (holes by winding). Anything not here comes from the doc set.
const P: Record<string, string> = {
  cursor: 'M6 3l12 9-5.2 1.1 3.3 6.6-2.3 1.2-3.3-6.7L6 18z',
  textbox: 'M3 3h18v18H3z M5 5v14h14V5z M7 7h10v3h-2V9h-2v8h1.5v2h-5v-2H11V9H9v1H7z',
  shape: 'M8.5 2A6.5 6.5 0 0 1 15 8.5V9H9v6h-.5a6.5 6.5 0 0 1 0-13z M11 11h11v11H11z',
  rect: 'M3 5h18v14H3z',
  roundRect: 'M7 5h10a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4z',
  ellipse: 'M12 5c5 0 9 3.1 9 7s-4 7-9 7-9-3.1-9-7 4-7 9-7z',
  line: 'M3.3 19.3L19.3 3.3l1.4 1.4L4.7 20.7z',
  arrow: 'M4.7 20.7l-1.4-1.4L15.6 7H10V5h9v9h-2V8.4z',
  present: 'M2 3h20v14H2z M4 5v10h16V5z M10 7.5v5l4.5-2.5z M8 19h8v2H8z',
  background: 'M3 3h18v18H3z M5 5v14h14V5z M5 19L19 5v4L9 19z M5 13l8-8h4L5 17z',
  theme: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.4c3.1 0 5.6-2.5 5.6-5.6C22 5.5 17.5 2 12 2z',
  arrange: 'M12 2l10 5-10 5L2 7z M2 12l2-1 8 4 8-4 2 1-10 5z M2 17l2-1 8 4 8-4 2 1-10 5z',
  fill: 'M12 2.5s-6 6.6-6 10.6a6 6 0 0 0 12 0c0-4-6-10.6-6-10.6z',
  border: 'M3 3h18v18H3z M5 5v14h14V5z',
  weight: 'M3 4h18v1H3z M3 9h18v2H3z M3 15h18v4H3z',
  notes: 'M4 3h16v18H4z M6 5v14h12V5z M8 7h8v1.6H8z M8 10.5h8v1.6H8z M8 14h5v1.6H8z',
  caret: 'M7 10l5 5 5-5z',
  left: 'M15.4 7.4L14 6l-6 6 6 6 1.4-1.4L10.8 12z',
  right: 'M8.6 7.4L10 6l6 6-6 6-1.4-1.4L13.2 12z',
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6z M14 5h4v14h-4z',
  reset: 'M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z',
  duplicate: 'M8 2h12v14H8z M10 4v10h8V4z M4 6h2v14h10v2H4z',
  trash: 'M7 21q-.82 0-1.41-.59T5 19V6H4V4h5V3h6v1h5v2h-1v13q0 .82-.59 1.41T17 21z M17 6H7v13h10z M9 17h2V8H9z M13 17h2V8h-2z',
  slideAdd: 'M3 5h14v10H3z M5 7v6h10V7z M19 15v-3h2v3h3v2h-3v3h-2v-3h-3v-2z',
  presenter: 'M2 3h13v9H2z M4 5v5h9V5z M17 3h5v4h-5z M17 9h5v3h-5z M2 14h20v7H2z M4 16v3h16v-3z'
}

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  if (!P[name]) return <DocIcon name={name} size={size} />
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={P[name]} />
    </svg>
  )
}
