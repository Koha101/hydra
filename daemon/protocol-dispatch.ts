import { isReviewParticipant, onReviewReply, onParticipantDisconnect, onParticipantReconnect } from './adversarial.js'
import { isBuildParticipant, onBuildReply, onBuildParticipantDisconnect, onBuildParticipantReconnect } from './build.js'
import { isDesignParticipant, onDesignReply, onDesignParticipantDisconnect, onDesignParticipantReconnect } from './design.js'

// Protocols are mutually exclusive by construction — each spawns dedicated sessions
// with distinct IDs. The if/if/if pattern is safe; at most one branch fires per call.
// Protocol handlers are idempotent to double-dispatch (error + end on same socket).

export function dispatchReconnect(sessionId: string): void {
  if (isReviewParticipant(sessionId)) onParticipantReconnect(sessionId)
  if (isBuildParticipant(sessionId)) onBuildParticipantReconnect(sessionId)
  if (isDesignParticipant(sessionId)) onDesignParticipantReconnect(sessionId)
}

export function dispatchReply(sessionId: string, text: string, chatId: string, sentIds: string[]): void {
  if (isReviewParticipant(sessionId)) onReviewReply(sessionId, text, chatId, sentIds)
  if (isBuildParticipant(sessionId)) onBuildReply(sessionId, text, chatId, sentIds)
  if (isDesignParticipant(sessionId)) onDesignReply(sessionId, text, chatId, sentIds)
}

export function dispatchDisconnect(sessionId: string): void {
  if (isReviewParticipant(sessionId)) onParticipantDisconnect(sessionId)
  if (isBuildParticipant(sessionId)) onBuildParticipantDisconnect(sessionId)
  if (isDesignParticipant(sessionId)) onDesignParticipantDisconnect(sessionId)
}
