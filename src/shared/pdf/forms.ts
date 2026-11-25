import {
  PDFCheckBox, PDFDocument, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFRef, PDFTextField, type PDFField, type PDFPage, StandardFonts
} from 'pdf-lib'

/**
 * PDF forms (AcroForm): list the fields with their values and where their boxes are, and fill them in.
 * Isomorphic (pdf-lib): the window uses it on save and the CLI on files on disk.
 */
export type FormValue = string | boolean | string[]
export interface FormField {
  name: string
  type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'optionlist' | 'button' | 'signature' | 'other'
  value: FormValue | null
  options?: string[]
  multiline?: boolean
  readOnly?: boolean
  required?: boolean
  widgets: { page: number; x: number; y: number; w: number; h: number }[] // display points from the page's top-left
}

const typeOf = (f: PDFField): FormField['type'] => {
  const k = f.constructor.name
  if (f instanceof PDFTextField) return 'text'
  if (f instanceof PDFCheckBox) return 'checkbox'
  if (f instanceof PDFRadioGroup) return 'radio'
  if (f instanceof PDFDropdown) return 'dropdown'
  if (f instanceof PDFOptionList) return 'optionlist'
  if (/Button/.test(k)) return 'button'
  if (/Signature/.test(k)) return 'signature'
  return 'other'
}

function valueOf(f: PDFField): FormValue | null {
  try {
    if (f instanceof PDFTextField) return f.getText() ?? ''
    if (f instanceof PDFCheckBox) return f.isChecked()
    if (f instanceof PDFRadioGroup) return f.getSelected() ?? null
    if (f instanceof PDFDropdown) return f.getSelected()[0] ?? null
    if (f instanceof PDFOptionList) return f.getSelected()
  } catch { /* malformed field */ }
  return null
}

/** User-space rectangle -> display box on a (possibly rotated) page. */
function toDisplay(page: PDFPage, r: { x: number; y: number; width: number; height: number }) {
  const rot = ((page.getRotation().angle % 360) + 360) % 360
  const { x: x0, y: y0, width: W, height: H } = page.getCropBox()
  const pt = (ux: number, uy: number): [number, number] => {
    switch (rot) {
      case 90: return [uy - y0, ux - x0]
      case 180: return [x0 + W - ux, uy - y0]
      case 270: return [y0 + H - uy, x0 + W - ux]
      default: return [ux - x0, y0 + H - uy]
    }
  }
  const a = pt(r.x, r.y)
  const b = pt(r.x + r.width, r.y + r.height)
  const round = (n: number) => Math.round(n * 100) / 100
  return { x: round(Math.min(a[0], b[0])), y: round(Math.min(a[1], b[1])), w: round(Math.abs(b[0] - a[0])), h: round(Math.abs(b[1] - a[1])) }
}

export async function listFields(bytes: Uint8Array): Promise<FormField[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  const pages = doc.getPages()
  const form = doc.getForm()
  return form.getFields().map(f => {
    const widgets = f.acroField.getWidgets().flatMap(w => {
      // The widget's page: its /P entry when present, otherwise the page whose /Annots lists it.
      const pref = w.P()
      let pi = pref ? pages.findIndex(p => p.ref === pref) : -1
      if (pi < 0) {
        const wref = doc.context.getObjectRef(w.dict)
        pi = pages.findIndex(p => (p.node.Annots()?.asArray() || []).some(a => a instanceof PDFRef && wref && a === wref))
      }
      if (pi < 0) return []
      return [{ page: pi + 1, ...toDisplay(pages[pi], w.getRectangle()) }]
    })
    const field: FormField = { name: f.getName(), type: typeOf(f), value: valueOf(f), widgets, readOnly: f.isReadOnly(), required: f.isRequired() }
    if (f instanceof PDFRadioGroup || f instanceof PDFDropdown || f instanceof PDFOptionList) field.options = f.getOptions()
    if (f instanceof PDFTextField) field.multiline = f.isMultiline()
    return field
  })
}

/**
 * Fills fields by name. Text fields take strings, checkboxes booleans (or "true"/"yes"/"on"), radio groups and
 * dropdowns one option, option lists an array. Unknown names and options fail with the list of what exists.
 * `flatten` bakes the values into the page and removes the fields.
 */
export async function fillFields(bytes: Uint8Array, values: Record<string, FormValue>, opts: { flatten?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const form = doc.getForm()
  const names = form.getFields().map(f => f.getName())
  for (const [name, raw] of Object.entries(values)) {
    const f = names.includes(name) ? form.getField(name) : null
    if (!f) throw new Error(`No form field "${name}". Fields: ${names.join(', ') || '(none)'}`)
    if (f instanceof PDFTextField) {
      const text = Array.isArray(raw) ? raw.join(', ') : String(raw ?? '')
      const max = f.getMaxLength()
      f.setText(max != null && text.length > max ? text.slice(0, max) : text)
    } else if (f instanceof PDFCheckBox) {
      const on = raw === true || /^(true|yes|on|1|x|checked)$/i.test(String(raw))
      on ? f.check() : f.uncheck()
    } else if (f instanceof PDFRadioGroup || f instanceof PDFDropdown) {
      const v = String(Array.isArray(raw) ? raw[0] : raw)
      const options = f.getOptions()
      if (!options.includes(v) && !(f instanceof PDFDropdown && f.isEditable()))
        throw new Error(`"${name}" has no option "${v}". Options: ${options.join(', ')}`)
      f.select(v)
    } else if (f instanceof PDFOptionList) {
      const list = (Array.isArray(raw) ? raw : String(raw).split(',')).map(s => s.trim()).filter(Boolean)
      const options = f.getOptions()
      for (const v of list) if (!options.includes(v)) throw new Error(`"${name}" has no option "${v}". Options: ${options.join(', ')}`)
      f.select(list)
    } else throw new Error(`"${name}" is a ${typeOf(f)} field and can't be filled in`)
  }
  form.updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica))
  if (opts.flatten) form.flatten()
  return doc.save()
}

/** Coerces CLI / agent input ("true", "a,b") to what a field of that type expects. */
export function coerceValue(type: FormField['type'] | undefined, raw: unknown): FormValue {
  if (type === 'checkbox') return raw === true || /^(true|yes|on|1|x|checked)$/i.test(String(raw))
  if (type === 'optionlist') return Array.isArray(raw) ? raw.map(String) : String(raw).split(',').map(s => s.trim()).filter(Boolean)
  return Array.isArray(raw) ? raw.map(String).join(', ') : String(raw ?? '')
}
