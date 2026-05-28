---
name: forge-autopilot
description: >
  Routes any product, engineering, or software development lifecycle (SDLC/PDLC)
  activity to Forge. Invoke this skill whenever the user describes work that
  involves the product development process — across any phase: discovery,
  definition, planning, execution, review, handoff, release, or reporting.
  This includes: building or shipping features, fixing bugs, writing PRDs,
  breaking down stories, estimating, prioritizing, reviewing PRs, security
  audits, vulnerability assessments, release readiness checks, deployment gates,
  test planning and strategy, refactoring,
  or any similar SDLC activity. ALSO invoke
  for any reference to a tracked work item key matching the pattern
  "PROJ-123" / "BUG-42" / any "<UPPERCASE>-<digits>" id, regardless of the
  verb attached. Do NOT invoke for pure coding requests ("write a function",
  "refactor this file", "add a test") UNLESS they reference a tracked work
  item or describe product process. Do NOT invoke for git operations, file
  editing, or general Q&A unrelated to a project.
---

# Forge Autopilot

You are routing product development requests to Forge via the `forge` MCP
server. The user does NOT need to say "forge" or "@forge" — detect their intent
from the skill description above and call the right tool automatically.

Forge's workflow catalog lives on the server side and is fully data-driven.
You don't need to know which workflows exist — `forge__start_workflow` will
return a classifier prompt listing all available workflows (Forge defaults
plus any org-specific workflows configured for the current user) when it
can't auto-detect the right one. Just call it and follow the instructions.

## Step 1: Detect connected tools

Before calling any Forge tool, build the `connected_tools` array by checking
which MCP tools are available in the current session:

| Connector     | Look for these tool names                                      |
|---------------|---------------------------------------------------------------|
| jira          | searchJiraIssuesUsingJql, createJiraIssue, updateJiraIssue    |
| linear        | list_issues, get_issue, create_issue, save_issue              |
| github        | `gh` CLI available via shell, or GitHub connector tools         |
| slack         | slack_send_message, slack_search_users, slack_search_channels |
| confluence    | searchConfluenceUsingCql, getConfluencePage                   |
| notion        | notion-search, notion-fetch, notion-create-pages              |
| granola       | search_meetings, get_meeting_transcript                       |
| figma         | get_design_context, get_screenshot, get_metadata              |
| local_code    | filesystem/shell access (always include in coding environments) |

Only include connectors you can verify. Always include `local_code` when you
have filesystem access.

## Step 1b: Detect local skills

Build the `local_skills` array by checking your available skills, slash
commands, or rules. Include every skill **relevant to product development
or the software development lifecycle** — anything a Forge workflow step
could draw on, such as brainstorming, planning, requirements, estimation,
architecture analysis, code review, debugging, testing, or documentation.
Relevance — not whether the skill is project-specific — is the test: a
general-purpose skill still counts if it supports SDLC work.

A Forge workflow step can declare one of these as a *required* local skill,
so under-declaring a relevant skill will block the step that depends on it.
When in doubt, include it — over-declaring a relevant skill is harmless.

Do NOT include skills unrelated to product/SDLC work (e.g. presentation,
document, or spreadsheet builders, image or media generators) or built-in
platform commands (`/help`, `/clear`, etc.) — Forge workflows never use these.

| Source      | Where to look                                                   |
|-------------|-----------------------------------------------------------------|
| Codex       | Skills listed in the current session or loaded from the project |
| Cursor      | Rules loaded from `.cursor/rules/` shown in your system context |

For each skill found, include `{ "name": "<skill-name>", "description": "<brief description>" }`.
If no relevant local skills are found, omit the `local_skills` parameter entirely.

## Step 2: Route the request

For ANY product/SDLC request, your **default action** is:

→ `forge__start_workflow(feature_request, connected_tools, local_skills: <detected_skills>)`

Do NOT pass an explicit `workflow` parameter and do NOT try to pre-route to
a specific skill. Forge handles all routing on the server:

- **Unambiguous verbs + epic key** (e.g. "generate PRD for PROJ-123",
  "review the PR for SHI-512", "tech handoff for BUG-42") are matched
  server-side against a configured set of hot-path verbs and routed
  directly to the right skill in a single round-trip.
