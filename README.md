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

- **Forge MCP server** (`.mcp.json`) connects to
  `https://teams.shiptoday.ai/mcp`.
- **`forge-autopilot` skill** detects product-development intent and routes the
  request to the right Forge workflow.
- **`forge-workflow` skill** helps organization admins create or remove custom
  Forge workflow overrides.
- **Hooks** (`hooks/hooks.json`) coordinate session routing, workflow state,
  step guardrails, and workflow tracking.

## Local development

Point Codex at this plugin root:

```text
plugins/forge
```

If you want the plugin to appear in a local Codex marketplace, add a marketplace
entry that points to `./plugins/forge`.

## License

MIT - see `LICENSE`.
