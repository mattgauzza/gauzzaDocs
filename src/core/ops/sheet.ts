import { sheetOpHandler } from '../../shared/ops/sheet'
import type { OpHandler } from '../../shared/ops/types'

/** Sheet ops on a file not open in the app: the same pure ops the editor runs live. */
export const sheetOps: OpHandler = sheetOpHandler
