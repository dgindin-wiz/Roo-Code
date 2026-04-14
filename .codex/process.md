# Zen Memory Process Manual for Codex

## Purpose

This file defines the operating workflow Codex must follow in this repository.

It exists to make AI-assisted engineering work:

- stateful
- disciplined
- resumable
- reviewable
- durable

`AGENTS.md` is the runtime contract.
This file is the detailed operating manual.

---

## Core model

Every meaningful unit of work must move through explicit artifacts and explicit transitions.

### Artifact roles

#### GitHub Issue

The Issue is the work-item container.

It holds:

- objective or problem statement
- current status and phase
- current understanding
- evidence summary
- confirmed findings
- current or proposed plan
- next step
- implementation linkage

#### Issue body

The Issue body is the canonical current truth.

It should answer:

- what is this work item
- what phase is it in
- what is true now
- what matters now
- what happens next

#### Issue comments

Issue comments are milestone records.

They are for:

- meaningful findings
- meaningful transitions
- timestamped engineering events

They are not for routine procedural noise.

#### Branch

The branch is the implementation container.

#### Pull Request

The PR is the implementation and review artifact.

It should explain:

- what changed
- why it changed
- what was validated
- what remains uncertain

#### Closeout

Closeout is the final durable outcome record after merge.

---

## Non-trivial work

Treat work as non-trivial when it includes one or more of the following:

- behavior change
- bug diagnosis
- performance tuning
- refactor affecting more than a small localized surface
- multi-file change
- change needing validation beyond obvious visual inspection
- change that should be understandable later by someone who did not do the work

For non-trivial work, use the full workflow below.

---

## Work-item phases

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

Not every work item needs every phase, but the work should not skip silently across major boundaries.

---

## Intake issues versus operational work items

This repository contains intake-oriented GitHub issue forms intended for users and contributors, including public-facing feature and bug reports.

Examples:

- `.github/ISSUE_TEMPLATE/feature_request.yml`
- `.github/ISSUE_TEMPLATE/bug_report.yml`

These are valid starting points, but they are not automatically complete operational work items.

When an intake issue becomes active engineering work, do one of the following before meaningful implementation begins:

### Option 1. Convert the same issue into operational form

Use this when:

- the existing issue already cleanly represents the work
- the engineering work is modest or coherent
- it is useful for the public issue to also be the active engineering container

### Option 2. Create a linked follow-on operational issue

Use this when:

- the engineering work will be lengthy or complex
- diagnosis, experimentation, or implementation expands beyond the intake report
- preserving the original intake issue in a user-friendly form is desirable
- there is value in separating public report from engineering execution

If creating a follow-on issue:

- link it clearly to the original intake issue
- state that the follow-on issue is the active engineering container
- preserve the original issue as the public-facing source report

---

## Start-from-issue workflow

### 1. Start from a work item

For any meaningful task:

- locate the existing relevant Issue
- or create/draft one before implementation

The Issue title and body should be specific enough to support review and resumption later.

### 2. Plan before coding

Before code changes, establish a plan.

That plan should contain:

- objective
- scope in
- scope out if useful
- likely impacted files or systems
- risks / uncertainties
- acceptance criteria
- next step

This can live in the Issue body or be linked from it, but the Issue must reflect the current plan state.

Local issue-body draft files may be used as temporary authoring helpers when needed, but they are optional and non-canonical.
Do not create `.codex/work-items/...` or similar local mirror files by default.
The GitHub Issue body remains the canonical current truth.

When creating or converting an operational work item, use:

- `.codex/templates/operational-issue-body.md`

---

## Canonical issue-body structure

When an issue is being used as the operational work item, the body should use this structure where relevant:

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

Not every section must be populated at every phase, but the structure should remain stable.

## Implementation container recording

When an issue is actively being implemented, the body must also record:

- canonical repo for GitHub writes
- head branch when one exists
- base branch or merge target
- PR role:
    - same-Issue direct implementation
    - bundle PR into integration branch
    - final integration PR to `main`
    - direct PR to default branch

This field should stay current whenever the implementation container changes.

When working from a local checkout, the canonical write repo should be derived from `git remote get-url origin` unless the user explicitly directs work to a different repository.

---

## Comments versus body rules

### Update the Issue body when:

- the current understanding changes
- the main evidence summary changes
- confirmed findings change
- remediation direction changes
- next step changes materially
- implementation container changes
- validation state changes materially

### Add an Issue comment when:

