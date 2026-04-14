# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Repository-specific implementation rule

- Settings View Pattern: When working on `SettingsView`, inputs must bind to the local `cachedState`, NOT the live `useExtensionState()`. The `cachedState` acts as a buffer for user edits, isolating them from the `ContextProxy` source-of-truth until the user explicitly clicks "Save". Wiring inputs directly to the live state causes race conditions.

## Repository workflow rule

This repository uses a disciplined GitHub-centered workflow for AI-assisted engineering work.

For all non-trivial work, follow this workflow:

- every meaningful change starts from a GitHub Issue or equivalent tracked work item
- the Issue body is the canonical current truth
- Issue comments are milestone records, not noisy transcripts
- implementation happens on a branch and through a Pull Request
- validation must be recorded before work is treated as ready for review
- merge is not the end; closeout must be recorded

Read `.codex/process.md` before planning or implementing any non-trivial change.

If this repository also contains more deeply nested `AGENTS.md` files, follow the most specific one for files in that scope.

## Priority and scope

These instructions apply to the full repository unless a deeper `AGENTS.md` overrides them for a subdirectory.

Direct instructions from the user or system override this file.

## Default behavior

For non-trivial work, do not start coding immediately.

First:

1. inspect the relevant code and existing artifacts
2. identify or create the correct GitHub Issue or tracked work item
3. prepare a structured plan
4. update the work item before implementation begins

## Intake issue handling

This repository contains public-facing intake issue templates such as feature requests and bug reports.

Do not assume these intake forms are already complete operational work items.

When an intake issue becomes active engineering work, do one of the following before meaningful implementation begins:

1. convert the issue into operational form by updating the body into canonical current-state structure, or
2. create and link a follow-on operational issue for investigation or implementation

Choose the cleaner option for the repository and the scope of work.

Use the Investigation template for work where root cause is not yet known.

## Required workflow rules

### 1. Issue-first

Any meaningful implementation, bug fix, investigation, refactor, feature work, performance work, or architectural change must be anchored to a GitHub Issue or equivalent tracked work item before code changes begin.

If an appropriate Issue already exists, use it.
If not, draft or create one before implementing.

### 2. Canonical current truth

The Issue body must represent the current canonical state of the work.

It must be updated when there is a material change in:

- current understanding
- confirmed findings
- remediation direction
- current plan
- next step
- implementation container
- validation state

### 3. Comments are milestone records

Do not use Issue comments as a transcript of every action.

Only add comments for meaningful milestones such as:

- reproduction confirmed
- major hypothesis ruled out
- likely root cause identified
- diagnosis finalized
- implementation container selected
- validation summarized
- closeout recorded

### 4. Diagnosis must be explicit

If the work involves investigation or debugging, do not jump from vague diagnosis to implementation silently.

When diagnosis is solid enough to drive implementation:

1. update the Issue body first
2. record the diagnosis clearly
3. add a milestone comment titled `Diagnosis finalized`
4. state whether implementation remains on the same Issue or moves to a follow-on Issue

### 5. PR-based implementation

For non-trivial implementation work:

- do not treat direct work on `main` as acceptable
- use a branch
- use a Pull Request
- open a Draft PR once the Issue is anchored, the diagnosis/plan is stable enough to implement, the implementation container is selected, and there is a first coherent implementation slice or meaningful commit
- do not wait for full build/install/test before opening the Draft PR
- move a PR to ready for review only after validation has been recorded explicitly

### 6. Integration-branch workflow

If the current base branch is a long-lived feature or release branch:

- treat it as the integration branch
- target bundle branches and interim PRs back into that integration branch
- treat the final PR from the integration branch to `main` as a separate artifact

### 7. PR linkage semantics

Use link wording that matches the merge target:

- `Closes #...` only when merging that PR will actually resolve the Issue
- `Part of #...` for bundle PRs into an integration branch
- `Related to #...` for supporting or adjacent work that does not itself resolve the Issue

### 8. Implementation container recording

The Issue body must record the current implementation container, including:

- canonical repo for GitHub writes
- head branch
- base branch or merge target
- whether the current artifact is:
    - same-Issue direct implementation
    - bundle PR into an integration branch
    - final integration PR to `main`
    - direct PR to the default branch

### 9. Canonical repo resolution

For GitHub write actions originating from a local checkout:

- derive the canonical write repo from `git remote get-url origin`
- treat `upstream` as read/reference-only unless the user explicitly says to target upstream
- always pass an explicit `--repo owner/name` argument for `gh` write commands
- confirm the target repo in chat at meaningful GitHub workflow transitions

### 10. Mid-flight context-switch policy

If a new request arrives while another meaningful change is already in progress:

- if it is the same work item, continue in the current implementation container
- if it is related but separable, create a separate bundle issue, branch, or PR
- if it is unrelated, pause and do not silently mix it into the current implementation container
- if the worktree is mixed, never silently stage unrelated changes together

### 11. Validation before review

Before work is treated as ready for review, record:

- what validation was run
- whether it passed, failed, or was mixed
- any important caveats

### 12. Closeout after merge

After merge, record:

- the outcome
- linked merged PR
- whether the originating Issue is fully resolved
- any follow-on work that remains

## Workflow-step acknowledgments

At major workflow transitions, explicitly acknowledge the step in your response using this format:

`Workflow step: <step name> (<action being taken>)`

Use this for meaningful transitions only, such as:

- Issue anchored
- Investigation milestone recorded
- Diagnosis finalized
- Implementation container selected
- Draft PR opened
- Validation summarized
- Closeout recorded

Do not spam this format for trivial actions.

## Planning and execution behavior

Before implementation, produce or update a structured plan in the relevant work item.

That plan should include:

- objective
- scope
- likely impacted files or systems
- key risks or open questions
- acceptance criteria
- next step

Follow `.codex/process.md` for the detailed operating rules, body/comment conventions, templates, and transition requirements.

## Validation

If there are repository-specific test, lint, typecheck, benchmark, or validation commands documented elsewhere in the repo, run all relevant ones after changes and make a best effort to leave the work in a reviewable state.

If a required validation step cannot be run, say so explicitly and record it in the PR or work item summary.

## What not to do

Do not:

- skip the Issue/work-item anchor for meaningful work
- leave material state changes only in chat
- use comments as a noisy activity log
- silently change diagnosis without updating the canonical record
- claim work is ready for review without explicit validation summary
- treat merge as complete without closeout
