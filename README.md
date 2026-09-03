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
- `bg_watch` (dev servers) runs in a pane from birth; `bg_agent` starts its Pi,
  Codex, or Claude role worker in a sibling pane in the caller's tab, so the helper stays visible beside the
  calling session. Successful panes close automatically; blocked and failed panes
  stay.

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
| `bg_await` | Probe a command on an interval until a terminal condition, then wake the session once. Quiet by design. |
| `bg_agent` | Start a visible Pi, Codex, or Claude role agent beside the caller in the same Herdr tab; wakes you when it settles. |
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
dies on its own, prints a line matching `errorPattern` — at most once a minute
per run — or prints a line matching `donePattern`, a terminal condition that
wakes the session once and stops the watch (useful for CI/deploy log tails:
`"donePattern": "Succeeded|Failed|Aborted"`). Stopping it with `bg_stop` is
silent. In herdr mode the server runs in its own pane, so you can just look at it.

### `bg_await`

```jsonc
{ "command": "curl -fsS https://ci.example/status", "untilPattern": "Succeeded", "failPattern": "Failed|Aborted", "intervalSeconds": 60, "timeoutSeconds": 3600 }
```

Replaces sleep/poll loops run through the session. A quiet background loop runs
the probe once per interval and exits when the condition is met (exit 0), when
`failPattern` matches (exit 1), or at the deadline (exit 124) — the session is
woken exactly once, on the terminal state. Without `untilPattern` the wait
completes when the probe itself exits 0, which fits `curl -f` health checks.
Patterns are case-insensitive POSIX EREs. Waits that turn terminal within 15s
resolve inline without detaching. No viewer pane is ever attached; progress is
visible with `bg_output`, cancellation with `bg_stop`.

### `bg_agent` (Herdr only)

Pi is the default runtime:

```jsonc
{
  "role": "reviewer",
  "prompt": "Review the assigned builder diff for correctness and missing behavior.",
  "anchor": "result.md contains evidence-backed findings or a supported approval",
  "requiredSkills": ["review-pr"],
  "label": "auth-reviewer"
}
```

A role resolves through `~/.pi/agent/bg-agent-profiles.json`. The profile supplies
the semantic role contract: role skill, optional portable skill path, anchor
requirement, instructional prompt-cycle cap, and optional `resultDiscovery`.
For Pi-hosted advisor workers, `resultDiscovery: "advisor-worker"` finds the
worker's session-start JSONL entry and uses `<runDir>/result.md` as its durable
artifact. Discovery starts immediately after prompt acceptance, retries with
backoff in the background for up to about 60 seconds without delaying the tool
return, and makes one final attempt when the worker settles. Model selection is
not role policy. With no `model` or `thinking`, a Pi worker uses Pi's default
runtime identity. If supplied, `model`
("provider/model-id") and `thinking` are forwarded to Pi. `thinking` requires
`model`.

`bg_agent` submits a structured task packet and follows the promote-after-30s
contract. The caller is woken when the helper settles as `done`, `idle`,
`blocked`, or `stalled`. A worker whose session ledger still has a matching
`working` or `blocked` sub-agent remains supervised regardless of whether its
result artifact is missing or looks terminal; the pause notice names that live
sub-work. Transient child lookup failures are indeterminate and also keep the
worker supervised rather than failing open. A final discovery give-up note is
logged only when settlement actually becomes terminal. When a valid result
artifact is available, its first line under
`Status` is authoritative: a line beginning `BLOCKED` settles as blocked even
if Herdr reports done, while `IN PROGRESS`, `WAITING`, and the other
working-status aliases keep the run supervised when the worker ledger is absent
or unreadable. If that ledger is readable and shows no live sub-work, an
in-progress Status is treated as stale and settles as `stalled` so the parent is
woken instead of waiting forever. The parent receives at most one pause notice
and is woken later when the artifact becomes terminal or blocked.
Successful `done`/`idle` panes close after their transcript is captured. Blocked,
stalled, and failed panes remain visible. Preserve a successful pane only for a
planned follow-up:

```jsonc
{
  "role": "builder",
  "model": "anthropic/claude-sonnet-4-5",
  "thinking": "medium",
  "prompt": "Implement the fixed task packet.",
  "anchor": "localized typecheck and affected tests pass",
  "requiredSkills": ["backend-development", "testing-development"],
  "label": "auth-builder",
  "keepAlive": true
}
```

