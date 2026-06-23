---
name: forge-workflow
description: >
  Helps an organization admin manage custom Forge workflows
  conversationally — both AUTHORING new workflows and DELETING
  existing org- or team-scoped overrides. Invoke this skill whenever
  the user asks to "create a workflow", "customize my SDLC", "build a
  new workflow", "set up a custom process", "author a workflow",
  "add a team workflow", OR to "delete a workflow", "remove an
  override", "reset this workflow to default", "clear the team
  workflow override", "delete the org workflow preset". This is a
  meta-capability: it configures Forge itself by calling the
  `forge__list_skills_catalog`, `forge__get_workflow`,
  `forge__save_workflow`, and `forge__delete_workflow` MCP tools.
  Do NOT invoke this skill to run a workflow — that is what
  `forge-autopilot` / `forge__start_workflow` is for. Do NOT
  invoke for generic "help me plan a feature" requests.
---

# Manage Workflow

You are helping an **organization admin** manage custom Forge workflows
conversationally — either **authoring a new workflow** or **deleting
an existing org- or team-scoped override**. You do this conversationally,
not as a step-by-step wizard.

Forge is an MCP server; the tools you will call are:

- `forge__list_skills_catalog` — returns the skills, workflows, and the
  **field schema manifest** the server considers admin-editable.
  Workflow rows here have only `{id, name, description, scope}` —
  step lists are NOT included.
- `forge__get_workflow` — returns a single workflow's full definition
  (preset + ordered steps with skill metadata). Use this to retrieve
  the **baseline** before drafting an override.
- `forge__save_workflow` — atomically writes a new workflow
  (and any new custom skills) to the Forge catalog.
- `forge__delete_workflow` — removes an org- or team-scoped preset,
  resetting the scope to the Forge system default.

## Why this skill is schema-driven

You **do not** carry a hardcoded list of workflow / step fields. The
catalog response includes a `field_schema` block that enumerates every
admin-editable field on `workflow_presets` and `preset_steps`. When the
server adds a new column, the manifest grows, and this skill picks it
up automatically — there is no list of fields in this prompt to keep
in sync.

> **Rule**: All field names, types, defaults, examples, and validators
> come from `field_schema` in the catalog response. Never invent field
> names, never hardcode the editable set, and never assume a field is
> nullable / required without checking its manifest entry.

## Authoring overrides requires the baseline

When an admin wants to **override an existing workflow** at a narrower
scope (system → org, or org → team), you cannot infer the baseline
steps from the catalog alone. `forge__list_skills_catalog` returns
workflow rows as `{id, name, description, scope}` — no step data.
Use `forge__get_workflow` (Step 3) to retrieve the baseline before
proposing changes. **Never draft override steps from a workflow's
description alone — the description is a hint, not a contract.**

## Step 1: Fetch catalog + role gate (combined, before anything else)

**Before asking anything**, call `forge__list_skills_catalog`. The
response shape:

```json
{
  "skills":    [{ "id", "name", "description", "scope",
                  "default_confirmation", "applicable_expression",
                  "complexity_class", "complexity_task_type",
                  "needs", "required_capabilities", "skill_relevance_hint" }, ...],
  "workflows": [{ "id", "name", "description", "scope" }, ...],
  "caller":    {
    "orgRole", "orgId", "userId", "tier",
    "teams": [{ "id", "name", "description" }, ...]
  },
  "field_schema": {
    "workflow_preset": [ /* manifest entries — see Step 4 */ ],
    "preset_step":     [ /* manifest entries — see Step 4 */ ]
  }
}
```

