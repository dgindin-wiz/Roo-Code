#!/usr/bin/env bash
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="$KIT_DIR/install.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_file() {
  [ -f "$1" ] || fail "expected file: $1"
}

assert_contains() {
  file="$1"
  text="$2"
  grep -F -q "$text" "$file" || fail "expected $file to contain: $text"
}

assert_not_contains() {
  file="$1"
  text="$2"
  if grep -F -q "$text" "$file"; then
    fail "expected $file not to contain: $text"
  fi
}

new_target() {
  mktemp -d "${TMPDIR:-/tmp}/issue-first-workflow-kit-test.XXXXXX"
}

snapshot() {
  dir="$1"
  (
    cd "$dir"
    find . -type f | sort | while IFS= read -r file; do
      cksum "$file"
    done
  )
}

run_installer() {
  "$INSTALLER" "$@"
}

tmp_roots=""
cleanup() {
  for dir in $tmp_roots; do
    rm -rf "$dir"
  done
}
trap cleanup EXIT

track_target() {
  dir="$1"
  tmp_roots="$tmp_roots $dir"
  printf '%s\n' "$dir"
}

test_fresh_install() {
  target="$(track_target "$(new_target)")"
  run_installer "$target" >/dev/null

  assert_file "$target/AGENTS.md"
  assert_file "$target/.codex/process.md"
  assert_file "$target/.codex/templates/operational-issue-body.md"
  assert_file "$target/.github/PULL_REQUEST_TEMPLATE.md"
  assert_file "$target/.github/ISSUE_TEMPLATE/bug_report.yml"
  assert_file "$target/.github/ISSUE_TEMPLATE/investigation.yml"
  assert_contains "$target/AGENTS.md" "BEGIN issue-first-github-workflow"
  assert_contains "$target/.codex/process.md" "Managed by issue-first-workflow-kit"
}

test_existing_agents_append() {
  target="$(track_target "$(new_target)")"
  printf '# Local instructions\n\nKeep this line.\n' > "$target/AGENTS.md"

  run_installer "$target" >/dev/null

  assert_contains "$target/AGENTS.md" "Keep this line."
  assert_contains "$target/AGENTS.md" "BEGIN issue-first-github-workflow"
}

test_marked_agents_replace() {
  target="$(track_target "$(new_target)")"
  cat > "$target/AGENTS.md" <<'EOF'
# Local instructions

<!-- BEGIN issue-first-github-workflow -->
old managed content
<!-- END issue-first-github-workflow -->
EOF

  run_installer "$target" >/dev/null

  assert_contains "$target/AGENTS.md" "Issue-First GitHub Workflow"
  assert_not_contains "$target/AGENTS.md" "old managed content"
}

test_idempotent_rerun() {
  target="$(track_target "$(new_target)")"
  run_installer "$target" >/dev/null
  before="$(snapshot "$target")"
  run_installer "$target" >/dev/null
  after="$(snapshot "$target")"

  [ "$before" = "$after" ] || fail "rerun changed installed file contents"
}

test_dry_run_writes_nothing() {
  target="$(track_target "$(new_target)")"
  run_installer "$target" --dry-run >/dev/null

  [ ! -e "$target/AGENTS.md" ] || fail "dry-run created AGENTS.md"
  [ ! -e "$target/.codex" ] || fail "dry-run created .codex"
  [ ! -e "$target/.github" ] || fail "dry-run created .github"
}

test_conflict_without_force() {
  target="$(track_target "$(new_target)")"
  mkdir -p "$target/.codex"
  printf 'local process\n' > "$target/.codex/process.md"

  if run_installer "$target" > "$target/output.txt" 2>&1; then
    fail "expected unmanaged conflict to fail"
  fi

  assert_contains "$target/output.txt" "conflict .codex/process.md"
  assert_contains "$target/.codex/process.md" "local process"
}

test_force_backs_up_conflict() {
  target="$(track_target "$(new_target)")"
  mkdir -p "$target/.codex"
  printf 'local process\n' > "$target/.codex/process.md"

  run_installer "$target" --force >/dev/null

  assert_contains "$target/.codex/process.md" "Managed by issue-first-workflow-kit"
  backup_count="$(find "$target/.codex/issue-first-workflow-kit/backups" -type f -path '*/.codex/process.md' | wc -l | tr -d ' ')"
  [ "$backup_count" = "1" ] || fail "expected one process.md backup, got $backup_count"
}

test_fresh_install
test_existing_agents_append
test_marked_agents_replace
test_idempotent_rerun
test_dry_run_writes_nothing
test_conflict_without_force
test_force_backs_up_conflict

printf 'smoke tests passed\n'
