import { lazy } from 'react'
import type { Kind } from '../../shared/kinds'
import type { EditorProps } from './editor'

// Each editor loads the first time a file of its kind opens, so start-up stays light (pdf.js alone is large).
// Shared by the app window and the hidden window that renders screenshots for agents (look/Look.tsx).
export const EDITORS: Record<Kind, React.ComponentType<EditorProps>> = {
  doc: lazy(() => import('./doc/DocEditor')),
  sheet: lazy(() => import('./sheet/SheetEditor')),
  pdf: lazy(() => import('./pdf/PdfEditor')),
  text: lazy(() => import('./text/TextEditor')),
  slides: lazy(() => import('./slides/SlidesEditor'))
}