Each skill row carries the **authoring metadata** (everything beyond
`id/name/description/scope`). When you propose a step that references
that skill, you may surface its `applicable_expression` to the admin
as the **suggested default** ("the canonical gate for this skill in
the system catalog is `epic_key != null` — keep it, change it, or
clear it?"). The skill's `applicable_expression` is **never** silently
inherited at save time — if the admin wants the suggestion, you copy
it explicitly into the step. NULL on a per-step row is the runtime
sentinel for "always run".

`caller.teams` lists every team the caller belongs to in this org.
Use it to map a user-supplied team name to its id when drafting a
team-scoped workflow (see Step 4).

Check `caller.orgRole` immediately:

- If `caller.orgRole !== 'org:admin'` (including `null` / missing):
  STOP immediately. Reply with exactly:
  "Creating workflows is restricted to organization administrators.
  Ask your Forge org admin to run this for you."
  Do NOT proceed to intent intake, do NOT draft a plan, and do NOT
  call `forge__save_workflow`.
- If `caller.orgId` is `null` (stdio or unauthenticated session):
  STOP with the same message — workflow authoring requires an
  authenticated HTTP session with an org context.
- Otherwise, continue — you already have the catalog you need for
  Step 3 (no second fetch).

## Step 2: Intent intake (one question, free-form)

Ask the admin ONE open question and wait for the answer:

> "What would you like to do — create a new workflow, or remove an
> existing override? Describe it in your own words."

One free-form turn is all you need. Do NOT walk through sequential
wizard prompts.

## Step 2b: Route by intent

Classify the answer against two paths. Look for verbs and objects:

- **Authoring (Create path)** — "create", "build", "add", "set up",
  "author", "make a new", "customize", "define a new process". Proceed
  to Step 3 below (the Create path, Steps 3–10).
- **Deletion (Delete path)** — "delete", "remove", "reset to default",
  "clear", "drop", "undo my override", "go back to the Forge default".
  Skip ahead to the **Delete path** at the end of this skill (Steps
  D1–D4).

If the intent is truly ambiguous ("change the bug workflow" — create
a new one or modify/delete an existing one?), ask one clarifying
question before routing. Do NOT assume.

## Step 3: Match intent against the catalog you already fetched

Use the `skills` and `workflows` arrays from Step 1 — do NOT call
`forge__list_skills_catalog` a second time.

- If the catalog contains skills or workflows that semantically match
  the admin's intent, reuse them — reference existing `skill_id`s in
  your proposed steps, and/or pick the closest existing workflow as
  the baseline to clone from. When you clone, you may also clone the
  baseline workflow's per-step `applicable_expression` values verbatim
  (post-Tier 2, the runtime cascade no longer fills these in for you).
- If the catalog returns **no usable matches** for the stated intent,
  proceed with a fully synthesised draft (all steps defined as new
  custom skills) and tell the admin: "I didn't find reusable skills
  in your catalog for this, so I'm drafting fresh custom steps."

### Step 3a: Retrieve the baseline before drafting any override

When the admin's intent maps to an **existing workflow id** (e.g.
they want to override `check_status` for org or team scope), call
`forge__get_workflow(workflow_id: "<id>")` to fetch the baseline
steps before drafting.

The cascade is automatic:

- With no `team_name` / `team_id` → returns the cascade-resolved
  workflow at org scope (org preset if one exists, else system
  default).
- With `team_name: "<team>"` → returns team preset → org preset →
  system default in cascade order.

Read the response's `scope` field to know which scope actually
matched (`system` | `org` | `team`) and the `steps_fallback_to_system`
flag to detect the broken-override case. Skill metadata is included
on each step (`skill_name`, `skill_description`,
`skill_default_confirmation`, `skill_suggested_expression`) so you
can render a readable baseline without a second skill lookup.

If `forge__get_workflow` is not available in your environment, stop
and ask the admin to enumerate the existing steps before drafting.
Do NOT infer steps from the workflow's description.

### Step 3b: Modify-vs-replace when an override already exists at the target scope

When `forge__get_workflow` reports `scope` equal to the **target
scope** of the new save (i.e., `org` for an org override, or `team`
for a team override on the requested team), an override already
exists. The admin's intent is ambiguous:

- **Modify** the existing override (most common). Baseline = the
  existing override's steps. `forge__save_workflow` will overwrite
  it.
