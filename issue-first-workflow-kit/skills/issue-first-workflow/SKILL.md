---
name: issue-first-workflow
description: Use for non-trivial GitHub engineering work that should follow an Issue-first workflow, including implementation, bug diagnosis, investigations, refactors, performance work, PR-bound changes, validation recording, issue-body-as-canonical-truth updates, milestone comments, and branch/PR lifecycle decisions.
---

# Issue-First Workflow

## Overview

Use this skill to make GitHub-backed engineering work durable, reviewable, and
resumable. Keep the chat useful, but treat the Issue, branch, PR, validation
record, and closeout as the durable artifacts.

## Quick Start

1. Resolve the canonical repo from `git remote get-url origin`; treat
   `upstream` as read/reference-only unless the user explicitly says otherwise.
2. Read any repo-local `AGENTS.md` and `.codex/process.md`. If no local process
   exists, read `references/process.md` from this skill.
3. Anchor non-trivial work to a GitHub Issue or equivalent tracked work item
   before code changes.
4. Keep the Issue body as canonical current truth. Use comments only for
   meaningful milestones.
5. Select and record the implementation container: Issue, canonical repo, head
   branch, base branch, and PR role.
6. Implement on a branch and PR. Open a Draft PR once there is a first coherent
   implementation slice; do not wait for full validation before opening it.
7. Record validation before marking work ready for review.
8. After merge, record closeout and follow-on work.

## Workflow Details

Read `references/process.md` when:

- starting or resuming a non-trivial work item
- converting an intake issue into an operational work item
- deciding same-Issue versus follow-on Issue
- deciding direct PR versus bundle/integration PR
- finalizing diagnosis after investigation
- preparing validation or closeout

Use the templates in `assets/templates/` for operational Issue bodies, milestone
comments, validation summaries, closeout comments, and PR descriptions. Prefer
repo-local `.codex/templates/` when present because those templates may include
project-specific conventions.

## GitHub Writes

Before GitHub write actions:

- confirm the canonical write repo
- use explicit repository targets with tools or CLI commands
- avoid writing to `upstream` unless the user explicitly requested it
- keep comments milestone-level rather than chat transcripts

When the user asks to publish local changes, use the repository's GitHub
workflow and any available GitHub publish skill/plugin capabilities for commit,
push, and PR creation.

## Repo Bootstrap

This skill teaches Codex the behavior. It does not require every repository to
carry workflow files. Use the repo bootstrap kit only when a repository should
install visible workflow artifacts such as `AGENTS.md`, `.codex/process.md`,
GitHub issue templates, or `.github/pull_request_template.md`.
