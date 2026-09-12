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
  test planning and strategy, refactoring, mapping or documenting system
  architecture across the codebase, reconstructing an architecture estate or
  building an architecture atlas, or any similar SDLC activity. ALSO invoke
  when the current user request directly targets a tracked work item key matching
  "PROJ-123" / "BUG-42" / any "<UPPERCASE>-<digits>" id. Do NOT invoke for pure
  coding requests ("write a function", "refactor this file", "add a test") or
  continuation of already-scoped execution, even when a tracked key appears only
  in earlier conversation context. Do NOT invoke for git operations, file editing,
  applying already-scoped review feedback, resolving merge conflicts, publishing
  an existing change, or general Q&A unrelated to a project.
---

# Forge Autopilot

You are routing product development requests to Forge via the `forge` MCP
server. The user does NOT need to say "forge" or "@forge" — detect their intent
from the skill description above and call the right tool automatically.

Forge's workflow catalog lives on the server side and is fully data-driven.
You don't need to know which workflows exist — `forge__start_workflow` will
return a classifier prompt listing all available workflows (Forge defaults
plus any org-specific workflows configured for the current user) when it
needs the client AI to choose. Just call it and follow the instructions.

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

### Continuation boundary — check before calling Forge

Use the full conversation, not only the user's latest sentence, to decide
whether this is a new SDLC outcome or continuation of concrete work that is
already scoped. Handle the request normally without starting Forge when the
user is:

- implementing specific changes already requested or reviewed in this session;
- resolving a merge conflict or applying known review comments;
- editing known files, adding already-specified tests, or fixing an already-
  diagnosed local defect; or
- committing, pushing, creating, or updating a pull request for work already
  in progress.

This boundary still allows Forge when the current request explicitly invokes
Forge, directly names a tracked work item as the requested outcome's target, asks
to run a catalog workflow (for example,
"review this PR"), or asks for a new product/process outcome that has not
already been scoped. The distinction is the requested outcome: **review a PR**
is workflow-shaped; **apply these review changes and update the PR** is coding
continuation. A work item key that appears only in earlier turns or as historical
context does not override this boundary.

For any product/SDLC request that passes this boundary, your **default action** is:

→ `forge__start_workflow(feature_request, connected_tools, local_skills: <detected_skills>)`

Do NOT pass an explicit `workflow` parameter on the initial call and do NOT
try to route to a server-side skill. When intent selection is needed, Forge
returns the enabled workflow catalog for this user and organization.

