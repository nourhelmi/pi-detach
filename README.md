# pi-detach

Background shell runs for [pi](https://github.com/earendil-works/pi) that **wake the session when they finish**.

No polling loop, no `sleep 5 && check again`, no tokens burned while waiting. A long
command detaches, your turn ends, and the result is delivered back into the session
the moment the process exits.

```
bg_run("bun test")
  → still running after 30s — detached as a3f9k
  → turn ends, nothing is spent waiting
  ...
  → [detach] a3f9k · bun test — exit 0 in 2m14s
```

## Install

```bash
pi install git:https://github.com/nourhelmi/pi-detach
```

Or load it directly without installing:

```bash
pi -e /path/to/pi-detach/extensions/index.ts
```

## Design

**The agent never chooses foreground vs. background.** `bg_run` always starts
blocking and behaves like an ordinary shell tool. If the command is still alive
after 30 seconds it is promoted to the background automatically and the tool
returns a run id. The clock decides, so the model can't talk itself into
detaching everything.

**Fan-out is just parallel tool calls.** Issue several `bg_run` calls in one
message — three `codex exec` runs, a build, and a test suite — and they execute
concurrently, each detaching on its own schedule.

**Completions interrupt, deliberately.** When the agent is idle the completion
starts a fresh turn (`triggerTurn`). When it is mid-stream the completion is
steered into the running turn (`deliverAs: "steer"`). The message is worded as an
FYI and says to keep going, so a passing test suite doesn't derail whatever is in
flight. Failures carry a longer tail than successes, since that's when the
context is actually wanted inline.

**Dedupe is keyed on `(cwd, command)`, not command.** Running `bun dev` twice in
the same directory reuses the first process instead of fighting over the port.
Running `bun dev` in three different worktrees starts three servers, which is
usually exactly what you meant.

## Tools

| Tool | Purpose |
| --- | --- |
| `bg_run` | Run a command. Blocks, then auto-detaches after `promoteAfterMs` (default 30s). |
| `bg_watch` | Start a process that never exits — dev server, file watcher, log tail. Silent while healthy. |
| `bg_output` | Read a run's captured log, with `lines` and `grep`. |
| `bg_list` | Show every run from this session and its status. |
| `bg_stop` | SIGTERM a run and its whole process group. |

### `bg_run`

```jsonc
{ "command": "bun test", "cwd": "packages/api", "label": "api tests", "promoteAfterMs": 30000 }
```

Returns output inline if the command finishes before the threshold. Otherwise
returns a run id and notifies later. Aborting the turn (Esc) detaches the run
rather than killing it.

### `bg_watch`

```jsonc
{ "command": "bun dev", "label": "web dev", "errorPattern": "error|EADDRINUSE" }
```

Returns immediately and stays quiet. Interrupts the session only if the process
dies on its own or prints a line matching `errorPattern` — at most once a minute
per run. Stopping it with `bg_stop` is silent.

## Behavior notes

- Logs are written to `~/.pi/detach/runs/<runId>/output.log` and kept after exit,
  so `bg_output` works on finished runs. The in-memory tail keeps the last 500 lines.
- Processes are spawned into their own process group, so `bg_stop` reaches child
  processes — killing a dev server takes its workers with it.
- Everything still running is terminated on session shutdown and on `/reload`.
  Use tmux/cmux for processes that should outlive pi.

## Development

```bash
bun install
bun run check   # typecheck + tests
```

## License

MIT
