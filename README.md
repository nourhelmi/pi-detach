# pi-detach

Background runs for [pi](https://github.com/earendil-works/pi) that **wake the session when they finish** — and, when pi runs inside [herdr](https://herdr.dev), live in **visible panes** you can watch.

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

Launch pi from inside herdr and background work becomes visible — with Claude
Code's semantics: **foreground stays invisible, only real background work gets
a surface, and the surface disappears when the work is done.**

- A quick `bg_run` (a grep, a 2s build) runs as an invisible local process and
  returns inline. It never touches your layout.
- A `bg_run` that crosses the 30s promote threshold — genuine background work —
  gets a **live viewer pane** tailing its output. On success the pane closes
  itself, like a task chip completing; on failure it stays, renamed `✗`, for
  inspection (and is recycled by the next promoted run).
- `bg_watch` (dev servers) and `bg_agent` (helper agents) are panes from
  birth — those are the things you actually want on screen.

Nothing about how you use the tools changes — the backend is picked
per-session by detecting `HERDR_ENV`.

## Install

```bash
pi install git:https://github.com/nourhelmi/pi-detach
```

Or load it directly without installing:

```bash
pi -e /path/to/pi-detach/extensions/index.ts
```

For pane hosting, herdr ≥ 0.7 must be on `PATH` and pi must be started inside a
herdr-managed pane. Outside herdr everything falls back to the original local
detached-process backend.

## Tools

| Tool | Purpose |
| --- | --- |
| `bg_run` | Run a command. Blocks, then auto-detaches after `promoteAfterMs` (default 30s). |
| `bg_watch` | Start a process that never exits — dev server, file watcher, log tail. Silent while healthy. |
| `bg_agent` | Start a helper coding agent (codex, claude, …) in a herdr pane; wakes you when it settles. |
| `bg_output` | Read a run's captured log — live from the pane while running, from disk after. |
| `bg_list` | Show every run from this session, its status, and its pane. |
| `bg_stop` | Stop a run: SIGTERM locally, ctrl+c to a pane, esc to an agent. |

### `bg_run`

```jsonc
{ "command": "bun test", "cwd": "packages/api", "label": "api tests", "promoteAfterMs": 30000 }
```

Returns output inline if the command finishes before the threshold. Otherwise
returns a run id and notifies later — and, inside herdr, opens a live viewer
pane for the now-background run. Aborting the turn (Esc) detaches the run
rather than killing it.

### `bg_watch`

```jsonc
{ "command": "bun dev", "label": "web dev", "errorPattern": "error|EADDRINUSE" }
```

Returns immediately and stays quiet. Interrupts the session only if the process
dies on its own or prints a line matching `errorPattern` — at most once a minute
per run. Stopping it with `bg_stop` is silent. In herdr mode the server runs in
its own pane, so you can just look at it.

### `bg_agent` (herdr only)

```jsonc
{ "prompt": "Review the diff in ~/repo and list actionable findings.", "agent": "codex", "label": "reviewer" }
```

Starts a real interactive agent via `herdr agent start`, submits the prompt,
and follows the same promote-after-30s contract. The session is woken when the
agent **settles**: `done`/`idle` (finished), `blocked` (waiting on an approval
or question — the notification tells pi how to answer), or `stalled` (the
prompt never visibly started a turn). The agent stays alive in its pane;
follow-ups reuse it:

```jsonc
{ "name": "reviewer-a3f9k", "prompt": "Now fix finding #2." }
```

Plain headless invocations like `codex exec "…"` don't need `bg_agent` — they
are ordinary commands, use `bg_run`.

> Tip: if the agent shows a first-run trust dialog for a directory it has never
> seen, the prompt lands in that dialog instead of the agent. Trust your repos
> once beforehand, or pass the flags your agent needs in `agent`.

## Design

**The agent never chooses foreground vs. background.** `bg_run` always starts
blocking and behaves like an ordinary shell tool. If the command is still alive
after 30 seconds it is promoted to the background automatically and the tool
returns a run id. The clock decides, so the model can't talk itself into
detaching everything.

**Fan-out is just parallel tool calls.** Issue several `bg_run`/`bg_agent`
calls in one message and they execute concurrently, each detaching on its own
schedule. In herdr mode panes stack next to your session — the first split off
the caller's pane (right when wide, down when tall), later ones off the newest
run pane.

**Visibility follows backgroundness.** Commands don't get panes; *background
tasks* do. A pane appears only when a run is promoted, a watch starts, or an
agent starts — so a session full of quick shell calls leaves your layout
exactly as it was.

**Completions interrupt, deliberately.** When the agent is idle the completion
starts a fresh turn (`triggerTurn`). When it is mid-stream the completion is
steered into the running turn (`deliverAs: "steer"`). The message is worded as an
FYI and says to keep going. Failures carry a longer tail than successes, since
that's when the context is actually wanted inline.

**Dedupe is keyed on `(cwd, command)`, not command.** Running `bun dev` twice in
the same directory reuses the first process instead of fighting over the port.
Running `bun dev` in three different worktrees starts three servers. Agent runs
never dedupe.

**Panes are recycled, not accumulated.** Successful viewer panes close
themselves; failure panes and dead-watch panes return to a pool and the next
background task reuses them (verified against process-info first — if you
started typing in one, it's left alone).

**Watch completion in a pane is sentinel-based.** A pane is a shared terminal,
not a child process, so watch commands are bracketed with printed markers and
a blocking `herdr wait output` child detects the exit marker — along with the
exit code. The body runs in a subshell, so `exit`, `cd`, and exports can't
take down or pollute the pane's shell. If you ctrl+c a watch directly in its
pane, the marker never prints; a slow supervisor poll notices the shell is
back at its prompt and settles the run as killed.

## Herdr behavior notes

- Pane-hosted work (**watches and agents**) survives pi. On session shutdown
  or `/reload` their panes keep running — they're visible and yours. Close
  them in herdr when you're done. `bg_run` processes are local and die with
  the session as before; a viewer pane orphaned by a hard exit just shows the
  final tail and can be closed by hand.
- `bg_output` on a running watch or agent reads its pane live; local runs read
  their streamed log at `~/.pi/detach/runs/<runId>/output.log`. Pane
  scrollback limits apply to very chatty watch commands.
- If herdr refuses a start (server down, split failed), `bg_watch` falls back
  to the local backend and says so. `bg_agent` fails loudly instead. `bg_run`
  never depends on herdr at all.
- Config: `PI_DETACH_NO_HERDR=1` forces the local backend even inside herdr;
  `PI_DETACH_HERDR_TOAST=0` disables the herdr UI toasts.

## Behavior notes (both backends)

- Logs are written to `~/.pi/detach/runs/<runId>/output.log` and kept after
  exit, so `bg_output` works on finished runs. The in-memory tail keeps the
  last 500 lines.
- Local processes are spawned into their own process group, so `bg_stop`
  reaches child processes — killing a dev server takes its workers with it.

## Development

```bash
bun install
bun run check   # typecheck + unit tests
```

The unit tests fake the herdr CLI. There is also a live integration test that
drives a real, isolated herdr session (never your default one):

```bash
herdr server --session pidetachtest &   # isolated named session
HERDR_SOCKET_PATH=~/.config/herdr/sessions/pidetachtest/herdr.sock \
  herdr workspace create --cwd /tmp --label test --no-focus   # note root pane id

HERDR_INTEGRATION=1 \
HERDR_SOCKET_PATH=~/.config/herdr/sessions/pidetachtest/herdr.sock \
HERDR_PANE_ID=w1:p1 \
  node --import tsx tests/integration-herdr.ts

herdr session stop pidetachtest && herdr session delete pidetachtest
```

## License

MIT
