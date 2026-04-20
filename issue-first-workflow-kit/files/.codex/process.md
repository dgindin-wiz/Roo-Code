<!-- Managed by issue-first-workflow-kit. Local edits may be overwritten by install.sh. -->

# Issue-First Process Manual for Codex

## Purpose

This file defines the operating workflow Codex should follow in this repository.

It exists to make AI-assisted engineering work:

- stateful
- disciplined
- resumable
- reviewable
- durable

`AGENTS.md` is the runtime contract. This file is the detailed operating manual.

## Core Model

Every meaningful unit of work must move through explicit artifacts and explicit
transitions.

### Artifact Roles

The GitHub Issue is the work-item container. It holds the objective, current
status and phase, current understanding, evidence summary, confirmed findings,
current plan, next step, and implementation linkage.

The Issue body is the canonical current truth. It should answer what this work
item is, what phase it is in, what is true now, what matters now, and what
happens next.

Issue comments are milestone records. They are for meaningful findings,
meaningful transitions, and timestamped engineering events. They are not for
routine procedural noise.

The branch is the implementation container.

The Pull Request is the implementation and review artifact. It should explain
what changed, why it changed, what was validated, and what remains uncertain.

Closeout is the final durable outcome record after merge.

## Non-Trivial Work

Treat work as non-trivial when it includes one or more of the following:

- behavior change
- bug diagnosis
- performance tuning
- refactor affecting more than a small localized surface
- multi-file change
- change needing validation beyond obvious visual inspection
- change that should be understandable later by someone who did not do the work

For non-trivial work, use the full workflow below.

## Work-Item Phases

Use these conceptual phases:

- triage
- planning
- diagnosing
- diagnosis_complete
- implementation_planned
- implementing
- draft_pr_open
- validating
- ready_for_review
- merged
- closed_out

Not every work item needs every phase, but the work should not skip silently
across major boundaries.

## Intake Issues Versus Operational Work Items

Public-facing issue forms are valid starting points, but they are not
automatically complete operational work items.

When an intake issue becomes active engineering work, do one of the following
before meaningful implementation begins:

1. Convert the same issue into operational form when the existing issue cleanly
   represents the work and the implementation is modest or coherent.
2. Create a linked follow-on operational issue when the engineering work will be
   lengthy, diagnosis-heavy, or broader than the original report.

If creating a follow-on issue, link it clearly to the original intake issue and
state that the follow-on issue is the active engineering container.

## Start-From-Issue Workflow

For any meaningful task:

1. Locate the existing relevant Issue or create/draft one before implementation.
2. Establish a plan before code changes.
3. Ensure the Issue body reflects the current plan.

The plan should contain:

- objective
- scope in
- scope out if useful
- likely impacted files or systems
- risks or uncertainties
- acceptance criteria
- next step

When creating or converting an operational work item, use
`.codex/templates/operational-issue-body.md`.

## Canonical Issue-Body Structure

When an issue is being used as the operational work item, the body should use
this structure where relevant:

- Status
- Phase
- Last major update
- Objective or problem / symptom
- Impact
- Current known context
- Evidence summary
- Leading hypotheses
- Confirmed findings
- Current plan or proposed remediation
- Validation / measurement plan
- Implementation container decision
- Next step

Not every section must be populated at every phase, but the structure should
remain stable.

When an issue is actively being implemented, the body must also record:

- canonical repo for GitHub writes
- head branch when one exists
- base branch or merge target
- PR role:
    - same-Issue direct implementation
    - bundle PR into integration branch
    - final integration PR to `main`
    - direct PR to default branch

## Comments Versus Body Rules

Update the Issue body when:

- current understanding changes
- evidence summary changes
- confirmed findings change
- remediation direction changes
- next step changes materially
- implementation container changes
- validation state changes materially

Add an Issue comment when:

- a milestone occurs
- a future engineer would care about the timestamp of the event
- the event changes the trajectory of the work

Do not add comments for every file inspected, every command run, minor wording
changes, or trivial progress chatter.

Use repository comment templates in `.codex/templates/` for milestone comments.

## Canonical Repo Resolution

Before any GitHub write action such as creating or editing an issue, opening or
updating a PR, or posting a milestone comment:

