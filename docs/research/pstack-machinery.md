# PStack machinery: principles, utility skills, hooks, config, scripts, pi

Root: `/Users/jan/.claude/plugins/cache/pstack-claude/pstack/0.9.69/` (called `$P` below). This is michael-denyer's Claude Code port of Lauren Tan's pstack. README says "no server or telemetry"; everything is local Markdown plus a few local scripts.

## 0. Shape of the plugin

- `$P/.claude-plugin/plugin.json` registers only agents (12 files). Skills are auto-discovered from `$P/skills/*/SKILL.md`. Hooks come from `$P/hooks/hooks.json`.
- `$P/skills/` has 50ish skills. `poteto-mode` is the hub: a 25 KB SKILL.md with a routing table, the inline principles index, an Autonomy section, a Subagents section, a Models section, `playbooks/*.md` (27 files), `references/`, and `scripts/`.
- Every skill is plain Markdown with `name`/`description` frontmatter. "Public" skills appear as `/pstack:<name>`. Principle skills set `user-invocable: false`.
- The runtime model is: the agent reads Markdown, follows it, and spawns subagents via the `Agent` tool. Nothing is a deterministic workflow engine except the small TS/JS scripts in section 6.

## 1. Principle skills (`$P/skills/principle-*/SKILL.md`, 22 of them)

How they are meant to be used: NOT invoked directly by users. They are leaf references. `poteto-mode/SKILL.md` has a Principles index (lines ~44-82) that gives, per principle, "when it applies". The rule (Non-negotiables): "Read the leaf skill in full for any principle you apply", then in the reply "name each principle that shaped a decision and the specific choice it changed", citing only principles whose leaf you read this session. Other skills cite them by name or relative link (typescript-best-practices -> type-system-discipline and boundary-discipline; benchmark-checklist -> explain-the-number; no-comments -> fix-root-causes and redesign-from-first-principles; reflect -> encode-lessons-in-structure; attack-the-premise -> fix-root-causes, build-the-lever). Subagents of type `pstack:poteto-agent` are forced to read poteto-mode SKILL.md in full (including the index) and "navigate to a leaf principle whenever you apply it" (`$P/agents/poteto-agent.md`).

Summaries (from frontmatter and the poteto-mode index):

Core
- build-the-lever: for any non-trivial work, build the tool (codemod, script, generator) that does or proves the work; the tool is what a reviewer reruns.

Architecture / design
- laziness-protocol: bias to deletion and the smallest change; resist new abstractions/layers.
- foundational-thinking: name core types/data structures and what concurrent actors share before writing logic.
- redesign-from-first-principles: integrate a new requirement by redesigning as if it had been there from day one.
- attack-the-premise: after 2+ fixes sharing an assumption fail the same gate, state the assumption and run an observation that can falsify it.
- subtract-before-you-add: remove dead weight first, then build on the simpler base.
- minimize-reader-load: count layers/hidden state, collapse one-caller wrappers, shrink mutable scope.
- outcome-oriented-execution: planned rewrites converge on the target architecture; no throwaway compat states.
- experience-first: product/UX tradeoffs favor user delight over implementation convenience.
- exhaust-the-design-space: for novel decisions build 2-3 competing prototypes and compare.

Code-level
- model-the-domain: encode domain in a structure (state machine, typed model, registry, reducer) not scattered conditionals. Required "name the data shape first" for any code.
- boundary-discipline: validate at system boundaries only; trust internal types; keep logic pure.
- type-system-discipline: make illegal states unrepresentable, brand primitives, parse at boundaries, exhaustive variants. Largest principle file (4.9 KB); its companion is typescript-best-practices.
- make-operations-idempotent: commands/lifecycle steps converge to same end state under crash/retry.
- migrate-callers-then-delete-legacy-apis: new internal API + migrate all callers + delete old, one wave.
- separate-before-serializing-shared-state: eliminate sharing of file/branch/key among concurrent actors before adding locks.

Verification
- prove-it-works: verify against the real artifact, not a proxy.
- fix-root-causes: reproduce first, ask why to the root.
- sequence-verifiable-units: break work into units that each end in a check; stack commits/PRs so the sequence proves itself.
- test-behavior-not-implementation: pick a relevant defect and check the full test arrangement would detect it.
- explain-the-number: before trusting a measured number, find its limiter and rule out measuring the wrong thing (paired with benchmark-checklist).

