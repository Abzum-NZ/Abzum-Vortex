#!/usr/bin/env bash

set -euo pipefail

readonly source_repository="${VORTEX_TEST_SOURCE_REPOSITORY:-/source}"
readonly selector_relative="workflows/kestra/scripts/select-database-verification.sh"
readonly test_root="$(mktemp -d /tmp/vortex-database-selector-test.XXXXXX)"
trap 'rm -rf "$test_root"' EXIT

git clone --quiet "$source_repository" "$test_root/repository"
repository="$test_root/repository"
git -C "$repository" config user.name selector-test
git -C "$repository" config user.email selector-test@example.invalid
selector="$repository/$selector_relative"
base="$(git -C "$repository" rev-parse HEAD)"

run_selector() {
  "$selector" --repository "$repository" --baseline "$1" --target "$2"
}

unchanged="$(run_selector "$base" "$base")"
jq --exit-status '
  .schemaVersion == 1 and .mode == "selected" and .historyStatus == "ancestor" and
  (.changedPaths | length) == 0 and (.executedChecks | length) == 0 and
  (.requiredChecks | length) > 100 and
  (.reusedChecks | length) == (.requiredChecks | length) and
  ([.requiredChecks[].id] == ([.requiredChecks[].id] | sort)) and
  ([.requiredChecks[].id] | unique | length) == (.requiredChecks | length) and
  all(.requiredChecks[]; (.relevantInputSha256 | test("^[0-9a-f]{64}$"))) and
  (.inventorySha256 | test("^[0-9a-f]{64}$")) and
  (.selectorSha256 | test("^[0-9a-f]{64}$")) and
  (.selectionSha256 | test("^[0-9a-f]{64}$"))
' <<<"$unchanged" >/dev/null

definition_digest_before="$(jq -r '.requiredChecks[] | select(.id == "sql:030_definition_root_draft_store") | .relevantInputSha256' <<<"$unchanged")"
record_digest_before="$(jq -r '.requiredChecks[] | select(.id == "sql:487_related_total_disclosure") | .relevantInputSha256' <<<"$unchanged")"

printf '\n-- selector fixture: record change\n' >>"$repository/supabase/migrations/20260914013000_transactional_relationship_totals.sql"
git -C "$repository" add supabase/migrations/20260914013000_transactional_relationship_totals.sql
git -C "$repository" commit --quiet -m "Change record relationship input"
record_commit="$(git -C "$repository" rev-parse HEAD)"
record_selection="$(run_selector "$base" "$record_commit")"
jq --exit-status '
  .mode == "selected" and .fullCoverageReasons == [] and
  any(.executedChecks[]; .id == "sql:487_related_total_disclosure" and
    any(.reasons[]; startswith("affected-group:record-runtime:"))) and
  any(.reusedChecks[]; .id == "sql:030_definition_root_draft_store") and
  (([.executedChecks[].id] + [.reusedChecks[].id] | sort) == [.requiredChecks[].id])
' <<<"$record_selection" >/dev/null
[ "$(jq -r '.requiredChecks[] | select(.id == "sql:030_definition_root_draft_store") | .relevantInputSha256' <<<"$record_selection")" = "$definition_digest_before" ]
[ "$(jq -r '.requiredChecks[] | select(.id == "sql:487_related_total_disclosure") | .relevantInputSha256' <<<"$record_selection")" != "$record_digest_before" ]

printf '\n-- selector fixture: definition change\n' >>"$repository/supabase/migrations/20260903215549_definition_root_draft_store.sql"
git -C "$repository" add supabase/migrations/20260903215549_definition_root_draft_store.sql
git -C "$repository" commit --quiet -m "Change definition input"
cumulative_commit="$(git -C "$repository" rev-parse HEAD)"
cumulative="$(run_selector "$base" "$cumulative_commit")"
jq --exit-status '
  .mode == "selected" and
  any(.executedChecks[]; .id == "sql:030_definition_root_draft_store") and
  any(.executedChecks[]; .id == "sql:487_related_total_disclosure") and
  (.changedPaths | index("supabase/migrations/20260903215549_definition_root_draft_store.sql")) != null and
  (.changedPaths | index("supabase/migrations/20260914013000_transactional_relationship_totals.sql")) != null
' <<<"$cumulative" >/dev/null

git -C "$repository" checkout --quiet -b revert-fixture "$base"
printf '\n-- temporary change\n' >>"$repository/supabase/migrations/20260903215549_definition_root_draft_store.sql"
git -C "$repository" add supabase/migrations/20260903215549_definition_root_draft_store.sql
git -C "$repository" commit --quiet -m "Temporarily change input"
git -C "$repository" checkout --quiet "$base" -- supabase/migrations/20260903215549_definition_root_draft_store.sql
git -C "$repository" commit --quiet -am "Revert input content"
reverted_commit="$(git -C "$repository" rev-parse HEAD)"
reverted="$(run_selector "$base" "$reverted_commit")"
jq --exit-status '
  .mode == "full" and
  any(.fullCoverageReasons[]; startswith("full:change-and-revert:")) and
  (.executedChecks | length) == (.requiredChecks | length) and
  (.reusedChecks | length) == 0
' <<<"$reverted" >/dev/null

git -C "$repository" checkout --quiet -b unknown-fixture "$base"
printf '\nselector unknown-path fixture\n' >>"$repository/README.md"
git -C "$repository" add README.md
git -C "$repository" commit --quiet -m "Change an unmapped input"
unknown_commit="$(git -C "$repository" rev-parse HEAD)"
jq --exit-status '
  .mode == "full" and
  (.fullCoverageReasons | index("full:unmapped-input:README.md")) != null
' <<<"$(run_selector "$base" "$unknown_commit")" >/dev/null

git -C "$repository" checkout --quiet -b check-fixture "$base"
printf '\n-- changed check\n' >>"$repository/supabase/tests/030_definition_root_draft_store.test.sql"
git -C "$repository" add supabase/tests/030_definition_root_draft_store.test.sql
git -C "$repository" commit --quiet -m "Change a verification check"
check_commit="$(git -C "$repository" rev-parse HEAD)"
jq --exit-status '
  .mode == "full" and
  any(.fullCoverageReasons[]; startswith("full:protected-input:supabase/tests/030_"))
' <<<"$(run_selector "$base" "$check_commit")" >/dev/null

git -C "$repository" checkout --quiet -b unrelated-fixture "$base"
git -C "$repository" commit --quiet --allow-empty -m "Unrelated history"
unrelated="$(git -C "$repository" rev-parse HEAD)"
jq --exit-status '
  .mode == "full" and .historyStatus == "non-ancestor" and
  .fullCoverageReasons == ["full:ambiguous-history:non-ancestor"]
' <<<"$(run_selector "$record_commit" "$unrelated")" >/dev/null

git -C "$repository" checkout --quiet -b incomplete-fixture "$base"
jq '.sqlSuites = .sqlSuites[1:]' \
  "$repository/workflows/kestra/database-verification-selection.json" \
  >"$test_root/incomplete.json"
mv "$test_root/incomplete.json" "$repository/workflows/kestra/database-verification-selection.json"
git -C "$repository" add workflows/kestra/database-verification-selection.json
git -C "$repository" commit --quiet -m "Omit a SQL suite"
incomplete="$(git -C "$repository" rev-parse HEAD)"
if run_selector "$base" "$incomplete" >"$test_root/incomplete.out" 2>"$test_root/incomplete.err"; then
  echo "expected an incomplete selection inventory to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "selection inventory must list every SQL suite exactly once" \
  "$test_root/incomplete.err"

echo "database verification selector fixtures passed"
