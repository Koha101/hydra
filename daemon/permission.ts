import { loadAccess } from './access.js'
import type { ChatGateway, ButtonDef } from '../gateway.js'

// ---------------------------------------------------------------------------
// Pending permissions store
// ---------------------------------------------------------------------------

export const pendingPermissions = new Map<
  string,
  { tool: string; summary: string; input: string; sessionable: boolean }
>()

export function approvalButtons(k: string, sessionable: boolean, withMore = true): ButtonDef[] {
  const buttons: ButtonDef[] = withMore ? [{ id: `perm:more:${k}`, label: 'See more', style: 'secondary' }] : []
  buttons.push({ id: `perm:allow:${k}`, label: 'Allow once', style: 'success', emoji: '✅' })
  if (sessionable) buttons.push({ id: `perm:session:${k}`, label: 'Allow for session', style: 'primary', emoji: '🔓' })
  buttons.push({ id: `perm:deny:${k}`, label: 'Deny', style: 'danger', emoji: '❌' })
  return buttons
}

// ---------------------------------------------------------------------------
// Button click handler for permission approval flow
// ---------------------------------------------------------------------------

const PERM_BUTTON_RE = /^perm:(allow|session|deny|more):([0-9a-f]{16})$/

export function setupPermissionHandler(
  gateway: ChatGateway,
  onDecision: (requestId: string, behavior: 'allow' | 'session' | 'deny') => boolean,
): void {
  gateway.onButtonClick(click => {
    const m = PERM_BUTTON_RE.exec(click.customId)
    if (!m) return

    const access = loadAccess()
    if (!access.allowFrom.includes(click.userId)) {
      void click.respond('Not authorized.')
      return
    }

    const [, behavior, requestId] = m

    if (behavior === 'more') {
      const details = pendingPermissions.get(requestId)
      if (!details) {
        void click.respond('Details no longer available.')
        return
      }
      const { tool, summary, input, sessionable } = details
      let prettyInput: string
      try {
        prettyInput = JSON.stringify(JSON.parse(input), null, 2)
      } catch {
        prettyInput = input
      }
      const expanded =
        `Permission: ${tool}\n\n` +
        `flagged: ${summary}\n` +
        `input:\n${prettyInput}`
      void click.respond(expanded, approvalButtons(requestId, sessionable, false))
      return
    }

    // Hand the decision to the gate-approval bridge, which writes the signed
    // grant the permission-gate hook consumes on the agent's retry.
    const applied = onDecision(requestId, behavior as 'allow' | 'session' | 'deny')
    pendingPermissions.delete(requestId)
    const label = !applied ? 'Request expired — ask the agent to re-run the action'
      : behavior === 'deny' ? 'Denied' : behavior === 'session' ? 'Allowed for session' : 'Allowed once'
    void click.clearButtons(`${click.messageContent}\n\n${label}`)
  })
}