Delegation / meta
- guard-the-context-window: route bulk output to subagents, keep summaries in main thread.
- never-block-on-the-human: on reversible work proceed and present; don't ask.
- encode-lessons-in-structure: when writing the same instruction twice, make it a lint/flag/runtime check/script instead.

Factory relevance: the principles are the "house style" layer. For a factory, `never-block-on-the-human`, `prove-it-works`, `sequence-verifiable-units`, `separate-before-serializing-shared-state`, `make-operations-idempotent`, `guard-the-context-window`, and `encode-lessons-in-structure` are directly about unattended pipelines. They work by being injected as reading material, so they are soft constraints; enforcement is the agent's compliance (plus the "name the principles you used" reply rule as a weak audit hook).

## 2. Utility skills

Quality gates (reusable as pipeline stages)
- `deslop` (`skills/deslop/SKILL.md`, 719 B): diff vs main; strip AI slop (extra comments, abnormal defensive checks, `any` casts, deep nesting). Keep behavior; summary 1-3 sentences. Cheap pre-commit pass. poteto-mode: "Before commit -> deslop".
- `no-comments` (2.7 KB) + `agents/comment-sicko.md`: spawns the `pstack:comment-sicko` subagent over a diff, which deletes comments (exceptions: license headers, external-constraint gotchas, prettier-ignore, public API docs, RFC links) and reports `MUST KILL` flags on code whose surprise a comment papered over. The parent then audits the report (rejects scope escapes, application-code edits), fixes root causes (optionally via `/architect`), and offers to encode "do not remove" constraints as lints/tests. One rejected rerun then fail. poteto-mode: "Before review -> no-comments". This is the most pipeline-ready gate: has a pass/fail outcome and a structured report (deletion count, MUST KILL list, open constraints).
- `thermo-nuclear-code-quality-review` (13.5 KB): harsh maintainability review; "code judo" restructuring, giant files, spaghetti-condition growth. Heavy; suited as an optional review stage, not every PR.
- `test-audit`: NOT in pstack. It is a separate user skill at `~/.claude/skills/test-audit` (symlink to `~/.agents/skills/test-audit`, with CAMPAIGN.md). Three modes: authoring gate (4 questions: behavior protected, credible regression, why not already covered, needs a test-only production seam?), audit of junk tests (a 15-item junk-pattern list), and campaign mode for pruning a subsystem. Good fit to wire in as a "tests are worth keeping" gate. Complements pstack `principle-test-behavior-not-implementation` and `tdd`.
- `typescript-best-practices` (2.7 KB): rule table (discriminated unions, brands, no `as`, exhaustive `never`, schemas before guards, etc.). Has `paths: ["**/*.ts","**/*.tsx"]` frontmatter so Claude Code auto-loads it when TS files are touched; this is the one skill using path-scoped auto-activation, a pattern worth copying for per-language rules.
- `benchmark-checklist` (5.4 KB): 7 questions (why not double, tuned?, broke limits?, errors?, repeatable?, matters?, did it happen?) to vet any perf number before reporting. Perf-gate for factory only if perf claims are in scope.
- `fix-merge-conflicts` (988 B): detect conflicts, minimal resolution, regenerate lockfiles via package manager, compile/lint/test, stage; never push/tag. Small recipe; usable as a CI/merge step. (Note: Babysit playbook treats a conflict as "report, don't resolve" when it needs rebase on a stack; this skill is for plain merge conflicts.)

Verification harness generators
- `create-verification-skill` (6.4 KB): interviews the repo (surface, run, drive, observe, isolate) then writes a project-local `.claude/skills/verify/SKILL.md` (Launch, Doctor, Drive, Evidence, Cleanup, Helpers) plus `features/README.md` + one file per feature (template in `references/feature-map-example/`). Naming it `verify` overrides Claude Code's bundled `/verify` (requires Claude Code 2.1.200+), so every playbook that says "the driver skill" calls it. Must run itself end to end before handoff ("a generated skill that was never executed is a draft"). KEY factory building block: it produces the per-repo "prove it works like a user" step.
- `maintain-verification-skill` (5.1 KB): periodic upkeep. Outcomes clean/changed/blocked. One read-only subagent per feature file (source wave), one coordinator live pass over every feature (doctor-before-drive, evidence survives cleanup, no residue), triage into doc drift / harness gap / product gap, at most one PR of proven corrections; only edits the verify skill's own directory. Natural scheduled job in a factory.

