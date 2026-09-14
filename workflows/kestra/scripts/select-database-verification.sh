#!/usr/bin/env bash

set -euo pipefail

readonly SELECTION_PATH="workflows/kestra/database-verification-selection.json"
readonly VERIFICATION_PATH="workflows/kestra/database-verification.json"
readonly SELECTOR_PATH="workflows/kestra/scripts/select-database-verification.sh"

die() {
  echo "database-verification-selector: FAILED: $*" >&2
  exit 1
}

sha256_file() {
  sha256sum "$1" | cut -d' ' -f1
}

repository="."
baseline=""
target="HEAD"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repository) [ "$#" -ge 2 ] || die "--repository requires a value"; repository="$2"; shift 2 ;;
    --baseline) [ "$#" -ge 2 ] || die "--baseline requires a value"; baseline="$2"; shift 2 ;;
    --target) [ "$#" -ge 2 ] || die "--target requires a value"; target="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

repository="$(cd "$repository" && pwd -P)"
target_commit="$(git -C "$repository" rev-parse --verify "${target}^{commit}" 2>/dev/null)" ||
  die "target is not a commit"

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/vortex-db-selector.XXXXXX")"
trap 'rm -rf "$temporary_root"' EXIT
selection_file="$temporary_root/selection.json"
verification_file="$temporary_root/verification.json"
tree_paths="$temporary_root/tree-paths"
tree_entries="$temporary_root/tree-entries"

git -C "$repository" show "${target_commit}:${SELECTION_PATH}" >"$selection_file" 2>/dev/null ||
  die "selected commit has no database verification selection inventory"
git -C "$repository" show "${target_commit}:${VERIFICATION_PATH}" >"$verification_file" 2>/dev/null ||
  die "selected commit has no database verification manifest"
git -C "$repository" cat-file -e "${target_commit}:${SELECTOR_PATH}" 2>/dev/null ||
  die "selected commit has no database verification selector"
target_selector_sha256="$(git -C "$repository" show "${target_commit}:${SELECTOR_PATH}" | sha256sum | cut -d' ' -f1)"
[ "$(sha256_file "$0")" = "$target_selector_sha256" ] ||
  die "executing selector differs from the selected commit"

jq --exit-status '
  type == "object" and
  (keys == ["fullCoveragePatterns", "groups", "schemaVersion", "sqlSuites"]) and
  .schemaVersion == 1 and
  (.sqlSuites | type == "array" and length > 0 and
    all(type == "string" and test("^supabase/tests/[A-Za-z0-9_.-]+[.]sql$")) and
    (unique | length) == length) and
  (.groups | type == "array" and length > 0 and
    all(type == "object" and
      (keys == ["concurrencyPatterns", "id", "lintSchemas", "sqlPatterns"]) and
      (.id | type == "string" and test("^[a-z][a-z0-9-]{0,49}$")) and
      all(.sqlPatterns[], .concurrencyPatterns[];
        type == "string" and length > 0 and length <= 200) and
      (.lintSchemas | type == "array" and all(type == "string"))) and
    (map(.id) | unique | length) == length) and
  (.fullCoveragePatterns | type == "array" and length > 0 and
    all(type == "string" and length > 0 and length <= 200) and
    (unique | length) == length)
' "$selection_file" >/dev/null || die "database verification selection inventory is invalid"

jq --exit-status '
  type == "object" and .schemaVersion == 1 and
  (.concurrencyProofs | type == "array" and length > 0 and
    all(.[]; type == "object" and
      (.migration | type == "string") and (.proof | type == "string")) and
    (map(.migration) | unique | length) == length and
    (map(.proof) | unique | length) == length) and
  (.lintSchemas | type == "array" and length > 0 and
    all(.[]; type == "string") and (unique | length) == length)
' "$verification_file" >/dev/null || die "database verification manifest is invalid"

git -C "$repository" ls-tree -r --format='%(path)%x09%(objectname)' "$target_commit" |
  LC_ALL=C sort >"$tree_entries"
cut -f1 "$tree_entries" >"$tree_paths"
actual_sql="$temporary_root/actual-sql"
inventory_sql="$temporary_root/inventory-sql"
actual_proofs="$temporary_root/actual-proofs"
inventory_proofs="$temporary_root/inventory-proofs"
sed -En '/^supabase\/tests\/[A-Za-z0-9_.-]+[.]sql$/p' "$tree_paths" >"$actual_sql"
jq --raw-output '.sqlSuites[]' "$selection_file" | LC_ALL=C sort >"$inventory_sql"
cmp -s "$actual_sql" "$inventory_sql" ||
  die "selection inventory must list every SQL suite exactly once"