Then reuse it by name. If the occupant is already working, Pi queues the prompt
as a steer/follow-up without a lifecycle wait and pi-detach continues supervising
that run; a wait timeout is also accepted when `agent get` confirms the same
occupant is still working:

```jsonc
{ "name": "auth-builder-a3f9k", "prompt": "Address these bounded reviewer findings: …", "keepAlive": true }
```

Without a role, `bg_agent` starts plain interactive Pi. An explicit compatibility
command is still supported with `agent`, but role and agent cannot be combined:

```jsonc
{ "agent": "codex", "prompt": "One legacy interactive task", "label": "legacy" }
```

Every configured semantic role can instead use its selected provider's native
harness unless its profile declares a transport requirement. Set `harness: "native"`
per launch, or set `PI_DETACH_WORKER_HARNESS=native` once for the parent session.
The parent variable is authoritative over per-launch requests;
an explicit profile `harness` constraint takes precedence over both defaults:

```jsonc
{
  "role": "builder",
  "harness": "native",
  "model": "openai-codex/gpt-5.6-luna",
  "thinking": "max",
  "prompt": "Implement the locked packet and write the requested result artifact.",
  "anchor": "affected tests pass"
}
```

Native routing is provider-based:

- `openai-codex` or `openai` → Codex CLI;
- `claude-bridge` or `anthropic` → Claude Code;
- any other provider → a visible launch error.

Pi-detach translates the selected model and reasoning to native flags, runs the
native CLI unattended, injects the same role/task/anchor/skills packet, and adds
a durable result-artifact instruction. It reserves the empty artifact before
launch and validates a nonempty result with Status, Claims, Evidence, Files,
Decisions, and Remaining Risk headings before accepting successful settlement.
Missing or malformed results become `stalled` and retain their pane. The path defaults to
`$ADVISOR_STATE_ROOT/runs/native/<uuid>/result.md` (or a temporary fallback) and
is included in `bg_agent` details and completion output. Successful native panes
close on settlement exactly like successful Pi panes; blocked or failed panes
remain visible.

Profile file shape:

```jsonc
{
  "defaultAgent": "pi",
  "profiles": {
    "reviewer": {
      "agent": "pi",
      "harness": "pi",
      "skill": "role-reviewer",
      "skillPath": "skills/roles/reviewer/SKILL.md",
      "resultDiscovery": "advisor-worker",
      "maxTurns": 5,
      "requireAnchor": true
    },
    "builder": {
      "agent": "pi",
      "skill": "role-builder",
      "skillPath": "skills/roles/builder/SKILL.md",
      "maxTurns": 6,
      "requireAnchor": true
    }
  }
}
```

`harness` is an optional generic transport constraint (`"pi"` or `"native"`).
Use it when a role contract depends on capabilities available only in one
runtime; it does not encode role semantics. `skillPath` is resolved relative to
the profile file and gives any harness a plain filesystem location for the role
skill. Task packets also identify the
profile-adjacent `skills/` root so native workers can resolve named required
skills without Pi slash syntax or harness-specific symlinks. In Pi mode, legacy `cliArgs`,
`turnCapFlag`, `tools`, and `excludeTools` fields are still supported when
configured. Native mode intentionally constructs its own Codex/Claude command;
Pi-only tool filters are rejected and role boundaries remain instructional.
Every generated argument uses the restricted safe-argument syntax.

Older configs may still contain top-level `models` and profile-level
`allowedModels` or `allowedThinkingByModel`. These fields are deprecated,
accepted for migration compatibility, and ignored during launch resolution:
they never select, default, or reject a runtime identity. Remove them when
convenient.

The prompt instructs every harness to load the profile's configured role skill
before starting; it does not disable unrelated project skills. Pi installations
may still mark skills that must never load automatically with
`disable-model-invocation: true`.

> Tip: trust a repository before unattended work. `bg_agent` fails visibly when
> a selected runtime is waiting on first-run input and never falls back to a
> hidden process.

## Design

**The agent never chooses foreground vs. background.** `bg_run` always starts
blocking and behaves like an ordinary shell tool. If the command is still alive
after 30 seconds it is promoted to the background automatically and the tool
returns a run id. The clock decides, so the model can't talk itself into
detaching everything.

**Fan-out is just parallel tool calls.** Issue several `bg_run`/`bg_agent`
calls in one message and they execute concurrently, each detaching on its own
schedule. Promoted commands use viewer panes. Agents split into sibling panes
in the caller's tab—right when the caller is wide, down when it is narrow or
tall—so their work remains visible while the caller keeps focus.

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