Learning loops
- `reflect` (6.9 KB + `references/{judgment,tooling,divergent}-reviewer.md`, `synthesizer.md`, `scripts/find-transcript.mjs`): finds the active transcript under `~/.claude/projects/<encoded-cwd>/`, fans out 3 parallel reviewers (judgment, tooling, divergent) with MCP access, a synthesizer returns Accepted/Rejected/Backlog, then a "structural enforcement check" moves anything lintable out of Accepted into Backlog, then PRESENTS the list and WAITS for explicit user approval before editing any skill ("Skill changes affect every future agent. Do not auto-apply."). Edits route to `plugin-dev:skill-development`. Backlog items go to "your devex tracker" (unspecified). Factory use: run after each pipeline run on its transcript; the human-approval gate would have to be replaced by a policy (e.g., open a PR against the skills repo instead of editing in place). `find-transcript.mjs` is reusable on its own (streams JSONL, handles 3 layouts) and is also imported by `worktree-audit.mjs`.
- `recall` (5.8 KB): rebuilds working context from own chat history (parallel cheap-model subagents, time-windowed, default 7 days, current workspace only) plus the "shared record" via `why`'s source investigators (git, issue tracker, chat, docs, error tracker), verified against `git`/`gh`. Output contract: Capsule (<=5 bullets), Threads (status tags `[merged #N]`, `[open PR #N]`, `[in flight branch]`, `[verified, uncommitted]`, `[reverted #N]`, `[planned, not started]`), Problems (<=5), Next move. Useful as the "resume a stuck factory job" input; pairs with the `session-pickup` and `pause-safely` playbooks.
- `correct` (2.4 KB): "find the mistakes agents keep repeating and make each impossible". Hierarchy: architecture > types > lint whose error names the fix > tests > docs last. Prove each check fails on a real past mistake; keep a rule->enforcer table in the agent instruction file; exceptions need reason + expiry + human approval. This is the closest thing to a self-hardening loop: reflect edits skills, correct hardens the repo.
- `teach` (5.7 KB): composes `how` + `why` into one plain explanation. Human-facing; low factory value.
- `how` (4.5 KB; `references/explorer-prompt.md`, `explainer-prompt.md`): read-only architecture explanation; complex questions fan out 2-4 explorers (role `how explorer`, readonly) then an explainer. Good "spec grounding / codebase mapping" stage and also "where should this live" placement questions.
- `why` (11.9 KB; `references/epistemics.md`, `investigator-prompt.md`, `source-playbook.md`, `synthesizer-prompt.md`, `sources/`): discovers available MCPs and queries each evidence category (source control, issue tracker, docs, chat, observability, error tracking, analytics) in parallel; synthesizer must follow a confidence framework. Slow; good for intake enrichment on bugs/regressions.
- `bro` (282 B): "restate your last message plainly". Trivial.
- `what-did-i-get-done` (1 KB): summarize own authored commits over a time window (excludes merges/uncommitted). Cheap reporting job (standup/digest) a factory could emit.

Writing
- `unslop` (6 KB): numbered rules (ids are stable and cited by other skills, e.g. "rule 14" no colon connector) that strip AI tells. poteto-mode makes it mandatory for any prose surface including the reply. Description says "Must always apply".
- `technical-writing` (9.8 KB): four layers (Diataxis mode, Google developer style, STE, Global English) plus "vary the rhythm". For docs, RFCs, PR descriptions, commit messages.
- Both are strong candidates for the PR-description / commit-message stage of a factory.

Setup
- `setup-pstack` (9.5 KB): see section 4.

Related (outside my slice but wired in): `make-pr-easy-to-review`, `get-pr-comments`, `fix-ci`, `babysit`, `blast-radius`, `show-me-your-work` (decision trail), `tdd`, `architect`, `arena`, `swarm`, `interrogate`, `figure-it-out`, `automate-me`.

## 3. Hooks (`$P/hooks/`)

