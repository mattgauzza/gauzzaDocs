// Files gauzzaDocs makes beside a person's files while it writes, and removes once it's done: a design's lock
// (core/design/lock.ts), a stale lock moved aside and the check that its folder takes new files, and the temp file an
// export writes before it's put in place (core/design/export.ts). Lists of files (Home, the Explorer, the project
// browser and its search) never show them.

const LOCK = /\.gdesign\.lock(\.\d+\.[0-9a-f]+\.(stale|probe))?$/i
const EXPORT_TEMP = /^\..+\.\d+\.[0-9a-f]{8}\.tmp$/i

/** Whether a file name is one of gauzzaDocs' own files of the moment (see above). */
export const isScratchFile = (name: string): boolean => LOCK.test(name) || EXPORT_TEMP.test(name)