sed -n '/^supabase\/tests\/[a-z0-9-]*-concurrency\.test\.sh$/p' "$tree_paths" >"$actual_proofs"
jq --raw-output '.concurrencyProofs[].proof' "$verification_file" | LC_ALL=C sort >"$inventory_proofs"
cmp -s "$actual_proofs" "$inventory_proofs" ||
  die "database verification manifest must list every concurrency proof exactly once"

matches_pattern() {
  local value="$1"
  local pattern="$2"
  [[ "$value" == $pattern ]]
}

group_ids="$temporary_root/group-ids"
full_patterns="$temporary_root/full-patterns"
jq --raw-output '.groups[].id' "$selection_file" >"$group_ids"
jq --raw-output '.fullCoveragePatterns[]' "$selection_file" >"$full_patterns"
while IFS= read -r group_id; do
  jq --raw-output --arg id "$group_id" '.groups[] | select(.id == $id) | .sqlPatterns[]' "$selection_file" >"$temporary_root/group-${group_id}-sql"
  jq --raw-output --arg id "$group_id" '.groups[] | select(.id == $id) | .concurrencyPatterns[]' "$selection_file" >"$temporary_root/group-${group_id}-concurrency"
  jq --raw-output --arg id "$group_id" '.groups[] | select(.id == $id) | .lintSchemas[]' "$selection_file" >"$temporary_root/group-${group_id}-lint"
done <"$group_ids"

groups_for_check() {
  local kind="$1"
  local target_value="$2"
  local group_id pattern schema
  while IFS= read -r group_id; do
    case "$kind" in
      sql)
        while IFS= read -r pattern; do
          if matches_pattern "$target_value" "$pattern"; then echo "$group_id"; break; fi
        done <"$temporary_root/group-${group_id}-sql"
        ;;
      concurrency)
        while IFS= read -r pattern; do
          if matches_pattern "$target_value" "$pattern"; then echo "$group_id"; break; fi
        done <"$temporary_root/group-${group_id}-concurrency"
        ;;
      lint)
        while IFS= read -r schema; do
          if [ "$target_value" = "$schema" ]; then echo "$group_id"; break; fi
        done <"$temporary_root/group-${group_id}-lint"
        ;;
    esac
  done <"$group_ids"
}

checks="$temporary_root/checks"
: >"$checks"
while IFS= read -r path; do
  name="${path#supabase/tests/}"
  printf 'sql:%s\tsql\t%s\n' "${name%.test.sql}" "$path" >>"$checks"
done <"$inventory_sql"
while IFS=$'\t' read -r proof migration; do
  name="${proof#supabase/tests/}"
  printf 'concurrency:%s\tconcurrency\t%s\t%s\n' "${name%-concurrency.test.sh}" "$proof" "$migration" >>"$checks"
done < <(jq --raw-output '.concurrencyProofs[] | [.proof, .migration] | @tsv' "$verification_file")
while IFS= read -r schema; do
  printf 'lint:%s\tlint\t%s\n' "$schema" "$schema" >>"$checks"
done < <(jq --raw-output '.lintSchemas[]' "$verification_file")
LC_ALL=C sort -o "$checks" "$checks"
[ "$(cut -f1 "$checks" | uniq -d | wc -l)" -eq 0 ] || die "database verification check IDs are not unique"

check_groups="$temporary_root/check-groups"
: >"$check_groups"
while IFS=$'\t' read -r check_id kind check_target paired_migration; do
  groups="$(groups_for_check "$kind" "$check_target" | LC_ALL=C sort -u)"
  [ -n "$groups" ] || die "selection inventory does not assign ${check_id} to a check group"
  while IFS= read -r group_id; do
    printf '%s\t%s\n' "$check_id" "$group_id" >>"$check_groups"
  done <<<"$groups"
done <"$checks"

# The committed SQL-suite and concurrency-proof inventories are the complete,
# exact changed-input mapping.  They deliberately do not infer dependencies
# from names, contents, migrations, or broad check groups.
direct_check_inputs="$temporary_root/direct-check-inputs"
awk -F '\t' '$2 == "sql" || $2 == "concurrency" { print $3 "\t" $1 }' "$checks" |
  LC_ALL=C sort >"$direct_check_inputs"
[ "$(cut -f1 "$direct_check_inputs" | uniq -d | wc -l)" -eq 0 ] ||
  die "database verification inputs must map to exactly one direct check"
