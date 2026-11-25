import { useState } from 'react'
import { docId } from '../../../shared/docId'

/**
 * What an agent you already have open (Claude Code, Codex... in a terminal) needs to join a document: the listen
 * command, with the few instructions that make it a working loop. The chip shows the command; copying gives both.
 */
export function joinPrompt(path: string) {
  const id = docId(path)
  return (
    `Join me in gauzzaDocs on ${id} ("${path}"). First run \`gdocs instructions ${id}\` and follow it. ` +
    `Then loop: run \`gdocs listen ${id} --once --agent <your name>\`, do what my comment or edit asks with small edits, ` +
    `reply in the thread with \`gdocs reply ${id} <thread id> "what you did" --resolve\`, and listen again. ` +
    `Stop when I say so, or if I disconnect you.`
  )
}

export function JoinChip({ path }: { path: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="cm-cmd"
      title="Copy the command with instructions for your agent, then paste it into the agent"
      onClick={() => navigator.clipboard.writeText(joinPrompt(path)).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
    >
      {copied ? 'copied' : `gdocs listen ${docId(path)}`}
    </button>
  )
}
