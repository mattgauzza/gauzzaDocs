import fs from 'node:fs'
import type { Command } from 'commander'
import { parseCsv } from '../shared/sheet/csv'
import type { CellStyle } from '../shared/types'
import { type Ctx, liveOptions } from './common'

/**
 * gdocs sheet ...: spreadsheet commands. Each runs live in the app when the file is open there
 * (or with --live), otherwise straight on the file.
 */
export function registerSheetCommands(program: Command, ctx: Ctx) {
  const sheet = program
    .command('sheet')
    .description('Read and edit spreadsheets (.xlsx .csv .tsv). Cells are A1 style; --sheet picks a sheet by name or 0-based index.')

  const cmd = (name: string, desc: string) => liveOptions(sheet.command(name).description(desc).option('-s, --sheet <sheet>', 'sheet name or index (default: first / active)'))
  const sheetOpt = (o: Record<string, unknown>) => (o.sheet === undefined ? {} : { sheet: o.sheet })

  /** 2D values from --values, --csv, a file (@path) or standard input (-). */
  function readValues(o: { values?: string; csv?: string; tsv?: string }, positional?: string): unknown[][] {
    if (o.values !== undefined) {
      const v = JSON.parse(ctx.input(o.values))
      if (!Array.isArray(v)) throw new Error('--values must be a 2D array, e.g. [["a",1],["b",2]]')
      return v.map(r => (Array.isArray(r) ? r : [r]))
    }
    if (o.tsv !== undefined) return parseCsv(ctx.input(o.tsv), '\t')
    const text = o.csv !== undefined ? ctx.input(o.csv) : positional !== undefined ? ctx.input(positional) : fs.readFileSync(0, 'utf8')
    return parseCsv(text.replace(/\r?\n$/, ''))
  }

  const table = (values: unknown[][]) => values.map(r => r.map(v => (v == null ? '' : String(v))).join('\t')).join('\n')

  cmd('get', 'Print a range (default: the used range)')
    .argument('<file>')
    .argument('[range]', 'e.g. A1:C10, B:B, 3:5')
    .option('-f, --format <fmt>', 'values | display | formulas | csv | cells', 'display')
    .action(async (file: string, range: string | undefined, o) => {
      if (o.format === 'cells') {
        const r = (await ctx.run(file, { op: 'get', range, ...sheetOpt(o) }, o)) as { cells: Record<string, { text: string; f?: string }> }
        ctx.out(r, () => Object.entries(r.cells).map(([a, c]) => `${a}\t${c.f ? '=' + c.f + '\t→ ' : ''}${c.text}`).join('\n'))
        return
      }
      const r = (await ctx.run(file, { op: 'read', range, format: o.format, ...sheetOpt(o) }, o)) as { range: string | null; values?: unknown[][]; content?: string }
      ctx.out(r, () => (r.content !== undefined ? r.content.replace(/\n$/, '') : r.values?.length ? table(r.values) : '(empty)'))
    })

  cmd('set', 'Set cells: gdocs sheet set f.xlsx A1 "Total" B1 "=SUM(B2:B9)"   (or --cells \'{"A1": 5}\')')
    .argument('<file>')
    .argument('[pairs...]', 'cell value pairs; values starting with = are formulas')
    .option('--cells <map>', 'JSON object of cell -> value ("-" for stdin, @file)')
    .action(async (file: string, pairs: string[], o) => {
      let cells: Record<string, unknown> = {}
      if (o.cells !== undefined) cells = JSON.parse(ctx.input(o.cells))
      if (pairs.length % 2) throw new Error('Give cell/value pairs, e.g. A1 hello B2 "=A1&\\"!\\""')
      for (let i = 0; i < pairs.length; i += 2) cells[pairs[i]] = pairs[i + 1]
      const r = await ctx.run(file, { op: 'set', cells, ...sheetOpt(o) }, o)
      ctx.out(r, () => `Updated ${(r as { updated: number }).updated} cell(s)`)
    })

  cmd('set-range', 'Write a block of values starting at a cell (from --csv, --tsv, --values, or stdin as CSV)')
    .argument('<file>')
    .argument('<start>', 'top-left cell, e.g. A1')
    .option('--csv <text>', 'CSV text ("-" for stdin, @file)')
    .option('--tsv <text>', 'TSV text ("-" for stdin, @file)')
    .option('--values <rows>', 'JSON 2D array ("-" for stdin, @file)')
    .action(async (file: string, start: string, o) => {
      const r = await ctx.run(file, { op: 'setRange', start, values: readValues(o), ...sheetOpt(o) }, o)
      ctx.out(r, () => `Wrote ${(r as { range: string }).range}`)
    })

  cmd('append', 'Add rows under the last used row (CSV from --csv/--values/stdin)')
    .argument('<file>')
    .argument('[csv]', 'CSV text, "-" for stdin, @file')
    .option('--values <rows>', 'JSON 2D array')
    .option('--csv <text>', 'CSV text')
    .action(async (file: string, csv: string | undefined, o) => {
      const r = await ctx.run(file, { op: 'append', values: readValues(o, csv), ...sheetOpt(o) }, o)
      ctx.out(r, () => `Appended ${(r as { range: string }).range}`)
    })

  cmd('clear', 'Clear values in a range')
    .argument('<file>')
    .argument('<range>')
    .option('--keep-format', 'keep cell formatting')
    .action(async (file: string, range: string, o) => {
      const r = await ctx.run(file, { op: 'clear', range, keepFormat: !!o.keepFormat, ...sheetOpt(o) }, o)
      ctx.out(r, () => `Cleared ${range}`)
    })

  cmd('format', 'Format a range: --bold --italic --color "#c00" --bg "#ffff00" --align center --number "$#,##0.00"')
    .argument('<file>')
    .argument('<range>')
    .option('--bold', 'bold').option('--no-bold', 'not bold')
    .option('--italic', 'italic').option('--no-italic', 'not italic')
    .option('--underline', 'underline')
    .option('--strike', 'strikethrough')
    .option('--color <hex>', 'text color')
    .option('--bg <hex>', 'fill color')
    .option('--align <a>', 'left | center | right')
    .option('--wrap', 'wrap text')
    .option('--size <pt>', 'font size in points')
    .option('--number <fmt>', 'general | 0.00 | #,##0 | 0% | $#,##0.00 | date | datetime | any Excel format')
    .option('--reset', 'replace the existing formatting instead of adding to it')
    .action(async (file: string, range: string, o) => {
      const style: CellStyle = {}
      const has = (k: string) => process.argv.some(a => a === `--${k}` || a === `--no-${k}`)
      if (has('bold')) style.b = !!o.bold
      if (has('italic')) style.i = !!o.italic
      if (o.underline) style.u = true
      if (o.strike) style.s = true
      if (o.color) style.color = o.color
      if (o.bg) style.bg = o.bg
      if (o.align) style.align = o.align
      if (o.wrap) style.wrap = true
      if (o.size) style.size = Number(o.size)
      if (o.number) style.fmt = o.number
      if (!Object.keys(style).length && !o.reset) throw new Error('Nothing to format. Try --bold, --bg "#ffff00", --number "0.00%"...')
      const r = await ctx.run(file, { op: 'format', range, style, reset: !!o.reset, ...sheetOpt(o) }, o)
      ctx.out(r, () => `Formatted ${range}`)
    })

  for (const [name, op, what] of [
    ['insert-rows', 'insertRows', 'Insert rows before row <at> (1-based)'],
    ['delete-rows', 'deleteRows', 'Delete rows starting at row <at> (1-based)'],
    ['insert-cols', 'insertCols', 'Insert columns before column <at> (letter or 1-based)'],
    ['delete-cols', 'deleteCols', 'Delete columns starting at column <at> (letter or 1-based)']
  ] as const) {
    cmd(name, what + '. Formulas are adjusted.')
      .argument('<file>')
      .argument('<at>')
      .option('-n, --count <n>', 'how many', '1')
      .action(async (file: string, at: string, o) => {
        const r = await ctx.run(file, { op, at, count: Number(o.count), ...sheetOpt(o) }, o)
        ctx.out(r, () => 'Done')
      })
  }

  liveOptions(sheet.command('sheets').description('List sheet names').argument('<file>')).action(async (file: string, o) => {
    const r = (await ctx.run(file, { op: 'sheets' }, o)) as { sheets: string[] }
    ctx.out(r, () => r.sheets.map((s, i) => `${i}\t${s}`).join('\n'))
  })
  liveOptions(sheet.command('add-sheet').description('Add a sheet').argument('<file>').argument('[name]')).action(async (file: string, name: string | undefined, o) => {
    const r = await ctx.run(file, { op: 'addSheet', name }, o)
    ctx.out(r, () => `Added ${(r as { sheet: string }).sheet}`)
  })
  liveOptions(sheet.command('rename-sheet').description('Rename a sheet (references to it are updated)').argument('<file>').argument('<sheet>').argument('<name>')).action(
    async (file: string, s: string, name: string, o) => {
      const r = await ctx.run(file, { op: 'renameSheet', sheet: s, name }, o)
      ctx.out(r, () => `Renamed to ${name}`)
    }
  )
  liveOptions(sheet.command('delete-sheet').description('Delete a sheet').argument('<file>').argument('<sheet>')).action(async (file: string, s: string, o) => {
    const r = await ctx.run(file, { op: 'deleteSheet', sheet: s }, o)
    ctx.out(r, () => `Deleted ${(r as { deleted: string }).deleted}`)
  })
  // ---------- merged cells ----------
  cmd('merge', 'Merge cells. Only the top-left value of each block is kept')
    .argument('<file>')
    .argument('<range>')
    .option('--mode <mode>', 'all | horizontal (one block per row) | vertical (one per column)', 'all')
    .action(async (file: string, range: string, o) => {
      const r = (await ctx.run(file, { op: 'merge', range, mode: o.mode, ...sheetOpt(o) }, o)) as { merged: string[] }
      ctx.out(r, () => `Merged ${r.merged.join(', ')}`)
    })
  cmd('unmerge', 'Unmerge every merged block touching a range')
    .argument('<file>')
    .argument('<range>')
    .action(async (file: string, range: string, o) => {
      const r = (await ctx.run(file, { op: 'unmerge', range, ...sheetOpt(o) }, o)) as { unmerged: number }
      ctx.out(r, () => `Unmerged ${r.unmerged} block(s)`)
    })

  // ---------- conditional formatting ----------
  const cf = sheet.command('cf').description('Conditional formatting rules (first matching rule wins, like Google Sheets)')
  const cfCmd = (name: string, desc: string) => liveOptions(cf.command(name).description(desc).option('-s, --sheet <sheet>', 'sheet name or index'))
  cfCmd('list', 'List the rules with their index')
    .argument('<file>')
    .action(async (file: string, o) => {
      const r = (await ctx.run(file, { op: 'rules', ...sheetOpt(o) }, o)) as { rules: { index: number; range: string; description: string; style?: object }[] }
      ctx.out(r, () => r.rules.map(x => `${x.index}\t${x.range}\t${x.description}${x.style ? `\t${JSON.stringify(x.style)}` : ''}`).join('\n') || '(no rules)')
    })
  cfCmd('add', 'Add a rule: gdocs sheet cf add f.xlsx B2:B50 gt 100 --bg "#f4c7c3"   (types: gt gte lt lte eq neq between contains notContains empty notEmpty formula scale)')
    .argument('<file>')
    .argument('<range>')
    .argument('<type>')
    .argument('[value]', 'operand; for between the low end; for formula the formula, e.g. "=$C2>$B2"')
    .argument('[value2]', 'between: the high end')
    .option('--bg <hex>', 'fill color')
    .option('--color <hex>', 'text color')
    .option('--bold', 'bold text')
    .option('--italic', 'italic text')
    .option('--strike', 'strikethrough')
    .option('--min <hex>', 'scale: color for the lowest value', '#ffffff')
    .option('--max <hex>', 'scale: color for the highest value', '#57bb8a')
    .action(async (file: string, range: string, type: string, value: string | undefined, value2: string | undefined, o) => {
      const style: Record<string, unknown> = {}
      if (o.bg) style.bg = o.bg
      if (o.color) style.color = o.color
      if (o.bold) style.b = true
      if (o.italic) style.i = true
      if (o.strike) style.s = true
      const rule: Record<string, unknown> = { type, range }
      if (type === 'formula') rule.formula = value
      else if (value !== undefined) rule.value = value
      if (value2 !== undefined) rule.value2 = value2
      if (type === 'scale') rule.scale = { min: o.min, max: o.max }
      else if (Object.keys(style).length) rule.style = style
      const r = (await ctx.run(file, { op: 'addRule', range, rule, ...sheetOpt(o) }, o)) as { index: number; description: string }
      ctx.out(r, () => `Added rule ${r.index}: ${r.description}`)
    })
  cfCmd('delete', 'Delete a rule by its index (see cf list)')
    .argument('<file>')
    .argument('<index>')
    .action(async (file: string, index: string, o) => {
      const r = await ctx.run(file, { op: 'deleteRule', index: Number(index), ...sheetOpt(o) }, o)
      ctx.out(r, () => `Deleted rule ${index}`)
    })

  // ---------- charts ----------
  const chart = sheet.command('chart').description('Charts drawn over the grid (saved in the .xlsx for this app; Excel does not show them)')
  const chCmd = (name: string, desc: string) => liveOptions(chart.command(name).description(desc).option('-s, --sheet <sheet>', 'sheet name or index'))
  chCmd('list', 'List charts')
    .argument('<file>')
    .action(async (file: string, o) => {
      const r = (await ctx.run(file, { op: 'charts', ...sheetOpt(o) }, o)) as { charts: { id: string; type: string; range: string; title?: string; at: string; series: string[] }[] }
      ctx.out(r, () => r.charts.map(c => `${c.id}\t${c.type}\t${c.range}\tat ${c.at}\t${c.title || ''}\t${c.series.join(', ')}`).join('\n') || '(no charts)')
    })
  chCmd('add', 'Add a chart: gdocs sheet chart add f.xlsx A1:C13 --type line --title "Revenue"')
    .argument('<file>')
    .argument('<range>', 'data; first row = series names, first column = labels (guessed)')
    .option('-t, --type <type>', 'column | bar | line | pie | scatter', 'column')
    .option('--title <text>', 'title')
    .option('--at <cell>', 'top-left cell to place it over (default: right of the data)')
    .option('--width <px>', 'width', '480')
    .option('--height <px>', 'height', '300')
    .option('--no-headers', 'the first row is data, not series names')
    .option('--no-labels', 'the first column is data, not labels')
    .action(async (file: string, range: string, o) => {
      const op: Record<string, unknown> = { op: 'addChart', range, type: o.type, title: o.title, at: o.at, w: Number(o.width), h: Number(o.height), ...sheetOpt(o) }
      if (process.argv.includes('--no-headers')) op.headers = false
      if (process.argv.includes('--no-labels')) op.labels = false
      const r = (await ctx.run(file, op as never, o)) as { id: string }
      ctx.out(r, () => `Added ${r.id}`)
    })
  chCmd('delete', 'Delete a chart by id (see chart list)')
    .argument('<file>')
    .argument('<id>')
    .action(async (file: string, id: string, o) => {
      const r = await ctx.run(file, { op: 'deleteChart', id, ...sheetOpt(o) }, o)
      ctx.out(r, () => `Deleted ${id}`)
    })

  liveOptions(sheet.command('info').description('Sheets with their used size and formula counts').argument('<file>')).action(async (file: string, o) => {
    const r = (await ctx.run(file, { op: 'info' }, o)) as { sheets: { name: string; rows: number; cols: number; used: string | null; formulas: number }[] }
    ctx.out(r, () => r.sheets.map((s, i) => `${i}\t${s.name}\t${s.used ?? '(empty)'}\t${s.rows} rows x ${s.cols} cols\t${s.formulas} formulas`).join('\n'))
  })
}
