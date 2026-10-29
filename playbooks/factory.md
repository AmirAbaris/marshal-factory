---
extends: bug-fix, feature, opening-a-pr, babysit
when: Resolving one Linear issue unattended on a `factory/<KEY>` branch that marshal-factory started, where the first message carries the issue.
---

# Factory run

This playbook ships with marshal-factory, not with the repository: the first message names its path on this machine. It changes PStack's bundled playbooks the way a project playbook under `.agents/playbooks/` does, so open the bundled ones it extends and apply the changes below. A repository copy of this file may add notes about that repository; where it differs from this one, this one wins.

No human reads this thread while it runs. The supervision panel and the pull request are the only outputs anyone sees. The branch name carries the issue key: `factory/FAC-2` works issue `FAC-2`. The issue title, body and URL are in the first message.

## Standing rules

- **Report every stage.** Call the `report_stage` tool of the `factory-report` MCP server each time the run enters a stage, before doing that stage's work. Stages in order: `triage`, `investigating`, `implementing`, `verifying`, `pr`. Off the main path: `waiting` and `failed`. The summary is one or two plain sentences about this issue, not about the process.
- **Never ask in the thread.** No `AskUserQuestion`, no plan-mode approval, no question in a reply that waits for an answer. Nobody answers. Treat the factory run as a full-autonomy grant for every reversible step.
- **Blocked or ambiguous means `waiting`.** When the issue does not say what done looks like, or something outside the repo blocks you, call `report_stage` with `stage: "waiting"`, a summary of what you found, and a `question` the reporter can answer in one reply. Name the decisions you need and offer two or three concrete options for each. Then end the turn. Do not guess and do not open a PR for a guess.
- **Never merge yourself.** Never run `gh pr merge`, never arm auto-merge, never push to `main`. The run ends at a merge-ready PR reported with a merge assessment (see Merge assessment). The factory decides whether it merges or goes to a human.
- **Clean up only what you started.** Other runs and the operator's own servers share this machine. Start a dev server on a free port, remember its PID, and stop that PID before the turn ends. Never `pkill` or `killall` by name, and never stop a process you did not start.
- **Prove the commit you ship.** Before you report `pr`, run `factory-verify` in the worktree on the final pushed commit, with nothing uncommitted. In a sandbox it is on `PATH`; elsewhere run the command the `report_stage` reply for `verifying` names (`bun <factory root>/hooks/verify.ts`). It runs the repo's checks at `HEAD` and reports exit codes and output for that exact commit. The factory merges only a head whose checks passed there, and runs them itself when it can. Uncommitted changes make the run count for nothing. If you push again, run it again.
- **Show the pages you change.** In a sandbox the `playwright` MCP server drives a headless Chromium that reaches only `localhost`. Before you report `verifying` done on a change to a page or screen, start the repo's dev server, open it there and look at the result. Take a viewport screenshot of each changed page or state with `browser_take_screenshot`; it saves the file under `/work/browser`. Attach them to the `pr` assessment (see Merge assessment). The owner sees what you attached, and the factory hands a PR that changes UI files over to the owner when it has no screenshots.
- **Giving up means `failed`.** If you cannot finish (three fix rounds on the same failure, a broken toolchain, a dead end), call `report_stage` with `stage: "failed"` and the reason in `summary`, then end the turn.

## Triage

1. Call `report_stage` with `stage: "triage"`.
2. Decide the type from the issue text. A described symptom that differs from stated expected behaviour is a bug: follow the bundled Bug fix playbook. A request for new behaviour is a feature: follow the bundled Feature playbook.
3. Test for ambiguity before any code. Write down the acceptance check, a test or an observable result, using only the issue text. If you cannot, the issue is ambiguous: report `waiting` with the question and stop.
4. Work in the thread's worktree on the current branch. Do not create other worktrees or branches for the PR.

## Resumed runs

A run that stopped in `waiting` resumes when the reporter answers on Linear. The factory then sends this thread a message that quotes your question and the answer, or starts a fresh thread on the same branch with both in its first message.

1. Start again at Triage and call `report_stage` with `stage: "triage"`. Keep the branch and any commits already on it.
2. The answer is the spec. Where it picks an option you offered, build that option and nothing the reporter did not ask for. Where it adds a request, include it.
3. Run the ambiguity test again with the issue plus the answer. If you still cannot write the acceptance check, report `waiting` with one more concrete question about what is still open, and end the turn. Do not guess.
4. Otherwise continue with the bundled playbook as usual.

## Merge conflicts

When the factory tells this thread that its PR conflicts with main, the board has already moved the run back to Implementing.

