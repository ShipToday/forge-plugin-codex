# Forge by ShipToday for Codex

Free, AI-powered product development lifecycle automation for Codex.

## What it does

Describe what you want to build, fix, plan, review, or ship. Forge routes the
request through a structured PDLC workflow backed by the hosted Forge MCP
server.

Examples:

```text
implement user authentication with OAuth
fix the checkout page crash on mobile
break down the notifications feature into stories
estimate story points for PROJ-123
check status of my feature
```

## What's included

- **Forge MCP server** (`plugins/forge/.mcp.json`) connects to
  `https://teams.shiptoday.ai/mcp`.
- **`forge-autopilot` skill** detects product-development intent and routes the
  request to the right Forge workflow.
- **`forge-workflow` skill** helps organization admins create or remove custom
  Forge workflow overrides.
- **Hooks** (`plugins/forge/hooks/hooks.json`) coordinate session routing,
  workflow state, step guardrails, and workflow tracking.

## Install

This repository is a self-contained Codex plugin marketplace. The marketplace
manifest lives at `.agents/plugins/marketplace.json` and the plugin itself at
`plugins/forge/`.

### From the Codex app

1. Open **Plugins → ⋯ → Add marketplace**.
2. **Source**: `ShipToday/forge-plugin-codex`
3. **Git ref**: `main`
4. **Sparse paths**: leave blank.
5. Click **Add marketplace**, then install **Forge** from the `shiptoday`
   marketplace.

### From the Codex CLI

```bash
codex plugin marketplace add ShipToday/forge-plugin-codex
```

Then run `/plugins`, open the `shiptoday` marketplace, and install **Forge**.

### Enable hooks

The plugin ships lifecycle hooks (session routing, workflow guardrails).
Plugin hooks are disabled by default — enable them in `~/.codex/config.toml`:

```toml
[features]
plugin_hooks = true
```

### Token usage capture

Forge captures per-session token usage from the local Codex rollout log
(`~/.codex/sessions/…/rollout-*.jsonl`) and delivers it on Forge's own
`forge__update_state` calls via a `PreToolUse` input rewrite
(`hookSpecificOutput.updatedInput`). Codex honors these rewrites from
**rust-v0.131.0**. To decide whether the rewrite is safe, the plugin reads the
**running session's** version from the rollout's `session_meta` record — so a
Codex Desktop build newer than the `codex` binary on your `PATH` is detected
correctly — and only falls back to a cached `codex --version` probe when no
rollout version is available. On older versions it skips the rewrite instead of
triggering per-call hook errors; capture then degrades to the best-effort
checkpoint relay. Upgrade to Codex ≥ 0.131.0 for reliable capture.

## License

MIT - see `LICENSE`.
