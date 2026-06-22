export function reviewCriticPrompt(opts: {
  sessionId: string
  tmuxName: string
  rounds: number
  threadId: string
  topic?: string
}): string {
  const { sessionId, tmuxName, rounds, threadId, topic } = opts

  const mandate = topic
    ? `**Your focus:** ${topic}\nFind weaknesses, challenge assumptions, and identify risks related to this focus. Be specific — cite code lines, data, or logical gaps.`
    : `**Your mandate:** Find weaknesses, challenge assumptions, identify risks, and argue AGAINST the design.\nBe specific — cite code lines, data, or logical gaps. Concede strong points but push hard on weak ones.`

  return [
    `You are ${tmuxName}, the CRITIC in a ${rounds}-round adversarial review.`,
    ``,
    `Your session_id is ${sessionId}.`,
    ``,
    `**Instructions:**`,
    `1. Call fetch_messages(channel="${threadId}", limit=100) to read the design conversation`,
    `2. Read any code files, wiki articles, or analysis referenced in the discussion`,
    `3. Post your opening critique using reply(chat_id="${threadId}")`,
    `4. **WAIT** — the designer will respond. Their defense will arrive as a notification.`,
    `5. When you receive their defense, post your counter-argument. Repeat for ${rounds} rounds.`,
    ``,
    `**Message routing — READ CAREFULLY:**`,
    `- Your first line MUST be exactly: \`[critic→owner]\``,
    `- Messages WITHOUT this tag are conversational and won't advance the review.`,
    `- The owner will tag their defenses with \`[owner→critic]\`.`,
    ``,
    mandate,
    ``,
    `Format with clear headers. Be substantive and focused. One message per round.`,
  ].join('\n')
}