1. Run `git fetch origin` and `git merge origin/main` on this branch. Never rebase a pushed factory branch and never force-push it.
2. Resolve each conflict so that main's change and yours both keep working. Read main's commit to learn what it meant. Do not drop either side to make the conflict go away.
3. Call `report_stage` with `stage: "verifying"`, then run lint, typecheck, tests and build, and check the changed screen when the conflict touched UI.
4. Commit the merge, push, and babysit the PR to green as in the bundled Babysit playbook. Run `factory-verify` on the pushed merge commit. Then call `report_stage` with `stage: "pr"`, the `prUrl` and a fresh merge assessment again, and end the turn.
5. If the two changes contradict each other and the issue does not say which wins, abort the merge with `git merge --abort`, report `waiting` with a question that names both changes, and end the turn.

## Merge assessment

Every run ends one of three ways: the factory merges it, it hands it over to the owner for review, or you asked before building (`waiting`). If the issue is open enough that different readings give different features, report `waiting` before building.

1. Write down how you read the issue and every assumption you filled a gap with. Issues are often underspecified; that is fine. Put the assumptions in the PR body under a heading `Assumptions I made`, one bullet each; the factory copies them to the Linear comment.
2. Run `factory-verify` on the pushed head, as in Standing rules.
3. Recommend `merge` when you are confident you built what the issue asked for and that it works. Additive changes the issue asked for, such as new exports or new endpoints, are fine.
4. Recommend `handover` only when you are not confident: you are unsure what the issue meant, unsure about an assumption you had to make, or you could not show the change works. Say why in one or two sentences.

When you report `pr`, pass `assessment`: `recommendation`, `interpretation`, `assumptions`, and `confidence` with `confident` and, when you are not confident, the `reason`. Add `notes` for anything else the owner should know. When the change shows on a page, add `screenshots`: up to six entries, each with the `file` the `playwright` server saved (its name under `/work/browser`) and a `caption` that says what the image shows and what to look for. Each file must be a PNG, JPEG or WebP image under 1 MB; `report_stage` refuses the report if one can't be read. Be honest: the factory checks CI, conflicts and Bugbot itself, holds the head to the evidence `factory-verify` reported for it, and a `merge` it cannot back up costs trust.

## Changes to the bundled playbooks

- **Before** "Reproduce it yourself on the matching surface via the driver skill" call `report_stage` with `stage: "investigating"`.
- **Replace** "Ask the user only with a stated, specific reason the control surface cannot reach the target, and only after driving it as far as it goes." with: If the control surface cannot reach the target after you drove it as far as it goes, report `waiting` with the reason and the exact repro you need, then stop.
- **Before** "Plan the fix." call `report_stage` with `stage: "implementing"`.
- **Replace** "Skip it when the test would be expensive, integration-heavy, or unclear." with: In a factory run the failing test is mandatory. Write it first, run it, and quote the failure before the fix. If no test can express the bug, report `waiting` and say why.
- **After** "Stage the commits so the failing repro lands before the fix in git history." commit the failing test on its own, then the fix in a second commit.
- **Before** "Verify on the same surface." call `report_stage` with `stage: "verifying"`. Run the repo's lint, typecheck, tests and build locally before you push.
- **Before** "`how` over the affected subsystem." call `report_stage` with `stage: "investigating"`.
- **Before** "Delegate code-writing to a subagent using your configured feature model" call `report_stage` with `stage: "implementing"`.
- **Before** "Verify on the matching surface." call `report_stage` with `stage: "verifying"`. Run the repo's lint, typecheck, tests and build locally before you push.
- **In** "Use Conventional Commits in the form `type(scope): subject`." prefix the title with the issue key, as in `FAC-2 fix(search): match item names case-insensitively`.
- **After** "Drop a section when it has nothing to say." start the body with a line that links the issue, as in `Linear: [FAC-2](<issue url>)`.
- **Replace** "Opening a PR does not start a babysit." with: In a factory run, opening the PR starts a `drive` babysit of that one PR right away. The factory run is the standing request to get it green.
- **Replace** "Run `drive` and `background` under `/loop` in dynamic mode." with: Run the watcher in the foreground and rerun it until it returns a verdict. Do not use `/loop` or scheduled wakeups: once the turn ends, nothing wakes this thread.
- **After** "Babysitting never authorizes merging." when the watcher reports `READY`, or owner approval is the only blocker left, run `factory-verify` on the pushed head, then call `report_stage` with `stage: "pr"`, the `prUrl`, a summary of the CI and review state, and your merge assessment. Then end the turn. If CI or a bot finding still fails after three fix rounds, report `failed` with the PR URL in the summary.
