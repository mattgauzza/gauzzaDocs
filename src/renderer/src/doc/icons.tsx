// Material Symbols paths (24px grid), drawn with currentColor.
const P: Record<string, string> = {
  undo: 'M7 19v-2h7.1q1.58 0 2.74-1T18 13.5T16.84 11T14.1 10H7.8l2.6 2.6L9 14L4 9l5-5l1.4 1.4L7.8 8h6.3q2.43 0 4.16 1.58T20 13.5t-1.74 3.93T14.1 19z',
  redo: 'M9.9 19q-2.43 0-4.16-1.58T4 13.5t1.74-3.92T9.9 8h6.3l-2.6-2.6L15 4l5 5l-5 5l-1.4-1.4l2.6-2.6H9.9q-1.58 0-2.74 1T6 13.5T7.16 16t2.74 1H17v2z',
  print: 'M16 8V5H8v3H6V3h12v5zM4 10h16zm14 2.5q.43 0 .71-.29T19 11.5t-.29-.71T18 10.5t-.71.29t-.29.71t.29.71t.71.29M16 19v-4H8v4zm2 2H6v-4H2v-6q0-1.27.88-2.14T5 8h14q1.28 0 2.14.86T22 11v6h-4zm2-6v-4q0-.43-.29-.71T19 10H5q-.43 0-.71.29T4 11v4h2v-2h12v2z',
  bold: 'M8.8 19q-.83 0-1.41-.59T6.8 17V7q0-.82.59-1.41T8.8 5h3.53q1.63 0 3 1t1.37 2.78q0 1.27-.57 1.96t-1.08.99q.63.27 1.39 1.02T17.2 15q0 2.23-1.62 3.11t-3.05.89zm1.03-2.8h2.6q1.2 0 1.46-.61t.26-.89t-.26-.89t-1.53-.61H9.83zm0-5.7h2.33q.83 0 1.2-.43t.37-.97q0-.6-.43-.98t-1.12-.37H9.83z',
  italic: 'M6.25 19v-2.5h4l3-9h-4V5h10v2.5h-3.5l-3 9h3.5V19z',
  underline: 'M5 21v-2h14v2zm7-4q-2.53 0-3.94-1.58T6.65 11.25V3H9.2v8.4q0 1.4.7 2.28t2.1.87t2.1-.87t.7-2.28V3h2.55v8.25q0 2.6-1.41 4.18T12 17',
  strike: 'M2 14v-2h20v2zm8.5-4V7H5V4h14v3h-5.5v3zm0 10v-4h3v4z',
  color: 'M2 24v-4h20v4zm3.5-7.5L10.75 3h2.5l5.25 13.5h-2.4l-1.25-3.6H9.2l-1.3 3.6zm4.4-5.6h4.2l-2.05-5.8h-.1z',
  highlight: 'M6.5 21L3 17.5L13.6 6.9l3.5 3.5zm11.3-11.3l-3.5-3.5l2.1-2.1q.3-.3.71-.3t.71.3l2.1 2.1q.3.3.3.71t-.3.71z M2 24v-2h20v2z',
  link: 'M11 17H7q-2.08 0-3.54-1.46T2 12t1.46-3.54T7 7h4v2H7q-1.25 0-2.12.88T4 12t.88 2.13T7 15h4zm-3-4v-2h8v2zm5 4v-2h4q1.25 0 2.13-.87T20 12t-.87-2.12T17 9h-4V7h4q2.08 0 3.54 1.46T22 12t-1.46 3.54T17 17z',
  image: 'M5 21q-.82 0-1.41-.59T3 19V5q0-.82.59-1.41T5 3h14q.83 0 1.41.59T21 5v14q0 .83-.59 1.41T19 21zm0-2h14V5H5zm1-2h12l-3.75-5l-3 4L9 13zm-1 2V5z',
  alignLeft: 'M3 21v-2h18v2zm0-4v-2h12v2zm0-4v-2h18v2zm0-4V7h12v2zm0-4V3h18v2z',
  alignCenter: 'M3 21v-2h18v2zm4-4v-2h10v2zm-4-4v-2h18v2zm4-4V7h10v2zM3 5V3h18v2z',
  alignRight: 'M3 5V3h18v2zm6 4V7h12v2zm-6 4v-2h18v2zm6 4v-2h12v2zm-6 4v-2h18v2z',
  alignJustify: 'M3 21v-2h18v2zm0-4v-2h18v2zm0-4v-2h18v2zm0-4V7h18v2zm0-4V3h18v2z',
  checklist: 'M5.55 19L2 15.45l1.4-1.4l2.13 2.13l4.25-4.25l1.4 1.43zm0-8L2 7.45l1.4-1.4l2.13 2.13l4.25-4.25l1.4 1.43zM13 17v-2h9v2zm0-8V7h9v2z',
  bullets: 'M9 19v-2h12v2zm0-6v-2h12v2zm0-6V5h12v2zM5 20q-.82 0-1.41-.59T3 18t.59-1.41T5 16t1.41.59T7 18t-.59 1.41T5 20m0-6q-.82 0-1.41-.59T3 12t.59-1.41T5 10t1.41.59T7 12t-.59 1.41T5 14m0-6q-.82 0-1.41-.59T3 6t.59-1.41T5 4t1.41.59T7 6t-.59 1.41T5 8',
  numbers: 'M3 22v-1.5h2.5v-.75H4v-1.5h1.5v-.75H3V16h3q.43 0 .71.29T7 17v1q0 .43-.29.71T6 19q.43 0 .71.29T7 20v1q0 .43-.29.71T6 22zm0-7v-2.75q0-.43.29-.71T4 11.25h1.5v-.75H3V9h3q.43 0 .71.29T7 10v1.75q0 .43-.29.71T6 12.75H4.5v.75H7V15zm1.5-7V3.5H3V2h3v6zM9 19v-2h12v2zm0-6v-2h12v2zm0-6V5h12v2z',
  outdent: 'M3 21v-2h18v2zm8-4v-2h10v2zm0-4v-2h10v2zm0-4V7h10v2zM3 5V3h18v2zm4 11l-4-4l4-4z',
  indent: 'M3 21v-2h18v2zm8-4v-2h10v2zm0-4v-2h10v2zm0-4V7h10v2zM3 5V3h18v2zm0 11V8l4 4z',
  clear: 'm13.2 10.35l-2.03-2.03L11.75 7H8.82l-2-2H20v3h-5.7zm6.6 13.25L11.4 15.2L9.5 20h-3l3.15-7.6L1.4 4.2l1.4-1.4l18.4 18.4z',
  outline: 'M3 17v-2h12v2zm0-4v-2h18v2zm0-4V7h18v2z',
  close: 'M6.4 19L5 17.6l5.6-5.6L5 6.4L6.4 5l5.6 5.6L17.6 5L19 6.4L13.4 12l5.6 5.6l-1.4 1.4l-5.6-5.6z',
  up: 'M7.4 15.4L6 14l6-6l6 6l-1.4 1.4l-4.6-4.6z',
  down: 'M12 15.4l-6-6L7.4 8l4.6 4.6L16.6 8L18 9.4z',
  minus: 'M5 13v-2h14v2z',
  plus: 'M11 13H5v-2h6V5h2v6h6v2h-6v6h-2z',
  table: 'M3 21V3h18v18zm2-12h14V5H5zm5 5h4v-3h-4zm0 5h4v-3h-4zm-5-5h3v-3H5zm11 0h3v-3h-3zM5 19h3v-3H5zm11 0h3v-3h-3z'
}

export function Icon({ name, size = 18 }: { name: keyof typeof P | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={P[name] || ''} />
    </svg>
  )
}
