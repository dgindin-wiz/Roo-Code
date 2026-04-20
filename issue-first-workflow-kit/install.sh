#!/usr/bin/env bash
set -euo pipefail

KIT_NAME="issue-first-workflow-kit"
MANAGED_TEXT="Managed by issue-first-workflow-kit"
BEGIN_MARKER="<!-- BEGIN issue-first-github-workflow -->"
END_MARKER="<!-- END issue-first-github-workflow -->"

usage() {
  cat <<'USAGE'
Usage: ./install.sh [TARGET_DIR] [--dry-run] [--force]

Options:
  --dry-run   Print planned changes without writing files.
  --force     Back up and overwrite unmanaged conflicting payload files.
  -h, --help  Show this help.
USAGE
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '%s\n' "$*"
}

target_arg=""
dry_run=0
force=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      ;;
    --force)
      force=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      if [ "$#" -gt 0 ]; then
        [ -z "$target_arg" ] || die "multiple target directories provided"
        target_arg="$1"
        shift
      fi
      [ "$#" -eq 0 ] || die "unexpected arguments after target directory"
      break
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      [ -z "$target_arg" ] || die "multiple target directories provided"
      target_arg="$1"
      ;;
  esac
  shift
done

if [ -z "$target_arg" ]; then
  target_arg="."
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
payload_dir="$script_dir/files"
[ -d "$payload_dir" ] || die "payload directory not found: $payload_dir"

[ -d "$target_arg" ] || die "target directory does not exist: $target_arg"
target_dir="$(cd "$target_arg" && pwd)"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/${KIT_NAME}.XXXXXX")"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_root="$target_dir/.codex/$KIT_NAME/backups/$timestamp"

agents_source="$payload_dir/AGENTS.workflow.md"
[ -f "$agents_source" ] || die "missing AGENTS workflow payload: $agents_source"

agents_block_file="$tmp_dir/agents-block.md"
{
  printf '%s\n' "$BEGIN_MARKER"
  cat "$agents_source"
  printf '\n%s\n' "$END_MARKER"
} > "$agents_block_file"

is_managed_file() {
  [ -f "$1" ] && grep -F -q "$MANAGED_TEXT" "$1"
}

has_marker() {
  grep -F -q "$1" "$2"
}

copy_or_report() {
  src="$1"
  rel="$2"
  dest="$target_dir/$rel"

  if [ ! -e "$dest" ]; then
    info "create $rel"
    return 0
  fi

  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
    info "unchanged $rel"
    return 0
  fi

  if is_managed_file "$dest"; then
    info "update $rel"
    return 0
  fi

  if [ "$force" -eq 1 ]; then
    info "backup and overwrite $rel"
    return 0
  fi

  info "conflict $rel"
  return 1
}

backup_existing() {
  rel="$1"
  src_path="$target_dir/$rel"
  backup_path="$backup_root/$rel"

  [ -e "$src_path" ] || return 0
  mkdir -p "$(dirname "$backup_path")"

  if [ -d "$src_path" ] && [ ! -L "$src_path" ]; then
    cp -R "$src_path" "$backup_path"
  else
    cp -p "$src_path" "$backup_path"
  fi
}

install_payload_file() {
  src="$1"
  rel="$2"
  dest="$target_dir/$rel"

  if [ -e "$dest" ] && ! { [ -f "$dest" ] && cmp -s "$src" "$dest"; } && ! is_managed_file "$dest"; then
    if [ "$force" -eq 1 ]; then
      backup_existing "$rel"
      rm -rf "$dest"
    fi
  fi

  mkdir -p "$(dirname "$dest")"

  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
    return 0
  fi

  cp "$src" "$dest"
}

validate_agents_markers() {
  agents_file="$target_dir/AGENTS.md"
  [ -e "$agents_file" ] || return 0

  begin_count="$(grep -F -c "$BEGIN_MARKER" "$agents_file" || true)"
  end_count="$(grep -F -c "$END_MARKER" "$agents_file" || true)"

  if [ "$begin_count" -ne "$end_count" ]; then
    die "AGENTS.md has an unmatched issue-first workflow marker"
  fi

  if [ "$begin_count" -gt 1 ]; then
    die "AGENTS.md has more than one issue-first workflow block"
  fi
}

plan_agents() {
  agents_file="$target_dir/AGENTS.md"

  if [ ! -e "$agents_file" ]; then
    info "create AGENTS.md workflow block"
    return 0
  fi

  if has_marker "$BEGIN_MARKER" "$agents_file"; then
    info "update AGENTS.md workflow block"
  else
    info "append AGENTS.md workflow block"
  fi
}

install_agents() {
  agents_file="$target_dir/AGENTS.md"

  if [ ! -e "$agents_file" ]; then
    cp "$agents_block_file" "$agents_file"
    return 0
  fi

  if has_marker "$BEGIN_MARKER" "$agents_file"; then
    tmp_agents="$tmp_dir/AGENTS.md"
    awk -v begin="$BEGIN_MARKER" -v end="$END_MARKER" -v block_file="$agents_block_file" '
      BEGIN {
        while ((getline line < block_file) > 0) {
          block = block line ORS
        }
      }
      $0 == begin {
        printf "%s", block
        in_block = 1
        next
      }
      $0 == end {
        in_block = 0
        next
      }
      !in_block {
        print
      }
    ' "$agents_file" > "$tmp_agents"
    cp "$tmp_agents" "$agents_file"
  else
    {
      cat "$agents_file"
      printf '\n%s\n' "$BEGIN_MARKER"
      cat "$agents_source"
      printf '\n%s\n' "$END_MARKER"
    } > "$tmp_dir/AGENTS.appended.md"
    cp "$tmp_dir/AGENTS.appended.md" "$agents_file"
  fi
}

validate_agents_markers

conflicts=0
while IFS= read -r src; do
  rel="${src#$payload_dir/}"
  [ "$rel" != "AGENTS.workflow.md" ] || continue
  if ! copy_or_report "$src" "$rel"; then
    conflicts=$((conflicts + 1))
  fi
done <<EOF
$(find "$payload_dir" -type f | sort)
EOF

plan_agents

if [ "$conflicts" -gt 0 ]; then
  die "$conflicts unmanaged conflicting payload file(s); rerun with --force to back them up and overwrite"
fi

if [ "$dry_run" -eq 1 ]; then
  info "dry-run complete; no files changed"
  exit 0
fi

while IFS= read -r src; do
  rel="${src#$payload_dir/}"
  [ "$rel" != "AGENTS.workflow.md" ] || continue
  install_payload_file "$src" "$rel"
done <<EOF
$(find "$payload_dir" -type f | sort)
EOF

install_agents

info "installed issue-first workflow kit into $target_dir"
