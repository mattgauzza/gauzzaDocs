import { Component, type ReactNode } from 'react'

/**
 * Contains a crash to one tab: the other tabs, the menus and the agent bridge keep working, and the tab offers a
 * reload from disk. `onError` lets the shell report the reason to an agent waiting on this tab.
 */
export class TabBoundary extends Component<{ children: ReactNode; onError(e: Error): void; onReload(): void }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    console.error(error)
    this.props.onError(error)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="editor-placeholder" style={{ flexDirection: 'column', gap: 12, padding: 32, textAlign: 'center' }}>
        <b>This file's editor hit a problem.</b>
        <code style={{ maxWidth: 720, whiteSpace: 'pre-wrap', fontSize: 12 }}>{this.state.error.message}</code>
        <button className="btn primary" onClick={() => (this.setState({ error: null }), this.props.onReload())}>Reload from disk</button>
      </div>
    )
  }
}