1. Resolve the canonical repo from the local checkout's `origin` remote.
2. Treat `upstream` as read/reference-only unless the user explicitly says to
   target it.
3. Pass the resolved repo explicitly to the tool or command.
4. Record the canonical repo in the Issue body's implementation-container
   section.

Do not rely on implicit GitHub CLI defaults for write targets.

## Investigations Are First-Class

If root cause or remediation is not yet known, the work is in investigation
mode.

Use the issue body for canonical current truth and milestone comments for
important discoveries.

Meaningful investigation milestones include:

- reproduction confirmed
- important benchmark recorded
- major hypothesis rejected
- likely root cause identified
- investigation redirected
- investigation blocked

## Diagnosis-Finalized Transition

This is a mandatory transition for investigation-driven work.

When diagnosis becomes solid enough to drive implementation:

1. Update the Issue body first.
2. Add a milestone comment using
   `.codex/templates/diagnosis-finalized-comment.md`.
3. Announce the transition in chat:
   `Workflow step: Diagnosis finalized (updating canonical Issue state and adding mandatory milestone comment)`.

The milestone comment must include root cause, key evidence, remediation
direction, implementation container decision, next step, and a statement that
the Issue body has been updated to reflect the current canonical diagnosis and
plan.

## Implementation Container Decision

Before implementation begins after diagnosis or planning, make this explicit:

- whether work stays on the same Issue or moves to a follow-on Issue
- whether the implementation is a direct PR, bundle PR into an integration
  branch, final integration PR to `main`, or direct PR to the default branch
- the canonical GitHub repo for writes
- head branch
- base branch or merge target

When in doubt, prefer the option that keeps scope reviewable and avoids silent
mixing of unrelated changes.

## Implementation Workflow

Once the Issue is anchored, the diagnosis or plan is stable enough to implement,
the implementation container is selected, and there is a first coherent
implementation slice or meaningful commit:

- ensure the Issue body is current
- create or identify the implementation branch
- create or update the PR artifact
- do not wait for full build, install, or test completion before opening the
  Draft PR
- prefer Draft PR for non-trivial work

Announce in chat:

`Workflow step: Draft PR opened (moving implementation into reviewable artifact)`

The PR body should use `.github/PULL_REQUEST_TEMPLATE.md` and include summary,
primary work item, link type, PR role, canonical repo, base branch, rationale,
scope, validation summary, known caveats, and follow-on work.

## Validation Workflow

Before treating work as ready for review, record:

- commands or checks run
- pass / fail / mixed result
- benchmark or performance deltas if relevant
- important caveats or gaps

Use `.codex/templates/validation-summary-comment.md` when a milestone validation
comment is appropriate.

Validation is the gate for moving a Draft PR to ready for review. It is not the
gate for opening the Draft PR in the first place.

Do not claim fixed, done, or ready for review unless the validation summary
supports that claim.

## Closeout Workflow

After merge:

1. update the work-item state
2. record final outcome
3. link merged PR
4. record unresolved follow-on work if any
5. mark closed only when the outcome is explicit and durable

Use `.codex/templates/closeout-comment.md` if a closeout comment is appropriate.

Announce in chat:

`Workflow step: Closeout recorded (capturing durable final outcome)`

Merge is not the end of the operating model. Closeout is.

## Workflow-Step Vocabulary

Use these step names consistently:

- Issue anchored
- Investigation milestone recorded
- Diagnosis finalized
- Implementation container selected
- Draft PR opened
- Validation summarized
- Closeout recorded

Use the short one-line form by default.

## Material Change Rule

A material change is one that alters current understanding, accepted diagnosis,
remediation direction, implementation container, validation state, next step, or
merge/closeout state.

Material changes require canonical state refresh. Non-material changes do not.

## Validation Command Rule

If repository-specific validation commands are documented elsewhere in the repo,
run the relevant ones after changes.

If a required validation step cannot be run:

- say so explicitly
- record it in the PR or work item summary
- do not imply a stronger level of confidence than the evidence supports

## Final Operating Principle

The point of this workflow is:

- no material engineering state lost
- no invisible transitions
- no implementation without durable context
- no review without explicit validation
- no merge without durable outcome
