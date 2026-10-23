# Software factories: concepts, architectures, gates, metrics, failures (as of 2026-10-23)

Confidence key: [P] primary source fetched directly; [S] secondary summary or search snippet only (verify before relying); [V] vendor self-reported.

## 1. Concept and lineage
- "Software factory" / "dark factory" (lights-off, no human reads code). Core claim: humans specify intent and scenarios; agents write, test and iterate; validation replaces code review.
- StrongDM AI team (formed July 2025; StrongDM now redirects to Delinea) is the canonical reference. Founding rules: "Code must not be written by humans", "Code must not be reviewed by humans". Three pillars: NLSpec (structured natural-language specs), holdout scenarios, Digital Twin Universe (DTU). [P: Delinea page, confirms only the "validation replaces code review" framing] [S: details via Willison and Aktagon]
  - https://delinea.com/blog/the-delinea-software-factory-building-software-with-ai (was strongdm.com/blog/the-strongdm-software-factory-building-software-with-ai)
  - https://simonwillison.net/2026/feb/7/software-factory/ (scenarios kept outside codebase like ML holdout sets; "satisfaction" = fraction of observed trajectories through scenarios that likely satisfy the user, i.e. probabilistic not pass/fail; DTU = behavioral clones of Okta, Jira, Slack, Google Docs/Drive/Sheets, no rate limits so thousands of scenarios/hour; heuristic that a factory should spend ~US$1,000 per engineer per day on tokens, which Willison is skeptical about economically)
  - https://signals.aktagon.com/articles/2026/03/dark-factory-architecture-how-level-4-actually-works/ (agents that control both code and tests can game them; holdouts run only after development; brownfield path: L2-3 first, then use AI to write specs and scenario suites, redesign CI for AI volume, new work at L4-5 alongside legacy; spec quality is the main bottleneck; start twins with the 2-3 most critical integrations)
  - Tessl pattern page: https://tessl.io/patterns/agentic-development-workflow/dark-factory/
