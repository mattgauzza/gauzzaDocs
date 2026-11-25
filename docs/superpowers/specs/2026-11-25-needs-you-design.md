# Questions for the person glow ("Needs you")

Approved by Matt on 2026-11-25 ("yes build that").

## Why

Agents ask Matt things in comment threads ("Matt, does this read clearly?") and he misses them among agent-to-agent
talk. He wants a question meant for him to glow so he knows to look. The same mechanism should carry over to document
sharing later, where other people get @mentioned.

## What it does

- Agents are told to write `@<name>` when they need the person's answer or decision. The name is the one the person's
  comments are signed with (today the OS user name, capitalized; the first word of it). It goes into the gauzzaDocs
  skill, `gdocs instructions` output, the subscription prompt and the copied join command.
- A thread "needs you" when it is open and an agent message after your last message in it @mentions your name, and you
  haven't clicked it since that message arrived.
- A thread that needs you glows in the comments panel with a "Needs you" tag. Its quoted text in the doc glows too.
- The comments button gets a pulsing dot when the open file has one. A tab whose file has one gets a dot too.
- When an agent asks you and gauzzaDocs isn't the window in front, its taskbar button flashes until you come back.
- It stops when you reply in the thread, resolve it or click it.
- It's keyed on the name mentioned, so with sharing, `@Sam` would glow for Sam.

## Approaches

1. Detect @mentions of the person's name in agent messages (chosen). Explicit, cheap and it works for other people later.
2. Guess questions from any agent text that names the person or ends in a question mark. Too noisy: agents ask each
   other questions all the time.
3. A separate "ask the person" command for agents. More reliable but another thing for agents to learn, and it doesn't
   help with sharing.

## Builder's calls

- Seen state is per message id in the renderer's localStorage. With sharing it would move into the comment data.
- The person's name comes from one helper in core (`personName`) used by main, the CLI and the subscription prompt.
- Mention matching uses the same `@word` pattern as agent mentions (letters, digits, `_` and `-`), case-insensitive.
