# marshal-factory

A software factory on top of Claude Code, PStack and T3 Code, with a browser panel for supervising it.

Linear and GitHub webhooks reach a Neon Function, which records what they ask for. A runner daemon on the Mac acts on that within seconds. Each issue gets its own T3 thread, which runs PStack on a `factory/<issue>` worktree branch. Claude Code hooks and a small `factory_report` MCP server stream every run's stage, subagents, models and cost to Neon Postgres. The panel shows that live through Neon Realtime.

```
Linear / GitHub webhooks ──► Neon Function /webhooks ──► intents (Postgres)
                                                              │ Realtime
runner daemon (launchd) ◄─────────────────────────────────────┘
  └─ t3 thread start per issue, branch factory/FAC-123
                                   │
            T3 thread (Claude Code + PStack + factory playbook)
              ├─ hooks ──────────────┐  session, subagents, models, tokens
              └─ factory_report MCP ─┤  stage, status, summary
                                     ▼
                     Neon (Function /ingest + Postgres + Realtime)
                                     ▼
                Next.js + shadcn panel
          board · run timeline · agent tree · inbox · metrics · Open in T3
```

## Build order

1. Neon backend: append-only `events` with `runs` and `agents` projections, and an ingest Function. `issues` and `gates` follow in later phases.
2. Claude Code hooks that post session and subagent events, verified against a normal T3 thread.
3. `factory_report` MCP server and a factory playbook extending PStack's feature and bug-fix playbooks.
4. Panel UI: board, run view, agent tree, inbox.
5. Linear intake: webhooks into the ingest Function, acted on by the runner daemon.

## Operating it

- **Wire a target repo.** `bun scripts/install-target.ts <repo>` adds the reporter hooks, the `factory-report` MCP server and `.agents/playbooks/factory.md`, all pointing at this checkout. Re-running changes nothing. Commit the result in the target repo.
- **Webhooks.** `bun scripts/install-webhooks.ts <owner/repo>` creates the Linear webhook (team FAC, Issue and Comment) and the GitHub webhook (`pull_request`, `push`), both pointing at the ingest Function, and records their ids under `factory.webhooks`. The Function checks the signatures (`Linear-Signature` with a webhookTimestamp no older than a minute, `X-Hub-Signature-256`), stores every delivery under its delivery id so a redelivery does nothing, and records an intent: claim, stop, answer, merged or recheck_conflicts. The secrets live in `.env.local` and the Function env (`neon.ts`); set `FACTORY_TEAM_KEY` and `FACTORY_LABEL` there too when the config uses another team or label.
- **Runner.** `runner/index.ts` is the only process that touches T3, git and gh. It subscribes to open intents and to issues with an unsynced stage through Neon Realtime and acts through `runner/ops.ts`. It claims and launches (`t3 thread start --worktree origin/main` after a fetch, and logs whether the worktree really sits on origin/main), stops, resumes on an answer, writes merges back and rechecks conflicts after a push to main. Every `tickSeconds` (90) a plain timer claims into free slots, checks open PRs for merges and conflicts, and runs the watchdog, the cost cap, usage reconcile and write-back, with cleanup hourly. On startup it reconciles everything a missed webhook could have changed, so downtime only delays work. `bun scripts/install-runner.ts` installs it as the LaunchAgent `com.marshal-factory.runner` (restarts on exit, log `~/Library/Logs/marshal-factory/runner.log`); `--uninstall` unloads it. `bun runner/index.ts --once` runs one reconcile by hand.
- **Write-back.** Stage `pr` moves the Linear issue to In Review with the PR link, `waiting` posts the question, and a merged PR moves it to Done. `failed` posts the reason, moves the issue back to Todo, and swaps the `factory` label for `factory-failed`, so the runner does not pick it up again in a loop.
- **Retry.** Adding `factory` back to a failed issue claims it again as a new attempt on its own branch (`factory/FAC-7-a2`) with a fresh budget: the cap counts each attempt on its own, and the card shows the attempt, its spend against the cap, and the total of all attempts. Comment ids are derived from the stage event, so a replay never posts twice.
- **Config.** `~/.config/marshal-factory/config.json` holds `ingestUrl`, `secret` and `linearApiKey`. An optional `factory` object overrides the limits in `lib/config.ts`: `teamKey`, `label`, `maxInFlight` (2), `stuckAfterMinutes` (30), `stoppedGraceMinutes` (2), `failAfterNudgeMinutes` (30), `budgetUsd` (5), `cleanupGraceDays` (3), `subagentIdleHours` (6), `tickSeconds` (90), `provider` and `model` for new threads, `repos`, which the installer fills, and `webhooks`, which install-webhooks fills.
- **Cleanup.** The runner walks the `factory/*` branches, worktrees and T3 threads of every repo in `factory.repos`. A merged issue's worktree and local branch go right away, and a failed one's after `cleanupGraceDays`. Anything with uncommitted files, commits no remote holds (unless the PR merged that exact head), or a running thread is held and listed under `cleaned.held`. Idle Claude Code subagent worktrees under `<repo>/.claude/worktrees/` go the same way, with commits no remote has pushed to `factory-salvage/<branch>` first. The `t3` CLI cannot archive threads, so the runner lists the threads left behind under `cleaned.archive` in its log; archive them in T3 by hand or from an agent with `t3_thread_organize`.
- **Budget.** Ingest answers every batch with the spend of the issues it touched, main sessions plus subagents across all runs, and the reporter caches it under `~/.cache/marshal-factory/spend/`. On factory branches the reporter also sends a usage snapshot at most every 30 s mid-turn. The synchronous `hooks/budget.ts` PreToolUse hook blocks every tool except `report_stage` once the cached spend reaches `budgetUsd`, and tells the agent to report `failed`. It reads only local files and returns in about 20 ms; sessions off a factory branch pass straight through. The runner fails a working issue over its cap in case the thread does not.
- **Merge conflicts.** A push to main makes the runner wait for GitHub to recompute mergeability, then read every open factory PR with `gh`. When a PR in stage `pr` turns `CONFLICTING`, its thread is told to merge `origin/main`, resolve, rerun checks and report `pr` again, and the run moves back to Implementing. This happens once per PR head.
- **Watchdog.** The runner's timer checks issues in a working stage. One that has been quiet for `stuckAfterMinutes`, or whose thread stopped and stayed quiet for `stoppedGraceMinutes`, gets one nudge asking the thread to continue and report its stage. If it is still stuck in the same stage `failAfterNudgeMinutes` later, the issue fails, Linear gets the reason, and the slot frees up. A thread T3 no longer has fails at once.

## Testing

`bun run test:regressions` runs every `scripts/*-regressions.ts` against a Neon branch it creates from production for that run, and deletes the branch when the run ends. The branch expires after 2 hours, so a crashed run cannot leak one. Pass a name prefix to run a subset, for example `bun run test:regressions ingest`. It needs the `neon` CLI signed in, and the project id from `.neon` or `NEON_PROJECT_ID`.

Each script starts with `import "./test-guard"`, which exits before any write unless the harness started it and `DATABASE_URL` points at the harness's branch. The `.env.local` database is always refused. During a regression the real Linear client, `gh`, `t3 thread` commands and the deployed ingest URL throw (`lib/test-mode.ts`); tests use fakes such as `threads` in `runner/ops.ts`.

## Research

Background reports from the initial investigation live in [`docs/research/`](docs/research/).