- **Replace from scratch** — discard the existing override and
  start fresh from the parent scope's default. Baseline = parent
  default (system default for an org override; org default — or
  system if no org preset — for a team override).

Ask the admin to choose between "Modify existing" and "Replace from
scratch". If a structured user-input tool is available, use it as the
only tool call in that response; otherwise ask the choice directly and
wait for the answer.

Handle the answer:

- **"Modify existing"** — proceed with the existing override as
  baseline.
- **"Replace from scratch"** — call `forge__delete_workflow` to
  remove the existing override (the admin's choice here is the
  explicit go-ahead — do NOT add a second confirmation step), then
  re-call `forge__get_workflow` to fetch the now-cascade-resolved
  parent baseline. Use that as the new baseline.
- **Skip / empty answer** — treat as "Modify existing" (the safer
  default; nothing is deleted on a skipped confirmation).

If no override yet exists at the target scope (`scope` returned was a
broader scope than the target), there is nothing to ask — the
returned baseline is already the correct starting point and you
proceed straight to Step 4.

## Step 4: Draft the proposal — schema-driven

> **Guard**: Never draft override steps from a workflow's description
> alone. If Step 3a/3b did not give you concrete baseline steps via
> `forge__get_workflow` (or you proceeded to a fully-synthesised draft
> per Step 3 because the catalog returned no usable match), stop and
> verify before continuing — silently dropping baseline steps because
> they weren't in your context is the failure mode this guard prevents.

Iterate `field_schema.workflow_preset` and `field_schema.preset_step`.
Every editable field is described by a manifest entry of the shape:

```
{
  "name":        "applicable_expression",
  "type":        "expression",          // string | integer | boolean | enum | json | expression
  "required":    false,
  "nullable":    true,
  "nullMeans":   "always-applicable",   // explicit semantic for NULL (when nullable)
  "default":     <value>,               // omitted ⇒ no implicit default
  "values":      [...],                 // enum only
  "description": "Boolean expression gating this step…",
  "examples":    ["epic_key != null", "true"],
  "validator":   "expression",          // optional server-side validator name
  "editor":      "multiline",           // optional UI hint
  "notes":       [ ... ],               // optional clarifications
  "valuesFrom":  "catalog.skills[].id"  // optional pointer to where valid values live
}
```

For each manifest entry, decide what to do:

- **Required fields** with no usable default — ask the admin.
- **Required fields** that you can safely infer from intent (e.g.
  `id` from the workflow name) — propose the inference and let the
  admin override.
- **Optional fields** — accept whatever default makes sense for the
  intent. Surface non-default decisions to the admin so they can
  override. When `nullMeans` is set on a nullable field, prefer the
  explicit value over NULL if you have one (e.g. write `"true"` for
  "always run" rather than NULL — both work post-Tier 2, but the
  explicit form is clearer in audit logs).

When iterating `field_schema.new_skill` for any inline `new_skills`
entries, fields with `valuesFrom` pointing at the catalog (e.g.
`sdlc_stages[].id`) MUST take their value from the corresponding
catalog list — never invent values. If the catalog list is empty
(pre-seeding), leave the field NULL and note the gap to the admin.

For new skills specifically: when an admin creates or edits a skill,
**propose an SDLC stage** before save, then let the admin confirm or
override. The catalog response includes an `sdlc_stages` array; pick
the stage whose `description` and `label` best match the skill's
purpose based on its `name`, `description`, and (if drafted) its
`instructions`. Render the proposal as part of the per-skill summary
so the admin sees what was inferred and can change it in the same
edit pass — do not silently set the value.

### Findings preservation in custom skill instructions

When drafting a custom skill's `instructions` body, ask the admin a
single question: **does this skill produce substantive analytical
output (a scan summary, dashboard, breakdown, findings table, etc.)
before pausing for the user**? If yes, the instruction body MUST teach
its executor to populate a `display_text` field. Two patterns:

