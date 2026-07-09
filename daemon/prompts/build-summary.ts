// The build's closing summary — same closing move as review's (one grammar
// for endings, every protocol): what was built, where it lives, what was
// contested, and present-tense orientation.
export function buildSummaryFormat(rounds: number, prLinks: string[]): string[] {
  const prLine = prLinks.length
    ? `- **PRs / artifacts** — links (detected this run: ${prLinks.join(' · ')})`
    : `- **PRs / artifacts** — links, or "none"`
  return [
    `**Build Summary** (${rounds} round${rounds > 1 ? 's' : ''})`,
    `- **What was built** — one bullet per piece, each with how to think about it`,
    prLine,
    `- **Key tensions** — what the critic pushed, and what changed because of it`,
    ``,
    `**Where we are** — 1–3 sentences, present tense: the state of the work now, and what — if anything — needs the human right now.`,
  ]
}
