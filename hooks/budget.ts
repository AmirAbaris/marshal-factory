// The factory has no budget cap any more. Repos wired before that still name this PreToolUse hook
// in their .claude/settings.json, so it stays as a no-op that allows every tool call; re-running
// install-target drops it from the wiring.
process.exit(0);
