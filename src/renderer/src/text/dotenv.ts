import { StreamLanguage, type StringStream } from '@codemirror/language'

/**
 * .env files (KEY=value, # comments, optional `export`, quoted values with ${VAR} references). The generic
 * properties mode colors only the comments; this shows keys, values and references apart, like VS Code does.
 */
interface State { inValue: boolean; quote: string | null }

export const dotenv = StreamLanguage.define<State>({
  name: 'dotenv',
  startState: () => ({ inValue: false, quote: null }),
  token(stream: StringStream, state: State) {
    if (stream.sol() && !state.quote) state.inValue = false
    if (!state.inValue) {
      if (stream.eatSpace()) return null
      if (stream.match('#')) {
        stream.skipToEnd()
        return 'comment'
      }
      if (stream.match(/^export\b/)) return 'keyword'
      if (stream.match(/^[A-Za-z_][\w.-]*/)) return 'propertyName'
      if (stream.eat('=') || stream.eat(':')) {
        state.inValue = true
        return 'operator'
      }
      stream.next()
      return null
    }
    // The value: quoted (may span lines for double quotes), or bare up to an inline comment.
    if (state.quote) {
      // ${VAR} references stand out inside double (and back) quotes; single quotes are literal.
      if (state.quote !== "'" && stream.match(/^\$\{?[A-Za-z_]\w*\}?/)) return 'variableName.special'
      let ch: string | void
      while ((ch = stream.next()) != null) {
        if (ch === '\\') stream.next()
        else if (ch === state.quote) {
          state.quote = null
          break
        } else if (state.quote !== "'" && stream.match(/^\$\{?[A-Za-z_]/, false)) break // always after consuming one
      }
      return 'string'
    }
    if (stream.eatSpace()) return null
    if (stream.match(/^\$\{?[A-Za-z_]\w*\}?/)) return 'variableName.special'
    if (stream.peek() === '"' || stream.peek() === "'" || stream.peek() === '`') {
      state.quote = stream.next()!
      return 'string'
    }
    if (stream.match(/^#.*/)) return 'comment'
    if (stream.match(/^(true|false|yes|no|on|off)\b/i)) return 'bool'
    if (stream.match(/^-?\d+(\.\d+)?\b/)) return 'number'
    stream.match(/^[^\s#$]+/) || stream.next()
    return 'string'
  }
})