- **Workflow-shaped requests** (e.g. "do a security review", "is SHI-615
  ready to ship", "plan the test strategy") are classified server-side
  against the full workflow catalog (Forge defaults plus any org-specific
  customer workflows) and routed to the matching workflow.
- **Ambiguous requests** trigger a classification prompt that you'll need
  to follow — Forge returns instructions telling you which workflow or
  skill to call next, and you re-call with `classification_complete: true`.

You do not need to know which workflows or skills exist. The server is
the source of truth and tells you what to do next via the response.

### Exception 1 — Help / recommendation request

"What should I do with PROJ-123?", "help with PROJ-123", "where to start"

→ `forge__start_workflow(feature_request, connected_tools, recommendation: true, local_skills: <detected_skills>)`

### Exception 2 — Session observer (passive tracking)

Triggered by the `stop-observer.cjs` Stop hook (or by `prompt-router.cjs`
on a snoozed session wake check) — input contains "observe session" or
"observe_session workflow".

→ `forge__start_workflow(feature_request: "Passive session observation", connected_tools, workflow: "observe_session", local_skills: <detected_skills>)`

The `observe_session` workflow is a single-step workflow that wraps the
session observer. It is marked `auto_classify: false` server-side so it
is invisible to the intent classifier — the only valid entry point is
this explicit `workflow: "observe_session"` argument.

Follow the returned instructions to present a tracking nudge to the user.
Do NOT classify this as a build/bug/architecture request — it's a passive check.

#### After `session_observer` completes — read `follow_up`

When the observer workflow returns `Workflow complete.`, look at the
final `state_updates` payload you sent. If it includes a `follow_up`
object (the Link and Create paths set this; Ad-hoc, Snooze, and Dismiss
paths set `follow_up: null`), **you MUST chain to the follow-up workflow
before resuming the user's original request**:

```
forge__start_workflow(
  feature_request: <follow_up.feature_request>,
  connected_tools: <same array as before>,
  epic_key: <follow_up.epic_key>,
  workflow: <follow_up.workflow ?? omit>,
  pre_forge_context: <follow_up.pre_forge_context>,
  local_skills: <detected_skills>
)
```

The four-field structured shape (SHI-666) keeps the bound work item key
clean: `epic_key` is passed as a structured parameter so any
`SHI-NNN`-shaped strings inside `pre_forge_context` cannot hijack the
binding via the embedded-key regex.

If `follow_up` is `null` or absent, do **not** chain — the user's choice
(Ad-hoc / Snooze / Dismiss) means they explicitly opted out of starting
a tracked workflow. Continue the conversation normally.

**Common failure mode to avoid**: treating "Workflow complete" as
"observer is done — go back to the user's original ask". When the user
picked Link or Create, they implicitly chose to route the rest of the
session through a tracked workflow — silently going back to the
original ask leaves their selection unhonored and the audit trail
blind to which workflow should now be active. Always read `follow_up`
before resuming.

### Exception 3 — Session checkpoint (passive time tracking)

Triggered by the `stop-observer.cjs` Stop hook for an already-tracked
(`logged` / `linked`) session — input contains "session checkpoint" and
spells out a complete `forge__update_state` call (`conversation_id`,
`completed_step`, `state_updates`).

→ Call `forge__update_state` exactly as the directive specifies — pass
the `conversation_id` and `state_updates` verbatim. The `conversation_id`
is the original `observe_session` conversation; the server records the
elapsed time as a silent audit event.

Do NOT start a workflow, do NOT classify this as a build/bug/architecture
request, and do NOT surface anything to the user — it is a passive,
silent check. After the call, continue normally.

## Step 3: Follow the workflow

Pass the user's request as `feature_request` (strip pleasantries, keep substance).

After calling `start_workflow`, Forge returns step-by-step instructions.
Follow them:

1. Execute each step as instructed
2. When a step says to ask the user a question, ask the user directly. If a
   structured user-input tool is available, use it as the only tool call in
   that response, then wait for the answer before continuing.
3. If the answer is empty (Skip button), record "TBD" and move on
4. After completing each step, call `forge__update_state` with the results
   AND the `step_token` from the most recent response (see below)
5. If Forge returns `needsDisambiguation` or `needsIntentClassification`,
   present options or pick a workflow per the returned instructions and re-call

### Workflow guard — what is enforced

Forge installs a `PreToolUse` hook (`workflow-guard.cjs`) that **denies**
tool calls when the active step does not allow them. Two layers:

**Layer 1 — CHECKPOINT enforcement.** When the orchestrator returns a
`**CHECKPOINT**` response from `forge__update_state` (a relayed-question
skill is awaiting user input), the only tools you may call until the
user has answered are:

- user-input tool or direct user question — relay the pending question
- `forge__update_state` — advance with the user's answer
- `forge__abandon_workflow` — exit cleanly (see below)
- Read-only inspection: filesystem reads, search, web fetch/search when
  available, plus read-only MCP tools (names starting with `list_`, `get_`,
  `search_`, `query_`, `fetch_`, `notion-search`, `notion-fetch`)

**Layer 2 — Per-step `tool_permissions`.** Every step transition publishes
a `**Tool Permissions**: cat1, cat2, …` line listing the categories the
active step is allowed to use. The hook denies any tool whose category
is not in the list. Categories are coarse:

| Category | Tools |
|----------|-------|
| `read_code` | filesystem reads and search (always allowed regardless) |
| `ask_user` | direct user question or structured user-input tool |
| `web` | web fetch and web search tools |
| `tracker_read` | `list_issues`, `get_issue`, `list_comments`, `search_threads`, … |
| `tracker_write` | `save_issue`, `create_issue`, `save_comment`, `update_issue`, … |
| `docs_read` / `docs_write` | Notion read / write |
| `messaging` | Slack send |
| `calendar` / `design` / `meetings` | Per-connector groups |
| `code_edit` | code-editing tools such as `apply_patch` or editor writes |
| `shell` | shell execution tools |

Concretely: `readiness_check` does not allow `code_edit` or `shell`, so
editing during it is denied. `begin_code_execution` allows both,
so editing during it is allowed. `notify_tech_lead` allows `messaging`
but not `tracker_write` — the model can send a Slack message but not
silently rewrite the ticket.

Anything denied gets an actionable reason that points at the three
legitimate next moves: relay the user question, advance
(`forge__update_state`), or abandon (`forge__abandon_workflow`).
This makes silent-bypass structurally impossible, not just discouraged.

If you receive a deny decision for a tool you genuinely need, the right
move is usually to advance the workflow — the next step's allowlist
likely includes the tool you want.

### Step token — pass it back on every `update_state`

Every `start_workflow` and `update_state` response also includes a line:

```
**Step Token**: `step_<uuid>` — include this in your next `forge__update_state` call
```

When you call `forge__update_state`, include the most recent token via
`state_updates.step_token: "<token>"`. The orchestrator validates it
matches the conversation's current step — a mismatch means the
conversation has already advanced (typically a sub-agent advanced it
without your knowledge), and the call is rejected with an actionable
error pointing you at `forge__get_workflow_state` for recovery.

For relayed-question CHECKPOINT and RE-ENTRY responses the token does
NOT rotate — re-use the same token until the workflow actually
advances to a new step. The token rotates on every real step advance.

### Sub-agent relay — verify the envelope, fetch canonical state when absent

If you delegate a step to a sub-agent, pass the current step's token
into the sub-agent prompt verbatim — the sub-agent threads it through
its own `update_state` call. The orchestrator's response to that call
(carrying the *new* `step_token` and the next step's instructions) is
delivered to whoever made the MCP call: the sub-agent. The sub-agent
MUST return that response to you (the parent) **VERBATIM**.

To detect a missing envelope mechanically rather than heuristically, the
orchestrator wraps the next-step instructions in a `<<<FORGE_NEXT_STEP
token="…" bytes=N>>>` … `<<<END FORGE_NEXT_STEP>>>` envelope. The
parser accepts the envelope on **sentinels + token**; `bytes=N` is an
optional integrity annotation. After every sub-agent return:

1. Scan the return for the envelope. If either sentinel is missing —
   or the opening sentinel is restructured so `token="…"` no longer
   sits on it — the sub-agent didn't include a parseable envelope.
2. If both sentinels are present AND the opening sentinel declares
   `bytes=N`, compute the UTF-8 byte length of the body between them
   and compare against `N`. Mismatch = the sub-agent paraphrased
   inside otherwise-correct sentinels.
3. If both sentinels are present but `bytes=N` is **absent** (a
   common smaller-model paraphrase mode — the agent keeps the
   sentinel shape but drops the byte count as "boring metadata"),
   trust the envelope on sentinel + token alone. No fetch needed —
   the next-step body is good as-is.
4. On a step-1 fail (missing/restructured sentinels) OR step-2
   mismatch (declared bytes don't match), call
   `forge__get_workflow_state(conversation_id: "<id>")` to fetch the
   canonical step body and current step_token. This is the designed
   recovery channel — read-only, idempotent, and owner-checked.
   Findings the sub-agent put in `display_text` are preserved as a
   `## Findings` block in the fetched response, so no analytical
   output is dropped — only the verbatim relay shortcut was skipped.

**Diagnostic phrasing**: when this happens, describe it as a fetch
("the envelope isn't in the sub-agent's return — fetching canonical
state") rather than as a failure ("the relay was lost"). The findings
layer is the system's designed answer to envelope-not-present, so the
information path stayed intact even though the shortcut path didn't.
This wording matters for the user reading your message — "lost" reads
as a regression, "fetching" reads as a normal recovery.

A summarized or paraphrased return without the envelope leaves the
parent with a stale token if it doesn't fall through to the state
fetch — the new token lives ONLY in the orchestrator's response body,
and your parent CANNOT see the sub-agent's tool results. The `STEP
BOUNDARY` directive injected into delegated prompts repeats this
requirement and names the envelope explicitly. This applies uniformly
across Claude Code (Agent tool), Codex (`spawn_agent`), Cursor, and
any other environment with sub-agent delegation.

### Escape hatch — `forge__abandon_workflow`

If the workflow no longer applies — the user redirected to unrelated work,
the classifier picked the wrong workflow, or scope changed mid-stream — call
`forge__abandon_workflow(conversation_id, reason)` to cleanly close the
conversation. This is the **only** correct way to exit a workflow without
completing it.

- **Do NOT silently bypass** the workflow by skipping `forge__update_state`
  calls and proceeding directly with implementation. Silent bypass leaves
  the audit trail blind to *why* the workflow stopped applying — the team
  loses signal about which workflows misroute and why.
- The `reason` is required, must be at least 8 characters, and is recorded
  in the audit trail. Make it meaningful (e.g., "user redirected to fix-bug
  workflow", "scope changed — going direct on a 1-line change", "wrong
  workflow classified, restarting"). Don't write filler like "abandoning"
  or "no longer needed".
- Idempotent: re-abandoning returns the original record. Safe to retry.
- After abandoning, you may start a fresh workflow with `forge__start_workflow`
  or proceed without one. Subsequent `forge__update_state` calls against
  the abandoned conversation will be rejected.

## Step 4: Respect model delegation rules

Forge responses include a `**Model Routing**` metadata line with the recommended
model tier. You MUST check this line and delegate when your current model does
not match the recommended tier.

### How to read the routing signal

The response metadata contains a line like:

```
**Model Routing**: tier=balanced | model=gpt-5.4 | environment=codex | guidance=codex_model_map | complexity=medium | task=planning
```

The `tier` value tells you which capability tier to use. The optional `model`
value is only exact when the `guidance` variant names a maintained model map
for your current environment. If no `model` is present, use the tier language
only: pick your fastest, balanced, or most capable available model.

### How to delegate

Follow the instructions in the Model Routing block returned by Forge:

| Routing signal | What to do |
|----------------|------------|
| `guidance=claude_code_model_map` | Use the concrete model parameter Forge provides. |
| `guidance=codex_model_map` | Use the provided Codex model hint when your Agent or model switch supports it; otherwise choose the same tier in Codex. |
| `guidance=model_agnostic_tier` | Do not invent a model name. Choose your tool's available model that matches the tier. |

The sub-agent inherits your MCP tools and can call external connectors directly.

**CRITICAL**: Sub-agents execute ONE step only. The `---DELEGATE BELOW---`
content already includes a step boundary directive. After the sub-agent returns,
YOU (the parent) **MUST display the sub-agent's full analysis, findings, and
substantive output to the user immediately — before launching the next
sub-agent, calling `forge__update_state`, or asking any confirmation
question.** This rule fires on every sub-agent return, not just before
confirmations. Do NOT summarize or paraphrase — reproduce the sub-agent's key
content (analysis results, discovery summaries, recommendations, structured
findings) so the user can see exactly what was produced. Then continue the
workflow by interpreting the next step yourself. Do NOT expect the sub-agent
to chain multiple steps.

Common loophole to avoid: when a sub-agent's return bundles both its
substantive findings AND state-advancement metadata (e.g. "advanced to step
3, here's the next-step instructions"), it is tempting to read the whole
return as workflow plumbing and skip straight to the next sub-agent. Don't.
The findings are user-facing; the state metadata is internal. Surface the
findings first, every time.

### Self-check: which tier are you?

- **fast** - lightweight/low-cost model tier
- **balanced** - default reasoning model tier
- **capable** - strongest available reasoning model tier

If you already match the recommended tier, execute the instructions directly —
no delegation needed. If you do NOT match, delegate or switch using the
environment-specific guidance Forge returned.

### Rules

1. **Always check** — if `**Model Routing**` is present, evaluate it before
   executing the step instructions
2. **Delegate both up and down** — if the tier says "capable", use your
   strongest available model; if it says "fast", use your lightweight model
3. **Announce delegation** — briefly tell the user before delegating
   (e.g., "Delegating to a balanced model for this step...")
4. **Pass the full prompt** — everything below `---DELEGATE BELOW---` in the
   instructions is the delegated prompt. Include all of it
5. **Do NOT skip delegation** — direct execution is easier but costs 10-20x
   more on low-complexity tasks. The cost difference is real

## Step 5: Coexist with planning/dry-run modes

Some AI harnesses enter a **planning/dry-run mode** when they detect intent
to execute non-trivial work (for example, Codex may be operating in a plan or
dry-run mode for verbs like "implement", "fix", "build"). In plan mode, the harness forbids
non-readonly tool calls and expects you to present a plan for the user to
approve before any writes happen.

When plan mode is active AND a Forge workflow is requested, **both
protocols apply** — they are not in conflict:

1. **Routing still applies** — call `forge__start_workflow` to fetch the
   right workflow. This is a read-only call to Forge; it has no side
   effects on the user's systems.
2. **Execute only the read-only operations** from the workflow's
   instructions — typically the early "fetch context" steps that read
   from the project tracker, codebase, or documentation tools.
3. **Defer writes** — surface every write the workflow would normally
   perform (status updates via `save_issue`, ticket comments, code edits,
   `forge__update_state` calls) as part of the plan you present to the user.
   Do NOT execute those writes while plan mode is active.
4. **After plan mode exits** (the user approves the plan), resume the
   workflow from where you paused — call `forge__update_state` to
   advance through the deferred steps in order until the workflow
   completes.

**Why both protocols are compatible**: plan mode constrains *which tools
you may call*, not *which workflows you may consider*. Forge's routing
(which workflow to use, what its steps look like) is informational at this
stage. Writes are deferred, not skipped — the workflow completes normally
once plan mode releases you to act.

**Anti-pattern to avoid**: do NOT abandon the Forge workflow mid-step
because plan mode is active. If you've called `forge__start_workflow` and
read the step instructions, complete the read-only portions and present
the deferred writes in your plan — do not pivot to a parallel
plan-mode-only investigation that ignores the workflow. Abandoning leaves
the session's `active_workflow` flag stuck (workflow-tracker.cjs only
clears it on completion), which causes every subsequent prompt to receive
a stale "A Forge workflow is active and waiting for user input" reminder.

## What NOT to route

Regular coding tasks should be handled normally without Forge:

- "Write a function that..." — pure code
- "Refactor this component" — pure code (unless tied to a ticket)
- "Add a test for..." — pure code
- "Read this file" / "explain this code" — exploration
- "Commit my changes" / "push to main" — git operations
- "What does this error mean?" — debugging Q&A

The line: if the user is talking about the **product development process**
(planning, scoping, tracking, handing off, reviewing against requirements,
auditing, releasing), route to Forge. If they're just writing code directly,
don't.