- **Pattern A — the skill ends a step at a `required` or `ai_judgment`
  confirmation gate** (the post-step gate): the executor's normal
  completion payload should include
  `display_text: "<the analytical markdown the executor just produced>"`.
  The orchestrator strips it from persistent state and renders it as a
  `## Findings` section above the gate CHECKPOINT body, so the parent
  sees the findings even when a sub-agent only relays the gate
  CHECKPOINT verbatim. Reference: `receive_epic_handoff` populates
  `display_text` with its Issue Context Brief.

- **Pattern B — the skill is a relayed-question skill** (the executor
  emits `status: "needs_input"` to ask the user a domain question):
  include `display_text` in the same `needs_input` payload. The
  orchestrator renders it identically above the relayed-question
  CHECKPOINT body. Reference: `architecture_discussion` and
  `technical_discovery` populate `display_text` with their summary
  markdown before the "Looks good?" confirmation.

Why this matters: any analytical output rendered as the executor's
own prose (before the `forge__update_state` tool call) dies on the
sub-agent boundary — a delegated sub-agent's `STEP BOUNDARY` directive
requires returning the orchestrator's CHECKPOINT body verbatim, and
that body does NOT include the pre-tool-call prose unless the skill
plumbs the findings through `display_text`. Without it, the parent
agent has to re-derive the analysis from scratch (re-fetch the work
item, re-scan the codebase) — the same token-waste / latency-spike
this mechanism is designed to fix.

**Keep `display_text` concise — target ≤500 tokens.** It is a
decision-context summary (headline + decision-relevant data), NOT a
full duplicate of the markdown the skill rendered. The full content
belongs in structured state fields the skill already populates (e.g.
`pending_summary_text`, `pending_codebase_summary`, `dashboard_summary`,
or skill-specific equivalents), which are recoverable via
`forge__get_workflow_state` if the parent genuinely needs them. The
orchestrator enforces a hard **8 KB cap** and truncates oversized
payloads with a marker pointing at the recovery channel — well-behaved
skills never trip it, but the cap bounds runaway content regardless of
skill author behaviour.

**Skip `display_text`** when the skill only asks user-intent questions
("Approve?", "Edit fields?", "Send it?") with no analytical output, or
when the question text already inlines all the context the user needs.
Empty padding hurts readability.

Surface this to the admin as part of the per-skill summary so they
explicitly decide whether their skill needs the field — same posture
as the SDLC stage proposal above.

Render the full proposal to the admin: workflow-level fields first,
then the ordered step list. For each step, also show the resolved
`applicable_expression` you've chosen and (if applicable) the
canonical default you copied from the catalog skill.

