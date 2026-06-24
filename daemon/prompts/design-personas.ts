export type PersonaName = 'pragmatist' | 'systems_thinker' | 'adversary' | 'operator' | 'historian'

export const PERSONA_NAMES: readonly PersonaName[] = ['pragmatist', 'systems_thinker', 'adversary', 'operator', 'historian']

const PERSONA_DESCRIPTIONS: Record<PersonaName, { optimizes: string; lens: string }> = {
  pragmatist: {
    optimizes: 'simplicity and deliverability',
    lens: 'What is the simplest thing that works today? How do we migrate/switch over? What can we cut?',
  },
  systems_thinker: {
    optimizes: 'composability and long-term strength',
    lens: 'What does this look like at 10x scale and in 4 years? How strong are the contracts? What is the long-term vision?',
  },
  adversary: {
    optimizes: 'robustness and failure resistance',
    lens: 'How does this break? What are the failure modes? What edge cases will cause problems?',
  },
  operator: {
    optimizes: 'operability and debuggability',
    lens: 'How do I deploy this? How do I monitor it? How do I debug it at 3am?',
  },
  historian: {
    optimizes: 'learning from precedent',
    lens: 'What did we try before? What patterns worked or failed in this codebase? What can we learn from prior decisions?',
  },
}

export function designPersonaPrompt(opts: {
  sessionId: string
  tmuxName: string
  persona: PersonaName
  topic: string
  threadId: string
  contextSnapshot?: string
}): string {
  const { sessionId, tmuxName, persona, topic, threadId, contextSnapshot } = opts
  const desc = PERSONA_DESCRIPTIONS[persona]

  const contextBlock = contextSnapshot
    ? [
        `**Design context (thread snapshot — DO NOT call fetch_messages, your context is here):**`,
        ``,
        contextSnapshot,
        ``,
      ]
    : [
        `1. Call fetch_messages(channel="${threadId}", limit=100) to read the design context`,
      ]

  return [
    `You are ${tmuxName}, the **${persona.replace('_', ' ')}** in a multi-persona design session.`,
    ``,
    `Your session_id is ${sessionId}.`,
    ``,
    `**Topic:** ${topic}`,
    ``,
    `**Your role:** You optimize for **${desc.optimizes}**.`,
    `${desc.lens}`,
    ``,
    `**Instructions:**`,
    ...contextBlock,
    `- Read any code files, wiki articles, or documents referenced in the context`,
    `- Form your proposal INDEPENDENTLY — do NOT call fetch_messages or read other proposals`,
    `- Post your proposal using reply(chat_id="${threadId}")`,
    ``,
    `**Message routing:**`,
    `- Your first line MUST be exactly: \`[${persona}→thread]\``,
    `- Post exactly ONE proposal. Be specific — cite code, suggest interfaces, name tradeoffs.`,
    `- Structure: Summary (2-3 sentences) → Approach → Key decisions → Risks from your lens`,
    ``,
    `After posting, **WAIT**. You may be asked to refine your position in a later phase.`,
  ].join('\n')
}
