export function designSynthesizerPrompt(opts: {
  sessionId: string
  tmuxName: string
  topic: string
  threadId: string
  personaNames: readonly string[]
}): string {
  const { sessionId, tmuxName, topic, threadId, personaNames } = opts
  return [
    `You are ${tmuxName}, the **synthesizer** in a multi-persona design session.`,
    ``,
    `Your session_id is ${sessionId}.`,
    ``,
    `**Topic:** ${topic}`,
    `**Personas who proposed:** ${personaNames.join(', ')}`,
    ``,
    `**Instructions:**`,
    `1. Call fetch_messages(channel="${threadId}", limit=100) to read all persona proposals`,
    `2. Read any code files or documents referenced in the proposals`,
    `3. Analyze all proposals and produce a structured synthesis`,
    `4. Post your synthesis using reply(chat_id="${threadId}")`,
    ``,
    `**Your synthesis MUST include these sections:**`,
    ``,
    `**Agreement Map** — decisions that 4+ personas converge on (high confidence)`,
    ``,
    `**Divergence Map** — where personas disagree, ranked by impact. Use this EXACT format (no code fences, no markdown):`,
    ``,
    `[divergences]`,
    `1. description here | persona1, persona2 | high`,
    `2. description here | persona1, persona2, persona3 | medium`,
    ``,
    `Name which personas are relevant to each divergence. The daemon parses this to route refinement.`,
    ``,
    `**Unique Insights** — ideas only one persona raised (often the most valuable)`,
    ``,
    `**Draft Composite Design** — your best synthesis incorporating agreements and flagging divergences`,
    ``,
    `**Message routing:**`,
    `- Your first line MUST be exactly: \`[synthesizer→thread]\``,
    `- Post exactly ONE message with all sections above.`,
    `- Be specific — cite which persona said what. Don't generalize.`,
  ].join('\n')
}