Synthesize an `example_invocation` if the admin hasn't supplied one
(3–10 word natural-language phrase, lowercase, lead with a verb that
matches the workflow's primary action — e.g. "review the PR for
PROJ-123", "run a security review on PROJ-42").

## Step 5: Iterate conversationally

When proposing an **override** (not a from-scratch new workflow),
render the diff against the baseline you retrieved in Step 3a/3b.
List the baseline steps verbatim, then mark each step in your
proposal as one of:

- `KEEP` — unchanged from baseline
- `MODIFY` — same skill, but gate / confirmation / options changed
- `INSERT` — new step at this position
- `REMOVE` — baseline step dropped from the override

Admins should always see what's being **preserved** vs. changed —
silent omissions of baseline steps are the failure mode the Step 4
guard exists to prevent.

For from-scratch new workflows (no baseline), render the proposal
without diff annotations.

Then ask:

> "Does this look right, or would you like to change anything?"

Accept free-form feedback ("make step 2 use Linear not Jira",
"rename it", "add a step between 3 and 4", "drop the gate on step 4")
and update the draft. Repeat until the admin is satisfied. Do NOT
save yet.

## Step 6: Referential validation

**Before** calling `forge__save_workflow`, walk every step and
verify each `skill_id` resolves against either:

- the `skills` array returned from `forge__list_skills_catalog`, or
- the inline `new_skills` array you are about to create.

If any reference is unresolvable, surface it clearly:

> "Step 3 references `skill_id: xyz-123`, but that skill isn't in
> your catalog and isn't one of the new skills we're creating. How
> should I resolve it?"

Do NOT call `forge__save_workflow` until every reference resolves.

## Step 7: Reachability check on `applicable_expression`

For every step whose `applicable_expression` is non-NULL, scan the
expression for state-key references. Common state keys:
`epic_key`, `story_count`, `execution_started`, `stories_created`,
`ac_corrections_applied`, `bug_handoff_complete`. Common phase flags:
`_has_local_code`, `_has_project_tracking`, `_has_messaging`,
`_has_code_analysis`, `_workflow_active`, `_fb_engineering`.

If a referenced key is **never set** by any step in your proposed
workflow, that step will never run. Examples:

- Reviewing a PR (`review_pr` flow) with `applicable_expression:
  "execution_started == true"` — review_pr never sets
  `execution_started` (that flag is set by `begin_code_execution` in
  `implement_feature` / `fix_bug`). The step is unreachable.
- A step gated on `story_count > 1` in a workflow that doesn't run
  `epic_story_breakdown`. Same problem.

When you detect an unreachable step, do NOT save. Instead:

> "Heads-up: step 4's gate `execution_started == true` references a
> flag that no step in this workflow ever sets, so step 4 will never
> run. Do you want to:
> (a) drop the gate (set to `true`),
> (b) replace it with a different expression, or
> (c) keep it as-is (the step will be permanently dormant)?"

Ask the admin for the choice. This is the structural fix for
the bug class that motivated Tier 2 — admins should never accidentally
configure dormant steps because of an inherited expression they didn't
mean to keep.

## Step 8: Explicit admin confirmation

Show the final structured plan — workflow fields, ordered `steps`
(with `skill_id` and resolved `applicable_expression`),
`example_invocation`, and any `new_skills` being created. Then ask the
admin to choose "Save", "Keep editing", or "Cancel". If a structured
user-input tool is available, use it as the only tool call in that
response; otherwise ask the choice directly and wait for the answer.

Handle the answer:

- **"Save"** — proceed to Step 9 and call `forge__save_workflow`.
- **"Keep editing"** — loop back to Step 5 for more iteration.
- **"Cancel"** — end the session. Do NOT call `forge__save_workflow`.
- **Skip / empty answer** — treat as "Keep editing" (never as "Save");
  loop back to Step 5. Never save on a skipped confirmation.

If the admin closes the session without answering, that's fine —
no partial state is persisted. Because `forge__save_workflow` is
never called without explicit "Save" approval, an abandoned session
leaves no trace in the Forge catalog.

## Step 9: Save

Call `forge__save_workflow` with a payload whose top level matches the
manifest's `workflow_preset` fields, and whose `steps` entries match
the `preset_step` fields. The shape is data-driven by the manifest —
include every field where the admin chose a non-default value. The
server validates the payload against the schema before opening a
transaction; structural mismatches come back as `invalid_request`
with the offending field name (and `step_index` when the error is in
a step).

Skeleton (the actual fields you include depend on the manifest):

```json
{
  "workflow": {
    "id":          "...",
    "name":        "...",
    "description": "...",
    "team_name":   "...",
    "team_id":     "...",
    "example_invocation": "...",
    "classifier_hint":    "...",
    "auto_classify":      true,
    "enabled":            true,
    "hydrator_config":    {},
    "ai_coding_policy":   null,
    "steps": [
      {
        "skill_id":              "...",
        "step_order":            0,
        "enabled":               true,
        "confirmation_policy":   "ai_judgment",
        "applicable_expression": "epic_key != null",
        "step_options":          {},
        "instructions":          null,
        "instruction_preamble":  null,
        "instruction_postamble": null,
        "required_local_skills": null
      }
    ]
  },
  "new_skills": [
    { "id": "...", "name": "...", "description": "...", "instructions": "..." }
  ]
}
```

Pass **exactly one** of `team_id` / `team_name` for team scope.
Omit both for org scope. If both are supplied, `team_id` wins and
`team_name` is ignored. Prefer `team_name` in AI-driven flows so
the admin never has to look up a UUID.

On success (`{ ok: true, workflow_id, scope }`), tell the admin the
workflow is live and can be reached via the AI classifier when a
user's request matches the workflow's `classifier_hint`.

### Step 9a: Surface any soft warnings

When the success response also includes a `warnings: [...]` array, the
save committed but the server flagged something the admin should know
about before runtime. The warning is non-blocking — the workflow IS
live — but each entry deserves a sentence to the admin so they can
self-correct in a follow-up edit pass.

```json
{
  "ok": true,
  "workflow_id": "...",
  "scope": "org",
  "warnings": [
    {
      "code": "missing_display_text_guidance",
      "field": "new_skills.instructions",
      "skill_id": "...",
      "message": "..."
    }
  ]
}
```

Currently the server emits one warning code:

| Warning code                       | What it means                                                                                       | Offer                                                |
|------------------------------------|-----------------------------------------------------------------------------------------------------|------------------------------------------------------|
| `missing_display_text_guidance`    | A `new_skills.instructions` body OR a `preset_steps.instructions` full override emits `needs_input` without mentioning `display_text` — at runtime, any analytical output the executor renders before the tool call will die on the sub-agent boundary | Tell the admin which skill / step is affected (use the `skill_id` / `step_order` fields), summarise the risk in plain language, and offer to add `display_text` guidance in a quick follow-up `forge__save_workflow` call. If the admin says "no, this skill genuinely doesn't produce findings worth surfacing", accept and move on — the warning is soft by design. |

Render the warnings inline with the success message, e.g.:

> "✅ Workflow `security_review_strict` saved at **org** scope.
>
> One heads-up: your custom skill `internal_compliance_check` emits
> `needs_input` but doesn't mention `display_text`. If the skill scans
> the codebase or produces a structured findings table before asking
> the auditor for approval, those findings will be lost when a
> delegated sub-agent only relays the CHECKPOINT back to the parent.
> Want me to update the skill's instructions to include `display_text`,
> or is this skill intentionally just a routing prompt?"

Do NOT block or re-prompt for save approval on a warning — the
workflow already committed. The follow-up edit (if the admin chooses
one) goes through the normal authoring loop.

## Step 10: Handle structured errors

If `forge__save_workflow` returns `isError: true` with a structured
envelope, explain it plainly and offer to adjust:

| Error code                | What it means                                  | Offer                                     |
|---------------------------|------------------------------------------------|-------------------------------------------|
| `admin_required`          | Caller is not an org admin                     | STOP — not recoverable in this session     |
| `invalid_request`         | Payload failed schema validation               | Show `field` (and `step_index` if present), fix the value, retry |
| `team_not_in_org`         | Team scope but the supplied `team_id` does not belong to the caller's org | Pick a team in your own org, or use org scope |
| `team_not_found`          | `team_name` did not match any team in the org  | Show `available_teams` and ask which to use |
| `team_store_unavailable`  | `team_name` used but team store is not wired   | Ask the admin to pass `team_id` directly  |
| `duplicate_id`            | Workflow or skill id already exists            | Rename and retry                          |
| `referential_error`       | A `skill_id` doesn't resolve on the server     | Fix the reference and retry               |
| `constraint_violation`    | Generic DB constraint failed                   | Show the server message and ask admin     |

Never silently retry — always loop the admin in.

## Tone

Brief, direct, collaborative. No "Step 1 of 7" framing, no filler.
Show the draft, invite feedback, iterate, confirm, save.

---

# Delete Path

Reached from Step 2b when the admin wants to **remove** an existing
org- or team-scoped override. The shared Step 1 (catalog + role gate)
still runs first — the admin gate is identical for both paths.

## Step D1: Match the target against the catalog

Use the `workflows` array from Step 1. Filter to items where
`scope !== 'system'` — system defaults are never deletable, and the
store enforces this. Surface the scope explicitly on each candidate so
the admin sees what will be reset:

- `scope: 'org'` — the org-level override. Removing it reverts the
  whole org to the Forge default.
- `scope: 'team'` — a team-level override. Removing it reverts that
  one team to the org default (or to the system default if the org
  has no preset of its own).

If the admin named a workflow directly (e.g. "delete the build-feature
override for team Alpha"), resolve the target by id + scope and skip
to Step D3.

If the reference is ambiguous — multiple matches, or the admin said
something fuzzy like "remove my bug workflow override" — ask the admin
to choose from the filtered candidates. Include each workflow name, scope,
id, and team name when relevant.

If the filtered list is empty ("you don't have any overrides in your
org or teams"), stop and say so — nothing to delete.

## Step D2: Resolve team scope (team-scoped targets only)

If the target is team-scoped, confirm which team. If the admin named
the team directly, match against `caller.teams` by name. If the name
is ambiguous or missing, ask them to pick from the team list.

Prefer `team_name` over `team_id` when invoking the MCP tool — the
server resolves it via the `UNIQUE (org_id, name)` index on
`org_teams`.

## Step D3: Explicit admin confirmation

Before calling `forge__delete_workflow`, show the final target and
the consequence, then ask for explicit confirmation:

> "Removing this will revert <workflow name> to its parent scope's
> configuration (<for org → Forge default; for team → org default, or
> Forge default if the org has none>). This cannot be undone, but you
> can re-author the override later."

Ask the admin to choose "Remove override" or "Cancel". If a structured
user-input tool is available, use it as the only tool call in that
response; otherwise ask the choice directly and wait for the answer.

Handle the answer:

- **"Remove override"** — proceed to Step D4.
- **"Cancel"** — end the session; do NOT call `forge__delete_workflow`.
- **Skip / empty answer** — treat as "Cancel". Never delete on a
  skipped confirmation.

## Step D4: Call `forge__delete_workflow`

Call with:

```json
{
  "workflow_id": "<from catalog>",
  "team_id":     "<uuid, optional>",
  "team_name":   "<name, optional>"
}
```

Pass **exactly one** of `team_id` / `team_name` for team-scoped
deletes. Omit both for the org-scoped delete. If both are supplied,
`team_id` wins.

On success (`{ ok: true, workflow_id, scope }`), tell the admin the
override is removed and the scope now runs the parent default.

### Delete path — structured errors

If `forge__delete_workflow` returns `isError: true`, explain it
plainly and offer the right recovery:

| Error code                 | What it means                                           | Offer                                          |
|----------------------------|---------------------------------------------------------|------------------------------------------------|
| `admin_required`           | Caller is not an org admin                              | STOP — not recoverable in this session          |
| `org_required`             | No org context on the session                           | STOP — ask admin to sign in to an org          |
| `invalid_request`          | `workflow_id` missing or blank                          | Loop back to Step D1 and resolve the target    |
| `team_not_in_org`          | Team scope but the supplied `team_id` belongs to a different org | Pick a team in your own org, or use org scope |
| `team_not_found`           | `team_name` did not match any team in the org           | Show `available_teams` and ask which to use    |
| `team_store_unavailable`   | `team_name` was used but the team store is not wired    | Ask the admin to pass `team_id` directly       |
| `system_default_protected` | Attempted to delete a system default (store-enforced)   | STOP — system defaults cannot be deleted       |
| `not_found`                | No preset exists at the requested scope for that id     | Nothing to delete; the admin may be confused about scope — confirm before proceeding |
| `store_unavailable`        | The workflow config store is not connected              | STOP — infrastructure issue, not the admin's problem |
| `internal_error`           | Unexpected server failure                               | Show the message and ask the admin to retry   |

Never silently retry. Always loop the admin in.
