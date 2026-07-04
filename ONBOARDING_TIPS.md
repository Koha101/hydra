# Hydra Onboarding Tips (agent-facing)

> **Last verified:** 2026-07-04 · Claude Code 2.1.201 · macOS 14 (darwin 24.3) · Discord
> **Audience:** a Claude Code agent bringing up a byte on a *non-primary* machine.
> Read before `hydra install`. Each step names the gotcha that cost real debugging time.

## Prereqs
`bun`, `tmux`, `claude` on PATH → `brew install bun tmux`.

## Ordered bring-up

1. **Deps + bridge plugin** — `bun install`; `claude plugin install discord@claude-plugins-official`.
   - *Gotcha:* if `$CLAUDE_CONFIG_DIR/settings.json` is a **dangling symlink**, the install fails with an ENOENT on a `.tmp` file. Resolve the symlink target first.

2. **State dir** — create `~/.claude/channels/<platform>/.env` (token, `CHAT_PLATFORM`, `SPAWN_CWD`, `DEFAULT_SESSION_CHANNEL`) and `access.json`.
   - `SPAWN_CWD` **must be an existing directory** — a missing cwd fails every spawn silently.
   - Discord: enable **Message Content Intent** or inbound arrives with empty content.

3. **The `allowFrom` command gate** (highest-leverage gotcha) — `spawn:` / `kill:` / `/sessions` / `/health` are intercepted **only when the sender is in the top-level `access.allowFrom`**, independent of any channel-group `allowFrom`. A group lets *replies* through but silently drops *commands*. Add your user snowflake to **top-level** `allowFrom`. (The daemon now logs `command-shaped message from non-allowlisted sender …` when this happens.)

4. **Byte config-file location** — the byte runs `claude` with `CLAUDE_CONFIG_DIR=~/.claude`, so its state file is **`$CLAUDE_CONFIG_DIR/.claude.json`** (`~/.claude/.claude.json`), *not* `~/.claude.json` in `$HOME`. Editing the wrong file does nothing. Seed onboarding in the right one:
   `theme`, `hasCompletedOnboarding: true`, `bypassPermissionsModeAccepted: true`, and per-project `hasTrustDialogAccepted: true` for `SPAWN_CWD`.
   - Without these a detached tmux byte hangs on theme → login → trust; without `bypassPermissionsModeAccepted` it prompts on **every** tool call and freezes.
   - `hydra preflight` now checks these two flags.

5. **Auth in detached tmux** — byte auth resolves from `CLAUDE_CODE_OAUTH_TOKEN` (written to `.byte-token`) or a one-time interactive login (persists to macOS Keychain `Claude Code-credentials`). No token *and* no prior login = byte stuck at the login screen. Fix: `claude setup-token` + set the env, **or** `tmux attach -t <platform>-byte` and log in once. For environments where the detached process can't read the keychain, set `HYDRA_AUTH=keychain` to copy the credential into the config dir.

6. **Install + up** — `hydra install <platform> --cwd <existing-dir>`; `hydra preflight <platform>` (all green except token → fill token); `hydra up <platform>`.

7. **Verify inbound end-to-end** — do not trust "connected":
   - `grep -E "main bridge connected|running tmux new-session" ~/hydra-<platform>-daemon.log`
   - Send a real message; a spawned session should appear in `hydra list` and greet its thread.
   - *Known failure* (Claude Code ≥ 2.1.199, inline plugins): bridge logs `Channel notifications skipped … inline` → byte replies but **never receives**. Run the plugin marketplace-installed + enabled and omit `--plugin-dir`.

## One-token-per-daemon
One Discord Application = one bot = one token = one gateway connection. Concurrent machines (laptop / work / VPS) each need their **own** Application + token. Same name/icon is fine; the Application ID and token cannot be shared.
