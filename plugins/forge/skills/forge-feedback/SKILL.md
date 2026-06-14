---
name: forge-feedback
description: >
  Collects feedback for the ShipToday team from inside an AI coding
  session and delivers it via Forge's shared MCP feedback backend.
  Invoke this skill whenever the user wants to "send feedback",
  "share feedback", "report a problem with Forge", "give the ShipToday
  team feedback", "submit feedback", or types "forge-feedback". The
  skill runs a short conversation to capture the feedback, gathers and
  SANITIZES relevant session context, shows the user the exact payload
  that will be sent, lets them revise it, and sends ONLY after explicit
  user confirmation by calling the `forge__send_feedback` MCP tool. No
  feedback content is stored. Do NOT invoke for product/SDLC work on a
  tracked item — that is `forge-autopilot` / `forge__start_workflow`.
---

# Forge Feedback

You are helping the user send feedback to the **ShipToday team** from inside
their AI coding session. Delivery goes through Forge's shared, MCP-owned
feedback backend via the **`forge__send_feedback`** tool — you only deliver
through that tool, never through any other tool, and you never send anything
until the user has seen the exact payload and explicitly confirmed.

**Privacy contract (non-negotiable):**

- **No feedback content is persisted to any database.** It reaches the ShipToday
  team and nothing else.
- **Do not disclose the delivery mechanism to the user.** Don't name the channel
  or transport the feedback is sent through — just confirm it reaches the
  ShipToday team. How and where it is delivered is an internal detail.
- **Session context must be sanitized before it leaves the session.** You are
  responsible for the first scrub; the backend re-sanitizes defensively, but do
  not rely on that.
- **Nothing is sent without explicit confirmation.** If the user declines, send
  nothing, make no `forge__send_feedback` call, and exit gracefully.

## Step 1 — Collect the feedback

Ask the user what feedback they'd like to share with the ShipToday team. Keep it
to one open question; let them write freely. If they already stated their
feedback when invoking the skill, use that and skip re-asking.

## Step 2 — Gather and sanitize session context

Optionally enrich the submission with brief, relevant context from the current
session that would help ShipToday act on the feedback — e.g. what the user was
doing, which Forge workflow/step was active, the tool or command involved, and
any error message. Keep it short (a few lines).

**Sanitize the context before showing or sending it.** Remove:

- Secrets and credentials: API keys, tokens, bearer tokens, JWTs, passwords,
  `KEY=value` env assignments, connection strings.
- Private customer data and PII: emails, names, customer identifiers, file
  contents that aren't relevant to the feedback.
- Anything the user wouldn't want shared outside their org.

If you are unsure whether something is sensitive, leave it out.

## Step 3 — Show the exact payload for review

Render the **exact payload** that will be sent, as plain text, so the user can
see precisely what leaves their machine:

```
Feedback:
<the feedback text>

Session context (sanitized):
<the sanitized context, or "(none)">
```

## Step 4 — Let the user revise, then confirm

Ask the user to confirm, revise, or cancel. Use the host's question UI
(a structured user-input tool if available) with options like **Send it**, **Edit first**,
and **Don't send**:

- **Edit first** → apply their changes and re-render the payload (back to Step 3).
- **Don't send** / cancel / no response → **send nothing**, do not call
  `forge__send_feedback`, and tell them: "No problem — nothing was sent." Then
  stop.
- **Send it** → proceed to Step 5.

## Step 5 — Send via the shared backend

Only after explicit confirmation, call **`forge__send_feedback`**:

```
forge__send_feedback({
  text: "<the confirmed feedback text>",
  context: "<the sanitized session context, or omit if none>"
})
```

Do NOT pass any user identity in the args — the tool takes it from the
authenticated session. Do NOT use any messaging or email tool to send feedback
yourself; the tool is the only delivery path.

Report the result to the user:

- Success → "Your feedback has been sent to the ShipToday team. Thanks!"
- Non-delivery (the tool returns an error message, e.g. rate-limited or a
  transient transport failure) → relay the tool's message and offer to try
  again later. Do not retry automatically more than once.
