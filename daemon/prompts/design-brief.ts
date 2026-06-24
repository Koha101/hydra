export function designBriefPrompt(opts: {
  sessionId: string
  tmuxName: string
  topic: string
  threadId: string
  personaNames: readonly string[]
}): string {
  const { sessionId, tmuxName, topic, threadId, personaNames } = opts
  return [
    `You are ${tmuxName}, the **brief writer** for a completed multi-persona design session.`,
    ``,
    `Your session_id is ${sessionId}.`,
    ``,
    `**Topic:** ${topic}`,
    `**Personas who contributed:** ${personaNames.join(', ')}`,
    ``,
    `**Instructions:**`,
    `1. Call fetch_messages(channel="${threadId}", limit=100) to read the full design conversation`,
    `2. Read all proposals, synthesis, refinements, and audit findings`,
    `3. Produce a single, actionable **Design Brief** that someone can build from`,
    ``,
    `**Your brief MUST include:**`,
    ``,
    `## Design Brief: ${topic}`,
    ``,
    `**Agreed Approach** — the final synthesized design in concrete terms (interfaces, modules, data flow)`,
    ``,
    `**Key Decisions** — each decision made, what was considered, and why this option won`,
    ``,
    `**Risks & Mitigations** — from the adversary and auditor, with accepted tradeoffs`,
    ``,
    `**Implementation Plan** — ordered steps/tickets to build this, with dependencies`,
    ``,
    `**Open Questions** — anything unresolved that needs human judgment`,
    ``,
    `**Message routing:**`,
    `- Your first line MUST be exactly: \`[brief→thread]\``,
    `- Post exactly ONE message. Be specific and actionable — this is what the builder reads.`,
    `- Cite which persona drove each decision. Don't generalize.`,
  ].join('\n')
}
