# Private layer

This fork tracks upstream Hydra's native Codex app-server implementation. The older `codex-bridge.ts` sidecar is intentionally not carried forward.

Local additions are kept above that base:

- Claude deployment defaults, auth, permission gates, marketplace setup, and operational commands
- Codex `/model`, `/effort`, `/context`, `/clear`, `/ultracode`, and provider-aware `/fork`
- `/provider claude|codex` handoff with conversation resume, transcript fallback, worktree reuse, and rollback
- Provider/model options for Discord `/spawn`, CLI spawn, and the `spawn_session` tool
- Runtime loading of workspace `CLAUDE.md` and its Claude memory index for Codex sessions
- A shared Codex session store so native resume/fork survives Hydra process-name changes
- Temporary command compatibility for Codex sidecars that were running before this migration

When updating, rebase this layer onto `upstream/main`; do not reintroduce a second Codex transport.
