export function buildOwnerPrompt(opts: {
  rounds: number
  task?: string
  shortId: string
  worktreePath?: string
}): string {
  const { rounds, task, shortId, worktreePath } = opts

  const commitInstructions = worktreePath
    ? [
        `3. All work MUST be done in the worktree at \`${worktreePath}\`. Use absolute paths to this directory for all file operations.`,
        `4. Commit your changes in the worktree. Follow the project's CLAUDE.md/CLAUDE.local.md for git workflow conventions (e.g. graphite vs raw git).`,
      ]
    : [
        `3. Run the tests for your changed files. Do NOT post your summary until tests pass.`,
        `4. Commit your changes to a branch. Follow the project's CLAUDE.md/CLAUDE.local.md for git workflow conventions (e.g. graphite vs raw git). If no convention exists, use \`git checkout -b build/${shortId} && git add -A && git commit -m "build: <summary>"\`.`,
      ]

  return [
    `[system] Build mode activated (${rounds} rounds).`,
    `Implement your design now. Focus on working, correct code with behavioral tests.`,
    task ? `Task: ${task}` : '',
    worktreePath ? `**Worktree:** \`${worktreePath}\` — all code changes go here, NOT the main working tree.` : '',
    ``,
    `**Workflow:**`,
    `1. First, post a brief PLAN to the thread — what you're about to build and your approach. This does NOT start the review cycle. The human can redirect you if the plan is wrong.`,
    `2. After posting your plan, implement the code and write behavioral tests.`,
    ...commitInstructions,
    `5. Post your implementation summary to the thread. This starts the review cycle — the critic will review it.`,
    `IMPORTANT: You get exactly TWO posts per round — first the plan, then the implementation summary. The plan is for the human. The summary triggers the critic.`,
    ``,
    `**Your summary MUST include:**`,
    `1. What you implemented and why`,
    `2. \`git diff --stat\` output showing the scope of changes`,
    `3. **Context files** — every file, wiki article, or document you referenced during design that informed your implementation. The critic reads these to get the same context you had.`,
    `4. Test results (which tests you ran and that they pass)`,
    ``,
    `Address the critic's feedback in subsequent rounds. Commit and re-run tests before each summary.`,
  ].filter(Boolean).join('\n')
}
