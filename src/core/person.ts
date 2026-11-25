import os from 'node:os'

/**
 * The person's name: what their comments are signed with and what agents @mention to ask them something. The first
 * word of the OS user name, capitalized ("matt.gauzza" gives "Matt").
 */
export function personName(): string {
  try {
    const word = os.userInfo().username.match(/[\p{L}\p{N}_-]+/u)?.[0]
    return word ? word.charAt(0).toUpperCase() + word.slice(1) : 'You'
  } catch {
    return 'You'
  }
}

/** What agents are told about asking the person something; the app makes threads that @mention them glow. */
export const askPerson = (name = personName()) =>
  `You're working with ${name}. When you need their answer or a decision, ask in a comment and write @${name} so it ` +
  `lights up for them. Don't @mention them just to report progress.`
