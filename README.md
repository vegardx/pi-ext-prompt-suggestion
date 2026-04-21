# pi-ext-prompt-suggestion

Claude-Code-style inline ghost-text prompt suggestions for [Pi](https://pi.dev).

After Pi finishes responding, a secondary model (Haiku 4.5 by default) predicts
your next message and renders it as dim ghost text inside the input. Press Tab
to accept the suggestion into the buffer, then Enter to submit. Any other key
dismisses the suggestion.

## Install

```bash
pi install git:github.com/vegardx/pi-ext-prompt-suggestion           # global
pi install -l git:github.com/vegardx/pi-ext-prompt-suggestion        # project-local
pi install git:github.com/vegardx/pi-ext-prompt-suggestion@v0.1.0    # pinned
```

Pi clones the repo, runs `npm install`, reads the `pi.extensions` manifest in
`package.json`, and auto-loads the extension on next start.

## Requirements

- Pi (`@mariozechner/pi-coding-agent`) already configured.
- An API key for whichever provider backs the suggestion model. By default
  this is `anthropic/claude-haiku-4-5-20251001`, which reads `ANTHROPIC_API_KEY`.
- Any model available through `ctx.modelRegistry.find()` works — swap via
  `/suggest-model` or `--suggest-model=...`. Local Ollama, OpenAI, Groq etc.
  all work once Pi itself can authenticate to them.

If the configured suggestion model has no API key or auth fails, the extension
surfaces a single `notify()` warning for the session and disables suggestions
silently thereafter — it will not spam on every turn.

## Scope and security

This extension only renders predictions and writes the accepted one into the
buffer. It does **not** filter potentially harmful model output. Tab accepts
into the buffer, Enter submits — so you always get a visual confirmation step
between the prediction and Pi's agent. Still, if your workflow involves
untrusted content (fetched web pages, external PRs, third-party READMEs), a
malicious prediction could show up as ghost text and be Tab-accepted by
muscle memory.

Command-safety belongs in a separate, composable extension that intercepts
submissions via `pi.on("input", ...)` and rejects or rewrites dangerous
patterns. This extension stays narrowly focused on the prediction UX; layer
a safety extension on top if you want hard guarantees.

For display integrity, `sanitize()` strips ANSI escapes, C0/C1 control
characters, and Unicode bidi/format overrides from the suggestion before it
renders. That prevents a prediction from corrupting the terminal, but it is
not a command-safety filter.

## Behavior

- Fires once per turn, on the `agent_end` event, when the input is empty and
  Pi is idle. Never fires while you are typing.
- Renders a dim suffix inside the editor input. Tab accepts the suggestion into
  the buffer (does not submit); Enter submits the buffer as normal. Any other
  keystroke dismisses the suggestion and cancels the in-flight prediction.
- Suppressed during session resume (the first synthetic `agent_end` after
  loading a prior session). Comes back on the next real turn.
- Suppressed in non-interactive modes (`pi -p`, RPC).

## Flags

| Flag | Default | Description |
|---|---|---|
| `--suggest` | `true` | Enable/disable the feature for this run |
| `--suggest-model` | `anthropic/claude-haiku-4-5-20251001` | `provider/modelId` to use |

## Commands

| Command | Effect |
|---|---|
| `/suggest` | Interactive picker: list of models with configured auth, plus an "off" option |
| `/suggest-status` | Dump the extension's runtime state for debugging |

## How it works

Pi rejected a first-party ghost-text API
([pi-mono#2355](https://github.com/badlogic/pi-mono/issues/2355)); this
extension is the supported workaround, built on the `CustomEditor` subclass
pattern that pi-mono's `rainbow-editor.ts` and `modal-editor.ts` examples
demonstrate. Credit to [@conarti](https://github.com/conarti)'s
[`feat/tui-ghost-text`](https://github.com/conarti/pi-mono/tree/feat/tui-ghost-text)
fork for the Enter-accept-and-submit semantics used here.

### Files

- `extensions/prompt-suggestion.ts` — extension factory (flags, commands, event wiring)
- `extensions/ghost-editor.ts` — `CustomEditor` subclass that paints the dim suffix
- `extensions/predictor.ts` — model call, message trimming, `AbortController` plumbing
- `test/predictor.test.ts` — unit tests for the pure helpers

### Dev loop

```bash
git clone https://github.com/vegardx/pi-ext-prompt-suggestion
cd pi-ext-prompt-suggestion
bun install                                # bun.lock is the canonical lockfile
bun run typecheck                          # or: npx tsc --noEmit
bun run test                               # or: npx vitest run
pi -e ./extensions/prompt-suggestion.ts    # one-shot load for testing
```

End-user installs go through `pi install`, which runs `npm install` against
the `peerDependencies` declared in `package.json` — so `bun.lock` only applies
to this repo's dev workflow.

## License

MIT