- a milestone occurs
- a future engineer would care about the timestamp of the event
- the event changes the trajectory of the work

### Do not add comments for:

- every file inspected
- every command run
- minor wording changes
- trivial progress chatter

### Use repository comment templates

When adding milestone comments, use the templates in:

- `.codex/templates/investigation-milestone-comment.md`
- `.codex/templates/diagnosis-finalized-comment.md`
- `.codex/templates/implementation-container-selected-comment.md`
- `.codex/templates/draft-pr-opened-comment.md`
- `.codex/templates/validation-summary-comment.md`
- `.codex/templates/closeout-comment.md`

---

## Canonical repo resolution

Before any GitHub write action such as creating or editing an issue, opening or updating a PR, or posting a milestone comment:

1. Resolve the canonical repo from the local checkout's `origin` remote.
2. Treat `upstream` as read/reference-only unless the user explicitly says to target it.
3. Pass the resolved repo explicitly to the tool or command.
4. Record the canonical repo in the issue body's implementation-container section.

Do not rely on implicit GitHub CLI defaults for write targets.

---

## Investigations are first-class

If root cause or remediation is not yet known, the work is in investigation mode.

Use:

- the issue body for canonical current truth
- milestone comments for important discoveries

For investigation-driven work, avoid premature implementation. Gather evidence first, then converge on diagnosis.

Meaningful investigation milestones include:

- reproduction confirmed
- important benchmark recorded
- major hypothesis rejected
- likely root cause identified
- investigation redirected
- investigation blocked

---

## Diagnosis-finalized transition

This is a mandatory transition for investigation-driven work.

When diagnosis becomes solid enough to drive implementation, do all of the following.

### Step A. Update the Issue body first

Refresh at least:

- Status
- Phase
- Last major update
- Evidence summary
- Confirmed findings
- Current plan or proposed remediation
- Validation / measurement plan
- Implementation container decision
- Next step

### Step B. Add a milestone comment

Use `.codex/templates/diagnosis-finalized-comment.md`.

The comment must include:

- Root cause
- Key evidence
- Remediation direction
- Implementation container decision
- Next step

It must end with:

- a statement that the Issue body has been updated to reflect the current canonical diagnosis and plan

### Step C. Announce the transition in chat

Use:

`Workflow step: Diagnosis finalized (updating canonical Issue state and adding mandatory milestone comment)`

---

## Same-Issue versus follow-on Issue rule

Before implementation begins after diagnosis, make this explicit.

### Stay on the same Issue when:

- the original Issue still accurately describes the work
- the remediation is one coherent implementation unit
- the acceptance criteria remain substantially aligned

### Create a follow-on implementation Issue when:

- the root cause changes scope materially
- the implementation becomes large or architectural
- multiple distinct fixes are required
- the original Issue is now mostly diagnosis history and a poor implementation container

Always record the decision in the Issue body and, when diagnosis is finalized, also in the milestone comment.

---

## Integration-branch workflow

If the current base branch is a long-lived feature or release branch, treat it as the integration branch.

In that model:

- reviewable sub-changes should prefer bundle branches and PRs back into the integration branch
- the final PR from the integration branch to `main` is a separate artifact
- implementation-container records must name both the head branch and the integration-branch base
- implementation-container records must also name the canonical GitHub repo for writes

---

## PR linkage semantics

Choose link wording that matches what the merge target will actually do:

- Use `Closes #...` only when that PR's merge target will resolve the Issue.
- Use `Part of #...` for bundle PRs into an integration branch.
- Use `Related to #...` for supporting or adjacent changes that do not themselves resolve the Issue.

Do not imply resolution too early by using `Closes` on an interim bundle PR.

These semantics do not change the canonical repo rule: link and write actions must still target the explicitly resolved repo.

---

## Same PR versus bundle PR versus final PR rule

Make the PR role explicit before meaningful implementation is underway.

### Stay in the same PR or direct implementation container when:

- the work is one coherent implementation unit
- the current branch is already the correct review target
- splitting the work would not improve clarity or reviewability

### Use a bundle PR into an integration branch when:

- the current base branch is a long-lived feature or release branch
- the work is a reviewable subset of a broader initiative
- the final merge target is not yet `main`

### Use a final PR to `main` when:

- the integration branch represents the release-ready aggregate
- bundle PRs have already been merged into the integration branch
- cumulative validation is ready to be presented as one final review artifact

---

## Mid-flight context-switch rule

When a new user request arrives while meaningful work is already in progress:

