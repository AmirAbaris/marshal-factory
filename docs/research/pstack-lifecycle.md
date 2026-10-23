# PStack end-to-end lifecycle and automation boundary

Source: pstack 0.9.69 (a Claude Code port of Lauren Tan's pstack by Michael Denyer).
- P = /Users/jan/.claude/plugins/cache/pstack-claude/pstack/0.9.69
- M = /Users/jan/.claude/plugins/marketplaces/pstack-claude (CHANGES.md, CONTEXT.md, docs/reference.md, tools/)
- Runtime data dir /Users/jan/.claude/plugins/data/pstack-pstack-claude/ is EMPTY. PStack keeps no plugin-level state there.

## 0. What PStack is (and is not)

PStack is prompt-level playbooks plus a few local scripts, not a daemon. There is no server, no queue, no telemetry (P/README.md "Data handling"). The only code that executes is:
- P/hooks/session-start.sh: injects P/hooks/session-start-context.md ("invoke pstack:poteto-mode when a task touches >1 file, has a design choice, or is an unknown bug/perf issue"). It is switched off by a `session hook: off` line in ~/.claude/pstack-models.md.
- Scripts under P/skills/poteto-mode/scripts/: `watch-pr/watch-pr` and `ship-pr` (TypeScript/bun; GitHub PR watcher, landing-revision inspect/cancel), `orch/orch.ts` (file-backed store CLI for the Orchestrate playbook), `resume.mjs` (checkpoints), `worktree-audit.mjs`, `check-plan.mjs`, `check-playbooks.mjs`.
- P/pi/*.ts: a Pi-runtime extension providing subagent, loop and schedule tools. Not used on Claude Code.

The "pipeline" is the model reading `poteto-mode/SKILL.md` and its `playbooks/*.md`, then following them. The orchestrator is an LLM session. This matters for factory design: nothing here enforces stage order outside the model's compliance, except the few scripts above.

## 1. One task from request to merged PR

Entry: SessionStart hook -> `pstack:poteto-mode` (P/skills/poteto-mode/SKILL.md, 167 lines). It matches the request to a playbook (P/skills/poteto-mode/playbooks/), copies its steps verbatim into a todolist, and names which principles shaped each decision. Subagents are spawned as `pstack:poteto-agent` (P/agents/poteto-agent.md), background, explicit model per role.

Stage trace for a Feature (playbooks/feature.md) or Bug fix (playbooks/bug-fix.md):

| # | Stage | Skill / playbook that fires | Hands off | Artifact |
|---|---|---|---|---|
| 0 | Intake / routing | poteto-mode (+ hook) | picks playbook | todolist (TaskCreate/TodoWrite, or `todo.md` fallback) |
| 1 | Understand | `how` (explorers sonnet@low, explainer); `why` for regression history (reads git, Linear, Slack, Sentry, Datadog, Notion, Databricks via per-source playbooks in why/references/sources/) | findings to lead | cited briefs, in chat |
| 1b | Reproduce (bug) | driver skill: project-local `.claude/skills/verify/` (made by `create-verification-skill`), fallback bundled `run` | repro evidence | repro output; failing test first (`tdd`) |
| 2 | Design | `architect` (parallel runners on opus+sonnet panel, runner-prompt.md, rationale-template.md) which runs `arena` (N candidates, cross-judge, pick base, graft) | chosen design | design rationale, candidate dirs (worktree or /tmp/arena-*) |
| 3 | Throughput checkpoint | feature.md step 3 | decomposition | 4 todo items: blocking steps, independent streams, shared state, smallest decomposition |
| 4 | Implement | delegate to `pstack:poteto-agent` (feature=opus/sonnet per sheet, bug-fix=opus), each file-writing delegate in its own worktree (`isolation: "worktree"`) | diff | commits (small, ordered, "each commit is a future PR") |
| 5 | Verify | driver skill on real surface; `principle-prove-it-works`; "Inconclusive" is not a pass | evidence | transcript/screenshots/receipts |
| 6 | Review | `interrogate` (multi-model adversarial: opus+sonnet reviewers, rubric.md, lead-judgment.md; "Do NOT auto-apply changes", lead synthesizes), `thermo-nuclear-code-quality-review`, `blast-radius` | verdict | synthesized verdict |
| 7 | Clean | `/deslop`, `/no-comments` (comment-sicko agent), `technical-writing` + `unslop` for PR text | | cleaned diff |
| 8 | Open PR | playbooks/opening-a-pr.md (Conventional Commit title; sections Why/What changed/Scope/Tradeoffs/Blast Radius/Verification; always ready not draft; forge resolved: `gh` default, `origin` if present; built-in PR tool preferred) | PR URL | PR |
| 9 | CI / review loop | playbooks/babysit.md (modes drive/background/threads-only/check) using `watch-pr` (JSON verdicts READY/WAITING/ADVANCE/COMPLETE/BLOCKER); `fix-ci`, `fix-merge-conflicts`, `get-pr-comments`; bot comments triaged skeptically via references/bugbot-triage.md (fix/dismiss/ask) | merge-ready | thread replies, push waves |
| 10 | Land | playbooks/shipping.md: one verifier subagent per PR (not the author) returns PASS/PASS+NOTES/FAIL, records head SHA + patch-id; `ship-pr inspect/cancel-pending`; `gh pr merge --squash --match-head-commit <sha>`; post-merge confirmation that merge commit is in destination history | merged | verdict records |
| 11 | Retrospective | `reflect` (3 reviewers + synthesizer -> skill edits; Accepted list requires user approval), `correct` (fix repeated agent mistakes at highest structural level), `what-did-i-get-done` | | skill/lint edits |

Important handoff rules:
- Opening a PR does NOT start babysitting (opening-a-pr.md "Babysit"). A subagent that opens a PR runs interrogate/deslop/no-comments, posts the URL, and returns. The parent (or an Autopilot owner) babysits later.
- Babysit ends at merge-ready. "Babysitting never authorizes merging" (babysit.md step 9). Merging requires an explicit user request and routes to Shipping.
- Shipping "requires the user's landing authority" (shipping.md line 5).

Program-scale variants (these are the closest things to a factory):
- `figure-it-out`: bespoke playbook for large or unattended work; Frame -> Design workflow -> hypothesis loop -> decision log.
- `multi-phase-plan.md`: produces a plan file (default `~/.claude/orchestrate/<slug>/docs/`), validated by `check-plan.mjs`; "Do not implement"; execution starts only on the operator's explicit go.
- `autopilot-full.md`: a queue of independent PRs; one background owner subagent per PR (own worktree) carries build -> PR -> self-proof -> bot triage -> deslop -> rebase -> babysit to merge-ready; root runs a swarm verification (parallel lanes: gates rerun, live behaviour on the real surface, diff audit, regression vs trunk) on the exact head SHA; hourly audit tick via `/loop` dynamic mode; owner pushes after every verifiable unit; fresh owner per next queue item. The operator clicks every merge.
- `autopilot-stack.md`: same but verified PRs are appended by the root (sole topology writer) into one linear base-branch stack for the operator to land.
- `orchestrate.md`: standing coordinator for multi-day, dozens-to-hundreds of subagents. Store at `~/.claude/orchestrate/<slug>/` with preferences.md (standing orders), units.tsv, frontier.json, ledger.tsv (verdicts keyed PR+head SHA: live-ui-verified | unit-test-verified | type-check-only | verifier-blocked | verifier-failed), inbox/, gates.md, decisions.tsv, status.md. `orch` CLI (orch.ts) manages it. Brief template GOAL/SCOPE/CONTEXT/ACCEPTANCE/VERIFY/TIMEBOX/FORBIDDEN/REPORT/STANDING. Pilot-one-unit-first rule. Retry policy by failure mode (cap-hit: smaller scope; network: retry; tool-error: other model; two retries then abandon). Coordinator never writes code.
  Evidence this has been used on this machine: ~/.claude/orchestrate/linear-feel/ (decisions.tsv, owner-brief.md, swarm/, trails/, todo.md) and video-marshal/.

## 2. Human touchpoints and the "never block" principle

Principle: `principle-never-block-on-the-human` (P/skills/principle-never-block-on-the-human/SKILL.md, 20 lines): proceed on reversible work, present the result, let the human course-correct. Boundaries: irreversible actions (force-push, delete prod data, external messages) still need confirmation; product direction comes from the human, execution should not block.

poteto-mode Autonomy section (SKILL.md ~lines 118-126):
- "Just do it": any MCP tool, reversible work and external actions (team chat, ticket updates, evals) proceed.
- "Always pause": force-push to shared branches, deploys, data deletion, customer messages.
- Session override phrases ("don't stop", "going to bed", "run until done", "be fully autonomous") -> keep going.
- AskUserQuestion triage (Non-negotiables): a "which approach" fork that is an observable fact must be settled with the Prototype playbook, not asked. Only genuine product/preference calls no experiment can settle are asked. Under a "full-autonomy grant" the agent decides, acts, reports, and applies a default for operator-only calls, explaining what the operator could say instead.

Where a human is still expected (enumerated):

| Point | Where | Removable? |
|---|---|---|
| Merge click | autopilot-full.md ("operator clicks every merge", "no owner runs the merge itself"); babysit.md step 9; shipping.md ("requires the user's landing authority") | Yes, by an explicit "merge/land/ship" grant, which routes to Shipping. Shipping itself is fully scripted (verifier per PR, `--match-head-commit`, no `--admin`). Needs repo rules enforcing verification gates before arming `--auto` (shipping step 8). Autopilot-full deliberately withholds this in the port (CHANGES 0.9.64: "The autopilots stop at merge-ready for the operator's click"). |
| "State plan then wait for explicit go" | autopilot-full step 1, autopilot-stack step 3, multi-phase-plan step 7 | Yes: that is a one-time arming message; a factory dispatcher can send "go" programmatically. |
| Hold / stop order | autopilot step 7 | Intentional kill switch. Keep. |
| Countersign of a raised gate/budget value (CI pinned limits) | autopilot-full step 6 | Covered by standing orders if they say so; the forge-enforced approval is never bypassed by the root. |
| Genuinely irreversible: force-push to shared branches, deploys, data deletion, customer messages, closing others' PRs | Autonomy; orchestrate Escalation | Keep as human gates. Orchestrate parks them in gates.md with a default-on-no-answer, so work routes around them. |
| Product/preference decisions | Non-negotiables; multi-phase-plan step 2 | Should become the spec stage's inputs (acceptance criteria) rather than runtime questions. |
| Bugbot/security review comments | babysit step 8; bugbot-triage.md | Agent-handled with fix/dismiss/ask. "Ask" is the escape; map to a gate. |
| Bug-fix: asking user to reproduce | bug-fix.md step 1 | Only with a stated reason the driver cannot reach the target. |
| Intent uncertain | interrogate Step 2 ("ask the user before proceeding"); automate-me; setup-pstack; babysit skill (standalone) "next fix forces a design choice -> AskUserQuestion" | interrogate/babysit-skill asks are avoidable (use the playbook babysit, not the bundled skill). automate-me and setup-pstack are interactive config tools, not pipeline stages. |
| Applying `reflect` output | reflect Step 5: "present Accepted/Rejected/Backlog and wait for explicit approval ... Do not auto-apply" | Real human gate on self-modification. Good to keep. |
| Review of results | interrogate: "Do NOT auto-apply changes" (lead judges, not human, though) | The lead agent applies; human only if the skill is run standalone. |

Net: planning-to-merge-ready can run unattended today. Two human-shaped holes remain: the merge click (by design) and the explicit "go". `orchestrate`'s reply contract says "gates awaiting the human (the only asks)".

## 3. State and memory across sessions

PStack stores almost nothing itself. Persistence is conventions over files, git, and the model's transcripts:

| Mechanism | Location | Notes |
|---|---|---|
| Model/role overrides | ~/.claude/pstack-models.md (via `/setup-pstack`; read by hook and skills). Present on this machine. | Global config, not per-run state. |
| Decision trail (`show-me-your-work`) | `decisions.tsv` in the work dir, or `.audit/<task-slug>.tsv` for concurrent efforts; gitignored by default, committed when a reviewer needs it. Columns ts, phase, decision, why, evidence, result. Helper `skills/show-me-your-work/scripts/log.sh` (stamps ts, sanitizes cells). Runs mark start rows so later runs can append. | Primary audit/observability artifact. Required for long/unattended runs (poteto-mode Non-negotiables). Autopilot owners must start one within ~15 min and push the branch snapshot. |
| Orchestrate store | `~/.claude/orchestrate/<slug>/` (outside repo and session; one writer per file; `orch` CLI with locks that self-clear on dead pid) | Survives session restart; coordinator re-reads standing orders + units.tsv, recomputes frontier, reattaches by PR/branch (not agent id). Plans from multi-phase-plan also default here. |
| Pause/resume checkpoints | `<git common dir>/pstack/resume/` managed by `resume.mjs begin/publish/read` (hash-verified, atomic latest.json). Playbooks `pause-safely` and `session-pickup` | Per-repo, shared across worktrees, runtime-agnostic. Does not survive repo deletion. |
| Transcript mining | `~/.claude/projects/<encoded-cwd>/*.jsonl` | `recall` (fan-out cheap subagents over last 7 days + `why` sweep + live gh/git verification -> capsule/threads/problems/next move), `reflect` (finds transcript via find-transcript.mjs, 3 reviewers -> skill edits), `automate-me` (distills habits into a `-mode` skill), `session-pickup` fallback. |
| Learned lessons | Edits to SKILL.md files (via reflect), lints/scripts (principle-encode-lessons-in-structure, `correct`) | Self-improvement loop requires human approval for skill edits (reflect step 5). |
| Project-local | `.claude/skills/verify/` (+features/ map, maintained by `maintain-verification-skill`), `.agents/playbooks/*.md` (project playbooks with `extends:`/`when:`; linted by check-playbooks.mjs), CLAUDE.md/AGENTS.md | These are the right place for repo-specific factory policy. |
| Cross-session truth | git branches, PRs, `gh` state, ledger.tsv keyed by PR+head SHA | Playbooks say to reattach by branch/PR; "transcript mtime is not liveness". |

There is no database, no run registry, no cross-task memory index (recall is a retrieval skill that rereads transcripts each time).

## 4. Parallelism, worktrees, cost and model routing

Parallelism:
- `swarm` (N workers, partitioned slices or races: first-pass / rank-all / best-of; PASS/ISSUES/BLOCKED reports; result must record exact SHAs and method or is respawned once, then recorded as a gap).
- `arena` (N candidates + cross-judge + graft), `architect`, `interrogate`, `how`: fixed model panels.
- Autopilot-full: many owners in parallel, one writer per branch, disjoint files. Orchestrate: rolling window of workers up to an in-flight cap (~10 per drain per sub-coordinator), depth capped at coordinator/track/worker.
- Defaults for every Agent call: `run_in_background: true`, full tool access (MCP preserved), file pointers instead of inlined context, explicit model per role, fresh subagent per new unit of work (resume only when state lives in the old agent). Abandoned agents must be explicitly stopped and confirmed (a "completed" notification can precede a still-live child).

Isolation:
- Worktree per file-writing delegate (`isolation: "worktree"` or exclusive branch) (feature.md step 4, opening-a-pr.md "Worktree"). `principle-separate-before-serializing-shared-state`: eliminate sharing before locking; "fencing a file in prose is not a lock".
- Before commit/merge from a worktree, stop and confirm every live agent holding it.
- `worktree-audit.mjs` + `worktree-cleanup.md` prune merged/abandoned worktrees (scans Claude and Codex session recency).
- Stack topology has a single writer (root/stacker). Owners push only their own branch; pushes use `--force-with-lease=ref:captured_sha`.
- Isolation is local only: "Claude Code has no remote worker environment" (orchestrate.md). All agents run on one machine; ports and shared dev servers are a collision risk that `create-verification-skill`'s "Isolate" item only documents.

Model routing:
- Single source: P/models.json (tiers default/strongest/panel; roles table; per-runtime maps for claude/codex/pi), stamped into every SKILL.md "Models" section by M/tools/generate.mjs, overridden at runtime by ~/.claude/pstack-models.md. Values: model alias, `inherit-parent`/`auto`, optional `@effort` (low..max); effort realised via agents `pstack:effort-<level>` / `pstack:poteto-agent-<level>`.
- Your sheet: feature/refactor=sonnet, bug-fix/perf/hillclimb=opus, judgment=sonnet, strongest=opus, explorer sonnet@low, panels (arena/architect/interrogate) = opus+sonnet, swarm workers=sonnet, default effort medium.
- Hard-change tiering: "hardest changes go to strongest-judgment model, trivial mechanical edits to the fast model".
- Verifier on a different model family than the worker (orchestrate Roles/Verification).
- Cost control is only implicit: scale ceremony to unit size (orchestrate: collapse for cheap units; "a verifier agent whose entire product is rerunning one command is ceremony"), Laziness Protocol, guard-the-context-window, "retry twice then abandon", ten-lane swarm only on PR heads that need it. There is NO token or dollar budget, no spend tracking, no per-task cap, no rate limiting. (grep for budget/spend across skills finds only CI-limit "budget" language and prose style guidance.)

## 5. Factory mapping and gaps

Stage mapping:

| Factory stage | PStack coverage | Rating |
|---|---|---|
| Intake | Free-text request routed by poteto-mode; `why` can read Linear/Slack/Sentry for context; no ticket-to-task ingestion | Weak |
| Queue | `orchestrate` units.tsv/inbox and Autopilot queue are in-chat lists the coordinator is told by the operator | Weak (manual queue, no triggers) |
| Spec | `multi-phase-plan` (plan file, checked by check-plan.mjs), `figure-it-out` (falsifiable done predicate), `how`/`architect`, `prototype` | Strong for spec-as-plan; no acceptance-test generation from ticket |
| Implement | feature/bug-fix/refactoring/perf playbooks, `tdd`, delegate in worktree, `swarm`/`arena` | Strong |
| Verify | driver skill (`verify`), prove-it-works, ledger keyed by head SHA, independent verifier lanes, benchmark-checklist | Strong, but depends on a per-repo `verify` skill existing |
| Review | `interrogate` multi-model, `thermo-nuclear-code-quality-review`, deslop, no-comments, blast-radius, bugbot triage | Strong |
| PR | opening-a-pr, `make-pr-easy-to-review`, technical-writing | Strong |
| CI | `babysit` playbook + `watch-pr`, `fix-ci`, `fix-merge-conflicts`, `get-pr-comments`; flake policy: classify, one retry only | Strong (GitHub only) |
| Merge | Shipping + `ship-pr` (head-guarded, cancel pending auto-merge, post-merge confirmation); autopilots stop at merge-ready | Strong mechanics, human-gated by policy |
| Post-merge | orchestrate "retro watcher" for reverts/post-merge CI breaks (a role named, no tooling); `reflect`/`correct` | Thin |

Concrete gaps:

1. Intake/queue. Nothing watches an issue tracker, label, or inbox and starts a run. No priority, dedupe, dependency graph between tickets, SLA, or WIP limit beyond the orchestrate in-flight cap. `orch` is a bookkeeping CLI, not a dispatcher; units are added by the coordinator LLM. Needed: an external queue (Linear/GitHub issues or a DB) plus a dispatcher that launches one coordinator/owner per item with the brief template (orchestrate "The brief" is a ready-made contract).
2. Scheduling. Only in-session `/loop` wakeups (dynamic mode) and Pi's schedule.ts. Autopilot "audit tick" lives and dies with the coordinator session; "after a session restart in-flight subagents are dead". Needed: an external scheduler (T3 scheduled tasks, cron, launchd, or a hosted runner) that re-enters via `session-pickup`/`resume.mjs read` and the orchestrate store.
3. Isolation. Worktrees only; same machine, shared ports, shared env, shared credentials, shared `gh` login. No container/VM per task, no network or filesystem sandbox, no secret scoping. Bypass-permission posture is implicit. Needed: per-run sandbox (container/VM or remote worktree), per-run ports/data dirs, scoped tokens, and an allowlist for Always-pause actions enforced by tool permissions rather than by prose. Hooks: PStack ships only a SessionStart hook; none of its pause rules are enforced by PreToolUse hooks, so "never force-push shared branches" is a model promise.
4. Observability. decisions.tsv per run and orch status.md are good but file-local, unaggregated, and gitignored by default. No run IDs, structured events, cost/latency per stage, dashboard, or alerting; liveness is inferred from side effects (commits/pushes/PR deltas) by hourly audit. Needed: ship TSV rows and ledger rows to a central store, add run IDs and per-agent token/cost capture (from Claude Code transcripts), and a stuck-run alarm outside the LLM.
5. Budgets. None (see section 4). Only structural limits: depth 3, ~10 children per drain, two retries then abandon, timebox field in briefs (model-honored), "stop line" in standing orders when spawning would produce garbage. Needed: per-ticket token/dollar/wall-clock caps enforced by the dispatcher, model-tier downgrade rules, and a circuit breaker on repeated failures.
6. Merge policy. Present and careful but binary: autopilot = never merge; Shipping = merge on user command. Missing: a policy that grants landing by risk class (docs-only, small, high test coverage, touched paths, blast-radius score from `blast-radius`), required reviewer/bot quorum, merge windows/freezes, and a human override. Shipping step 8 explicitly refuses `--auto`/queues unless repo rules enforce the verification on the eventual revision, and "never use --admin", so a factory must configure branch protection/rulesets (required checks including the independent verdict as a status check) first. The independent verdict is currently a prose PR comment; to make it a gate it must become a required check.
7. Rollback. Essentially absent. Shipping confirms a landing and stops the chain if it contradicts the verified record; orchestrate names a "retro watcher" for reverts and post-merge CI breaks; `why` can find reverted fixes. There is no revert playbook, no post-merge canary/metric watch, no auto-revert on failed deploy, and deploys are on the Always-pause list. Needed: a revert-PR playbook triggered by main CI red, a deploy/health check hook (the Vercel and Sentry/Datadog sources in `why` are a start), and feature-flag guidance.
8. Forge scope. Watcher/shipping scripts are GitHub-only (Origin has a documented partial alternative). `gt` (Graphite) is referenced in orchestrate.md but CHANGES says Graphite is never required; orch.ts has no gt calls, so the frontier recompute text may be stale. Treat orchestrate.md's stack mechanics with some skepticism.
9. Verification dependency. Everything leans on a project-local `verify` skill. Factory onboarding per repo must run `create-verification-skill` and `maintain-verification-skill` and prove one feature before enabling autopilot.
10. Learning loop is human-gated and manual. `reflect` waits for approval; `correct` and `recall` are invoked by a user. A factory needs a scheduled reflect-over-failed-runs job whose output is a PR to the factory's own playbooks (`.agents/playbooks/`), reviewed by a person.
11. Determinism. Stage order and gating rely on LLM compliance with long markdown. Only `check-plan.mjs`, `check-playbooks.mjs`, `watch-pr`, `ship-pr`, `orch`, `resume.mjs` are deterministic. A factory should wrap the stage machine (queue state, PR state, ledger verdicts) in code and call PStack skills as the work inside each state.

## 6. Recommended integration shape

- Keep PStack as the "worker brain": one external dispatcher creates a task record, makes a worktree/sandbox, starts Claude Code headless with a brief (orchestrate's template) and `Autopilot-stack`-style rules ("build and verify, stop at STACK-READY/merge-ready").
- Use PStack for the work inside states: Feature/Bug fix -> Opening a PR -> Babysit(drive) -> swarm verify -> Shipping.
- Put in code: queue, priority, budgets, run IDs, schedule/wake, merge-policy engine, rollback trigger, central trail.
- Per repo: `.claude/skills/verify/`, `.agents/playbooks/factory.md` (extends feature, bug-fix, babysit with the factory's gates), branch protection with the verifier verdict as a required check, and `~/.claude/pstack-models.md` for cost tiers.
- Grant mechanism: a "full-autonomy grant" phrase plus the Always-pause list defines the human boundary; mirror those in PreToolUse hooks so the boundary is enforced, not just prompted.
- Leave `reflect` and merge-by-risk as the last two things to automate.

## Key file index
- P/skills/poteto-mode/SKILL.md (router, autonomy, subagent rules)
- P/skills/poteto-mode/playbooks/{feature,bug-fix,opening-a-pr,babysit,shipping,autonomous-run,autopilot-full,autopilot-stack,orchestrate,multi-phase-plan,pause-safely,session-pickup}.md
- P/skills/poteto-mode/references/{merge-safety,resume-storage,bugbot-triage}.md
- P/skills/poteto-mode/scripts/{watch-pr/,orch/,resume.mjs,worktree-audit.mjs,check-plan.mjs}
- P/skills/{swarm,arena,architect,interrogate,show-me-your-work,recall,reflect,create-verification-skill,principle-never-block-on-the-human}/SKILL.md
- P/models.json, ~/.claude/pstack-models.md, P/hooks/session-start.sh
- M/CHANGES.md (policy history, e.g. 0.9.64 "autopilots stop at merge-ready"), M/CONTEXT.md, M/docs/reference.md
