<!-- Managed by issue-first-workflow-kit. Local edits inside this block may be overwritten by install.sh. -->

## Issue-First GitHub Workflow

This repository uses a disciplined GitHub-centered workflow for AI-assisted
engineering work.

For all non-trivial work:

- every meaningful change starts from a GitHub Issue or equivalent tracked work item
- the Issue body is the canonical current truth
- Issue comments are milestone records, not noisy transcripts
- implementation happens on a branch and through a Pull Request
- validation must be recorded before work is treated as ready for review
- merge is not the end; closeout must be recorded

Read `.codex/process.md` before planning or implementing any non-trivial change.

If this repository contains more deeply nested `AGENTS.md` files, follow the
most specific one for files in that scope. Direct instructions from the user or
system override this workflow.

### Default Behavior

For non-trivial work, do not start coding immediately.

First:

1. inspect the relevant code and existing artifacts
2. identify or create the correct GitHub Issue or tracked work item
3. prepare a structured plan
4. update the work item before implementation begins

### Intake Issue Handling

Public-facing intake issue templates such as feature requests and bug reports
are not automatically complete operational work items.

When an intake issue becomes active engineering work, do one of the following
before meaningful implementation begins:

1. convert the issue into operational form by updating the body into canonical
   current-state structure, or
2. create and link a follow-on operational issue for investigation or
   implementation

Use the Investigation template for work where root cause is not yet known.

### Required Workflow Rules

1. Issue-first: any meaningful implementation, bug fix, investigation, refactor,
   feature work, performance work, or architectural change must be anchored to a
   GitHub Issue or equivalent tracked work item before code changes begin.
2. Canonical current truth: the Issue body must represent the current canonical
   state of the work and be updated for material changes in understanding, plan,
   implementation container, next step, or validation state.
3. Milestone comments only: add comments for meaningful milestones such as
   reproduction confirmed, diagnosis finalized, implementation container
   selected, validation summarized, or closeout recorded.
4. Explicit diagnosis: if the work involves investigation or debugging, update
   the Issue body and add a `Diagnosis finalized` milestone comment before
   implementation proceeds from diagnosis.
5. PR-based implementation: use a branch and Pull Request for non-trivial
   implementation work. Open a Draft PR once the Issue is anchored, the plan is
   stable enough, and there is a first coherent implementation slice.
6. Integration branches: if the current base branch is a long-lived feature or
   release branch, treat it as the integration branch and target interim PRs
   back into that branch.
7. PR linkage semantics: use `Closes #...` only when merging that PR resolves
   the Issue, `Part of #...` for bundle PRs into an integration branch, and
   `Related to #...` for supporting or adjacent work.
8. Implementation container recording: the Issue body must record the canonical
   repo, head branch, base branch or merge target, and PR role.
9. Canonical repo resolution: derive the write target from `git remote get-url
origin`, treat `upstream` as read/reference-only unless explicitly told
   otherwise, and pass explicit repository targets to GitHub write commands.
10. Mid-flight context switches: do not silently mix unrelated work into the
    current Issue, branch, or PR.
11. Validation before review: record what validation ran, whether it passed,
    failed, or was mixed, and any important caveats before marking work ready
    for review.
12. Closeout after merge: record the outcome, linked merged PR, resolution
    state, and follow-on work after merge.

### Workflow-Step Acknowledgments

At major workflow transitions, explicitly acknowledge the step in chat using:

`Workflow step: <step name> (<action being taken>)`

Use these step names consistently:

- Issue anchored
- Investigation milestone recorded
- Diagnosis finalized
- Implementation container selected
- Draft PR opened
- Validation summarized
- Closeout recorded

Do not use this format for trivial actions.