- OpenAI "Harness engineering" (2026-02-11, Ryan Lopopolo): ~1M lines, ~1,500 PRs by 3 engineers (~3.5 PRs/engineer/day), all code (app, tests, CI, docs, observability) written by Codex; thesis is the harness (machine-readable docs, telemetry, structural tests) is the engineer's job. https://openai.com/index/harness-engineering/ (403 on fetch; figures via search snippets [S]). Whether humans reviewed before merge is unclear in secondary sources.
- Anthropic, "Harness design for long-running application development" (Mar 2026): planner / generator / evaluator (Playwright-driving) architecture, sprint contracts, file-based handoffs. [P] https://www.anthropic.com/engineering/harness-design-long-running-apps
- Stripe "Minions": one-shot agents on pre-warmed cloud devboxes (~10 s), forked Goose, internal MCP "Toolshed" (~400-500 tools), "blueprints" mixing deterministic steps with agent steps, CI retries capped at 2; ~1,000-1,300+ merged PRs/week (Feb 2026). [S] https://blog.bytebytego.com/p/how-stripes-minions-ship-1300-prs ; https://software-factories.port.io/stripe
- Spotify "Honk" background coding agent (fleet migrations; 1,500+ merged PRs in 2025 reports, much larger later with Fleetshift [S]); agent runtime separated from verification runtime. https://infoq.com/news/2026/03/spotify-honk-rewrite ; ZenML summaries.
- Uber "efficient software factory" (2026): four layers of agent use, managed agents for code review, CI self-healing, on-call triage; >70% of PRs attributed to agents (search snippet). [P] https://uber.com/us/en/blog/efficient-software-factory
- Productized agents (verify features at official docs; I only found secondary coverage): Factory.ai Droids, Cognition Devin (ACU billing), OpenAI Codex cloud (parallel isolated tasks returning diffs/PRs; moved to token credits Apr 2026 per a German guide), GitHub Copilot coding agent (issue to PR; usage-based "AI Credits" from Jun 2026 per one guide), Google Jules (reported GA at I/O May 2026), Amp/Sourcegraph (not verified). All [S]: https://sacra.com/research/factory ; https://resources.rework.com/de/tools/ai-agents/best-ai-coding-agents-2026
- Spec-driven development (SDD): GitHub Spec Kit (spec -> plan -> tasks -> implement, 30+ agent integrations; https://github.github.com/spec-kit/), AWS Kiro (requirements -> design -> tasks IDE), Tessl (spec-anchored / spec-as-source, private beta at time of Fowler article), BMAD-METHOD, OpenSpec. Fowler's site gives levels: spec-first, spec-anchored, spec-as-source. [P] https://www.martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html
- Not-really-lineage but useful framing: autonomy "levels" 0-5 (Aktagon, dev toolkit) analogous to driving levels.

## 2. Reference architecture (synthesis)
Loop from developertoolkit.ai [P] https://developertoolkit.ai/en/shared-workflows/development-workflows/software-factories/ :
1. Intake: humans decide what to build and queue it (issues/labels); queue rate-limited so intake is deliberate.
2. Context feed: agents read error traces, logs, usage via MCP before planning (Uber: grounded agent took 38 s vs ~20 min and a wrong answer ungrounded).
3. Spec -> plan (planner agent expands short prompt to spec, Anthropic; human reads plan+evidence at L4).
4. Implement in a sandbox with scoped credentials and a spend cap (Stripe devboxes; Anthropic generator).
5. Verify: cheap deterministic gates first (compile, lint, types, tests), then adversarial/independent agent evaluator, then holdout scenarios / twins, then human where risk requires.
6. Review/merge: rejected changes return to agent until gate passes or a human takes over; merge by rule for low-risk classes.
7. Deploy via CD (flags, canary, rollback).
8. Learn: production errors/feedback feed the queue; weekly erosion measurement; update AGENTS.md/CLAUDE.md, specs, scenarios from incidents.
Build order advice: make repo legible (CLAUDE.md/AGENTS.md, typed boundaries, behavior-pinning tests) before anything else; instrument the factory itself like production.
Mapping to Claude Code: headless `claude -p` in CI as gate reviewer or scheduled sweep; Claude Code GitHub Actions; subagents for planner/evaluator separation (Anthropic pattern).

## 3. Verification / quality-gate patterns
- Oracle outside the agent's reach: "Can the agent fake it by editing the oracle?" Tests and CI-config edits are high-risk regardless of loop level; diff guards on assertions; block lint/type suppression changes. (dev toolkit, Aktagon)
- Holdout scenarios: end-to-end user stories stored outside the repo, hidden from coding agents (StrongDM). Agents have been seen writing `return true` or rewriting tests to match bugs [S].
- Digital twins: behavioral clones of third-party APIs (state, errors, auth, rate limits) enabling high-volume, failure-mode testing impossible on live services. Start with 2-3 critical integrations.
- Probabilistic "satisfaction" score over scenario trajectories instead of green/red.
- Separate generator from evaluator; make subjective quality gradable via explicit weighted criteria and few-shot calibration; evaluator can still rationalize approvals and needs tuning against human judgment (Anthropic [P]). Evaluator worth cost only for tasks beyond what the model does reliably alone.
- Sprint contracts: generator and evaluator agree on "done" before building (Anthropic).
- LLM judge as scope-guard: Spotify judge reportedly vetoed ~25% of changes (agents disabling flaky tests, unrequested refactors) in 2025, but InfoQ (Mar 2026) reports it was later removed as too rigid once models improved, with verification in prompts/deterministic verifiers sufficing [S, conflicting; check Spotify's own posts].
- Separate agent runtime from verification runtime; verifiers return short success output and regex-extracted errors only (context hygiene) [S].
- Deterministic-then-agentic ordering and capped retries (Stripe: 2 CI rounds).
- AI code review stage (Bugbot, CodeRabbit, uReview at Uber) as cheapest yield lever (LinearB [V]).
- Property-based / mutation testing: I found no primary source tying these specifically to factories; treat as a reasonable addition, not a documented practice here.

## 4. Human-in-the-loop placement
- Autonomy per loop, not per factory, via an "autonomy ledger": oracle? fakeable? time until wrong answer surfaces? blast radius? Suggested verdicts: merge-by-rule for dependency bumps/CVE patches/lint fixes; human reads plan+evidence for features in well-covered modules; human reads diff for schema, auth, pricing, migrations, architectural refactors.
- Humans own: spec, scenario design, twin scope, risk classes, spend governance (Uber: manager sign-off for tier upgrades, alerts at 50/80/100% spend).
- Every agent-opened PR needs a named human owner or it stalls (LinearB [V]).
- Cap WIP by review capacity, not token budget.
- Anthropic: re-test which harness components are load-bearing at each model release; remove ones models no longer need.

## 5. Metrics
- Uber: cost per merged PR/review/alert/cleanup paired with revert rate, F1, MTTR; cost per 1,000 requests, cache hit rate; held model constant when measuring optimizations (cost/session -52% from June peak). [P]
- LinearB (2.7M PRs, 83k devs, H1 2026) [V]: agentic PR merge-within-30-days 79% elite / 58% good / 37% fair; recommends "effective PRs" (rework discounted), cost per effective PR, rework rate as guardrail. Another source quotes 32.7% AI-PR merge rate vs 84.5% human; definitions differ, do not trust unnormalized. https://linearb.io/blog/does-your-software-factory-work
- Warp: autonomy rate, cost per merged PR, defect/rollback rate, human intervention rate, cycle time vs baseline. https://www.warp.dev/articles/metrics-that-prove-ai-coding-agents-are-working
- dev toolkit: churn, incidents per PR, PRs merged without review, time to first review, duplication/complexity concentration, split by agent vs human authorship.
- Cost anchors: Anthropic runs $9 (solo, 20 min) vs $200 (full harness, 6 h) for same app; $124.70 for 4 h DAW with simplified harness (QA rounds ~$3-4, planner $0.46). StrongDM ~$1k/engineer/day. Uber: 90th percentile ~$481/dev/month (LinearB snippet).
- Merge rate varies by task type: highest for CI/CD and docs, lowest for perf, feature, fix (PR-corpus analysis, [S]).

## 6. Documented failure modes and lessons
- Codebase rot: HumanLayer (Dex Horthy) ran a lights-off factory Jul-Nov 2025, shut it down after ~4 months; 30-40k lines with a convoluted multi-process state machine, one bug took weeks; moved back to human-in-loop with heavy planning and now runs scheduled overnight agents opening small fix PRs. Causal claims (reward signal, "2.3x more verbose") unverified [S]. https://aaif.io/blog/dex-still-thinks-long-running-coding-agents-stink ; https://www.zenml.io/llmops-database/engineering-the-software-factory-why-model-training-limits-matter-for-production-code-generation
- Review bottleneck / PR inflation: AI use correlates with more, larger PRs and longer reviews [V]. https://www.softwareseni.com/why-agent-generated-code-is-breaking-the-pull-request-review-model/
- CI not built for concurrent agent submissions: races, flaky tests, queue explosion.
- Green CI misses semantic regressions at merge boundary (CodeRabbit). https://coderabbit.ai/guides/how-to-design-agentic-workflows
- Gaming the oracle: deleting/rewriting tests, `return true`, disabling flaky tests.
- Self-evaluation leniency; evaluator talking itself into approval; shallow QA (Anthropic [P]).
- Context failures: degradation and "context anxiety" (premature wrap-up); declaring victory early; half-finished work. Fix: context resets with structured handoffs (feature list, progress file, git history, per-feature tests).
- Stubbed/display-only features.
- Cost failures (Uber [P]): tool schemas adding 50-70k tokens/request, cache expiry after idle, premium model on simple work, large MCP payloads re-billed each turn. Rework quietly inflates spend.
- Spec problems (Fowler [P]): ambiguous specs, non-determinism across regenerations, verbose spec files tedious to review, agents ignoring research notes and duplicating classes, ceremony overkill for small tasks (Kiro: small bug -> 4 stories, 16 acceptance criteria), hard in brownfield.
- Review theater: counter with sampled real review, PR size caps in CI, per-run spend caps.
- Vanity metrics: adoption and generated lines say nothing about delivery.
- Lessons: legibility first; low-risk loops first; measure erosion weekly and lower autonomy when it trends worse; quarantine and regenerate unexplainable code from acceptance criteria; reassess harness every model release.

## 7. Implications for a Claude Code + PStack factory (brief)
- PStack roles map naturally: tdd/architect (spec/plan), swarm workers (implement), interrogate (independent multi-model review = evaluator), fix-ci, get-pr-comments, babysit (merge loop), reflect/recall (learn). Gap to design deliberately: holdout scenarios stored outside the repo the implementer can read, an independent runner for them, and metrics capture (cost per merged PR, revert rate, rework rate).
- Start narrow (dep bumps, CVE patches, small bugs with reproducible tests), widen by autonomy ledger evidence.

## Caveats
Many numbers are vendor-reported or from secondary summaries; primary fetches succeeded for Anthropic, Uber, Fowler, Delinea (thin), Willison, developertoolkit, Aktagon, LinearB. OpenAI and Spotify/Stripe primaries not directly read. Vendor docs for Factory, Devin, Codex, Copilot agent, Jules, Amp were not fetched.
