# Claude Code / Anthropic building blocks for an unattended "software factory"

Research date: 2026-10-23. Sources are official docs at code.claude.com (Claude Code v2.1.3xx era) and anthropic.com/engineering unless noted. Status tags: [STABLE] documented as GA, [BETA], [PREVIEW] (research preview), [EXPERIMENTAL], [UNVERIFIED].

Base docs index: https://code.claude.com/docs/llms.txt

---

## 0. Architecture map (what to use for what)

| Factory stage | Building block | Status |
|---|---|---|
| Ticket intake | MCP (Linear/Jira/GitHub), GitHub Actions triggers, routine API/GitHub triggers | stable / preview |
| Dispatcher / orchestrator | Agent SDK (TS/Python) or `claude -p` from your own queue worker | stable |
| Per-ticket worker | `claude -p --bare` in a worktree inside a container/VM | stable |
| Role specialization | Subagents (`.claude/agents/*.md`), plugins (PStack) | stable |
| Quality gates | Hooks (Stop/PreToolUse/TaskCompleted), CI, separate evaluator agent | stable |
| Review | `code-review` plugin / Code Review / `@claude` | stable |
| Scheduled / event runs | Cloud scheduled tasks ("routines") | PREVIEW |
| Fleet on own infra | Self-hosted environments | BETA (Team/Enterprise) |
| Cost/observability | OTel metrics+events, `--max-budget-usd`, workspace limits | stable (traces beta) |

---

## 1. Headless mode (`claude -p`) [STABLE]

Doc: https://code.claude.com/docs/en/headless