- `hooks.json` (Claude Code): single `SessionStart` hook, matcher `startup|resume|clear|compact`, command `"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh" claude`.
- `codex-hooks.json`: same with arg `codex` and a `commandWindows` that runs `session-start.ps1`.
- `session-start.sh` (POSIX sh): picks the sheet (`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pstack-models.md` or `${CODEX_HOME:-$HOME/.codex}/pstack-models.md`), strips BOM/CR, and if a line exactly equals `session hook: off` it exits 0 injecting nothing. Otherwise it `cat`s `hooks/session-start-context.md` to stdout (which Claude Code adds to context).
- `session-start-context.md` injects an `<EXTREMELY_IMPORTANT>` block: "You have pstack. Invoke `pstack:poteto-mode` when a task (a) touches more than one file or changes a shared signature, (b) involves a design/architecture choice, or (c) is a bug with unknown cause or a perf issue." Smaller tasks are done directly. When intent is specific, enter that skill directly (`tdd`, `architect`, `how`, `why`, `arena`, `interrogate`). User instructions (CLAUDE.md etc.) win; other mandates (e.g., superpowers) still apply.
- No PreToolUse/PostToolUse/Stop hooks. PStack ships no hard guardrails (no command blocking, no stop-gate). Enforcement is by instruction only. A factory wanting hard gates (e.g., refuse `gh pr merge`, require green verify before PR) has to add its own hooks in settings.json or the plugin's hooks.json.
- Note: the hook does not run for subagents (pi/prompt.ts comment says "SessionStart does not run for subagents"), which is why `poteto-agent` exists: it re-reads poteto-mode SKILL.md itself.

## 4. Model and effort configuration

Three layers:

1. `$P/models.json` (build-time source): `tiers` default=opus, strongest=fable, panel=[opus,fable,sonnet]; `efforts` low..max; `defaultEffort: session`; `available` [opus,fable,sonnet,haiku]; a `roles` list (role name -> tier -> owning skill); plus `codex` (gpt-6-sol/astra/luna) and `pi` (provider -> alias -> full model slug for anthropic/openai/openai-codex) maps. The comments in every SKILL.md say "stamped from plugins/pstack/models.json (edit there, rerun tools/generate.mjs)", i.e. the "Models" section at the bottom of each SKILL.md is generated. `tools/generate.mjs` is NOT in the installed plugin, so editing models.json in the cache does nothing; it is documentation of the upstream source of truth.
2. Per-skill "Models" section (defaults baked into the SKILL.md text).
3. Override sheet `~/.claude/pstack-models.md` (runtime). Loaded via `@/Users/jan/.claude/pstack-models.md` in `~/.claude/CLAUDE.md`, so the sheet is just context the agent reads; the skills tell the agent "Set `model` to that role line's value, or the default if the line is missing; leave `model` unset for `inherit-parent`/`auto`; if the Agent tool rejects a slug, use the default and say so". So routing is done by the LLM following text, not by code (except in Pi, see section 7).

Role lines currently in the user's sheet:
```
feature, refactoring: sonnet        bug-fix: opus        perf-issue: opus      hillclimb: opus
judgment and prose: sonnet          strongest judgment: opus
how explorer: sonnet @low           how explainer: sonnet
why investigators: sonnet           why synthesizer: sonnet
reflect tooling: sonnet             reflect judgment, divergent, synthesizer: sonnet
arena runners: opus, sonnet         arena cross-judge pool: opus, sonnet
swarm workers: sonnet               architect runners: opus, sonnet
interrogate reviewers: opus, sonnet
default effort: medium              session hook: on
```
(Shipped defaults map "strongest" to `fable`; this user replaced it with `opus` and dropped fable from the panels.)

Syntax: `model[ @effort]`; panel roles take comma lists, one subagent per entry, alias entries (`inherit-parent`, `auto`) still count toward fan-out; `arena cross-judge pool` picks one entry with a different family from the parent if possible; `swarm workers` is the default for all workers unless a race assigns per-arm models. `default effort` is a level or `session`. `session hook: off` disables the hook.

Effort mechanism: Claude Code's `Agent` tool has no effort parameter, so pstack ships agents that carry `effort:` frontmatter:
- `$P/effort-agents/effort-{low,medium,high,xhigh,max}.md`: tiny prompt "Do the task in your prompt. You have the full tool set. The effort level changes how long you reason, not the task." with `effort: <level>`. Used in place of `general-purpose`.
- `$P/effort-agents/poteto-agent-<level>.md`: same but with the poteto-agent body (read poteto-mode in full). Used in place of `pstack:poteto-agent`.
- Dispatch rule (poteto-mode "Reasoning effort"): `pstack:poteto-agent` -> `pstack:poteto-agent-<level>`; `general-purpose` or none -> `pstack:effort-<level>`. The `model` is still passed separately.
- `$P/agents/poteto-agent.md`: default subagent for playbook steps; `$P/agents/comment-sicko.md` (also duplicated at `skills/poteto-mode/references/agents/comment-sicko.md`, byte-identical) is the deletion-obsessed comment reviewer.

