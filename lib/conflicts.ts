export function conflictMessage(key: string, prUrl: string) {
  return [
    `Factory run ${key}: your pull request ${prUrl} now conflicts with main.`,
    "",
    "Bring the branch up to date and get the PR green again. Follow the merge-conflict section of the factory playbook (.agents/playbooks/factory.md):",
    "1. `git fetch origin` and `git merge origin/main` into this branch. Do not rebase and do not force-push.",
    "2. Resolve every conflict so that both main's change and yours keep working. Then run lint, typecheck, tests and build.",
    "3. Commit the merge, push, wait for CI and review bots, and call report_stage with stage pr and the PR URL again.",
    "If you cannot tell how the two changes should combine, report waiting with a concrete question instead of guessing.",
  ].join("\n");
}