Basics:
```bash
claude -p "Find and fix the bug in auth.py" --allowedTools "Read,Edit,Bash"
cat build-error.txt | claude -p 'explain root cause' > out.txt     # stdin capped at 10MB
```
- Exit code 0 on success, non-zero on failure; SIGTERM -> exit 143 (turn left unfinished, SessionEnd hooks still run). Use SIGINT or SDK `interrupt()` to end the turn cleanly.
- `--bare`: skips auto-discovery of hooks, skills, plugins, MCP servers, auto memory, CLAUDE.md; does NOT read OAuth/keychain, so needs `ANTHROPIC_API_KEY` (or Bedrock/Vertex/Foundry creds). Docs say it is "the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release". Load context explicitly: `--append-system-prompt[-file]`, `--settings`, `--mcp-config`, `--agents`, `--plugin-dir`/`--plugin-url`.
- Warning: without `--bare`, `-p` runs hooks in the repo's `.claude/settings.json` and connects `.mcp.json` servers with no trust dialog. Matters when the repo content is untrusted (https://code.claude.com/docs/en/permissions#what-runs-before-you-trust-a-folder).
- Output formats: `--output-format text|json|stream-json`. `json` result includes `result`, `session_id`, `total_cost_usd`, per-model cost (client-side estimate). `stream-json` needs `--verbose`; add `--include-partial-messages` for token deltas. Last line is a `result` message. `permission_denials` listed on result.
- Structured output: `--json-schema '{...}'` with `--output-format json` puts validated data in `structured_output` (check the field exists; absent if Claude declined).
```bash
claude --bare -p "Extract function names from auth.py" \
  --output-format json \
  --json-schema '{"type":"object","properties":{"functions":{"type":"array","items":{"type":"string"}}},"required":["functions"]}' \
  | jq '.structured_output'
```
- Sessions: `--continue`, `--resume <session_id>` (also accepts a transcript .jsonl path). `session_id=$(claude -p "..." --output-format json | jq -r .session_id)`.
- Permissions in `-p`: since v2.1.302 `-p` starts in Manual mode if nothing sets a mode, so un-allowed actions are denied (no human). Options: `--allowedTools "Bash(git diff *),Bash(git commit *)"` (prefix rule syntax, space before `*` matters), `--permission-mode acceptEdits|auto|dontAsk`, and `--permission-prompts none` (v2.1.259+) so denied requests are not retried and no host is waited on.
```bash
claude -p "Update dependency pins and run tests" --permission-mode auto --permission-prompts none
```
- `dontAsk` = deny everything not pre-approved (locked-down CI). `auto` = classifier reviews each action (classifier calls bill separately: https://code.claude.com/docs/en/auto-mode-classifier-billing.md).
- Limits / budget: `--max-turns` (used in the GitHub Action docs), `--max-budget-usd` (referenced in headless doc; stops remaining background work at the cap). Exact CLI flag table: https://code.claude.com/docs/en/cli-reference.
- Background work: a `-p` run waits for background subagents/commands; idle cap 10 min (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`).
- Skills work in `-p`: put `/skill-name` in the prompt and it expands. Built-in TUI-only commands do not.
- CI gate tip: `system/init` event exposes `plugins`, `plugin_errors`, `mcp_servers`, `mcp_server_errors`; fail the job on non-empty errors. `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` makes marketplace plugins install before the first turn.
- `--worktree <name>` works with `-p`; non-interactive runs do NOT clean up their worktrees (you must `git worktree remove`).

---

## 2. Claude Agent SDK (TS/Python) [STABLE]

Docs: https://code.claude.com/docs/en/agent-sdk/overview , TS ref https://code.claude.com/docs/en/agent-sdk/typescript , Python https://code.claude.com/docs/en/agent-sdk/python , demos https://github.com/anthropics/claude-agent-sdk-demos
Repos: github.com/anthropics/claude-agent-sdk-typescript, github.com/anthropics/claude-agent-sdk-python (CHANGELOGs linked from overview).

- `npm install @anthropic-ai/claude-agent-sdk` (bundles a native Claude Code binary as optional dep; set `pathToClaudeCodeExecutable` if skipped).
- Same loop, tools, hooks, subagents, MCP, sessions, skills/plugins loading as the CLI. Not a thin API client; it runs the Claude Code binary.
- Key `Options` (TS): `maxTurns`, `maxBudgetUsd` (client-side estimate, can overshoot, leave headroom), `permissionMode`, `allowedTools` (auto-approve only; does NOT restrict), `agents` (programmatic subagents), `hooks` (callbacks), `sandbox`, `settingSources` (`[]` disables user/project/local settings, important for reproducible factory workers), `plugins` (local paths), `outputFormat: {type:'json_schema', schema}`, `canUseTool` (custom approval; only called when flow would otherwise prompt).
- Auth caveat: Anthropic does not allow third parties to offer claude.ai login/rate limits for products built on the SDK; use API keys (or Bedrock/Vertex/Foundry).
- Branding caveat: don't name your product "Claude Code".
- Cost tracking: https://code.claude.com/docs/en/agent-sdk/cost-tracking.md (client-side estimates; accumulates across resumed calls).
- Observability: https://code.claude.com/docs/en/agent-sdk/observability.md
- Hosting: https://code.claude.com/docs/en/agent-sdk/hosting.md ; secure deployment: https://code.claude.com/docs/en/agent-sdk/secure-deployment.md

Minimal orchestration sketch (assembled from documented options; verify exact message-field names against the TS reference, which I could only read the first 100k of):
```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const msg of query({
  prompt: `Implement ticket ${ticket.id}: ${ticket.body}. Open a PR when tests pass.`,
  options: {
    cwd: worktreePath,
    maxTurns: 80,
    maxBudgetUsd: 15,
    permissionMode: "dontAsk",
    allowedTools: ["Read","Edit","Bash(npm test *)","Bash(git commit *)","Bash(gh pr create *)"],
    settingSources: ["project"],
    plugins: [{ type: "local", path: "/opt/pstack" }],
    agents: { reviewer: { description: "Reviews diffs", prompt: "...", tools: ["Read","Grep","Glob"], model: "opus" } },
  },
})) {
  if (msg.type === "result") record(ticket, msg);   // cost, subtype (success vs max-turns/budget errors), session_id
}
```
Unverified: exact result `subtype` strings (`error_max_turns`, `error_max_budget_usd` are what I recall; the fetch truncated before that section).

Related Anthropic-hosted alternative: **Managed Agents** (hosted agent harness, cloud sandbox or self-hosted sandbox, via API/`ant` CLI): https://platform.claude.com/docs/en/managed-agents/overview . Not deep-dived; status not verified.

---

## 3. GitHub Actions / `@claude` app [STABLE; action at v1]

Docs: https://code.claude.com/docs/en/github-actions ; repo https://github.com/anthropics/claude-code-action (docs/setup.md, docs/security.md, docs/usage.md, examples/).

- Setup: `/install-github-app` (github.com only) or manual: install https://github.com/apps/claude, add secret `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`; tied to one person's subscription, so use API key for org-wide). Workload identity federation (OIDC -> Console service account) avoids long-lived secrets: inputs `anthropic_federation_rule_id`, `anthropic_organization_id`, etc.; needs `id-token: write`.
- Two modes: interactive (no `prompt`, reacts to `@claude`) and automation (`prompt` given, any event incl. cron/issues.labeled).
- Interactive workflow (verbatim from docs):
```yaml
on:
  issue_comment: { types: [created] }
  pull_request_review_comment: { types: [created] }
jobs:
  claude:
    if: contains(github.event.comment.body, '@claude')
    runs-on: ubuntu-latest
    permissions: { contents: write, pull-requests: write, issues: write, id-token: write, actions: read }
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 1 }
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```
- Ticket->PR factory pattern: trigger on `issues: [labeled]` with label `ready-for-agent`, pass `prompt` that invokes a PStack skill, e.g. `prompt: "/pstack:poteto-mode implement issue #${{ github.event.issue.number }}"` with `plugin_marketplaces`/`plugins` inputs. (Pattern is my inference from documented inputs; the docs' own example is the code-review plugin.)
- Plugins/skills in Actions: `plugin_marketplaces: "https://github.com/anthropics/claude-code.git"`, `plugins: "code-review@claude-code-plugins"`, `prompt: "/code-review:code-review --comment ..."`. Repo-local skills need `actions/checkout` first.
- Tools: plain-text prompts get no shell/GitHub API until you grant via `claude_args: '--allowedTools "..."'` or `settings` input. `claude_args` accepts any CLI flag: `--max-turns 5 --model claude-sonnet-5 --mcp-config ...`.
- Guardrails: triggering actor must have write access (override: `allowed_non_write_users`), bots rejected unless in `allowed_bots` (prevents loops).
- Gotcha: commits pushed with default `GITHUB_TOKEN` do not trigger other workflows; leave `github_token` unset so the Claude app identity pushes, or CI won't run on agent PRs. This is critical for a factory (agent PR -> CI -> merge).
- Cloud providers: `use_bedrock`, `use_vertex`, `use_foundry` + OIDC (https://code.claude.com/docs/en/github-actions-cloud-providers.md).
- Cost controls in Actions: `--max-turns`, workflow `timeout-minutes`, GitHub `concurrency` groups.
- Also: GitLab CI/CD https://code.claude.com/docs/en/gitlab-ci-cd.md ; GitHub Enterprise Server https://code.claude.com/docs/en/github-enterprise-server.md ; managed **Code Review** (no workflow needed) https://code.claude.com/docs/en/code-review.md ; web **auto-fix of PRs** https://code.claude.com/docs/en/claude-code-on-the-web.md#auto-fix-pull-requests .
- App permission caveat: official GitHub App takes a broad permission set (Actions r/w, Workflows r/w, Administration r, etc.); create a custom app for least privilege (setup.md).

---

## 4. Scheduled / cloud agents

### 4a. Cloud scheduled tasks (formerly "routines") [PREVIEW]
Doc: https://code.claude.com/docs/en/routines.md ; manage at https://claude.ai/code/routines or `/schedule` (alias `/routines`).
- A saved prompt + repos + connectors (MCP) + cloud environment, run as a full Claude Code cloud session on Anthropic infra (or self-hosted env). Triggers: schedule (min interval 1h; cron), API, GitHub events (`pull_request.*`, `release.*` with filters).
- API trigger (beta header, may change):
```bash
curl -X POST https://api.anthropic.com/v1/claude_code/routines/trig_.../fire \
  -H "Authorization: Bearer sk-ant-oat01-..." \
  -H "anthropic-beta: experimental-cc-routine-2026-04-01" \
  -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" \
  -d '{"text": "Linear ENG-123 moved to Ready"}'