- If it is the same work item, continue in the current Issue, branch, and PR container.
- If it is related but separable, create a separate bundle Issue, branch, or PR.
- If it is unrelated, pause and do not silently mix it into the current implementation container.
- If the worktree is mixed, never stage unrelated changes together.

---

## Implementation-container decision tree

Use this order of decisions:

1. Resolve the canonical GitHub repo from `origin` unless the user explicitly overrides it.
2. Decide whether the new work stays on the same Issue or moves to a follow-on Issue.
3. Decide whether the implementation stays in the same PR/container, becomes a bundle PR into an integration branch, or becomes the final PR to `main`.
4. Decide whether to continue the current work immediately or checkpoint and split before switching.

When in doubt, prefer the option that keeps scope reviewable and avoids silent mixing of unrelated changes.

---

## Implementation workflow

### 1. Open implementation phase

Once the Issue is anchored, the diagnosis or plan is stable enough to implement, the implementation container is selected, and there is a first coherent implementation slice or meaningful commit:

- ensure the Issue body is current
- create or identify the implementation branch
- create or update the PR artifact
- do not wait for full build, install, or test completion before opening the Draft PR
- prefer Draft PR for non-trivial work

Announce in chat:

`Workflow step: Draft PR opened (moving implementation into reviewable artifact)`

### 2. PR body expectations

Use `.github/PULL_REQUEST_TEMPLATE.md`.

The PR should include:

- Summary
- Primary work item
- Link type (`Closes`, `Part of`, or `Related to`)
- PR role
- Canonical repo / write target
- Base branch / merge target
- Diagnosis or rationale
- Scope of change
- Validation summary
- Known caveats
- Follow-on work

If opening a Draft PR milestone comment, use:

- `.codex/templates/draft-pr-opened-comment.md`

### 3. Keep PR as the implementation artifact

Once meaningful code work is underway, the PR becomes the primary visible implementation artifact.

Refresh the PR body when there is a material change in:

- scope
- rationale
- validation
- caveats
- linked issue / implementation container
- canonical repo / write target

---

## Validation workflow

Before treating work as ready for review, record:

- commands or checks run
- pass / fail / mixed result
- benchmark or performance deltas if relevant
- important caveats or gaps

Use `.codex/templates/validation-summary-comment.md` when a milestone validation comment is appropriate.

Validation is the gate for moving a Draft PR to ready for review.
It is not the gate for opening the Draft PR in the first place.

Announce in chat:

`Workflow step: Validation summarized (recording readiness for review)`

Do not claim:

- fixed
- done
- ready for review

unless the validation summary supports that claim.

When uncertain:

- state what is known
- state what is not known
- state what still needs validation

---

## Closeout workflow

After merge:

1. update the work-item state
2. record final outcome
3. link merged PR
4. record unresolved follow-on work if any
5. mark closed only when the outcome is explicit and durable

Use `.codex/templates/closeout-comment.md` if a closeout comment is appropriate.

Do not use final closeout wording for an intermediate bundle PR merge into an integration branch unless the Issue is actually resolved there.

Announce in chat:

`Workflow step: Closeout recorded (capturing durable final outcome)`

Merge is not the end of the operating model.
Closeout is.

---

## Workflow-step vocabulary

Use these step names consistently:

- Issue anchored
- Investigation milestone recorded
- Diagnosis finalized
- Implementation container selected
- Draft PR opened
- Validation summarized
- Closeout recorded

Use the short one-line form by default.
Use longer explanation only when the transition materially changes execution path.

---

## Material change rule

A material change is one that alters:

- current understanding
- accepted diagnosis
- remediation direction
- implementation container
- validation state meaningfully
- next step
- merge or closeout state

Material changes require canonical state refresh.

Non-material changes do not.

---

## Validation command rule

If repository-specific validation commands are documented elsewhere in the repo, run the relevant ones after changes.

If a required validation step cannot be run:

- say so explicitly
- record it in the PR or work item summary
- do not imply a stronger level of confidence than the evidence supports

---

## Exception handling

Minor exceptions may exist for truly trivial changes, but do not assume an exception casually.

If the work is meaningful enough to matter later, it is meaningful enough to anchor and summarize properly.

Acceptable exceptions are rare and should not bypass:

- branch protections
- required PR flow
- required validation disclosure
- explicit closeout for meaningful work

---

## Final operating principle

The point of this workflow is not more ceremony.

The point is:

- no material engineering state lost
- no invisible transitions
- no implementation without durable context
- no review without explicit validation
- no merge without durable outcome