expected_direct_inputs="$temporary_root/expected-direct-check-inputs"
{
  cat "$inventory_sql"
  cat "$inventory_proofs"
} | LC_ALL=C sort >"$expected_direct_inputs"
cut -f1 "$direct_check_inputs" >"$temporary_root/actual-direct-check-inputs"
cmp -s "$temporary_root/actual-direct-check-inputs" "$expected_direct_inputs" ||
  die "direct check input mapping is incomplete"

all_lint="$temporary_root/all-lint"
group_lint="$temporary_root/group-lint"
jq --raw-output '.lintSchemas[]' "$verification_file" | LC_ALL=C sort >"$all_lint"
jq --raw-output '.groups[].lintSchemas[]' "$selection_file" | LC_ALL=C sort -u >"$group_lint"
cmp -s "$all_lint" "$group_lint" || die "selection inventory does not assign every lint schema"

history_status="ancestor"
full_reasons="$temporary_root/full-reasons"
events="$temporary_root/events"
changed_paths="$temporary_root/changed-paths"
: >"$full_reasons"
: >"$events"
: >"$changed_paths"

if [ -z "$baseline" ]; then
  history_status="missing-baseline"
  echo "full:ambiguous-history:missing-baseline" >>"$full_reasons"
elif ! baseline_commit="$(git -C "$repository" rev-parse --verify "${baseline}^{commit}" 2>/dev/null)"; then
  history_status="invalid-baseline"
  echo "full:ambiguous-history:invalid-baseline" >>"$full_reasons"
elif ! git -C "$repository" merge-base --is-ancestor "$baseline_commit" "$target_commit"; then
  history_status="non-ancestor"
  echo "full:ambiguous-history:non-ancestor" >>"$full_reasons"
else
  while IFS= read -r commit; do
    [ -n "$commit" ] || continue
    git -C "$repository" diff-tree --raw --no-abbrev --no-renames -m --root -r "$commit" |
      awk -v commit="$commit" -F '\t' 'NF == 2 { print commit "\t" $1 "\t" $2 }' >>"$events"
  done < <(git -C "$repository" rev-list --reverse --topo-order "${baseline_commit}..${target_commit}")
  LC_ALL=C sort -u -o "$events" "$events"
  cut -f3 "$events" | LC_ALL=C sort -u >"$changed_paths"

  while IFS= read -r path; do
    [ -n "$path" ] || continue
    before_blob="$(git -C "$repository" rev-parse "${baseline_commit}:${path}" 2>/dev/null || true)"
    after_blob="$(git -C "$repository" rev-parse "${target_commit}:${path}" 2>/dev/null || true)"
    if [ -n "$before_blob" ] && [ "$before_blob" = "$after_blob" ]; then
      echo "full:change-and-revert:${path}" >>"$full_reasons"
      continue
    fi

    direct_check_id="$(awk -F '\t' -v path="$path" '$1 == path { print $2 }' "$direct_check_inputs")"
    if [ -n "$before_blob" ] && [ -n "$after_blob" ] && [ -n "$direct_check_id" ]; then
      printf '%s\t%s\n' "$direct_check_id" "$path" >>"$temporary_root/selected-checks"
      continue
    fi

    matched=false
    while IFS= read -r pattern; do
      if matches_pattern "$path" "$pattern"; then
        echo "full:protected-input:${path}" >>"$full_reasons"
        matched=true
        break
      fi
    done <"$full_patterns"
    $matched && continue

    $matched || echo "full:unmapped-input:${path}" >>"$full_reasons"
  done <"$changed_paths"
fi

LC_ALL=C sort -u -o "$full_reasons" "$full_reasons"
selected_checks="$temporary_root/selected-checks"
[ -f "$selected_checks" ] || : >"$selected_checks"
LC_ALL=C sort -u -o "$selected_checks" "$selected_checks"
changed_input_sha256="$(sha256_file "$events")"
inventory_sha256="$( { jq -S -c . "$selection_file"; jq -S -c . "$verification_file"; } | sha256sum | cut -d' ' -f1 )"
selector_sha256="$target_selector_sha256"

global_relevant="$temporary_root/relevant-global"
printf '%s\n' "$SELECTION_PATH" "$VERIFICATION_PATH" "$SELECTOR_PATH" >"$global_relevant"
while IFS= read -r pattern; do
  while IFS= read -r path; do
    matches_pattern "$path" "$pattern" && echo "$path" >>"$global_relevant"
  done <"$tree_paths"