```
  `text` arrives wrapped as untrusted data; the saved prompt must explicitly say to act on the payload. Not part of the Platform API surface; claude.ai users only.
- Limits: 100 scheduled runs/h/account; Run-now+API 30/h per task; API fires 100/h/account; GitHub webhook events capped (per task/account). Subscription usage applies; overage only with usage credits.
- Constraints for a factory: tasks belong to an individual claude.ai account (commits/PRs appear as that user; not team-shared); requires subscription login (not API key / Bedrock); runs start in auto mode; pushes to `claude/`-prefixed branches; green status != task success; GitHub triggers only PR+release events (no issue events). Fit: good for a nightly backlog groomer or an API-fired "ticket ready" webhook; weak as the primary high-volume worker.
### 4b. Cloud sessions / `--cloud` [STABLE?]
https://code.claude.com/docs/en/claude-code-on-the-web.md , env config https://code.claude.com/docs/en/cloud-environments.md (network allowlist, setup script cached, network secrets). `claude --cloud` launches from terminal; queued follow-ups via `--cloud <session> -p`. Status label not verified.
### 4c. Self-hosted environments [BETA, Team/Enterprise, off by default]
https://code.claude.com/docs/en/self-hosted-environments.md . Runners on your infra poll Anthropic's queue (outbound HTTPS only), clone the repo, run sessions; scheduled tasks and `claude --cloud` can route there. Autoscaling orchestrator available. One runner locks to one owner (user) at a time. Not available with ZDR/HIPAA. Inference may go to Bedrock/Vertex. Good fit when you need internal network access.
### 4d. Local scheduling
`/loop` and session cron tools (https://code.claude.com/docs/en/scheduled-tasks.md), Desktop scheduled tasks. Session-bound; not a factory backbone.
### 4e. Channels [UNVERIFIED status]
MCP servers declaring `claude/channel` can push events (CI results, chat) into a running session via `--channels`: https://code.claude.com/docs/en/channels.md . Useful for a long-lived session reacting to CI; I did not read details.

---

## 5. Hooks as quality gates [STABLE; `agent` hook type experimental]

Doc: https://code.claude.com/docs/en/hooks (page is 274k chars; I read ~first 100k), Agent SDK hooks: https://code.claude.com/docs/en/agent-sdk/hooks.md
- Config: `.claude/settings.json` -> `hooks.<Event>[].matcher` + `hooks[]` handlers. Also in plugin `hooks/hooks.json`, skill/subagent frontmatter, managed policy.
- Events (partial): SessionStart, Setup, UserPromptSubmit, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, SubagentStart/Stop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle, WorktreeCreate/Remove, PreCompact/PostCompact, SessionEnd, etc.
- Handler types: `command`, `http`, `mcp_tool`, `prompt` (single-turn LLM judge), `agent` (subagent with tools; experimental).
- Semantics: exit 0 = ok (stdout JSON parsed); **exit 2 = block** (stderr fed back to Claude); other non-zero = non-blocking error (a trap: exit 1 does NOT enforce). v2.1.295+ `"onFailure": "block"` makes failed/timeout/invalid-output hooks block (fail-closed).
- PreToolUse block via JSON: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`. Hooks cannot override deny/ask rules.
- Stop gate (forces the agent to keep working until green):
```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command",
  "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/require-green.sh", "timeout": 900 } ] } ] } }
```
```bash
#!/bin/bash
# require-green.sh: block stop until tests+lint pass
INPUT=$(cat)
# avoid infinite loop: honor stop_hook_active field if set by the harness
if [ "$(echo "$INPUT" | jq -r '.stop_hook_active // false')" = "true" ]; then exit 0; fi
if ! npm test --silent >/tmp/t.log 2>&1; then
  echo "Tests failing; fix before finishing:" >&2; tail -40 /tmp/t.log >&2; exit 2
fi
```
  (`stop_hook_active` field: from my knowledge of the hook input; not re-verified in the 100k I read. Alternative: JSON `{"decision":"block","reason":"..."}`.)
