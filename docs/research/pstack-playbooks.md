# PStack playbook and orchestration skills: research for a software factory

Source: `/Users/jan/.claude/plugins/cache/pstack-claude/pstack/0.9.69/` (call it `$P`). This is the Claude Code port (michael-denyer/pstack-claude) of Lauren Tan's pstack. README is only 28 lines. Real content is in `$P/skills/*/SKILL.md`, `$P/skills/poteto-mode/playbooks/*.md`, `$P/agents/`, `$P/effort-agents/`, `$P/hooks/`, and the scripts under `$P/skills/poteto-mode/scripts/`.

Key framing: PStack is markdown instructions an LLM follows, not a workflow engine. The only executable code is a few Bun/Node scripts (`watch-pr`, `ship-pr`, `orch`, `check-plan.mjs`, `check-playbooks.mjs`, `worktree-audit.mjs`, `show-me-your-work/scripts/log.sh`). There is no intake, no issue tracker, no scheduler, no persistence layer other than files on disk. "Unattended" means a long-lived LLM session, not a daemon.

## 1. Architecture

- **Hook.** `hooks/hooks.json` runs `hooks/session-start.sh claude` on SessionStart (startup, resume, clear, compact). It injects `hooks/session-start-context.md` (the poteto-mode routing mandate) unless `~/.claude/pstack-models.md` contains `session hook: off`.
- **Router.** `poteto-mode` (`skills/poteto-mode/SKILL.md`, 25 KB) is the entry point. It matches a task to one of ~23 playbooks in `skills/poteto-mode/playbooks/` and requires the agent to copy the playbook's steps verbatim into a todolist. It also holds an index of ~25 `principle-*` skills the agent must read before citing.
- **Agents.** `agents/poteto-agent.md` is a thin wrapper whose only job is to force-read poteto-mode SKILL.md before working (substituting `general-purpose` "skips that read and drifts"). `effort-agents/{poteto-agent,effort}-{low,medium,high,xhigh,max}.md` are the same agents pinned to a reasoning effort. `agents/comment-sicko.md` is a comment-deleting reviewer used by `/no-comments`.
- **Model config.** `models.json` plus `~/.claude/pstack-models.md` (the user's override sheet) map roles to models. The user's sheet currently sets: feature/refactoring sonnet, bug-fix/perf/hillclimb opus, judgment sonnet, strongest judgment opus, swarm workers sonnet, arena runners and cross-judge pool opus+sonnet, architect runners opus+sonnet, interrogate reviewers opus+sonnet, default effort medium. Plugin defaults (in SKILL.md Models sections) use `opus`, `fable`, `sonnet`. The skill text also supports `inherit-parent`/`auto` and `model @effort` syntax (routes to `pstack:effort-<level>`).
- **Subagent conventions** (poteto-mode SKILL.md, "Subagents"): every `Agent` call is `run_in_background: true`, full tool access, pointers not inlined context, explicit model per role. Phase agents use `subagent_type: "pstack:poteto-agent"`. Panel skills (how, why, interrogate, swarm, arena) use `general-purpose`. Fresh subagent per new task. Resume only if state is costly to move. The parent owns every subagent's output and must review the diff itself.

## 2. Per-skill breakdown

### poteto-mode (router + autonomy contract)
- **Does.** Style and routing. Matches task to playbook: Investigation, Bug fix, Perf issue, Hillclimb, Runtime/Trace forensics, Feature, Refactoring, Prototype, Visual parity, Authoring a skill, Eval, Babysit, Shipping, Autonomous run, Orchestrate, Autopilot-full, Autopilot-stack, Session pickup, Pause safely, Multi-phase plan, Worktree cleanup, Opening a PR.
- **Trigger.** SessionStart hook injection, `/poteto-mode`, or "poteto".
- **Artifacts.** Todolist (TaskCreate/TodoWrite, or an uncommitted `todo.md` fallback), decision trail (via show-me-your-work), a prose reply with fixed content per playbook.
- **Fan-out.** Anything via `Agent`. Roles: feature/refactoring, bug-fix, perf, hillclimb, judgment, strongest judgment.
- **Done.** Per playbook. Generic rule: "Prove It Works" against the real artifact, state verdict VERIFIED/NOT VERIFIED/INCONCLUSIVE, inconclusive is not a pass.
- **Unattended?** Explicit autonomy contract. "Just do it" for reversible work and external actions. **Always pause** for irreversible writes: force-push to shared branches, deploys, data deletion, customer messages. "Don't stop"/"going to bed"/"run until done" keeps it going. Principle `never-block-on-the-human`: classify any "which approach" question; if observable by running something, run a prototype instead of asking. Under a full-autonomy grant it decides, acts, reports, and applies a default for operator-only calls. Gates the operator named still need the operator.

### figure-it-out (`skills/figure-it-out/SKILL.md`)
- **Does.** Meta-playbook: designs a bespoke playbook when none fits (large migration, multi-part change, away-from-keyboard work).
- **Phases.** A Frame (falsifiable done predicate, quantified scope, rigor level biased high, present framing; one checkpoint for multi-hour runs), B Design workflow (atomic units, riskiest-unknown first, verification harness with pre-change baseline built before work, `architect` for one-way doors, fan out only across seams with worktree per worker), C Run the loop (hypothesis, smallest change, measure on real artifact, keep or revert; pair delegated work with a judge), D Audit trail (show-me-your-work, usually committed), E Verify against the A predicate on the real product.
- **Outputs.** Written phase list, `decisions.tsv`, a reply naming rigor level, trail path, verified state, open items.
- **Models.** None prescribed; inherits poteto-mode roles.
- **Done.** Phase A predicate met on the real product.
- **Unattended.** Mostly yes; the human checkpoint is an explicit, single pause after framing for multi-hour runs.

### swarm (`skills/swarm/SKILL.md`)
- **Does.** Fan out N background workers (partition slices, race identical briefs, or mixed), aggregate into one report.
- **Trigger.** `/swarm`, "swarm this", parallel coverage, races, gauntlets.
- **Phases.** Frame (done predicate, shape, N, worker model, per-worker output path, exact SHAs and method for measurements), Fan out (one message, `general-purpose`, `run_in_background: true`), Aggregate (drop results missing SHAs/method and respawn once; gaps never count as pass), Report.
- **Model.** `swarm workers` (user: sonnet; plugin default: opus).
- **Output.** In-chat table of `PASS`/`ISSUES`/`BLOCKED` with evidence. No file artifact by default.
- **Done.** Every required slice has a result, or a gap is recorded. Race rule (first pass / rank all / best-of) declared up front.
- **Unattended.** Yes, no human gate. It is the verification primitive that autopilot and shipping lean on (ten live lanes per PR).

### arena (`skills/arena/SKILL.md`)
- **Does.** N parallel candidates at the same task, parent picks a base, grafts good ideas from losers, verifies.
- **Phases.** Frame (artifact, 3-6 gradeable rubric criteria, runners, per-candidate worktree or `/tmp/arena-<slug>/candidate-<n>/`), Fan out (each writes artifact plus rationale of alternatives rejected), Cross-judge (one read-only judge on a different family, run after candidates finish), Pick (score each against rubric; maintainer-extensibility tiebreak), Graft by hand, Verify.
- **Models.** `arena runners` and `arena cross-judge pool` (user: opus, sonnet).
- **Output.** One synthesized artifact plus a synthesis note (base, grafts and sources, rejections, dropouts, verification result).
- **Done.** Verified synthesized artifact. Divergent candidates mean Phase A was under-specified, so reframe and rerun.
- **Unattended.** Yes. No human gate.

### architect (`skills/architect/SKILL.md`, `references/runner-prompt.md`, `rationale-template.md`, `design-red-flags.md`)
- **Does.** Design before code: types, signatures, module boundaries with `not implemented` bodies. Throw out the sketch if implementation shows a pattern of friction.
- **Phases.** Ground (runs `how`, and `why` if redefining ownership), Sketch (runs `arena` with `architect runners`; at least two structurally distinct candidates; screened against red flags and interface depth), Agree (opt-in human checkpoint, default off), Implement (sketch is the contract; deviations reconciled into the same design artifact), Scrap (rerun `how`, redesign, return to Sketch).
- **Models.** `architect runners` (user: opus, sonnet).
- **Output.** Type sketch file or module map plus rationale doc (includes usage sketch, "Synthesis decision").
- **Done.** Implementation matches the accepted sketch or a recorded accepted deviation.
- **Unattended.** Yes by default; the checkpoint is opt-in ("/architect with checkpoint").

### tdd (`skills/tdd/SKILL.md`)
- **Does.** Failing regression test first, then the fix. Only when the user asks, or the bug has an obvious cheap test target. Explicitly allows no new test when impractical, falling back to a script or repro.
- **Steps.** Understand, pick narrowest check, write failing test, run it and quote the failure content (not the assertion line) to prove it fails for the right reason, fix, rerun.
- **Output.** Failing-before and passing-after evidence in the reply. No subagents.
- **Done.** The test fails before and passes after. Unattended: yes. Note: this is bug-fix only. It is not a general test-first-for-features skill (feature playbook has no TDD step).

### interrogate (`skills/interrogate/SKILL.md`, `references/{reviewer-prompt,rubric,code-quality-review,lead-judgment}.md`)
- **Does.** Multi-model adversarial code review. No personas; diversity comes from models.
- **Steps.** Scope (diff vs `main...HEAD`), state intent in one paragraph (asks the user if unsure), spawn one read-only `general-purpose` reviewer per entry in `interrogate reviewers` (user: opus, sonnet; default opus/fable/sonnet) with the same filled prompt and rubric, synthesize (consensus, lone findings, disagreements), lead judgment bucketing each finding as Act on / Consider / Noted / Dismissed.
- **Output.** A verdict document (Intent, Reviewers, Act On, Consider, Noted, Dismissed, Agreement Map). **Explicitly does NOT auto-apply changes.**
- **Done.** Verdict presented. No machine-readable pass/fail, so a factory has to parse the "Act On" bucket or wrap it.
- **Unattended.** Mostly; the one block is "If you're unsure about the intent, ask the user".

### babysit (skill `skills/babysit/SKILL.md`; playbook `skills/poteto-mode/playbooks/babysit.md`)
- **Skill (standalone).** Loop over `gh pr view --json ...`. Priority: merge conflicts (fix-merge-conflicts), failing checks (fix-ci), review comments (get-pr-comments; act only on ones it agrees with, mechanical ones fixed, judgment ones replied to), bot comments (triage per `references/bugbot-triage.md`). Pacing via the Claude Code `loop` skill (`gh pr checks --watch` while CI runs, 20-30 min heartbeat when awaiting a reviewer). Stop: all green, comments resolved, merges cleanly, OR 3 fix/push/recheck rounds fail, OR the next fix forces a design choice (then `AskUserQuestion`). `gh pr ready` only when green with no open comments. Never `--no-verify`, never weaken assertions, never mark checks non-required.
- **Playbook (inside poteto-mode, supersedes the skill).** Declares a mode: `drive` (to merge-ready), `background`, `threads-only`, `check` (one status pass). Works only the lowest unmerged PR (merge frontier). One babysitter per stack. Never mutates topology (no rebase/retarget/force-push; reports conflicts upward). Order: conflicts, threads, CI, batched into one push wave. Classifies CI before any retrigger (flake gets one rebuild only; failure in untouched code means stale base). Bugbot triaged skeptically always. Status comes from `scripts/watch-pr/watch-pr`, which emits JSON verdicts: `READY`, `WAITING`, `ADVANCE`, `COMPLETE`, `BLOCKER` (exit codes 2,3,4,6,7), `TIMEOUT` (exit 5). Ends at merge-ready; **babysitting never authorizes merging**.
- **Opening a PR does not start a babysit** (opening-a-pr.md). It starts only when the user asks, normally after a whole stack exists. Exception: Autopilot owners.
- **Unattended.** Yes up to merge-ready; stops at owner approval ("a wait, not a blocker"), conflicts (reported, not resolved), and design-forcing fixes.

### fix-ci (`skills/fix-ci/SKILL.md`, 30 lines)
- **Does.** Resolve PR, `gh pr checks --json name,bucket,state,workflow,link`, read first actionable error from Actions logs (or the check link for external services), smallest safe fix, push, recheck, repeat until green.
- **Output.** Failing job and root error, fixes in order, current status. One failure at a time. No retry cap and no flake classifier here (those live in the babysit playbook step 7). Unattended: yes.

### get-pr-comments (`skills/get-pr-comments/SKILL.md`, 20 lines)
- **Does.** Fetch review plus discussion comments for the active PR, group by severity and actionability, return a prioritized action list and open questions. Read-only summarizer. It does not reply, resolve threads, or edit. (Thread replies are in the babysit playbook via `gh api .../replies` with a JSON file.) Unattended: yes.

### make-pr-easy-to-review (`skills/make-pr-easy-to-review/SKILL.md`)
- **Does.** Reviewability pass: inspect commits, diff size, generated files, description. Propose a plan, then reorder commits in dependency order (schema, core, wiring, UI, tests), verify `git rev-parse HEAD^{tree}` is unchanged before push, and add TL;DR, core vs mechanical file split, risk and rollout notes. Recommends splitting rather than polishing if too large.
- **Gate.** History rewrite only when the user asks or agrees to the plan; "propose a plan before rewriting history or force-pushing". This is a human gate in the text (a factory must replace it with a policy: own-branch only plus tree-identity check).

### automate-me (`skills/automate-me/SKILL.md`)
- **Does.** Builds a personal `<handle>-mode` skill from the user's working style: mine transcripts (parallel subagents over `~/.claude/projects/<encoded-cwd>/*.jsonl`, 2-4 week slices), interview via `AskUserQuestion`, cluster, author via `plugin-dev:skill-development` + `unslop`, iterate with the user, land via worktree + PR.
- **Relevance.** Not part of the delivery lifecycle. Interactive and human-in-the-loop by design. Useful only as the way to capture a team's conventions into a skill the factory then loads. Not unattended.

### show-me-your-work (`skills/show-me-your-work/SKILL.md`, `scripts/log.sh`, `references/decision-log-template.tsv`)
- **Does.** Append-only TSV decision log: `ts, phase, decision, why, evidence, result` (single-line cells; evidence is a pointer: SHA, PR, file:line, artifact). `log.sh` stamps, writes the header, strips tabs, neutralizes CSV-injection prefixes.
- **Location.** `decisions.tsv` in the work dir, or `.audit/<slug>.tsv`; not committed by default, committed when the reviewer needs the trail.
- **Rules.** Append-only (supersede wrong rows). Each agent run opens with a `start` row. At end, audit the log against the run's transcript (`~/.claude/projects/<encoded-cwd>/`). Then spawn a cross-family reviewer to flag weak evidence and risky choices. Reply ends with an "Attention" section naming the reviewer model.
- **Unattended.** Yes. This is the artifact that lets a human review afterward. It is the best candidate for a factory's audit/event log.

### blast-radius (`skills/blast-radius/SKILL.md`)
- **Does.** Find what a change breaks outside the diff. Core idea: find the one fact the change is safe because of and prove it by running real code (script/test), grading confidence from "you said so" to "reproduced in the running app".
- **Steps.** Read the change, find the load-bearing fact, look where grep stops (library source, pinned versions, wire formats, timing), rate each risk, prove the fact, and for big changes run it as an `arena`.
- **Output.** Writeup: what it does, the one fact (proven or marked unproven), risks with file:line, cleared items, "before you merge" repro/script. Also meant to run before design when a brief asserts something about existing code.
- **Unattended.** Yes. Read plus script execution. Output is prose, not a gating verdict.

## 3. Supporting playbooks the lifecycle depends on (read for the chain)

- **Feature** (`playbooks/feature.md`): `how`, `architect`, throughput checkpoint (four todo items), delegate coding to a subagent on the feature model (or `arena` if multiple valid shapes), verify on the matching surface, rebase into small ordered commits, `interrogate` if contested, Opening a PR. Parent leads, subagent codes.
- **Bug fix** (`playbooks/bug-fix.md`): reproduce yourself via the driver skill, binary-search cause (uses `how`, `why`, `loop`), `architect` if crossing a function boundary, delegate fix, verify on same surface, stage the failing repro before the fix (`tdd`), Opening a PR.
- **Opening a PR** (`playbooks/opening-a-pr.md`): worktree off main, small ordered commits, `/deslop`, `/no-comments`, `/technical-writing` + `/unslop`, Conventional Commits titles, body sections Why / What changed / Scope / Tradeoffs / Blast Radius / Verification, ready (never draft), prefer many narrow PRs and stacks, forge = `gh` (or `origin` CLI if present). A subagent that opens a PR runs interrogate + deslop + no-comments and returns without babysitting.
- **Shipping** (`playbooks/shipping.md`, `scripts/watch-pr/ship-pr`, `references/merge-safety.md`): requires user's landing authority. One independent verifier subagent per PR (not the author) returns `PASS`/`PASS+NOTES`/`FAIL`, records head SHA, base SHA, `git patch-id`. Lands only the contiguous verified run bottom-up. Cancels pending auto-merges before topology changes. Merges with `gh pr merge --squash --match-head-commit <sha>`. Arms `--auto` only if repo rules enforce verification gates. Never `--admin`. Confirms landing by reading merge commit in destination history.
- **Autopilot-full** (`playbooks/autopilot-full.md`): one background owner per PR (own worktree) carries build, first push within ~15 min, ready PR, self-proof, bot triage, deslop, no-comments, rebase, babysit-to-green. Root runs a swarm (ten-ish lanes incl. live lane and regression-vs-trunk lane) at the code-ready SHA. Clean verdict plus the **operator's explicit merge click** are both required. Hourly audit tick via `/loop`. Operator stop means zero writes.
- **Autopilot-stack** (`playbooks/autopilot-stack.md`): same but delivers one linear reviewed stack that the operator lands.
- **Orchestrate** (`playbooks/orchestrate.md`, `scripts/orch/{orch.ts,store.ts}`): standing multi-day program; coordinator never writes code, authors briefs, drains completion events from an inbox, workers and verifiers (different model family from the worker) are background subagents, state in an `orch` CLI store under `~/.claude/orchestrate/<slug>/`. Coordinator may land verified work itself. Hard-coded swarm trees "tried and parked as too rigid".
- **Multi-phase plan** (`playbooks/multi-phase-plan.md`, `scripts/check-plan.mjs`): produces a plan document (one section per PR with Depends on / Files / Build / You see / Verify unit-live-perf / Review gate / Merge sub-blocks), linted by `check-plan.mjs`. Hands back and stops. Execution starts on the operator's explicit go.
- **Autonomous run** (`playbooks/autonomous-run.md`): exit predicate stated as a checkable predicate, wake mechanism via `loop` (watcher subagent for events, heartbeat fallback), smallest change per iteration, mid-run discoveries handled without asking, checkpoints via show-me-your-work, never relax the predicate.
- **Other utilities.** `fix-merge-conflicts`, `deslop`, `no-comments` (spawns `comment-sicko`), `technical-writing`, `unslop`, `create-verification-skill` / `maintain-verification-skill` (project-local driver skill that drives the app like a user; poteto-mode says UIs use `.claude/skills/verify/` or fall back to the built-in `run` skill), `how`, `why`, `reflect`, `recall`.

## 4. How they chain into a lifecycle

```
[intake: human prompt]  -- (no pstack skill)
   |
poteto-mode router ----------> picks playbook (Feature / Bug fix / Refactor / figure-it-out / Orchestrate)
   |
   |-- multi-phase-plan   : plan doc (large work), linted by check-plan.mjs, STOPS for operator "go"
   |-- how (+ why, blast-radius) : ground the system
   |-- architect (-> arena -> N runners + cross-judge) : design sketch, optional interrogate on the sketch
   |-- throughput checkpoint -> delegate to poteto-agent on feature/bug-fix model (or arena for impl shapes)
   |-- tdd (bug fixes with cheap test path) : failing test first
   |-- verify on real surface via driver skill (verify / run / create-verification-skill)
   |-- show-me-your-work : decisions.tsv throughout, cross-model audit at end
   |
   |-- deslop, no-comments, interrogate (multi-model review, verdict only), make-pr-easy-to-review
   |-- Opening a PR : worktree, ordered commits, technical-writing/unslop body, ready PR
   |
   |-- babysit playbook (drive) : watch-pr -> fix-merge-conflicts / get-pr-comments / fix-ci / bugbot-triage
   |       loops until watch-pr says READY (merge-ready)
   |-- Shipping (or Autopilot swarm verification) : independent PASS verdict per PR, patch-id pinned
   |-- merge : guarded gh pr merge --match-head-commit, confirm landing        <-- needs explicit authority/operator click
```

Orchestrate (standing program) and Autopilot-full/-stack wrap the middle-to-end of this chain across many PRs: they own per-PR owners, parallelism, hourly audit ticks, and verification swarms.

Mapping to the user's stages:

| Factory stage | PStack coverage |
|---|---|
| Intake | None. Human prompt or the session itself. `Session pickup` can resume from a transcript, cloud-agent URL, or pushed branch. |
| Spec | Partial: multi-phase-plan (plan doc), figure-it-out Phase A (falsifiable predicate), `writing-prds` is NOT pstack. architect rationale as design spec. |
| Implement | Strong: Feature / Bug fix / Refactoring playbooks, architect, arena, tdd, swarm. |
| Verify | Strong on principle (prove-it-works, driver skill, swarm lanes, blast-radius), but depends on a per-repo driver skill existing. |
| Review | interrogate (multi-model, verdict only), no-comments, deslop, Shipping's independent verifier. |
| PR | Opening a PR playbook, make-pr-easy-to-review. |
| CI | fix-ci, babysit (watch-pr verdict machine). |
| Merge | Shipping (guarded merge), but defaults to operator click. |

## 5. Can it run unattended? Where it blocks on a human

Designed to avoid blocking: `never-block-on-the-human`, `Autonomous run`, "Don't park reversible work for the human or use `AskUserQuestion`" (autonomous-run step 4), full-autonomy grants. The blocks that remain, by design:

1. **Merge.** Autopilot-full: "nothing merges without both your clean swarm verdict and the operator's explicit merge click". Babysit "never authorizes merging". Shipping "requires the user's landing authority". Landing needs an explicit phrase ("merge", "land", "ship", "merge when ready").
2. **Irreversible actions** (poteto-mode Always pause): force-push to shared branches, deploys, data deletion, customer messages.
3. **Plan approval.** multi-phase-plan hands back and "execution starts on the operator's explicit go". Autopilot-full step 1 "state-then-wait".
4. **Babysit exits to the human:** 3 failed fix rounds; a fix that forces a design choice (`AskUserQuestion`); owner approval wait; merge conflicts (reported to the owner, not resolved by the babysitter).
5. **Interrogate** Step 2: asks the user if intent unclear. **make-pr-easy-to-review**: asks before history rewrite. **automate-me**: fully interactive. **architect**: checkpoint is opt-in only.
6. **figure-it-out:** one framing checkpoint for multi-hour runs.
7. **Bug-fix step 1:** may ask the human to reproduce only with a stated reason the control surface cannot reach the target.
8. **Genuine product/preference calls** that no experiment can settle (poteto-mode).

## 6. State, artifacts, and persistence

- Todolist (in-session) or `todo.md`.
- `decisions.tsv` / `.audit/<slug>.tsv` (show-me-your-work).
- Plan docs under `~/.claude/orchestrate/<slug>/docs/`; `orch` store under the same agent store (units, boards, verdicts, standing orders, inbox pointers, open gates; see `scripts/orch/store.ts`).
- arena/swarm outputs under worktrees or `/tmp/arena-<slug>/`; synthesis notes.
- PR comments carrying verdicts (Shipping posts each verifier's PASS/FAIL on its own PR; patch-id/SHAs recorded).
- Transcripts in `~/.claude/projects/<encoded-cwd>/` (used for audit and `resume.mjs` / `references/resume-storage.md`).
- Project-local playbooks: `.agents/playbooks/*.md` with frontmatter `extends` and `when`, validated by `check-playbooks.mjs`. This is the sanctioned extension point for a factory.

## 7. Gaps a fully automated factory would need to fill

1. **Intake and triage.** Nothing turns an issue, ticket, Slack message, or alert into a task. No Linear/GitHub Issues/Jira adapters, no dedupe, no prioritization, no sizing, no "is this worth doing" gate. Needs an intake service that creates a work item and picks the playbook (the router is prompt-driven today and keyed to natural language).
2. **Spec stage.** No requirements/acceptance-criteria skill. figure-it-out Phase A and multi-phase-plan ask for a falsifiable predicate, but nothing elicits or validates it from a stakeholder, and nothing writes a machine-checkable acceptance test suite from a spec. (The user has `writing-prds` and `convex`/other skills outside pstack.) Needs a spec artifact schema and an approval policy (auto-approve below some risk tier).
3. **Durable orchestrator / scheduler.** All control flow is an LLM following markdown inside a session. No queue, no daemon, no retries, no crash recovery beyond `Session pickup`/`Pause safely` (manual), no concurrency limits or budget/cost caps, no timeouts. `/loop` and the `watch-pr` watcher are session-bound. `orch` is a state store, not a runner ("The CLI never spawns, waits, or wakes anything"). A factory needs an external runner (for example T3 Code threads plus scheduled tasks) that owns the state machine and re-enters the agent at each stage.
4. **Machine-readable stage outputs.** Most skills end with a prose reply. `interrogate` verdicts, `blast-radius` writeups, `swarm` tables, `arena` notes, and `show-me-your-work` Attention sections are all human-formatted. Only `watch-pr` (JSON verdicts and exit codes), `ship-pr`, `orch --json`, and `check-plan.mjs` are programmatic. A factory needs JSON schemas for verdicts (act-on count, severity, PASS/FAIL, risk tier) so a controller can gate transitions.
5. **Merge authority policy.** Merge is deliberately human. A factory needs an explicit, auditable auto-merge policy: risk tiers, required green checks plus PASS verdict plus no Act-On findings plus bot review clean plus blast-radius under a threshold, and repo rules that enforce those gates (Shipping step 8 insists on durable gates and never changing protection settings). Also the "explicit phrase" trigger must become a policy grant the controller injects.
6. **Verification infrastructure.** Everything rests on a per-repo driver skill (`.claude/skills/verify/`, from `create-verification-skill`). If a repo lacks one, live verification degrades to "risk in Appendix C". A factory needs this provisioned at repo onboarding, plus ephemeral environments and secrets (the real-surface lanes need a running app, simulators, test data).
7. **Review that blocks.** `interrogate` does not auto-apply or block. There is no loop of review -> fix -> re-review with a convergence criterion, and no reviewer calibration or false-positive tracking beyond `bugbot-triage.md` rubric additions.
8. **CI/forge coupling.** Hard-wired to GitHub `gh` (plus optional `origin` CLI); `watch-pr` is GitHub-only. No GitLab/Bitbucket. `fix-ci` has no cap or flake memory; the cap and classifier live in babysit text. No handling of external check providers beyond reading the link.
9. **Post-merge.** No deploy, canary, rollback, release notes, or production monitoring skill. The "Deploying to a managed platform" rule only says to load that platform's skill, and deploys are an always-pause item. Needs deploy and post-deploy verification stages plus an incident feedback path into intake.
10. **Observability and cost.** `decisions.tsv` is a per-run local file, not an event stream. No cross-run dashboard, token and cost accounting, per-stage latency, or SLOs. `orch` has `status` but no metrics export.
11. **Isolation and multi-tenancy.** Worktree-per-writer is a convention, not enforced. No sandbox/permissions policy per stage; subagents get full tools including MCP. Needs least-privilege per stage and secret handling.
12. **Context and memory across items.** `recall` / `reflect` / `bugbot-triage.md` rubric exist but nothing automatically feeds lessons back to subsequent work items; `encode-lessons-in-structure` is a principle, not an automation.
13. **Model dependency drift.** Plugin defaults reference `fable` while the user's sheet uses opus/sonnet; slugs fall back at runtime on rejection. A factory should pin and test model config. Subagent depth limits (poteto-mode notes "a subagent forbidden to spawn") mean some playbooks silently collapse to single-agent mode.
14. **Prompt-compliance risk.** Quality hinges on the LLM faithfully following 25 KB of router instructions and copying playbook steps verbatim. Only `check-plan.mjs` and `check-playbooks.mjs` mechanically enforce structure. Anything else is honor system, so a factory should add external checks (PR body lint, trailer checks, required-file checks) at stage boundaries.

## 8. Practical recommendation (for composing the factory)

- Treat PStack as the **worker-side library** (implement/verify/review/PR/CI), driven by an external controller that owns the state machine, intake, spec approval, merge policy, and deploy.
- Per stage, the best-fit entry points: Spec = figure-it-out Phase A or multi-phase-plan (+ own intake adapter); Implement = poteto-mode Feature/Bug-fix playbook (architect + arena where design is contested; tdd for bugs); Verify = swarm with the repo's driver skill + blast-radius; Review = interrogate + deslop + no-comments; PR = Opening a PR; CI = babysit `drive` mode or `watch-pr` directly; Merge = Shipping steps 2-10 with a policy-granted authority; Audit = show-me-your-work.
- Extend via `.agents/playbooks/<name>.md` with `extends:` and `when:` rather than forking the plugin, and run `check-playbooks.mjs` in CI.
- The Autopilot-full structure (one owner per PR, root keeps verdicts, hourly audit tick) is the closest existing blueprint for a factory; its only human-in-the-loop is the merge click.