done <"$full_patterns"
LC_ALL=C sort -u -o "$global_relevant" "$global_relevant"
# Direct check files affect only their exact committed check.  Protected
# migrations, helpers, selector/inventory/runner files, and configuration stay
# globally relevant and still force unconditional full coverage when changed.
awk -F '\t' 'NR == FNR { direct[$1] = 1; next } !($0 in direct) { print }' \
  "$direct_check_inputs" "$global_relevant" >"$temporary_root/relevant-global-without-direct-checks"
mv "$temporary_root/relevant-global-without-direct-checks" "$global_relevant"

digest_for_check() {
  local check_id="$1"
  local kind="$2"
  local check_target="$3"
  local paired_migration="${4:-}"
  local relevant="$temporary_root/relevant"
  cp "$global_relevant" "$relevant"
  [ "$kind" = "lint" ] || echo "$check_target" >>"$relevant"
  [ -z "$paired_migration" ] || echo "$paired_migration" >>"$relevant"
  LC_ALL=C sort -u -o "$relevant" "$relevant"
  awk -F '\t' 'NR == FNR { wanted[$1] = 1; next } $1 in wanted { print }' \
    "$relevant" "$tree_entries" | sha256sum | cut -d' ' -f1
}

required_json="$temporary_root/required.jsonl"
executed_json="$temporary_root/executed.jsonl"
reused_json="$temporary_root/reused.jsonl"
: >"$required_json"; : >"$executed_json"; : >"$reused_json"
full_mode=false
[ -s "$full_reasons" ] && full_mode=true

while IFS=$'\t' read -r check_id kind check_target paired_migration; do
  groups_json="$(awk -F '\t' -v id="$check_id" '$1 == id { print $2 }' "$check_groups" | jq -R -s -c 'split("\n")[:-1]')"
  relevant_digest="$(digest_for_check "$check_id" "$kind" "$check_target" "$paired_migration")"
  execute=false
  reasons_json='["unchanged-relevant-inputs"]'
  if $full_mode; then
    execute=true
    reasons_json="$(jq -R -s -c 'split("\n")[:-1]' "$full_reasons")"
  elif changed_check_path="$(awk -F '\t' -v id="$check_id" '$1 == id { print $2 }' "$selected_checks")" &&
    [ -n "$changed_check_path" ]; then
    execute=true
    reasons_json="$(jq -cn --arg path "$changed_check_path" '["changed-check:" + $path]')"
  fi
  disposition="reused"
  $execute && disposition="executed"
  object="$(jq -cn \
    --arg id "$check_id" --arg kind "$kind" --arg target "$check_target" \
    --arg disposition "$disposition" --arg relevant "$relevant_digest" \
    --argjson groups "$groups_json" --argjson reasons "$reasons_json" \
    '{id:$id,kind:$kind,target:$target,groups:$groups,relevantInputSha256:$relevant,disposition:$disposition,reasons:$reasons}')"
  echo "$object" >>"$required_json"
  if $execute; then echo "$object" >>"$executed_json"; else echo "$object" >>"$reused_json"; fi
done <"$checks"

json_lines_to_array() {
  jq -s -c 'sort_by(.id)' "$1"
}

mode="selected"
$full_mode && mode="full"
result="$(jq -cn \
  --arg baseline "${baseline_commit:-$baseline}" --arg target "$target_commit" \
  --arg historyStatus "$history_status" --arg mode "$mode" \
  --arg changedInputSha256 "$changed_input_sha256" --arg inventorySha256 "$inventory_sha256" \
  --arg selectorSha256 "$selector_sha256" \
  --argjson changedPaths "$(jq -R -s -c 'split("\n")[:-1]' "$changed_paths")" \
  --argjson fullCoverageReasons "$(jq -R -s -c 'split("\n")[:-1]' "$full_reasons")" \
  --argjson requiredChecks "$(json_lines_to_array "$required_json")" \
  --argjson executedChecks "$(json_lines_to_array "$executed_json")" \
  --argjson reusedChecks "$(json_lines_to_array "$reused_json")" \
  '{schemaVersion:1,baseline:$baseline,target:$target,historyStatus:$historyStatus,mode:$mode,
    inventorySha256:$inventorySha256,selectorSha256:$selectorSha256,
    changedInputSha256:$changedInputSha256,changedPaths:$changedPaths,
    fullCoverageReasons:$fullCoverageReasons,requiredChecks:$requiredChecks,
    executedChecks:$executedChecks,reusedChecks:$reusedChecks}')"
selection_sha256="$(jq -S -c . <<<"$result" | sha256sum | cut -d' ' -f1)"
jq -S --arg selectionSha256 "$selection_sha256" '. + {selectionSha256:$selectionSha256}' <<<"$result"
