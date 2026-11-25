import { Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import './shell/shell.css'

/** Shows what went wrong instead of a blank window, and offers a reload (open files come back as tabs). */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    console.error(error)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ padding: 32, overflow: 'auto', height: '100%' }}>
        <h2>Something went wrong</h2>
        <pre style={{ whiteSpace: 'pre-wrap', font: '12px var(--mono)' }}>{this.state.error.stack || String(this.state.error)}</pre>
        <button className="btn primary" onClick={() => location.reload()}>Reload</button>
      </div>
    )
  }
}

createRoot(document.getElementById('root')!).render(
  <Boundary>
    <App />
  </Boundary>
)
