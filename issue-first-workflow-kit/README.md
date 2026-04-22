# Issue-First Workflow Kit

This kit packages the repo-facing artifacts for a reusable Issue-first GitHub
workflow. It is shaped as a standalone repository so it can be copied out of
this checkout later, but it can also be run directly from this folder.

## Recommended Three-Layer Setup

Use the workflow in three layers:

1. **Global Codex policy**: keep a short default policy in
   `~/.codex/AGENTS.md` so every new chat/project starts with the same working
   agreement.
2. **Codex skill**: use the `issue-first-workflow` skill for the detailed
   behavior: Issue body as canonical truth, milestone comments, branch/PR
   container selection, validation, and closeout.
3. **Repo bootstrap kit**: run this installer only for repositories that should
   visibly carry the workflow files, GitHub templates, and local agent block.

Plugin packaging is a future sharing option for teams or multi-machine setup.
The current package intentionally keeps that path documented rather than
implemented.

## What The Repo Bootstrap Installs

- `.codex/process.md`
- `.codex/templates/*`
- `.github/ISSUE_TEMPLATE/*`
- `.github/pull_request_template.md`
- a managed workflow block in `AGENTS.md`

The installer preserves existing `AGENTS.md` content and only owns the block
between these markers:

```md
<!-- BEGIN issue-first-github-workflow -->
<!-- END issue-first-github-workflow -->
```

## Usage

From this directory:

```bash
./install.sh /path/to/target-repo
```

Install into the current directory:

```bash
./install.sh
```

Preview changes without writing files:

```bash
./install.sh /path/to/target-repo --dry-run
```

Overwrite unmanaged conflicting payload files after backing them up:

```bash
./install.sh /path/to/target-repo --force
```

Backups are written under:

```text
.codex/issue-first-workflow-kit/backups/<timestamp>/
```

## Conflict Model

Payload files installed by this kit contain a small managed header. On rerun,
managed files are updated automatically. Existing unmanaged files at the same
paths are treated as conflicts unless `--force` is provided.

`AGENTS.md` is handled differently: the installer creates, appends, or replaces
only the marked workflow block and leaves repository-specific instructions
outside that block alone.

## Validation

Run:

```bash
bash -n install.sh
bash -n tests/smoke.sh
tests/smoke.sh
```

The smoke tests use only standard shell tools and do not require network access.

## Skill Source

The repo-tracked source for the local Codex skill lives at:

```text
skills/issue-first-workflow/
```

Install or copy that folder to `~/.codex/skills/issue-first-workflow/` for
immediate local use.
