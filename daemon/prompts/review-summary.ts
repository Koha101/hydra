// The review's closing summary: the fast-skim disposition checklist, plus the
// one thing it always lacked — present-tense orientation. One opinionated
// format, deliberately not configurable: this surface is a stopgap the
// completion-surface rework replaces, and a config knob would outlive it.
export function reviewSummaryFormat(rounds: number): string[] {
  return [
    `**Review Summary** (${rounds} round${rounds > 1 ? 's' : ''})`,
    `- ✅ issue — fixed/will fix`,
    `- ⚠️ issue — acknowledged, deferred`,
    `- ❌ issue — rebutted`,
    ``,
    `**Where we are** — 1–3 sentences, present tense: the state of the work now that the review is done (what landed, what changed state, what's blocked), and what — if anything — needs the human right now.`,
  ]
}
