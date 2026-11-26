// The .gdesign format: layered vector images. This is the full format, including fields later releases use,
// so files never need converting.

export type Paint =
  | { type: 'color'; color: string } // #rrggbb or #rrggbbaa
  | { type: 'linear' | 'radial'; stops: { offset: number; color: string }[]; angle?: number }
  | { type: 'style'; ref: string } // a named color in styles, or kit/<name> (release 2)
export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'color-burn'
  | 'hard-light' | 'soft-light' | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity'
export interface FontRef { family: string; weight: number; style: 'normal' | 'italic'; postscript?: string; asset?: string }
export interface TextRun { text: string; font: FontRef; size: number; color?: Paint; letterSpacing?: number; lineHeight?: number }
export interface Shadow { x: number; y: number; blur: number; color: string }
export interface Timing { start?: number; end?: number; in?: string; out?: string; tracks?: unknown[]; text?: unknown }
interface Base {
  id: string; name: string; visible: boolean; locked: boolean; opacity: number; blend: BlendMode
  x: number; y: number; width: number; height: number; rotation: number; scaleX: number; scaleY: number
  fill?: Paint | null; stroke?: Paint | null; strokeWidth?: number; dash?: number[]; radius?: number
  shadow?: Shadow; blur?: number; timing?: Timing
}
export type Layer =
  | (Base & { type: 'rect' | 'ellipse' | 'line' })
  | (Base & { type: 'path'; d: string }) // path data in the layer box's coordinates
  | (Base & {
      type: 'text'; runs: TextRun[]; mode: 'box' | 'point'; align: 'left' | 'center' | 'right' | 'justify'
      valign: 'top' | 'middle' | 'bottom'; outlines?: boolean; glyphs?: string; missingFont?: boolean
    })
  | (Base & { type: 'image' | 'paint'; asset: string; fit?: 'fill' | 'contain' | 'cover' })
  | (Base & { type: 'group'; children: Layer[]; clip?: boolean }) // clip: the first child masks the rest
  | (Base & { type: 'instance'; component: string; overrides: Record<string, Override> })
  | (Base & {
      type: 'connector'; from: End; to: End; label?: string; route: 'straight' | 'orthogonal'
      points?: [number, number][]; arrow: 'end' | 'both' | 'none'
    })
  | (Base & { type: 'svg'; svg: string }) // cleaned SVG the converter couldn't map
export interface End { layer: string; side?: 'auto' | 'top' | 'right' | 'bottom' | 'left' }
export interface Override { text?: string; fill?: Paint; stroke?: Paint; visible?: boolean; asset?: string }
export interface Component { id: string; name: string; root: Layer & { type: 'group' } }
export interface Styles { colors: { name: string; color: string }[]; text: { name: string; run: Omit<TextRun, 'text'> }[] }
export interface Diagram {
  name: string; direction: 'right' | 'down' | 'left' | 'up'; spacing: number; nodeComponent: string
  /** the group holding the diagram's layers */
  layer?: string
  nodes: { id: string; layer: string; container?: string; pinned?: boolean; icon?: string }[]
  links: { from: string; to: string; layer: string; label?: string }[]
  containers: { id: string; layer: string; in?: string }[]
}
export interface Artboard {
  id: string; name: string; width: number; height: number; background: Paint | null
  layers: Layer[]; animation?: { duration: number; fps: number; loop: boolean }; diagrams?: Diagram[]
}
export interface Design {
  format: 1; id: string; artboards: Artboard[]; components: Component[]; styles: Styles
  kit?: { kitId: string; items: { itemId: string; name: string; copy: unknown }[] }; thumbnailStale?: boolean
}
export interface DesignFile { design: Design; assets: Record<string, Uint8Array>; thumbnail?: Uint8Array }
export type TextLayer = Extract<Layer, { type: 'text' }>
export interface ElkGraph {
  id: string; layoutOptions?: Record<string, string>; x?: number; y?: number; width?: number
  height?: number; children?: ElkGraph[]
  edges?: {
    id: string; sources: string[]; targets: string[]
    /** a label's size, so the layout leaves room for it */
    labels?: { text?: string; width: number; height: number; x?: number; y?: number }[]
    sections?: { startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: { x: number; y: number }[] }[]
  }[]
}
