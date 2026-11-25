import { useEffect, useState } from 'react'
import { EMPIRICAL_VOICE } from '../../../shared/links'
import { api } from '../lib'
import { Modal } from './Dialogs'
import { Icon, Logo } from './icons'

interface Agent { id: string; label: string; detected: boolean; installed: boolean }

/**
 * First-run setup (also Help > Set up gauzzaDocs): make it the default app for documents, teach the AI agents on this
 * PC to use it, and optionally set up a writing voice. Every step can be skipped.
 */
export function Onboarding({ onClose }: { onClose(): void }) {
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [pick, setPick] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string>('')
  const [err, setErr] = useState('')
  const [defaultsOpened, setDefaultsOpened] = useState(false)

  useEffect(() => {
    api.agentsDetect().then(list => {
      setAgents(list)
      setPick(new Set(list.filter(a => a.detected && !a.installed).map(a => a.id)))
    }, e => setErr((e as Error).message))
  }, [])

  const install = async () => {
    setBusy(true)
    setErr('')
    try {
      const r = await api.agentsInstall([...pick])
      setAgents(prev => prev?.map(a => r.find(x => x.id === a.id) || a) || null)
      setDone(r.filter(a => a.installed).map(a => a.label).join(', '))
      setPick(new Set())
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const finish = () => {
    api.setWelcomed()
    onClose()
  }

  return (
    <Modal title="Welcome to gauzzaDocs" onClose={finish} wide footer={<button className="btn primary" onClick={finish}>Done</button>}>
      <div className="ob">
        <div className="ob-hero">
          <Logo size={44} />
          <p>A few things to set up. You can skip any of them and come back later from Help &gt; Set up gauzzaDocs.</p>
        </div>

        <section className="ob-step">
          <div className="ob-num">1</div>
          <div className="grow">
            <h3>Open your files with gauzzaDocs</h3>
            <p className="muted">
              gauzzaDocs is already in the Open with menu for Word, Markdown, Excel, CSV, PDF and text files. Windows only lets you
              pick the default app yourself, so this opens the page where you choose it.
            </p>
            <button className="btn" onClick={() => (api.openDefaultApps(), setDefaultsOpened(true))}>
              {defaultsOpened ? 'Opened Default apps' : 'Choose default apps'}
            </button>
          </div>
        </section>

        <section className="ob-step">
          <div className="ob-num">2</div>
          <div className="grow">
            <h3>Connect your AI agents</h3>
            <p className="muted">
              This adds a gauzzaDocs skill to the agents on this PC, so they know how to read and edit your files live, follow your
              standing instructions and answer your comments.
            </p>
            {!agents && !err && <p className="muted small">Looking for agents...</p>}
            {agents && (
              <div className="ob-agents">
                {agents.map(a => (
                  <label key={a.id} className={`ob-agent${a.detected ? '' : ' missing'}`}>
                    <input
                      type="checkbox"
                      disabled={a.installed || busy}
                      checked={a.installed || pick.has(a.id)}
                      onChange={e => setPick(p => {
                        const n = new Set(p)
                        e.target.checked ? n.add(a.id) : n.delete(a.id)
                        return n
                      })}
                    />
                    <span className="grow">{a.label}</span>
                    <span className="muted small">{a.installed ? 'connected' : a.detected ? 'found' : 'not found'}</span>
                  </label>
                ))}
              </div>
            )}
            <div className="ob-row">
              <button className="btn primary" disabled={!pick.size || busy} onClick={install}>{busy ? 'Installing...' : 'Connect selected'}</button>
              {done && <span className="small"><Icon name="check" size={16} /> Connected {done}. They pick it up the next time they start.</span>}
            </div>
            {err && <p className="error small">{err}</p>}
          </div>
        </section>

        <section className="ob-step">
          <div className="ob-num">3</div>
          <div className="grow">
            <h3>Your writing voice (optional)</h3>
            <p className="muted">
              Empirical can learn how you write and give it to every agent that drafts in your name. gauzzaDocs can then remind agents
              to look it up before they write.
            </p>
            <button className="btn" onClick={() => api.openUrl(EMPIRICAL_VOICE)}>Set up my writing voice</button>
          </div>
        </section>
      </div>
    </Modal>
  )
}
