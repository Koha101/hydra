// Shared mechanics block — the single source for protocol-seed machinery:
// identity, orientation tooling, sentinel routing, cadence, wait discipline.
//
// Boundary rule: mechanics may name tools, tags, and timing — never content,
// and never illumination order for pool roles. A line that says what to THINK
// about is mandate and belongs in the role seed where it can be counter-steered;
// illumination order is position, and position belongs to the spec. The uniform
// read-everything-first default is correct only for singleton roles, where
// there is no pool to diversify.

export type MechanicsOpts = {
  tmuxName: string
  role: string
  protocol: string
  sessionId: string
  threadId: string
  tag: string | ReadonlyArray<{ phase: string; tag: string }>
                                       // deliverable sentinel, e.g. '[subtractor→thread]'; roles
                                       // routed on different tags per phase pass the full grammar —
                                       // a seed must never carry two contradictory first-line rules
  cadence: 'one-message' | 'per-round' | 'per-phase'
  waits?: boolean                      // roles that wait for [system] notifications between posts
  cutoffTs?: string                    // pool roles reading a shared thread independently
  orient?: string                      // pool roles supply their region's reading order; omit for
                                       // singleton roles to get uniform complete illumination
}

export function mechanicsBlock(opts: MechanicsOpts): string {
  const { tmuxName, role, protocol, sessionId, threadId, tag, cadence, waits, cutoffTs, orient } = opts

  const cadenceLine = cadence === 'one-message'
    ? 'Post exactly ONE protocol message.'
    : cadence === 'per-round'
      ? 'One protocol message per round.'
      : 'Exactly ONE protocol message per phase.'

  const orientTail = orient
    ?? 'Read every code file, wiki article, config, or document it references before forming a view.'

  const sentinelLines = typeof tag === 'string'
    ? [`- A protocol message's FIRST LINE must be exactly \`${tag}\` — the daemon routes on the first line only. A tag anywhere else is invisible to it.`]
    : [
        `- The daemon routes on the FIRST LINE only — a tag anywhere else is invisible to it. Your first line must be exactly the tag for the phase you are in:`,
        ...tag.map(t => `  - ${t.phase}: \`${t.tag}\``),
      ]

  return [
    `You are ${tmuxName}, the ${role} in this thread's ${protocol} run.`,
    `Your session_id is ${sessionId}.`,
    ``,
    `**Orient:** fetch_messages(channel="${threadId}", limit=100) is your window into this thread. ${orientTail}`,
    ...(cutoffTs ? [`Only read messages posted BEFORE ${cutoffTs}. Later messages belong to other roles — reading them contaminates your independence.`] : []),
    ``,
    `**Speak:** post to the thread with reply(chat_id="${threadId}").`,
    ...sentinelLines,
    `- Untagged messages are conversational: humans see them; the protocol does not advance. Use them for questions and status, never for your deliverable.`,
    `- ${cadenceLine}`,
    ...(waits ? [``, `**Wait:** after posting, WAIT. Phase advances and replies arrive as [system] notifications — do not poll the thread for them.`] : []),
  ].join('\n')
}
