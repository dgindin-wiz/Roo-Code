# Issue-First Workflow Kit

This kit packages a reusable Issue-first GitHub workflow for agent-assisted
engineering work. It is shaped as a standalone repository so it can be copied
out of this checkout later, but it can also be run directly from this folder.

## What It Installs

- `.codex/process.md`
- `.codex/templates/*`
- `.github/ISSUE_TEMPLATE/*`
- `.github/PULL_REQUEST_TEMPLATE.md`
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
