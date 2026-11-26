import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

// The design lock when the folder refuses it: a folder that takes no new files, and a stale lock that can't be moved
// aside. The file calls are stood in for (lockIo), so these run the same on any system, with no ACLs.

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-lock-home-'))
process.env.GAUZZADOCS_HOME = home
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-lock-work-'))
after(() => {
  for (const dir of [work, home]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const { NO_WRITE, lockIo, lockTiming, stuckLock, withDesignLock } = await import('../src/core/design/lock')

const fail = (code: string) => Object.assign(new Error(`${code}: refused`), { code })
/** Settles on a later turn of the event loop, as real file calls do, so a loop that never sleeps still lets timers run. */
const later = <T>(fn: () => T): Promise<T> => new Promise((resolve, reject) => setImmediate(() => {
  try {
    resolve(fn())
  } catch (e) {
    reject(e)
  }
}))

/** Runs `body` with some of the lock's file calls replaced, and the real ones put back after. */
async function withIo(fake: Partial<typeof lockIo>, body: () => Promise<void>): Promise<void> {
  const real = { ...lockIo }
  const timing = { ...lockTiming }
  Object.assign(lockIo, fake)
  try {
    await body()
  } finally {
    Object.assign(lockIo, real)
    Object.assign(lockTiming, timing)
  }
}

/** A handle that reads as a lock taken `ago` ms ago. */
const staleHandle = (ago: number) =>
  ({
    stat: async () => ({ mtimeMs: Date.now() - ago }),
    readFile: async () => JSON.stringify({ pid: 999_999, at: Date.now() - ago }),
    close: async () => {}
  }) as unknown as fs.promises.FileHandle

test('a folder that takes no new files fails fast with a plain message, after a bounded number of tries', async () => {
  const file = path.join(work, 'ro.gdesign')
  let opens = 0
  await withIo(
    {
      // every new file is refused (Windows says EPERM), and there is no lock to read
      open: (p, flags) => later(() => {
        opens++
        throw fail(flags === 'wx' ? 'EPERM' : 'ENOENT')
      })
    },
    async () => {
      let ran = false
      const t0 = Date.now()
      await assert.rejects(withDesignLock(file, async () => void (ran = true)), (e: Error) => e.message === NO_WRITE)
      assert.equal(ran, false)
      assert.ok(opens <= 20, `${opens} file opens`)
      assert.ok(Date.now() - t0 < 5_000, `took ${Date.now() - t0} ms`)
    }
  )
})

test('EACCES (a read-only folder elsewhere) fails the same way', async () => {
  const file = path.join(work, 'ro2.gdesign')
  let opens = 0
  await withIo(
    { open: (_p, flags) => later(() => {
      opens++
      throw fail(flags === 'wx' ? 'EACCES' : 'ENOENT')
    }) },
    async () => {
      await assert.rejects(withDesignLock(file, async () => {}), (e: Error) => e.message === NO_WRITE)
      assert.ok(opens <= 20, `${opens} file opens`)
    }
  )
})

test('EPERM for a moment, with the folder fine, is waited out: the lock is taken once it clears', async () => {
  const file = path.join(work, 'blip.gdesign')
  const lock = path.resolve(file) + '.lock'
  let refusals = 3 // a lock being deleted by another writer refuses its name for a moment
  const realOpen = lockIo.open
  await withIo(
    { open: (p, flags) => (p === lock && flags === 'wx' && refusals-- > 0 ? later(() => { throw fail('EPERM') }) : realOpen(p, flags)) },
    async () => {
      assert.equal(await withDesignLock(file, async () => 'ran'), 'ran')
    }
  )
  assert.equal(fs.existsSync(lock), false)
  assert.deepEqual(fs.readdirSync(work).filter(n => n.startsWith('blip')), [], 'the folder check leaves nothing behind')
})

test('a stale lock that cannot be moved aside fails at the deadline in plain words, never spinning', async () => {
  const file = path.join(work, 'stuck.gdesign')
  const lock = path.resolve(file) + '.lock'
  let renames = 0
  const realOpen = lockIo.open
  await withIo(
    {
      open: (p, flags) => (p === lock ? later(() => {
        if (flags === 'wx') throw fail('EEXIST')
        return staleHandle(120_000)
      }) : realOpen(p, flags)),
      rename: () => later(() => {
        renames++
        throw fail('EBUSY') // another program holds it open; the folder itself is fine
      })
    },
    async () => {
      lockTiming.waitMs = 300
      const t0 = Date.now()
      await assert.rejects(withDesignLock(file, async () => {}), (e: Error) => e.message === stuckLock(lock))
      const took = Date.now() - t0
      assert.ok(took >= 300 && took < 5_000, `took ${took} ms`)
      assert.ok(renames >= 2 && renames <= 40, `${renames} tries to move it aside`)
    }
  )
})

test('a stale lock in a folder that refuses changes fails fast with the folder message', async () => {
  const file = path.join(work, 'stuck-ro.gdesign')
  const lock = path.resolve(file) + '.lock'
  let calls = 0
  await withIo(
    {
      open: (p, flags) => later(() => {
        calls++
        if (flags === 'wx') throw fail(p === lock ? 'EEXIST' : 'EPERM')
        if (p === lock) return staleHandle(120_000)
        throw fail('ENOENT')
      }),
      rename: () => later(() => {
        calls++
        throw fail('EPERM')
      })
    },
    async () => {
      const t0 = Date.now()
      await assert.rejects(withDesignLock(file, async () => {}), (e: Error) => e.message === NO_WRITE)
      assert.ok(calls <= 30, `${calls} file calls`)
      assert.ok(Date.now() - t0 < 5_000)
    }
  )
})

test('the messages follow the copy rules', () => {
  for (const m of [NO_WRITE, stuckLock('C:/x/a.gdesign.lock')]) {
    assert.match(m, /^[\x20-\x7e]+$/)
    assert.doesNotMatch(m, / - /)
  }
  assert.equal(stuckLock('C:/x/a.gdesign.lock'), "Can't save: an old lock file is in the way and can't be removed. Delete a.gdesign.lock and try again.")
})