`setup-pstack` (`skills/setup-pstack/SKILL.md`): interactive 8-step wizard: detect models the Agent tool accepts, load current sheet (drops retired roles like `how critics`, rewrites `claude-*` full IDs to family names), confirm mapping via AskUserQuestion, ask default effort and hook on/off, validate, overwrite sheet idempotently, append `@<config>/pstack-models.md` to `<config>/CLAUDE.md`. Also documents sheet locations for Codex (`~/.codex/pstack-models.md`, rows pasted into AGENTS.md), Pi (`$PI_CODING_AGENT_DIR/pstack-models.md`, read by extension), opencode, Gemini CLI.

Factory takeaway: per-role routing can be edited by writing one text file; a factory can pre-seed the sheet for headless runs. Caveat: it is advisory text. For hard cost control, you would set models in your own orchestrator (e.g., the `Agent` call's `model` param or a custom subagent file's `model:` frontmatter) rather than rely on the model honoring the sheet.

## 5. Playbooks (context for extension, from poteto-mode)

`skills/poteto-mode/playbooks/` has 27: investigation, bug-fix, perf-issue, hillclimb, runtime/trace-forensics, feature, refactoring, prototype, visual-parity, authoring-a-skill, eval, babysit, shipping, autonomous-run, orchestrate, autopilot-full, autopilot-stack, session-pickup, pause-safely, multi-phase-plan, worktree-cleanup, opening-a-pr. The agent must open a todolist whose first items are the playbook's steps verbatim (skipped steps stay with `skip: <reason>`). `opening-a-pr` is invoked at the end of every other playbook.

Autonomy section: "Just do it" for reversible work and external actions; "always pause" for force-push to shared branches, deploys, data deletion, customer messages; session overrides like "run until done" keep it going; a "full-autonomy grant" changes how forks are resolved (operator-only calls get a default plus a report). Merge is never authorized by babysit; only an explicit request routes to `shipping`.

## 6. Scripts (`$P/skills/poteto-mode/scripts/`)

There is no top-level `$P/scripts/`. Everything lives here. Bun + TypeScript, `commander` dep, `bootstrap.ts` auto-installs deps on first run keyed by a sha256 of package.json+bun.lock and exits with a message if not running under bun. Tests: `bun test orch watch-pr`; `tsc` typecheck.

- `watch-pr/watch-pr` (bun shebang; `cli.ts`, `github.ts` 901 lines, `policy.ts` 887, `types.ts`, `render.ts`, `deadline.ts`): the PR watcher. Uses `gh`. Modes: `single` (default), `--stack` (list of PRs), `--queued-stack` (frozen bottom-to-top queue). Flags `--owner --repo --pr --interval 60 --status-only --allow-draft --pretty` plus timeout options. JSON output by default. Verdicts: `READY` (terminal, single/stack), `COMPLETE` (terminal, queued), `WAITING` and `ADVANCE` (progress), with merge-state/BLOCKED handling and a four-column status table. This is the deterministic CI/review-state oracle that the Babysit playbook relies on. High factory value: it is a typed, tested polling state machine you can call from a pipeline without LLM involvement.
- `watch-pr/ship-pr` (`shipping-cli.ts`, `shipping.ts`, `landing.ts`): `ship-pr inspect --repo o/r --pr N` emits a parsed landing record (head OID, base branch/OID, auto-merge/merge-queue state); `ship-pr cancel-pending --record file` disables auto-merge/dequeues and verifies both gone on the same revision. Does NOT merge. `references/merge-safety.md` describes capturing remote SHA and using `--force-with-lease` with the recorded SHA before restacking. `live-merge-safety.mjs` is a live check.
- `orch/orch.ts` + `store.ts` (1.6k lines): "plain-file orchestrate bookkeeping" with subcommands `unit`, `ledger`, `inbox`, `gate`, `frontier`, `standing`. Tab-separated files (`units: id track state branch pr sha brief`; `ledger: pr sha verdict evidence verifier ts`), lock file `.orch.lock`, verdict enum includes `live-ui-verified`, `unit-test-verified`, `type-check-only`, `verifier-blocked`. A durable work-queue/ledger for multi-PR programs (Graphite-stack aware via `frontier`). Used by `playbooks/orchestrate.md`. This is the nearest thing in PStack to a factory job store.
- `check-plan.mjs <plan.md>`: lints a multi-phase plan file: each unit needs sub-blocks (Depends on, Files, Build, You see, Verify unit/live/perf, Review gate, Merge), checkboxes, "Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked." Good template for a machine-checkable spec format.
- `check-playbooks.mjs`: validates project playbooks (see section 8): requires `when:` frontmatter, `extends` stems must exist, each `**After**/**Before**/**Replace**/**In** "quoted text"` anchor must appear verbatim in an extended bundled playbook. Detects upgrade drift.
- `resume.mjs`: resume-storage helper (git identity, realpath/containment checks, hashing, atomic rename writes) for pause/resume state; see `references/resume-storage.md`.
- `worktree-audit.mjs [repo] [transcripts...]`: read-only worktree classification (size, merge state, uncommitted work, PR state, last chat that used it); never deletes. Reuses `reflect/scripts/find-transcript.mjs`.
- `skills/reflect/scripts/find-transcript.mjs`: transcript locator (see reflect).

