// Review summary formats — selected per deployment via access.json
// `summaryFormat` (live-reloaded; switching is a config edit, not a PR).
// Every format stays in the codebase so the selection is always one word.
//
// These are instructions to the summarizing model; no parser consumes the
// section names. The state machine keys only on the [summary] sentinel.

export type SummaryFormat = { preamble: string; lines: string[] }

export const SUMMARY_FORMATS: Record<string, SummaryFormat> = {
  // The reader's six questions, near-verbatim from the primary user.
  'six-questions': {
    preamble: `Use this format — six short sections, each answering the reader's real question. Skip none; write "nothing" where empty:`,
    lines: [
      `**Tensions** — what was actually contested`,
      `**Changed** — what changed because of the review, with refs (commits, PRs, files)`,
      `**Pushed back** — what was resisted, and why it survived or died`,
      `**Emerged** — what surfaced that nobody asked for`,
      `**Juice** — the sharpest insight; how to think about done vs next`,
      `**Asks** — what needs the human, exactly now`,
    ],
  },
  // The original checkmark inventory — fastest to skim.
  'checklist': {
    preamble: `Use this format:`,
    lines: [
      `- ✅ issue — fixed/will fix`,
      `- ⚠️ issue — acknowledged, deferred`,
      `- ❌ issue — rebutted`,
    ],
  },
  // Compact core: the checklist's skim speed, the questions' altitude.
  'compact': {
    preamble: `Use this format — three short sections; write "nothing" where empty:`,
    lines: [
      `**Changed** — what changed, with refs`,
      `**Pushed back** — acknowledged-deferred vs rebutted, and why`,
      `**Asks** — what needs the human, exactly now`,
    ],
  },
}

export const DEFAULT_SUMMARY_FORMAT = 'six-questions'

export function resolveSummaryFormat(name: string | undefined): SummaryFormat {
  if (name && !(name in SUMMARY_FORMATS)) {
    process.stderr.write(`daemon: unknown summaryFormat "${name}" — using ${DEFAULT_SUMMARY_FORMAT} (known: ${Object.keys(SUMMARY_FORMATS).join(', ')})\n`)
  }
  return SUMMARY_FORMATS[name ?? DEFAULT_SUMMARY_FORMAT] ?? SUMMARY_FORMATS[DEFAULT_SUMMARY_FORMAT]
}
