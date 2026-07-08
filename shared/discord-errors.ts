// Discord API JSON error codes for a target that no longer exists — expected during
// teardown, when a thread/channel/message is deleted out from under an in-flight post.
// Treat as benign: don't retry, don't log. discord.js sets a numeric `code` on
// DiscordAPIError for these; its own client-side errors use string codes, which this
// intentionally ignores.
// https://discord.com/developers/docs/topics/opcodes-and-status-codes#json-json-error-codes
const GONE_CODES = new Set([
  10003, // Unknown Channel
  10004, // Unknown Guild
  10008, // Unknown Message
])

export function isGoneError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'number' && GONE_CODES.has(code)
}
