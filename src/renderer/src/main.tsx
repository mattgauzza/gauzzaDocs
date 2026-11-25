import { Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { lazy, Suspense } from 'react'
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

// #look is the hidden window that renders a file for `gdocs look` (agents seeing the document).
const Look = lazy(() => import('./look/Look'))
const looking = location.hash === '#look'
if (looking) document.documentElement.classList.add('look')

createRoot(document.getElementById('root')!).render(
  <Boundary>
    {looking ? (
      <Suspense fallback={null}>
        <Look />
      </Suspense>
    ) : (
      <App />
    )}
  </Boundary>
)
