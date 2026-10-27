---
when: Onboarding a repository to marshal-factory unattended, in an onboarding sandbox the factory started, where the first message names the repo and where to write the result.
---

# Onboarding a repository

No human reads this thread while it runs. The factory reads one file when the thread ends, and the owner reads the pull request you open. Your job is the repo's setup recipe: a `.factory/setup.json` that lets a fresh sandbox install everything and pass the repo's checks. The factory builds a warm image from it, so every later job in this repo starts set up.

## Standing rules

- **Never ask in the thread.** Nobody answers. Decide, note the decision in the PR body, and go on.
- **Never invent secret values.** When a check needs an env var you do not have, name it in the recipe's `env` with what it is for. Do not put a value, a placeholder token or a fake key anywhere: not in the recipe, a file, a commit, the PR or the result.
- **Change nothing but the recipe.** Commit only `.factory/setup.json`. Do not fix the repo's code, tests or CI, even when a check fails; report it instead.
- **Never merge.** Open the PR and stop. Never push to `main`.

## Read the repo

1. Read the README, CONTRIBUTING, every workflow under `.github/workflows`, the lockfiles, `package.json` scripts, `Makefile`, `justfile`, `.devcontainer`, `Dockerfile`, `.tool-versions`, `.nvmrc`, `.python-version` and any `.env.example`.
2. Find how CI installs the repo and which commands it runs for tests, lint, typecheck and build. Prefer CI's commands: they are what passes today.
3. List every env var the checks read (`process.env.X`, `os.environ`, `.env.example`, workflow `env:` and `secrets.` entries). Mark one required only when a check fails without it.

## Write the recipe

Write `.factory/setup.json`:

```json
{
  "system": ["libvips-dev"],
  "runtimes": { "node": "22", "bun": "1.4.4" },
  "setup": ["bun install --frozen-lockfile"],
  "checks": { "test": "bun test", "lint": "bun run lint", "typecheck": "bunx tsc --noEmit", "build": "bun run build" },
  "env": [{ "name": "DATABASE_URL", "purpose": "Postgres the integration tests use", "required": true }],
  "warmKey": ["bun.lock", "package.json"]
}
```

- `system`: apt package names the sandbox needs beyond its base (Debian bookworm with git, curl, Node 22, Bun, gh). Leave it out when nothing is missing.
- `runtimes`: pin a version only when the repo pins one (`.nvmrc`, `engines`, `packageManager`, CI's setup step). The factory installs a pinned runtime only when the sandbox lacks it.
- `setup`: the commands that install dependencies, in order, run from the repo root. Use the lockfile's frozen install. No command may prompt.
- `checks`: one command each for whichever of `test`, `lint`, `typecheck` and `build` the repo has. Leave a check out rather than inventing one. These are the checks every factory job must pass at its PR's exact head (`factory-verify`) before the factory merges it, so each must run from a clean checkout after `setup`, without a human. A repo with no checks never merges on its own.
- `env`: names and purposes only.
- `warmKey`: globs whose change makes installed dependencies stale, usually the lockfiles and manifests. Leave it out for the defaults (every common lockfile).
- Services (databases, queues) are not supported yet. If a check needs one, leave that check out and say so in the PR.

## Prove it

1. From a clean clone state, run every `system` install, then every `setup` command, then every check. Fix the recipe until they pass.
2. A check that fails for a reason outside the recipe (a broken test on main, a missing secret, a service) stays in the recipe if the repo means it to run; record it as failing with the reason.
3. Run the whole recipe once more from the top after your last change.

## Deliver it

1. Commit `.factory/setup.json` alone on this branch, `factory/onboarding`, with the message `Add the factory setup recipe`.
2. Push it. If `origin` already has `factory/onboarding` from an earlier attempt, it is the factory's own branch: push with `--force-with-lease`.
3. Open a pull request titled `Add the factory setup recipe`, or update the one already open for the branch. The body says in a few lines what the recipe installs, which checks passed, which failed and why, and which env vars it needs.
4. Write the result file the first message names, as JSON:

```json
{
  "recipe": { "setup": ["bun install --frozen-lockfile"], "checks": { "test": "bun test" } },
  "prUrl": "https://github.com/owner/name/pull/12",
  "checks": [{ "name": "test", "command": "bun test", "ok": true }],
  "summary": "One or two sentences on what the recipe does and what still fails."
}
```

`recipe` is exactly what you committed. Each entry in `checks` has `name`, `command`, `ok`, and a short `note` when it failed. If you could not write a working recipe at all, write `{ "failed": "the reason" }` instead. Then end the turn.
