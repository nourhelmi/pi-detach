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
- `bg_watch` (dev servers) runs in a pane from birth; `bg_agent` starts Pi in
  a sibling pane in the caller's tab, so the worker stays visible beside the
  advisor. Successful panes close automatically; blocked and failed panes stay.

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
| `bg_agent` | Start a visible Pi role agent beside the caller in the same Herdr tab; wakes you when it settles. |
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

### `bg_agent` (Herdr only)

Pi is the default runtime:

```jsonc
{
  "role": "checker",
  "model": "openai-codex/gpt-5.6-sol",
  "thinking": "medium",
  "prompt": "Review the assigned builder diff for correctness and missing behavior.",
  "anchor": "result.md contains evidence-backed findings or a supported approval",
  "requiredSkills": ["review-pr"],
  "label": "auth-checker"
}
```

A role resolves through `~/.pi/agent/bg-agent-profiles.json`. The profile pins
the guardrails only: hidden role skill, tool restrictions, CLI arguments, anchor
policy, and prompt-cycle cap. Profiles never pin a model. Every role launch
chooses `model` ("provider/model-id") and `thinking` per call; when the config
has a `models` map, the chosen model and thinking level must be in it. A
per-launch `maxTurns` overrides the profile cap and is forwarded through the
profile's `turnCapFlag`. `bg_agent` submits a structured task packet and
follows the promote-after-30s contract. The parent is woken when the worker
settles as `done`, `idle`, `blocked`, or `stalled`.

Successful `done`/`idle` panes close after their transcript is captured. Blocked,
stalled, and failed panes remain visible. Preserve a successful pane only for a
planned follow-up:

```jsonc
{
  "role": "builder",
  "model": "openai-codex/gpt-5.6-sol",
  "thinking": "high",
  "prompt": "Implement the fixed task packet.",
  "anchor": "localized typecheck and affected tests pass",
  "requiredSkills": ["backend-development", "testing-development"],
  "label": "auth-builder",
  "keepAlive": true
}
```

Then reuse it by name:

```jsonc
{ "name": "auth-builder-a3f9k", "prompt": "Address these bounded checker findings: …", "keepAlive": true }
```

Without a role, `bg_agent` starts plain interactive Pi. An explicit compatibility
command is still supported with `agent`, but role and agent cannot be combined:

```jsonc
{ "agent": "codex", "prompt": "One legacy interactive task", "label": "legacy" }
```

Profile file shape:

```jsonc
{
  "defaultAgent": "pi",
  "models": {
    "openai-codex/gpt-5.6-sol": {
      "character": "Workhorse for implementation, planning, and review.",
      "thinking": ["medium", "high", "xhigh", "max"],
      "defaultThinking": "high"
    }
  },
  "profiles": {
    "scout": {
      "agent": "pi",
      "skill": "advisor-role-scout",
      "excludeTools": ["edit", "bg_agent"],
      "cliArgs": ["--advisor-worker-role", "scout"],
      "turnCapFlag": "--advisor-worker-max-turns",
      "maxTurns": 3,
      "requireAnchor": true
    }
  }
}
```

Normal Pi skills remain available. A profile forces its hidden role skill; it
does not disable unrelated project skills. Mark skills that must never load
automatically with `disable-model-invocation: true`.

> Tip: trust a repository before unattended work. `bg_agent` fails visibly when
> Pi is waiting on first-run input and never falls back to a hidden process.

## Design

**The agent never chooses foreground vs. background.** `bg_run` always starts
blocking and behaves like an ordinary shell tool. If the command is still alive
after 30 seconds it is promoted to the background automatically and the tool
returns a run id. The clock decides, so the model can't talk itself into
detaching everything.

**Fan-out is just parallel tool calls.** Issue several `bg_run`/`bg_agent`
calls in one message and they execute concurrently, each detaching on its own
schedule. Promoted commands use viewer panes. Agents split into sibling panes
in the caller's tab—right when the advisor is wide, down when it is narrow or
tall—so their work remains visible while the advisor keeps focus.

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

**Panes are recycled, not accumulated.** Successful viewer and agent panes
close themselves. Failure panes and dead-watch panes return to a pool, while
blocked/failed agent panes remain available for diagnosis or input.

**Watch completion in a pane is sentinel-based.** A pane is a shared terminal,
not a child process, so watch commands are bracketed with printed markers and
a blocking `herdr wait output` child detects the exit marker — along with the
exit code. The body runs in a subshell, so `exit`, `cd`, and exports can't
take down or pollute the pane's shell. If you ctrl+c a watch directly in its
pane, the marker never prints; a slow supervisor poll notices the shell is
back at its prompt and settles the run as killed.

## Herdr behavior notes

- Pane-hosted work survives Pi shutdown or `/reload`. Active watches and agents
  remain visible. Successful agent panes normally close on settlement;
  `keepAlive` agents, blocked agents, and failed agents remain yours to inspect
  or close. Local `bg_run` processes die with the parent session as before.
- Agent panes are recorded in `~/.pi/detach/ledgers/<PI_SESSION_ID>.json` (one
  file per Pi session). After a session dies, another live Herdr session reaps
  settled orphans (`idle`/`done`) — including `keepAlive` panes, whose follow-up
  owner is gone. Working, blocked, and unknown agents are left alone. A live
  session never closes another live session's panes, and never closes a pane
  that is not in a ledger. After `/reload` in the same process, leftover
  `closeOnSettle` records in this session's file are finished when they settle.
  Identity is bound to the ledger pane ID (`agent get <paneId>`), never the
  agent name — Herdr reuses names for new agents; pane IDs are never reused.
  Records younger than 60s are ineligible. Immediately before `pane close` the
  reaper re-reads the pane and aborts if pane, name, settled state, or
  `state_change_seq` changed. Missing or non-number `state_change_seq` on
  either get keeps the record. The live driver also confirms pane, name, and
  idle/done via `agent get <paneId>` before close-on-settle. Upstream: complete
  atomicity needs a Herdr server-side conditional close keyed to pane + occupant
  generation; requested as a future herdr feature. Until that exists, a
  sub-millisecond residual race is accepted for settled orphans of dead sessions.
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