- If the request names no outcome and no lifecycle verb (for example "help me
  with the roadmap"), do not match yet: ask one question about what should
  exist when the work is done, with options phrased as outcomes the catalog
  can deliver (never workflow ids), plus a final "None of these fit". Forge's
  returned instructions say, per caller, whether to add "Build a custom
  workflow" before it. Then classify the answer, and report the ask on the
  classified call as `routing_ask: { asked: true, scope: "outcome", offered:
  [<the ids behind the outcomes you offered>] }`.
- A workflow fits only when it would deliver the named outcome, not feed into
  it — a near miss is a no-match, not a candidate. If one workflow clearly
  fits, re-call `forge__start_workflow` with that explicit catalog workflow id
  and `classification_complete: true`.
- If multiple catalog workflows genuinely fit, present only those, always with
  a final "None of these fit" option — a user handed the wrong options must
  never be cornered into one. When Forge's instructions say the caller can
  author, add "Build a custom workflow" immediately before it and show at most
  two candidates (the widget holds four options). After they choose a
  candidate, re-call with that explicit workflow id, `classification_complete:
  true`, and `routing_ask: { asked: true, scope: "catalog", offered: [<the ids
  you offered>] }` — add `authoring_offered: true` when the build option was
  shown. If they pick "None of these fit" — or skip the question — treat the
  request as having no match and follow the instructions Forge returns; do not
  re-ask. If they pick "Build a custom workflow", take the authoring offer in
  Forge's instructions directly, carrying their words forward.
- Never invent a workflow, expose a server-side skill id as an option, or set
  `classification_complete: true` without an explicit `workflow`.

The server-provided workflow catalog is the source of truth; the client AI
owns the contextual choice among those available workflows.

### Admission proposal — validate before activation

A post-classification call returns a server-resolved **workflow proposal**
before it creates an active conversation. Compare its entry step, missing
inputs, configured path, and potential side effects with the user's **full
conversation and current phase**:

- If they align, re-call `forge__start_workflow` with the same arguments plus
  the returned `admission_token` and `start_confirmed: true`.
- If they do not align, do **not** confirm and do **not** call
  `forge__abandon_workflow` — no workflow has started. Choose another workflow
  only when it is an exact catalog match. If none matches, continue normally
  when this is coding continuation, otherwise explain that no available Forge
  workflow fits.
- Never set `start_confirmed: true` without the server-issued
  `admission_token` from the immediately preceding proposal.

### Exception 1 — Help / recommendation request

"What should I do with PROJ-123?", "help with PROJ-123", "where to start"

→ `forge__start_workflow(feature_request, connected_tools, recommendation: true, local_skills: <detected_skills>)`

### Exception 2 — Session observer (passive tracking)

#### Codex passive delivery

Codex's Stop hook only saves pending observation/checkpoint work locally. On the
next real user prompt, UserPromptSubmit supplies short `FORGE PASSIVE OBSERVATION`
or `FORGE PASSIVE CHECKPOINT` developer context. This is not a new user request.
Read the referenced session JSON and match the delivered id before acting. Do not
repeat a delivered action from earlier history, and do not display the hook text,
session path, or receipt. Host-owned hook indicators may still be visible.

For **observation**, evaluate `delivered_observation` against this conversation:

- `skip`: no project-related SDLC work, or the user explicitly excluded tracking.
- `sleep`: a snoozed wake condition is not satisfied by the current message.
- `defer`: an optional interaction would interrupt the user's requested work,
  required input, or another active workflow.
- `observe`: relevant SDLC work, a satisfied wake condition if any, and room to
  handle optional tracking without displacing the requested result.

After evaluating, record a local receipt by running the acknowledge command the
delivered context already contains, verbatim, replacing only its final
`<observe|skip|defer|sleep>` token with your disposition. The hook built that
command from validated values; never assemble one yourself from the state file,
and if the context carries no command, write no receipt. The helper records
evaluation only; it neither authorizes nor logs work remotely. If shell
execution is not permitted, do not bypass the restriction or claim a receipt was
written. For skip and sleep continue the user's task without starting
observation. `defer` re-arms the offer: Forge brings it back on its own after a
cooldown of about eight turns, so do not retry it yourself. These are
at-most-once delivery attempts, not instructions to retry on every prompt. For
observe use the existing observe_session entry point below. A previous soft
decline must be acknowledged in any returning offer. Eligibility numbers describe
the queued interval, not additional time spent idle before this prompt.

A snoozed session also receives a short per-prompt `FORGE ROUTING` wake check
naming its wake condition. Act on it only when the user's current message
clearly satisfies that condition; otherwise say nothing about it.

For **checkpoint**, read `delivered_checkpoint` and pass only its
`conversation_id`, `completed_step`, and `state_updates` to the existing Forge
update-state tool. The session is already authorized as logged/linked; do not
start a workflow or ask again. Submit it once in the current active turn and
never retry an attempt that was made: an interrupted or failed submission stays
unretried, and so does an ambiguous one. The PostToolUse tracker records
successful processing separately from delivery. Preserve
`state_updates.codex_checkpoint_id` and the frozen payload exactly as delivered.
The guard claims that UUID before submission. If it refuses because the payload
does not match the delivered one, no attempt was made: resubmit the delivered
payload verbatim, once. Old delivered payloads without an ID cannot be
submitted. An undelivered legacy queue gains its ID when the next prompt
delivers it.

The user's substantive result must remain the final answer. Complete requested
work before opening an optional tracking interaction; defer if necessary. After
any interaction, still provide the full result and validation, not just tracking
status or a short acknowledgment. Do not infer consent from context delivery,
silence, a default selection, timeout, or failed submission. If the user redirects
away from an observer question, the new request is not automatically an answer;
use the existing abandonment path when that workflow no longer applies.

Delivery waits for a real user turn. If none arrives, or the session expires or
delivery is interrupted, observation and queued timing may remain unrecorded.
No background model turn or guaranteed end-of-session flush is provided.

Triggered by the Codex passive delivery evaluation above (or an explicit request)
— input contains "observe session" or
"observe_session workflow".

→ `forge__start_workflow(feature_request: "Passive session observation", connected_tools, workflow: "observe_session", local_skills: <detected_skills>)`

The `observe_session` workflow is a single-step workflow that wraps the
session observer. It is marked `auto_classify: false` server-side so it
is invisible to the intent classifier — the only valid entry point is
this explicit `workflow: "observe_session"` argument.

Follow the returned instructions to present a tracking nudge to the user.
Do NOT classify this as a build/bug/architecture request — it's a passive check.

#### After any workflow completes — read `follow_up`

When a workflow returns `Workflow complete.`, look at the final
`state_updates` payload you sent. If it includes a non-null `follow_up`
object, **you MUST chain to that workflow before resuming the user's
original request**. Status reports and session-observer outcomes both use
this structured handoff contract.

```
forge__start_workflow(
  feature_request: <follow_up.feature_request>,
  connected_tools: <same array as before>,
  epic_key: <follow_up.epic_key>,
  workflow: <follow_up.workflow>,
  classification_complete: <follow_up.classification_complete ?? true>,
  pre_forge_context: <follow_up.pre_forge_context>,
  local_skills: <detected_skills>
)
```

The four-field structured shape keeps the bound work item key
clean: `epic_key` is passed as a structured parameter so any
`PROJ-NNN`-shaped strings inside `pre_forge_context` cannot hijack the
binding via the embedded-key regex.

If `follow_up` is `null` or absent, do **not** chain. Continue the
conversation normally.

**Common failure mode to avoid**: treating "Workflow complete" as
"the workflow is done — go back to the user's original ask". A selected
follow-up is an explicit user route; silently ignoring it leaves that choice
unhonored. Always read `follow_up` before resuming.

### Exception 3 — Session checkpoint (passive time tracking)

Triggered by Codex passive delivery for an already-tracked (`logged` / `linked`)
session. Read the frozen call from `delivered_checkpoint` in the referenced state.

→ Call `forge__update_state` exactly as `delivered_checkpoint` specifies — pass
its `conversation_id`, `completed_step` and `state_updates` verbatim, once. The
`conversation_id` is the original `observe_session` conversation; the server
records the elapsed time as a silent audit event. If the call is denied as
already recorded, do not retry it.

Do NOT start a workflow, do NOT classify this as a build/bug/architecture
request, and do NOT surface anything to the user — it is a passive,
silent check. After the call, continue normally.

## Step 3: Follow the workflow

Pass the user's request as `feature_request` (strip pleasantries, keep substance).

After calling `start_workflow`, Forge returns step-by-step instructions.
Follow them:

1. Execute each step as instructed
2. Follow the returned question-delivery instructions. Forge may deliver a native MCP form and return the answered step directly; do not ask the same question again after RE-ENTRY. Otherwise use only a question tool available and permitted by this host. In Codex, `request_user_input_async` takes `questions: [{title, options: [string, ...]}]`; use `request_user_input` only when the current mode permits it. Use Claude's `AskUserQuestion` only when that host provides it. When no permitted tool fits, ask the concise free-text question in the host's allowed format.
3. An async `{accepted:true}` means submitted, not displayed or answered. Wait for the actual later user message before dependent work. Preserve the question ID, step token, option order and labels. Post the actual answer through the returned `user_answer` or `gate_answer` path. Never convert dismissal, failure, empty input or a preselected default into `TBD` or approval. Keep the decision identifiable to the user. Read-only recovery does not re-present; use `question_resume: true` with the returned identity on an explicit resume.
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
- `forge__abandon_workflow` — exit when the workflow no longer applies (see
  below; it is not a way to end a run early)
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
(`forge__update_state`), or abandon (`forge__abandon_workflow` — only when
the workflow itself no longer applies). This makes silent bypass hard to do
by accident. It is not a security boundary: `forge__abandon_workflow` is
always allowed, and a host that wraps MCP calls may not expose every call
to the hook.

If you receive a deny decision for a tool you genuinely need, the right
move is usually to advance the workflow — the next step's allowlist
likely includes the tool you want.

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

- **Not for ending a run early.** When a post-step confirmation gate is
  pending it already offers **Stop here**, which ends the run, keeps
  everything produced, and records which steps did not run. Relay that gate
  and let the user choose. Deciding on your own that the remaining steps are
  unnecessary is not a reason to abandon — an abandon at a gate is recorded
  as such in the audit trail, and the recap names the steps that did not
  run.
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
**Model Routing**: tier=balanced | model=gpt-5.6-terra | environment=codex | guidance=codex_model_map | complexity=medium | task=planning
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
environment-specific guidance Forge returned — unless the step's **Worth-it
check** flags the remaining work as a pre-computed replay (content already in
workflow state, no new generation), in which case run it inline regardless of
tier.

### Independence: a different question from tier

Tier asks "is this model strong enough?". It does not ask "should the reviewer
be someone who has already seen this work?" — and for a step whose job is to
**judge** an artifact, that second question is often the one that decides
quality. A reviewer who produced the work reads what they *meant* to write; a
reviewer with no prior exposure reads what is actually there.

Each step's advisory carries an **Independence check** above its delegation
rules. Settle it first, because the rules would answer it wrongly: "I'm already
on the right tier" and "I already hold the context" both point at running
inline, and on a review step holding the author's context is the
disqualification, not the qualification.

The check is a test you apply to the step in front of you — Forge does not
pre-label which steps are reviews, because your org's own workflows and skills
count too. It also covers judging your own *conclusions*, not just your own
code: confirming a root cause you hypothesised earlier in the run is the same
failure mode, and a more expensive one, since the whole fix gets built on it.

When it comes out yes, three things matter:

- **Give away the judgment, keep the step.** Hand the fault-finding to the
  fresh agent; keep the mechanical checks, the rendering, and — when the step
  ends in a gate or relayed question — the gate and the `forge__update_state`
  hand-off. Delegating a gated step whole forces the sub-agent to relay the
  entire envelope back to you, which is the most fragile part of the contract.
  A split prompt is **not** the standard payload — see rule 4 below.
- **Check that "fresh" is actually fresh.** On some hosts a spawned sub-agent
  inherits the parent conversation by default, so calling it fresh does not
  make it so — an agent holding your reasoning will confirm you, and it costs
  more than an isolated one. If your sub-agent tool has a context/history
  parameter, set it to inherit nothing. Forge's per-step advisory names the
  exact parameter where it knows it.
- **Reuse the reviewer, never the author.** Do not resume an agent that helped
  build the thing. Do resume the independent reviewer you already spawned this
  run — it is still independent, and it saves re-reading the same diff on every
  review step. A run with three judgments over one diff should pay one cold
  read, not three.
- **Brief it with the artifact and the standard, never your conclusions**, and
  surface what it found before you reconcile it. Knowing what you meant to
  write is not evidence that the code does it.

When you cannot spawn one, run it inline and label it: *"Reviewed on my own
context — this is a self-review."* A self-review is a fine outcome; a
self-review that reads as an independent one is not.

### Rules

1. **Always check** — if `**Model Routing**` is present, evaluate it before
   executing the step instructions
2. **Delegate both up and down** — if the tier says "capable", use your
   strongest available model; if it says "fast", use your lightweight model
3. **Announce delegation** — briefly tell the user before delegating
   (e.g., "Delegating to a balanced model for this step...")
4. **Pass the full prompt — when the WHOLE step goes over** — everything below
   `---DELEGATE BELOW---` is the delegated prompt; include all of it. **If you
   are splitting the step instead** (handing over a judgment per the
   independence check, or a bounded read per the step's rule 5), do NOT forward
   the `STEP BOUNDARY` directive: that is what makes a sub-agent call
   `forge__update_state` and advance, which rotates the `step_token` out from
   under your own call for the same step. Send the artifact, the standard and
   the analysis portion only, and tell it to return findings as text and call
   no `forge__` tool
5. **Everything ABOVE the delimiter stays with you** — it is addressed to the
   parent, not the sub-agent. In particular, a `<<<FORGE_DISPLAY_VERBATIM …>>>`
   block above the delimiter is content **for the user** (the "Step N of M"
   progress marker): render it verbatim BEFORE you delegate, and never fold it
   into the delegated prompt. See "Must-display blocks" below
6. **Delegate when it pays for itself, not reflexively** — for real work
   that's off your tier, delegating up buys better reasoning and down saves
   real cost. But each step's advisory carries a **Worth-it check**: when the
   remaining work is only replaying content already in workflow state (a
   pre-computed `pending_*` post, no new generation), run it inline on your
   current model — spawning a sub-agent for that just burns a round-trip.
   Follow the per-step Worth-it check; don't skip delegation merely because
   direct execution is easier

### Must-display blocks

Forge marks content that is meant for the **user** — not for you — by wrapping
it in a relay envelope:

```
> **Relay to the user** — render the block between the sentinels below ...

<<<FORGE_DISPLAY_VERBATIM id="position">>>
### Step 2 of 8: Discover AI SDLC
next: ... · then: ...

---
<<<END FORGE_DISPLAY_VERBATIM>>>
```

Rules:

- **Render what is between the sentinels, verbatim** — never the sentinels
  themselves, and never a summary. It is the user's only view of where the run
  has got to.
- **Render it before anything else in that turn** — before analysis, before
  delegating, before your next tool call.
- **Render it even if you think the display hook already did.** Forge's
  `must-display` hook runs on `PostToolUse` in this plugin and emits the block
  itself, but where that output lands is client-dependent — on some clients it
  goes to the session transcript rather than to the screen, and on a delegated
  step it never reaches the user at all. You cannot tell from inside the turn,
  so always render: a duplicate is untidy, a missing marker leaves the user
  with no view of the run.
- **It is always the parent's job.** These blocks sit OUTSIDE the
  `<<<FORGE_NEXT_STEP>>>` envelope and above `---DELEGATE BELOW---`, so a
  sub-agent never receives one as part of its prompt. If you ARE a sub-agent and
  one appears in a tool result you got, relay it to your parent unrendered along
  with the envelope — your parent is the one talking to the user.
- **Two ids exist today**: `preflight` (the "what to expect" brief, once at the
  start of a run) and `position` (the "Step N of M" marker, once per step).
  Treat any future id the same way.

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
plan-mode-only investigation that ignores the workflow. Abandoning closes
the run for good: the steps that had not run are recorded as not run, the
audit trail records the abandonment, and nothing resumes it — the user has
to start over.

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
