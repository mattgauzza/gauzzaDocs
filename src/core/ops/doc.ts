import { applyDocOp } from '../../shared/ops/doc'
import { OpError, type OpHandler } from '../../shared/ops/types'

/** Ops on a document's HTML when it is not open in the app (see src/shared/ops.md, "doc"). */
export const docOps: OpHandler = (payload, op) => {
  if (payload.kind !== 'doc') throw new OpError('not a document')
  const r = applyDocOp(payload.html, op)
  return { result: r.result, payload: r.html === undefined ? undefined : { kind: 'doc', html: r.html } }
}
