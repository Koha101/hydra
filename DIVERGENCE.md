# Divergence from upstream (sf8193/hydra)

This is a **private fork** (`Koha101/hydra`, `origin`) of `sf8193/hydra` (`upstream`), run as an
owner-only, Opus-4.8 Claude-Code harness over Discord on the alpha machine. Read this before
pulling upstream updates — it maps every commit we carry, why, and whether a given rebase
conflict should be *merged* or *dropped*.

## The important half of "our" work is NOT in this repo

Most of what makes this deployment ours lives **outside** the tree, so it never conflicts with
upstream:

- `~/.claude-hydra/gate/` — the permission gate: `permission_gate.sh` (PreToolUse hook),
  `judge_sys.txt` (Sonnet-judge policy), `reply_guard.sh` (Stop hook), `gate_eval.sh` (regression
  harness). This is the bulk of the custom engineering.
- `~/.claude-hydra/settings.json` — hooks, `enabledPlugins`, `extraKnownMarketplaces`,
  `allowedChannelPlugins`, `ultracode`.
- `~/.claude/channels/discord/` — `.env` (incl. `HYDRA_MARKETPLACE`, `CLAUDE_CODE_OAUTH_TOKEN`),
  `access.json`, `.byte-token`.
- `/Library/Application Support/ClaudeCode/managed-settings.json` — `allowedChannelPlugins`
  (root-owned; the last-mile fix that lets a channel plugin deliver inbound messages on current CC).

Only the in-repo commits below cost anything on a rebase.

## Pulling upstream updates

```sh
git fetch upstream
git rebase upstream/main            # onto the branch that carries our work (mg/gated-permissions)
# resolve conflicts per the table below; some resolve by DROPPING our commit (see "Retire when")
bun run build ...                   # compile-check daemon.ts, cli/hydra.ts, bridge.ts (see CLAUDE.md)
bun test
git push --force-with-lease origin mg/gated-permissions
```

## In-repo divergence commits

Keyed by purpose (hashes drift on rebase). Three buckets: **[ENV]** forced by current
CC/macOS gaps the upstream author doesn't hit (he runs a Feb CC build predating these guards);
**[REQ]** our deliberate requirements; **[FIX]** upstream-mergeable cleanups.

| Purpose | Bucket | Files (conflict surface) | Retire when |
|---|---|---|---|
| Marketplace name via `HYDRA_MARKETPLACE` (`marketplaceName()`, default upstream `claude-plugins-official`); local `.claude-plugin/marketplace.json`; deprecated-script forwarding | ENV | `shared/constants.ts`, `cli/helpers.ts`, `cli/lifecycle.ts`, `daemon.ts`, `daemon/session-lifecycle.ts`, `preflight.sh`, `start-byte.sh`, `start-daemon.sh`, `.env.example`, `.claude-plugin/marketplace.json` | The `discord` plugin is published in the official marketplace → unset `HYDRA_MARKETPLACE`, the code default takes over, drop the `marketplace.json`. |
| Prompt placed **before** `--channels` (CC ≥2.1.202 made `--channels` variadic, so a trailing prompt got eaten) | ENV | `cli/lifecycle.ts`, `daemon/session-lifecycle.ts` | CC stops treating `--channels` as variadic, or upstream adopts the same ordering. |
| Keep `--dangerously-skip-permissions` on the byte/spawns (headless byte with no TTY queues in "manual" mode otherwise; the real gate is the PreToolUse hook) | ENV | `cli/lifecycle.ts`, `daemon/session-lifecycle.ts` | Never, while running headless — this is upstream-aligned anyway. |
| Export `bun` on `PATH` for spawned sessions (detached tmux loses it → bridge MCP can't spawn) | ENV | `daemon/session-lifecycle.ts` | Upstream exports PATH in its spawn command. |
| Spawn auth via `CLAUDE_CODE_OAUTH_TOKEN` (detached tmux can't unlock the login keychain) | ENV | `daemon/session-lifecycle.ts` | Upstream adds a keychain-independent auth path. |
| Byte + spawns fall back to a persisted `.byte-token` on reboot (launchd plist env lacks the token) | ENV | `cli/lifecycle.ts`, `daemon/session-lifecycle.ts` | Upstream persists byte auth for launchd revival. |
| **Permission gate + Opus default** — in-repo wiring that routes to the external `~/.claude-hydra/gate` hook and defaults the byte to Opus 4.8 | REQ | `cli/lifecycle.ts`, `daemon/session-lifecycle.ts`, `shared/constants.ts`, `start-byte.sh` | Keep — core to running Claude-as-root-over-Discord safely. |
| **QoL command layer** — `/model /effort /context /clear /reboot /ultracode` + native Discord slash-command registration | REQ | `daemon/commands/session-config.ts` (new), `daemon/router.ts`, `discord-gateway.ts`, `cli/lifecycle.ts`, `shared/constants.ts` | Optional. **Highest conflict surface** (touches `router.ts` + `discord-gateway.ts`, which upstream edits often). If a rebase gets ugly, this is the first thing to drop. |
| **Silence benign teardown noise** — `isGoneError()` drops Discord gone-codes (10003/10004/10008) without retry/log when a thread/channel/message is deleted mid-post | FIX | `shared/discord-errors.ts` (new), `throttled-queue.ts`, `discord-gateway.ts`, `daemon/session-lifecycle.ts` | Upstream fixes it (or PR this upstream — it's not deployment-specific). |

### Rebase strategy notes

- **[FIX]** commits are candidates to **PR upstream** — landing them there removes them from our carry.
- **[ENV]** commits are the ones most likely to become **droppable**: when a conflict appears,
  first check whether upstream now does the same thing (then drop ours) before merging.
- The **QoL layer [REQ]** is the biggest risk. It is self-contained enough to abandon in a pinch
  without breaking the harness (the gate, auth, and marketplace bits are what keep it *working*).
- Nothing here contains secrets — tokens/creds live in the external state dir, never in the repo.