## 7. `pi/` directory

A TypeScript extension for the Pi coding agent (`@earendil-works/pi-coding-agent`), 13 files, ~1.5k lines. Only relevant if PStack is run in Pi; it re-implements what Claude Code provides natively:
- `index.ts` installs: `AgentRunner` (agents.ts), `Scheduler`, one-shot, agent tools, `ask`, schedule, prompt sections, path-skills; stops children on shutdown.
- `agent-tools.ts`: registers an `Agent`-shaped tool with the same params (`description`, `prompt`, `subagent_type`, `model`, `run_in_background`, `isolation: worktree`, `readonly`) so pstack skills run unchanged. `child.ts`/`agents.ts` spawn detached child `pi` processes, track depth via a `pstack-depth` flag, restore on session start.
- `config.ts`: reads `pstack-models.md` from `$PI_CODING_AGENT_DIR`; effort levels, parent-model aliases `inherit-parent`/`auto`; maps model aliases through `models.json` `pi` table (so in Pi the sheet is parsed by code, unlike Claude Code).
- `prompt.ts`: before each agent start injects as system prompt sections the session-start mandate (depth 0 only, unless hook off), the models sheet, the parallel-calls sentence, and a pointer to `references/pi-tools.md`.
- `worktree.ts`: `planWorktree` creates `.claude/worktrees/agent-<id>` on branch `worktree-agent-<id>` for isolated writers, with validation against replaced/linked paths.
- `schedule.ts`: wakeup (60-3600 s) and fixed-interval `/loop` (up to 24 d) delivering prompts as follow-up user messages. `sleep-wait.ts` rejects foreground sleep waits. `ask.ts` = AskUserQuestion shim. `path-skills.ts` = path-scoped skill activation.
This is a useful reference implementation of a headless harness around the same skills (background agents, worktree isolation, scheduling), and shows a model for how a factory could host PStack outside Claude Code. It is not used on Claude Code.

## 8. Extending PStack with custom skills and playbooks

Options, from least to most invasive:

