# marshal-factory

A software factory on top of Claude Code, PStack and T3 Code, with a browser panel for supervising it.

Linear issues are picked up by a T3 scheduled task. Each issue gets its own T3 thread, which runs PStack on a `factory/<issue>` worktree branch. Claude Code hooks and a small `factory_report` MCP server stream every run's stage, subagents, models and cost to Neon Postgres. The panel shows that live through Neon Realtime.

```
T3 scheduled task (poller) ──► t3_thread_launch per issue, branch factory/LIN-123
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
5. Linear poller as a T3 scheduled task.

## Operating it

- **Wire a target repo.** `bun scripts/install-target.ts <repo>` adds the reporter hooks, the `factory-report` MCP server and `.agents/playbooks/factory.md`, all pointing at this checkout. Re-running changes nothing. Commit the result in the target repo.
- **Intake.** The "Factory intake" T3 thread owns a scheduled task that runs every 20 minutes. Each pass runs `bun scripts/linear-poll.ts`, which claims Linear issues labeled `factory` in an unstarted state (at most `factory.maxInFlight` working at once, default 2), moves them to In Progress, and prints the issues to launch. The pass then starts one T3 thread per issue on `factory/<KEY>` and records it with `--attach <KEY> <threadId>`.
- **Write-back.** Stage `pr` moves the Linear issue to In Review with the PR link, `waiting` posts the question, `failed` posts the reason, and a merged PR moves it to Done. The reporter hook triggers this right after the stage event, and every poller pass repeats it. Comment ids are derived from the stage event, so a replay never posts twice.
- **Config.** `~/.config/marshal-factory/config.json` holds `ingestUrl`, `secret` and `linearApiKey`. An optional `factory` object overrides the limits in `lib/config.ts`: `teamKey`, `label`, `maxInFlight` (2), `stuckAfterMinutes` (30), `stoppedGraceMinutes` (2), `failAfterNudgeMinutes` (30), `budgetUsd` (5).
- **Budget.** Ingest answers every batch with the spend of the issues it touched, main sessions plus subagents across all runs, and the reporter caches it under `~/.cache/marshal-factory/spend/`. On factory branches the reporter also sends a usage snapshot at most every 30 s mid-turn. The synchronous `hooks/budget.ts` PreToolUse hook blocks every tool except `report_stage` once the cached spend reaches `budgetUsd`, and tells the agent to report `failed`. It reads only local files and returns in about 20 ms; sessions off a factory branch pass straight through. The poller fails a working issue over its cap in case the thread does not.
- **Merge conflicts.** Each pass reads every open factory PR with `gh`. When a PR in stage `pr` turns `CONFLICTING`, its thread is told to merge `origin/main`, resolve, rerun checks and report `pr` again, and the run moves back to Implementing. This happens once per PR head.
- **Watchdog.** Each pass checks issues in a working stage. One that has been quiet for `stuckAfterMinutes`, or whose thread stopped and stayed quiet for `stoppedGraceMinutes`, gets one nudge asking the thread to continue and report its stage. If it is still stuck in the same stage `failAfterNudgeMinutes` later, the issue fails, Linear gets the reason, and the slot frees up. A thread T3 no longer has fails at once.

## Research

Background reports from the initial investigation live in [`docs/research/`](docs/research/).