- Agent teams gates: `TeammateIdle`, `TaskCreated`, `TaskCompleted` (exit 2 to refuse).
- Hook caveat in worktrees: `${CLAUDE_PROJECT_DIR}` stays at the main checkout; use hook input `cwd` for the worktree path.
- Hooks for context hygiene: PreToolUse can rewrite commands (`updatedInput`) e.g. filter test output (https://code.claude.com/docs/en/costs.md).
- Sandboxing note: command hooks and MCP servers run unsandboxed on the host unless the whole process is containerized.

---

## 6. Subagents and agent definitions [STABLE]

Doc: https://code.claude.com/docs/en/sub-agents
- Markdown + YAML frontmatter; only `name`, `description` required. Locations/priority: managed > `--agents` JSON > `.claude/agents/` > `~/.claude/agents/` > plugin `agents/`.
- Fields: `tools`/`disallowedTools`, `model` (sonnet/opus/haiku/fable/full id/inherit), `permissionMode`, `maxTurns`, `skills` (preload), `mcpServers` (scoped), `hooks` (scoped), `memory` (user/project/local), `background`, `effort` (low..max), `isolation: worktree`, `color`, `initialPrompt`. Plugin subagents ignore `permissionMode`, `mcpServers`, `hooks`.
```markdown
---
name: refactorer
description: Applies mechanical refactors across many files
isolation: worktree
model: sonnet
maxTurns: 40
tools: Read, Edit, Bash, Grep, Glob
---
Apply the requested refactor, run tests, report results.
```
- `claude --agent <name>` runs a whole session as that agent. `--agents '{json}'` defines agents per run (good for `--bare` workers).
- Model resolution: per-call > frontmatter > `CLAUDE_CODE_SUBAGENT_MODEL` > parent. This is the mechanism PStack's `pstack-models.md` overrides lean on.
- Subagents started from the main conversation run in background by default; background subagents get a reduced tool set.
- **Agent teams** [EXPERIMENTAL, off by default, interactive only; do not work in `-p`/SDK]: https://code.claude.com/docs/en/agent-teams.md . `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Shared task list + mailbox; ~7x tokens in plan mode. Not usable for headless factory.
- **Dynamic workflows** [availability: all paid plans + API; newer feature]: https://code.claude.com/docs/en/workflows.md . A JS script (`agent()`, `pipeline()`, `parallel()`, `phase()`) orchestrates up to 1,000 agents/run, 16 concurrent by default (`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` 1-256), resumable in-session, saved to `.claude/workflows/` or shipped in a plugin `workflows/` dir. Works in `-p` and the SDK but needs `Workflow` allow rule (or auto/bypass mode) since no prompt is shown. The `ultracode` keyword is ignored in `-p`/scheduled/webhook contexts (deliberate anti-injection). Does not pause for usage limits in `-p`. Strong candidate for fan-out stages (e.g., per-file migration, adversarial review) inside one ticket.
- Blog on the pattern: https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code (linked from SDK overview; not fetched).

---

## 7. Plugins, skills, marketplaces (distributing PStack) [STABLE]

Docs: https://code.claude.com/docs/en/plugins/overview.md , create marketplace https://code.claude.com/docs/en/plugins/create-marketplace.md , host https://code.claude.com/docs/en/plugins/host-marketplace.md , org management https://code.claude.com/docs/en/plugins/org.md , manifest https://code.claude.com/docs/en/plugins/manifest-reference.md , marketplace ref https://code.claude.com/docs/en/plugins/marketplace-reference.md , security https://code.claude.com/docs/en/plugins/security.md

- A plugin bundles skills, agents, hooks, MCP servers, (monitors, workflows). A marketplace is a git repo with `.claude-plugin/marketplace.json`:
```json
{ "name": "acme-tools", "owner": {"name": "Acme"},
  "plugins": [ { "name": "pstack-fork", "source": {"source":"github","repo":"acme/pstack-fork"} } ] }
```
  Sources: relative path, `github`, `git-subdir`, `url`, `archive`, `npm`, `command`; pin with `ref`/`sha`.
- User flow: `/plugin marketplace add owner/repo` then `/plugin install name@marketplace`; CLI forms `claude plugin marketplace add`, `claude plugin install`, `claude plugin validate`.
- For unattended workers: `--plugin-dir <path>` / `--plugin-url` (works with `--bare`), `plugins:`/`plugin_marketplaces:` inputs in the GitHub Action, SDK `plugins: [{type:'local', path}]`, `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` to block until installed. Pin a `sha`/version so workers are reproducible. Project-scope plugins load in worktrees automatically (v2.1.200+).
- Org rollout: "an administrator can require it on every machine" (plugins/org.md); settings keys `extraKnownMarketplaces`, `enabledPlugins`, and managed `strictKnownMarketplaces` exist (I recall; the pages that define them were not read, so confirm in org.md/settings-reference).
- Skills in `-p`: `/plugin-name:skill-name` as prompt. Skill-level `allowed-tools` frontmatter pre-approves tools.
- **PStack specifics** (third-party; check provenance):
  - Original by Lauren Tan (Cursor skill stack); Claude Code port by Michael Denyer: https://github.com/michael-denyer/pstack-claude ( README: https://raw.githubusercontent.com/michael-denyer/pstack-claude/main/README.md ). Install: `/plugin marketplace add michael-denyer/pstack-claude` then `/plugin install pstack@pstack-claude`; requires Claude Code >= 2.1.292. `/pstack:setup-pstack` configures models/effort/routing.
  - A competing fork `TheOnlyFusionCube/potetos-for-everyone` claims to supersede it (self-described, v0.1.0, unverified): https://www.jsdelivr.com/package/npm/potetos-for-everyone
  - Skills seen in this environment: poteto-mode, architect, arena, swarm, babysit, fix-ci, fix-merge-conflicts, get-pr-comments, interrogate, tdd, deslop, unslop, how/why, make-pr-easy-to-review, and many `principle-*`. README I fetched does not list babysit/fix-ci/tdd (README summary incomplete, not evidence they are absent).
  - A SessionStart hook injects a "use poteto-mode" mandate (can be disabled via `session hook: off` in `~/.claude/pstack-models.md`). For headless workers decide deliberately whether to keep it; with `--bare` hooks are skipped, so you must pass the plugin explicitly and invoke skills by name in the prompt.
  - Supply-chain: pin a commit SHA, vendor/fork into your own marketplace, review hooks (they run arbitrary commands).

---

## 8. Isolation: worktrees, sandboxing, containers

### Worktrees [STABLE] https://code.claude.com/docs/en/worktrees.md
- `claude --worktree feature-auth` (or `-w`) -> `.claude/worktrees/<name>/` on branch `worktree-<name>`; `claude --worktree "#1234"` branches from a PR head. Works with `-p`. Subagent `isolation: worktree`.
- `.worktreeinclude` (gitignore syntax) copies `.env` etc. into new worktrees. `worktree.baseRef`: `"fresh"` (default, origin default branch) or `"head"`.
- Isolation enforcement: Claude Code blocks edits/commands/git redirects that target the main checkout; does NOT track `cp`/redirect writes (use sandbox).
- `-p` worktrees are not auto-cleaned (lock held until a later sweep or manual `git worktree unlock/remove`). Periodic sweep (`cleanupPeriodDays`) removes subagent/background worktrees without work. Factory must own cleanup.
- Large repos: sparse worktrees https://code.claude.com/docs/en/large-codebases.md . Non-git VCS via `WorktreeCreate`/`WorktreeRemove` hooks.
- Worktrees isolate files only, not processes, ports, DBs, or secrets. Each parallel worker still needs its own port/DB namespace.

### Sandboxing [Bash sandbox STABLE; sandbox-runtime BETA research preview]
- Choose-an-approach: https://code.claude.com/docs/en/sandbox-environments.md ; Bash sandbox https://code.claude.com/docs/en/sandboxing.md ; runtime https://github.com/anthropics/sandbox-runtime (`npm i -g @anthropic-ai/sandbox-runtime`; `srt claude`, config `~/.srt-settings.json`) ; blog https://www.anthropic.com/engineering/claude-code-sandboxing
- Key rule (official): unattended runs with `--dangerously-skip-permissions` must run inside a container/VM/sandbox runtime; it refuses to start as root. The Bash sandbox alone is "not sufficient for fully unattended runs" because Read/Edit, MCP servers, hooks run on the host. Auto mode's classifier is per-action, not an isolation boundary.
- Dev container with default-deny iptables firewall: https://code.claude.com/docs/en/devcontainer.md (supports `--dangerously-skip-permissions`).
- Hardened container (verbatim flags from secure-deployment): `--cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp ... --network none --memory 2g --cpus 2 --pids-limit 100 --user 1000:1000`, egress only via a mounted unix-socket proxy. Doc also covers gVisor (`--runtime=runsc`), Firecracker/vsock, cloud private subnets with Envoy `credential_injector`.
- Credential proxy pattern: keep API keys outside the agent boundary; `ANTHROPIC_BASE_URL` for sampling, `HTTP(S)_PROXY` + TLS-terminating proxy for others, or a custom MCP tool that calls an out-of-sandbox service. Don't mount `~/.ssh`, `~/.aws`, `.env`, etc.
- Note domain-fronting limitation of the allowlist proxy (no TLS inspection).
- Hosted options: Anthropic cloud sessions (VM per session, git credential proxy), self-hosted environments, Docker Sandboxes (microVM) https://docs.docker.com/ai/sandboxes/ . Vendor sandboxes (Vercel Sandbox, Upstash Box, Cloudflare Sandbox) exist as third-party hosts but I did not research them here.

---

## 9. MCP for ticket intake and tools [STABLE]

Doc: https://code.claude.com/docs/en/mcp.md ; managed MCP https://code.claude.com/docs/en/managed-mcp.md ; SDK https://code.claude.com/docs/en/agent-sdk/mcp.md
```bash
claude mcp add --transport http github https://api.githubcopilot.com/mcp/ --header "Authorization: Bearer $GH_PAT"
claude mcp add --transport http sentry https://mcp.sentry.dev/mcp
claude mcp add --transport sse linear-server https://mcp.linear.app/sse   # per Linear's 2025 changelog; v2.1.265+ tries HTTP then falls back to SSE
```
- Linear: https://linear.app/docs/mcp ; changelog https://linear.app/changelog/2025-05-01-mcp . I could not confirm whether the current canonical URL is `/mcp` or `/sse`; check Linear's page. Jira/Atlassian: hosted "Atlassian Rovo" MCP exists as a claude.ai connector (it showed as needing auth in this environment); no Claude Code doc page for Jira, so [UNVERIFIED] for exact URL/flags.
- `.mcp.json` (project scope, committed) supports `${VAR}` / `${VAR:-default}` expansion in `command,args,env,url,headers`. Project servers need approval interactively; in `-p` without `--bare` they just connect (see warning in section 1).
- Headless OAuth: `-p`/SDK can't run the OAuth flow; pre-auth with `claude mcp login <name>` (interactive) or use header tokens / `--client-id --client-secret` (`MCP_CLIENT_SECRET` env for CI). Unauthed servers appear as `needs-auth` in `system/init`.
- Pass servers in bare mode with `--mcp-config <file-or-json>`; `--bare` ignores `.mcp.json`.
- Tool search is on by default (MCP tool schemas deferred), cutting context. Output caps: 25k tokens (`MAX_MCP_OUTPUT_TOKENS`).
- Org control: `managedMcpServers`, `allowedMcpServers`, `deniedMcpServers`.
- Alternative intake that avoids MCP: webhook -> your queue -> `claude -p`; Linear/Jira webhook -> routine `/fire` endpoint; GitHub Issues -> Action trigger. For writes back to the tracker, prefer a narrowly-scoped MCP server or `gh` CLI (docs note CLIs are more context-efficient than MCP).
- Security: ticket text is untrusted input (prompt injection). Routine `/fire` text is wrapped as untrusted; do the same in your own dispatcher and don't give ticket-reading agents broad write credentials ("lethal trifecta": https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/).

---

## 10. Settings and permissions for safe autonomy [STABLE]

Docs: https://code.claude.com/docs/en/permissions.md , modes https://code.claude.com/docs/en/permission-modes.md , auto mode https://code.claude.com/docs/en/auto-mode-config.md , settings https://code.claude.com/docs/en/settings.md , managed https://code.claude.com/docs/en/managed-settings.md , server-managed https://code.claude.com/docs/en/server-managed-settings.md
- Modes: `default`/manual, `acceptEdits`, `auto` (classifier), `dontAsk` (deny-unless-allowed), `plan`, `bypassPermissions`. Recommended factory defaults: `dontAsk` + explicit allowlist inside a container, or `auto` + `--permission-prompts none`; reserve `bypassPermissions` for hardened sandbox only.
- Rule syntax: `Bash(git diff *)` prefix match; `WebFetch(domain:x)`; `Agent(Explore)`; `mcp__server__tool`. Evaluation is deny-first; PreToolUse hooks cannot bypass deny/ask.
```json
{
  "permissions": {
    "defaultMode": "dontAsk",
    "allow": ["Read","Edit","Bash(npm test *)","Bash(npm run lint *)","Bash(git add *)","Bash(git commit *)","Bash(git push origin HEAD)","Bash(gh pr create *)"],
    "deny":  ["Bash(git push --force*)","Bash(rm -rf *)","Read(./.env*)","WebFetch"],
    "disableBypassPermissionsMode": "disable"
  }
}
```
  (shape from docs; the exact `defaultMode` key placement not re-read in full.)
- Managed policy: `permissions.disableBypassPermissionsMode`/`disableAutoMode: "disable"`, `allowManagedPermissionRulesOnly`, sandbox keys enforceable via managed settings. Settings precedence: managed > CLI > local > project > user.
- Repo-supplied exporter env vars can't be set from project `.claude/settings.json` (OTel), only managed/user/shell.
- Branch protection + required CI + CODEOWNERS on GitHub is the real enforcement for "agents can open PRs but not merge/force-push"; routines doc says use branch protection rulesets to constrain pushes.
- Auto mode caveat: repeated classifier blocks eventually surface a prompt; with no human the run stalls unless `--permission-prompts none` (denies) is set.

---

## 11. Cost, budget, observability

- Per-run: `--max-turns`, `--max-budget-usd`, SDK `maxTurns`/`maxBudgetUsd` (client-side estimate; overshoot possible), `total_cost_usd` in JSON result, Actions `timeout-minutes` + `concurrency`.
- Reference numbers (Anthropic): ~$13 per dev per active day, $150-250/dev/month; 90% under $30/day (https://code.claude.com/docs/en/costs.md). Multi-agent research system ~15x chat tokens; agents ~4x (https://www.anthropic.com/engineering/multi-agent-research-system). Agent teams ~7x.
- Org-level: Console workspace spend limits and a dedicated workspace rate limit for Claude Code; TPM/RPM-per-user table in costs.md; Claude Code Analytics API (Admin key); Team/Enterprise spend limits + usage credits; Bedrock/Vertex use cloud budgets; LiteLLM gateway for per-key spend (third party). Claude apps gateway spend limits: https://code.claude.com/docs/en/claude-apps-gateway-spend-limits.md . `modelPricing` managed setting makes reported cost match contracted rates.
- Subscription vs API for automation: scheduled tasks and `/schedule` require claude.ai subscription; SDK/`--bare` expects API keys; Anthropic prohibits offering claude.ai login in third-party SDK products. A factory should use API key (Console) or Bedrock/Vertex.
- Model/effort levers: `model:` per subagent, `effort:`, `CLAUDE_CODE_SUBAGENT_MODEL`, prompt-cache TTL (`subagentPromptCacheTtl: 1h`), PStack per-role model sheet.
- OpenTelemetry [metrics/events STABLE; traces BETA]: https://code.claude.com/docs/en/monitoring-usage.md
```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4317
export OTEL_RESOURCE_ATTRIBUTES="ticket.id=ENG-123,team.id=platform"   # custom dims
# traces (beta):
export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 OTEL_TRACES_EXPORTER=otlp
```
  Metrics: `claude_code.session.count`, `.cost.usage`, `.token.usage`, `.commit.count`, `.pull_request.count`, `.lines_of_code.count`, `.active_time.total`. Events: `user_prompt`, `tool_result`, `tool_decision`, `api_request`, `api_error`, `api_refusal`, `safety_event` (2.1.307+). Spans: `claude_code.interaction/llm_request/tool/hook`. Content logging flags default off (`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_RAW_API_BODIES`). `ccr.session.id` on cloud sessions; `vcs.*` attrs opt-in. Use `OTEL_RESOURCE_ATTRIBUTES` to tag every run with ticket id for per-ticket cost attribution (my suggested use of the documented mechanism).
- Also: analytics dashboard https://code.claude.com/docs/en/analytics.md ; SDK observability https://code.claude.com/docs/en/agent-sdk/observability.md ; plugin cost measuring https://code.claude.com/docs/en/plugins/measure.md ; plugin evals https://code.claude.com/docs/en/plugin-evals.md .

---

## 12. Published Anthropic guidance on long-running / multi-agent harnesses

1. **Effective harnesses for long-running agents** (2025-11-26) https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
   - Failure modes: one-shotting and running out of context; later session declares victory; marking features passing without e2e testing; time wasted figuring out how to run the app.
   - Pattern: initializer session (init.sh, progress file, git commit, JSON feature list with `passes` flag, ~200 items all failing) + coding sessions doing one feature each, leaving clean state, committing. Agents may edit only `passes`; "unacceptable to remove or edit tests". Use JSON not Markdown for the list. Start every session with a basic e2e smoke check. Use browser automation (Puppeteer MCP) for e2e. Open question: single agent vs specialized multi-agent.
2. **Harness design for long-running application development** (2026-03-24, Prithvi Rajasekaran) https://www.anthropic.com/engineering/harness-design-long-running-apps (URL as fetched; resolved OK)
   - Planner (short prompt -> product spec, high-level only) + generator + separate skeptical evaluator (Playwright, scored thresholds fail the sprint). Self-evaluation is lenient; tuning a standalone evaluator is easier. Context resets with structured handoff vs compaction; resets dropped on newer models. Strip scaffolding one piece at a time as models improve (sprints removed on Opus 4.6; planner+evaluator kept, evaluator single end pass). Evaluator is worth cost only for tasks beyond the model's reliable solo ability.
3. **How we built our multi-agent research system** https://www.anthropic.com/engineering/multi-agent-research-system : orchestrator-worker, +90.2% over single agent on internal eval, tokens explain 80% of variance, explicit effort-scaling rules in prompts, filesystem handoffs to avoid telephone-game loss, resume from failure point, rainbow deploys, small (~20 query) evals first, LLM-judge with rubric. Explicitly says it fits coding poorly when shared context/dependencies are heavy.
4. **Claude Code sandboxing** https://www.anthropic.com/engineering/claude-code-sandboxing ; **Securely deploying AI agents** https://code.claude.com/docs/en/agent-sdk/secure-deployment.md .
5. **Dynamic workflows blog** https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code (not fetched).
6. Not fetched but likely relevant: "Building effective agents" (https://www.anthropic.com/engineering/building-effective-agents), "Effective context engineering for AI agents", "Writing effective tools for agents", Claude Code best practices (https://www.anthropic.com/engineering/claude-code-best-practices). Existence from memory, [UNVERIFIED this session].

Implications for a ticket->merged-PR pipeline: (a) persist state outside context (ticket spec, acceptance checklist JSON, progress file, git history); (b) separate generator from evaluator with e2e/browser verification, not just unit tests; (c) hard-gate completion by machine-checkable criteria (Stop/TaskCompleted hooks + required CI); (d) re-test assumptions as models change; (e) parallelism helps breadth tasks, hurts tightly coupled code edits, so parallelize across tickets (worktrees) more than within one.

---

## 13. Suggested minimal factory skeleton (assembled from the above; my design, not an Anthropic reference)

1. Intake: Linear/Jira/GitHub webhook -> queue (SQS/Redis/GitHub label). Triage worker (`claude -p --bare --json-schema` with a "ready/blocked/needs-clarification" schema, read-only tools).
2. Dispatcher: Agent SDK or shell worker pulls ticket, `git worktree add` (or `claude -p --worktree ticket-123`), starts a container with hardened flags and egress proxy.
3. Worker: `claude --bare -p "/pstack:poteto-mode <ticket spec>" --plugin-dir /opt/pstack@<sha> --settings factory-settings.json --mcp-config tracker.json --permission-mode dontAsk --max-budget-usd 15 --output-format stream-json --verbose` with `OTEL_RESOURCE_ATTRIBUTES=ticket.id=...`.
4. Gates inside: Stop hook runs tests/lint/typecheck; PreToolUse hook denies protected paths; evaluator subagent (read-only, different model) with browser/e2e verification before PR.
5. Output: `gh pr create`; agent identity pushes so CI triggers; required checks + branch protection; `code-review` plugin / Code Review comments; PStack `fix-ci`/`get-pr-comments`/`babysit` style skills loop on failures with a retry cap.
6. Merge: auto-merge only if checks green, diff-size/path policy passes, low-risk label; otherwise human.
7. Observability: OTLP -> dashboards per ticket; alert on cost/turn outliers, stalls, repeated denials; store `session_id` for `--resume`.
8. Cleanup: remove worktrees/containers, rotate tokens, TTL on runs.

---

## 14. Things I could not verify / caveats

- Hook doc and TS SDK reference were read only through the first ~100k characters each; later events/fields (exact `Stop` input fields like `stop_hook_active`, SDK result `subtype` names, hook JSON for `TaskCompleted`) not confirmed.
- `--max-budget-usd` / `--max-turns` exact CLI semantics come from mentions in headless/GitHub docs, not the CLI reference page (https://code.claude.com/docs/en/cli-reference not fetched).
- Linear current MCP URL (`/mcp` vs `/sse`) and any Jira/Atlassian Claude Code instructions: unconfirmed.
- Settings keys for team marketplace auto-install (`extraKnownMarketplaces`, `enabledPlugins`, `strictKnownMarketplaces`) cited from memory + partial doc references.
- Claude Code on the web / cloud sessions GA vs beta label not read; routines/scheduled tasks explicitly "research preview"; self-hosted environments "public beta"; agent teams "experimental"; OTel traces "beta"; sandbox-runtime "beta research preview"; `agent` hook type "experimental".
- Model names in docs (Opus 5.5, Sonnet 5.5, `claude-sonnet-5`, `claude-opus-5-5`) are as shown in the fetched docs; I did not cross-check the model list or pricing page.
- PStack: only third-party ports found (michael-denyer/pstack-claude, TheOnlyFusionCube/potetos-for-everyone); upstream Lauren Tan repo URL not located; version/skill inventory unverified beyond README summary. Treat blog review (explainx.ai) as non-authoritative.
- Anthropic "Managed Agents" (platform.claude.com) is an adjacent hosted option; not evaluated.
- Third-party search summaries used only for Linear/PStack pointers; everything else is from official pages fetched 2026-10-23.