1. Project playbooks (`.agents/playbooks/<name>.md` in a repo): frontmatter `extends: feature, bug-fix` (bundled stems, comma-separated, or empty = standalone) and `when: <one sentence>`. Body is a list of changes starting with `**After**`, `**Before**`, `**Replace**`, or `**In**` followed by a straight-quoted run of the bundled step's own words. poteto-mode loads it when the matched playbook is extended or `when` fits, copies bundled steps into the todolist, then applies changes at the quoted anchors. Run `node <plugin>/skills/poteto-mode/scripts/check-playbooks.mjs` from the repo root first; it fails on dangling extends or stale anchors after a pstack upgrade. This is the officially supported way to inject factory-specific stages (e.g., "After 'Run **Opening a PR**' ... do X") without forking.
2. Project-local skills (`.claude/skills/<name>/SKILL.md`): normal Claude Code mechanism. `create-verification-skill` uses this and relies on name shadowing (`verify`). Use `paths:` frontmatter for auto-activation (as typescript-best-practices does) and `user-invocable: false` for leaf references (as principles do).
3. Custom principles: add a `principle-*` skill and link it, but the index lives inline in poteto-mode/SKILL.md, so a new principle is only discoverable through a poteto-mode edit (or your own project playbook/CLAUDE.md pointing to it).
4. Skill authoring convention (`playbooks/authoring-a-skill.md`): use `plugin-dev:skill-development`; validate frontmatter has name+description, referenced files exist, links resolve; "when in doubt, delete"; delegate to other skills by path, don't restate; encode instead of explaining (`encode-lessons-in-structure`). `reflect` is the automated feeder of such edits.
5. Fork the plugin: edit SKILL.md/playbooks directly. Because "Models" sections are generated by an upstream `tools/generate.mjs` not shipped here, edit them by hand or rely on the override sheet. Plugin cache path includes the version, so edits in `~/.claude/plugins/cache/...` are lost on update; fork the repo (`github.com/michael-denyer/pstack-claude`) instead.
6. Agents: add `.md` files with `name`, `description`, optional `effort`, `model`, tools; register in `plugin.json` `agents` array. Dispatch with `subagent_type: "pstack:<name>"` (the bare name errors; plugin agents are namespaced).
7. Hooks: add to `hooks/hooks.json` (or settings.json) for hard enforcement that PStack itself lacks.

## 9. Reusable building blocks for a software factory (ranked)

Deterministic code (best, no LLM judgment needed):
1. `watch-pr` / `ship-pr` (CI/review state, landing-safety checks).
2. `orch` store (units, verification ledger, gates, frontier, inbox, standing orders) as a durable job ledger with verdict enum.
3. `check-plan.mjs` as a machine-checked spec/plan format (units with Depends/Files/Build/Verify unit+live+perf/Review gate/Merge).
4. `check-playbooks.mjs`, `worktree-audit.mjs`, `find-transcript.mjs`, `resume.mjs`.

Agent-run quality gates (each yields a reportable result):
- verify stage: project `verify` skill from `create-verification-skill`, kept honest by `maintain-verification-skill` on a schedule.
- pre-commit: `deslop`; pre-review: `no-comments`; contested diffs: `interrogate`; deep maintainability: `thermo-nuclear-code-quality-review`; tests: `test-audit` (user skill, not pstack) + `principle-test-behavior-not-implementation`; language rules: `typescript-best-practices` (path-activated); perf claims: `benchmark-checklist`; prose/PR text: `unslop` + `technical-writing`.
- merge side: `babysit` playbook + `watch-pr`, `fix-ci`, `get-pr-comments`, `references/bugbot-triage.md` (fix/dismiss/ask rubric for bot review), `fix-merge-conflicts`, then `shipping` playbook (independent per-PR verdict before anything is armed; contiguous verified run lands bottom-up).

Learning loops:
- Per run: `reflect` (needs its human approval gate replaced by an automated PR to the skills repo) and `correct` (hardening the repo itself); `recall` / `session-pickup` / `pause-safely` for resuming.
- Per period: `maintain-verification-skill`, `what-did-i-get-done`.

Config/customization surface: the override sheet (models, efforts, hook toggle), project playbooks (`.agents/playbooks/`), project skills, hook JSON.

## 10. Gaps and risks to flag

- Model routing, principles, and gates are all prompt-level; nothing blocks a skipped gate. No Stop/PreToolUse hooks. Merge safety relies on playbook text plus `ship-pr`.
- Mentions of tracker integration are generic ("your devex tracker", why's "issue tracker" MCP); there is no built-in intake from Linear/Jira/GitHub issues. Intake and spec stages would be new (candidates: `writing-prds` skill exists globally; `architect`/`figure-it-out` for design).
- `reflect` requires human approval before edits; `no-comments` encoding offers require interactive approval unless the caller pre-approves; Babysit/Shipping explicitly refuse to merge without a user request. A fully unattended factory must pass these as explicit grants (the "full-autonomy grant" language in poteto-mode and `autopilot-full`/`autopilot-stack` playbooks are the sanctioned path).
- Scripts require bun; Windows hook branch exists for session-start only.
- The shipped default for strongest/bug-fix/perf roles is `fable`; this user's sheet maps those to `opus`, so cited defaults differ from live behavior.
- Plugin version path (`0.9.69`) is baked into the cache dir; references like `<plugin>/skills/...` are resolved by the agent, not by `${CLAUDE_PLUGIN_ROOT}` (only the hook uses that variable).
