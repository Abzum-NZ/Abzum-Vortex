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

foundation_digest_before="$(jq -r '.requiredChecks[] | select(.id == "sql:010_request_scope") | .relevantInputSha256' <<<"$unchanged")"

printf '\n-- selector fixture: request-role migration change\n' >>"$repository/supabase/migrations/20260903115546_database_scope_request_role.sql"
git -C "$repository" add supabase/migrations/20260903115546_database_scope_request_role.sql
git -C "$repository" commit --quiet -m "Change request-role migration"
request_role_commit="$(git -C "$repository" rev-parse HEAD)"
request_role_selection="$(run_selector "$base" "$request_role_commit")"
jq --exit-status '
  .mode == "full" and
  (.fullCoverageReasons | index("full:protected-input:supabase/migrations/20260903115546_database_scope_request_role.sql")) != null and
  any(.executedChecks[]; .id == "sql:010_request_scope" and
    (.reasons | index("full:protected-input:supabase/migrations/20260903115546_database_scope_request_role.sql")) != null) and
  any(.executedChecks[]; .id == "sql:030_definition_root_draft_store") and
  any(.executedChecks[]; .id == "sql:487_related_total_disclosure") and
  (.reusedChecks | length) == 0 and
  (([.executedChecks[].id] + [.reusedChecks[].id] | sort) == [.requiredChecks[].id])
' <<<"$request_role_selection" >/dev/null
[ "$(jq -r '.requiredChecks[] | select(.id == "sql:010_request_scope") | .relevantInputSha256' <<<"$request_role_selection")" != "$foundation_digest_before" ]

printf '\n-- selector fixture: definition change\n' >>"$repository/supabase/migrations/20260903215549_definition_root_draft_store.sql"
git -C "$repository" add supabase/migrations/20260903215549_definition_root_draft_store.sql
git -C "$repository" commit --quiet -m "Change definition input"
cumulative_commit="$(git -C "$repository" rev-parse HEAD)"
cumulative="$(run_selector "$base" "$cumulative_commit")"
jq --exit-status '
  .mode == "full" and
  all(.fullCoverageReasons[]; startswith("full:protected-input:supabase/migrations/")) and
  any(.executedChecks[]; .id == "sql:030_definition_root_draft_store") and
  any(.executedChecks[]; .id == "sql:487_related_total_disclosure") and
  (.changedPaths | index("supabase/migrations/20260903215549_definition_root_draft_store.sql")) != null and
  (.changedPaths | index("supabase/migrations/20260903115546_database_scope_request_role.sql")) != null
' <<<"$cumulative" >/dev/null

git -C "$repository" checkout --quiet -b cross-schema-fixture "$base"
printf '\nCREATE OR REPLACE\nFUNCTION vortex_module.selector_multiline_shared_ddl_fixture()\nRETURNS void\nLANGUAGE sql\nAS $function$ SELECT $function$;\n' \
  >>"$repository/supabase/migrations/20260911090000_resolve_reachable_module_dependencies.sql"
git -C "$repository" add supabase/migrations/20260911090000_resolve_reachable_module_dependencies.sql
git -C "$repository" commit --quiet -m "Change multiline shared DDL migration"
cross_schema_commit="$(git -C "$repository" rev-parse HEAD)"
cross_schema="$(run_selector "$base" "$cross_schema_commit")"
jq --exit-status '
  .mode == "full" and
  (.fullCoverageReasons | index("full:protected-input:supabase/migrations/20260911090000_resolve_reachable_module_dependencies.sql")) != null and
  (.executedChecks | length) == (.requiredChecks | length) and
  (.reusedChecks | length) == 0 and
  any(.executedChecks[]; .id == "sql:470_module_dependency_pin_set") and
  any(.executedChecks[]; .id == "sql:150_application_access_coordination") and
  any(.executedChecks[]; .id == "lint:vortex_module") and
  any(.executedChecks[]; .id == "lint:vortex_access")
' <<<"$cross_schema" >/dev/null

git -C "$repository" checkout --quiet -b alternate-sql-fixture "$base"
printf 'begin; select plan(0); select * from finish(); rollback;\n' \
  >"$repository/supabase/tests/regression.sql"
jq '.sqlSuites += ["supabase/tests/regression.sql"] |
    .groups[0].sqlPatterns += ["supabase/tests/regression.sql"]' \
  "$repository/workflows/kestra/database-verification-selection.json" \
  >"$test_root/alternate-sql.json"
mv "$test_root/alternate-sql.json" "$repository/workflows/kestra/database-verification-selection.json"
git -C "$repository" add supabase/tests/regression.sql workflows/kestra/database-verification-selection.json
git -C "$repository" commit --quiet -m "Add alternate valid SQL suite name"
alternate_sql_commit="$(git -C "$repository" rev-parse HEAD)"
alternate_sql="$(run_selector "$base" "$alternate_sql_commit")"
jq --exit-status '
  .mode == "full" and
  any(.requiredChecks[]; .id == "sql:regression.sql" and .target == "supabase/tests/regression.sql") and
  any(.executedChecks[]; .id == "sql:regression.sql")
' <<<"$alternate_sql" >/dev/null

git -C "$repository" checkout --quiet -b empty-sql-fixture "$base"
printf 'select 1;\n' >"$repository/supabase/tests/.sql"
git -C "$repository" add supabase/tests/.sql
git -C "$repository" commit --quiet -m "Add invalid empty SQL suite name"
empty_sql_commit="$(git -C "$repository" rev-parse HEAD)"
empty_sql="$(run_selector "$base" "$empty_sql_commit")"
jq --exit-status '
  .mode == "full" and
  (.changedPaths | index("supabase/tests/.sql")) != null and
  (.fullCoverageReasons | index("full:protected-input:supabase/tests/.sql")) != null and
  all(.requiredChecks[]; .target != "supabase/tests/.sql")
' <<<"$empty_sql" >/dev/null

jq '.sqlSuites += ["supabase/tests/.sql"] |
    .groups[0].sqlPatterns += ["supabase/tests/.sql"]' \
  "$repository/workflows/kestra/database-verification-selection.json" \
  >"$test_root/invalid-empty-sql.json"
mv "$test_root/invalid-empty-sql.json" "$repository/workflows/kestra/database-verification-selection.json"
git -C "$repository" add workflows/kestra/database-verification-selection.json
git -C "$repository" commit --quiet -m "Attempt to inventory invalid empty SQL suite name"
invalid_empty_sql_commit="$(git -C "$repository" rev-parse HEAD)"
if run_selector "$base" "$invalid_empty_sql_commit" >"$test_root/invalid-empty-sql.out" 2>"$test_root/invalid-empty-sql.err"; then
  echo "expected an empty SQL suite name to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "database verification selection inventory is invalid" \
  "$test_root/invalid-empty-sql.err"

git -C "$repository" checkout --quiet -b missing-paired-migration-fixture "$base"
jq '.concurrencyProofs[0].migration = "supabase/migrations/20990101000000_missing_pair.sql"' \
  "$repository/workflows/kestra/database-verification.json" \
  >"$test_root/missing-paired-migration.json"
mv "$test_root/missing-paired-migration.json" "$repository/workflows/kestra/database-verification.json"
git -C "$repository" add workflows/kestra/database-verification.json
git -C "$repository" commit --quiet -m "Reference a missing paired migration"
missing_paired_migration_commit="$(git -C "$repository" rev-parse HEAD)"
if run_selector "$base" "$missing_paired_migration_commit" >"$test_root/missing-pair.out" 2>"$test_root/missing-pair.err"; then
  echo "expected a missing paired migration to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "tenant and organisation concurrency proof has no migration" \
  "$test_root/missing-pair.err"

git -C "$repository" checkout --quiet -b omitted-operated-schema-fixture "$base"
jq '.lintSchemas -= ["vortex_context"]' \
  "$repository/workflows/kestra/database-verification.json" \
  >"$test_root/omitted-operated-schema-manifest.json"
mv "$test_root/omitted-operated-schema-manifest.json" "$repository/workflows/kestra/database-verification.json"
jq '(.groups[] | select(.id == "foundation").lintSchemas) -= ["vortex_context"]' \
  "$repository/workflows/kestra/database-verification-selection.json" \
  >"$test_root/omitted-operated-schema-selection.json"
mv "$test_root/omitted-operated-schema-selection.json" "$repository/workflows/kestra/database-verification-selection.json"
git -C "$repository" add workflows/kestra/database-verification.json \
  workflows/kestra/database-verification-selection.json
git -C "$repository" commit --quiet -m "Omit an operated lint schema"
omitted_operated_schema_commit="$(git -C "$repository" rev-parse HEAD)"
if run_selector "$base" "$omitted_operated_schema_commit" >"$test_root/omitted-schema.out" 2>"$test_root/omitted-schema.err"; then
  echo "expected an omitted operated schema to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "database verification manifest does not list every operated schema exactly once" \
  "$test_root/omitted-schema.err"

git -C "$repository" checkout --quiet -b empty-concurrency-basename-fixture "$base"
printf '#!/usr/bin/env bash\nexit 0\n' >"$repository/supabase/tests/-concurrency.test.sh"
printf 'select 1;\n' >"$repository/supabase/migrations/20990101000000_empty_concurrency_basename.sql"
jq '.concurrencyProofs += [{
      migration: "supabase/migrations/20990101000000_empty_concurrency_basename.sql",
      proof: "supabase/tests/-concurrency.test.sh",
      label: "Empty concurrency basename"
    }]' "$repository/workflows/kestra/database-verification.json" \
  >"$test_root/empty-concurrency-basename.json"
mv "$test_root/empty-concurrency-basename.json" "$repository/workflows/kestra/database-verification.json"
git -C "$repository" add supabase/tests/-concurrency.test.sh \
  supabase/migrations/20990101000000_empty_concurrency_basename.sql \
  workflows/kestra/database-verification.json
git -C "$repository" commit --quiet -m "Add an empty concurrency basename"
empty_concurrency_basename_commit="$(git -C "$repository" rev-parse HEAD)"
if run_selector "$base" "$empty_concurrency_basename_commit" >"$test_root/empty-concurrency.out" 2>"$test_root/empty-concurrency.err"; then
  echo "expected an empty concurrency basename to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "database verification manifest is invalid" \
  "$test_root/empty-concurrency.err"

git -C "$repository" checkout --quiet -b selector-mismatch-fixture "$base"
printf '\n# local selector mismatch fixture\n' >>"$selector"
if run_selector "$base" "$base" >"$test_root/mismatch.out" 2>"$test_root/mismatch.err"; then
  echo "expected a selector differing from the target commit to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "executing selector differs from the selected commit" \
  "$test_root/mismatch.err"
git -C "$repository" checkout --quiet -- "$selector_relative"

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
check_selection="$(run_selector "$base" "$check_commit")"
jq --exit-status '
  .mode == "selected" and .fullCoverageReasons == [] and
  .changedPaths == ["supabase/tests/030_definition_root_draft_store.test.sql"] and
  [.executedChecks[].id] == ["sql:030_definition_root_draft_store"] and
  .executedChecks[0].disposition == "executed" and
  .executedChecks[0].reasons == ["changed-check:supabase/tests/030_definition_root_draft_store.test.sql"] and
  (.reusedChecks | length) == ((.requiredChecks | length) - 1) and
  all(.reusedChecks[]; .disposition == "reused" and .reasons == ["unchanged-relevant-inputs"]) and
  (([.executedChecks[].id] + [.reusedChecks[].id] | sort) == [.requiredChecks[].id]) and
  (([.executedChecks[].id] - [.reusedChecks[].id]) | length) == 1
' <<<"$check_selection" >/dev/null
[ "$(jq -r '.requiredChecks[] | select(.id == "sql:030_definition_root_draft_store") | .relevantInputSha256' <<<"$check_selection")" != \
  "$(jq -r '.requiredChecks[] | select(.id == "sql:030_definition_root_draft_store") | .relevantInputSha256' <<<"$unchanged")" ]
[ "$(jq -r '.requiredChecks[] | select(.id == "sql:487_related_total_disclosure") | .relevantInputSha256' <<<"$check_selection")" = \
  "$(jq -r '.requiredChecks[] | select(.id == "sql:487_related_total_disclosure") | .relevantInputSha256' <<<"$unchanged")" ]

git -C "$repository" checkout --quiet -b concurrency-check-fixture "$base"
printf '\n# changed concurrency proof\n' >>"$repository/supabase/tests/definition-consumer-read-concurrency.test.sh"
git -C "$repository" add supabase/tests/definition-consumer-read-concurrency.test.sh
git -C "$repository" commit --quiet -m "Change a concurrency proof"
concurrency_check_commit="$(git -C "$repository" rev-parse HEAD)"
concurrency_check_selection="$(run_selector "$base" "$concurrency_check_commit")"
jq --exit-status '
  .mode == "selected" and .fullCoverageReasons == [] and
  [.executedChecks[].id] == ["concurrency:definition-consumer-read"] and
  .executedChecks[0].reasons == ["changed-check:supabase/tests/definition-consumer-read-concurrency.test.sh"] and
  (.reusedChecks | length) == ((.requiredChecks | length) - 1)
' <<<"$concurrency_check_selection" >/dev/null

git -C "$repository" checkout --quiet -b replaced-check-fixture "$base"
mv "$repository/supabase/tests/030_definition_root_draft_store.test.sql" \
  "$repository/supabase/tests/030_definition_root_draft_store_replacement.test.sql"
jq '(.sqlSuites[] | select(. == "supabase/tests/030_definition_root_draft_store.test.sql")) =
      "supabase/tests/030_definition_root_draft_store_replacement.test.sql"' \
  "$repository/workflows/kestra/database-verification-selection.json" \
  >"$test_root/replaced-check-selection.json"
mv "$test_root/replaced-check-selection.json" "$repository/workflows/kestra/database-verification-selection.json"
git -C "$repository" add supabase/tests/030_definition_root_draft_store.test.sql \
  supabase/tests/030_definition_root_draft_store_replacement.test.sql \
  workflows/kestra/database-verification-selection.json
git -C "$repository" commit --quiet -m "Replace a database check"
replaced_check_commit="$(git -C "$repository" rev-parse HEAD)"
replaced_check_selection="$(run_selector "$base" "$replaced_check_commit")"
jq --exit-status '
  .mode == "full" and
  (.changedPaths | index("supabase/tests/030_definition_root_draft_store.test.sql")) != null and
  (.changedPaths | index("supabase/tests/030_definition_root_draft_store_replacement.test.sql")) != null and
  any(.requiredChecks[]; .id == "sql:030_definition_root_draft_store_replacement") and
  (.executedChecks | length) == (.requiredChecks | length)
' <<<"$replaced_check_selection" >/dev/null

git -C "$repository" checkout --quiet -b direct-check-revert-fixture "$base"
printf '\n-- temporary direct check change\n' >>"$repository/supabase/tests/030_definition_root_draft_store.test.sql"
git -C "$repository" add supabase/tests/030_definition_root_draft_store.test.sql
git -C "$repository" commit --quiet -m "Temporarily change a direct check"
git -C "$repository" checkout --quiet "$base" -- supabase/tests/030_definition_root_draft_store.test.sql
git -C "$repository" commit --quiet -am "Revert the direct check"
direct_check_revert_commit="$(git -C "$repository" rev-parse HEAD)"
direct_check_revert_selection="$(run_selector "$base" "$direct_check_revert_commit")"
jq --exit-status '
  .mode == "full" and
  .fullCoverageReasons == ["full:change-and-revert:supabase/tests/030_definition_root_draft_store.test.sql"] and
  (.executedChecks | length) == (.requiredChecks | length)
' <<<"$direct_check_revert_selection" >/dev/null

git -C "$repository" checkout --quiet -b direct-check-recreated-fixture "$base"
rm "$repository/supabase/tests/030_definition_root_draft_store.test.sql"
git -C "$repository" add supabase/tests/030_definition_root_draft_store.test.sql
git -C "$repository" commit --quiet -m "Delete a direct check"
printf 'begin; select plan(0); select * from finish(); rollback;\n' \
  >"$repository/supabase/tests/030_definition_root_draft_store.test.sql"
git -C "$repository" add supabase/tests/030_definition_root_draft_store.test.sql
git -C "$repository" commit --quiet -m "Recreate a direct check"
direct_check_recreated_commit="$(git -C "$repository" rev-parse HEAD)"
direct_check_recreated_selection="$(run_selector "$base" "$direct_check_recreated_commit")"
jq --exit-status '
  .mode == "full" and
  .fullCoverageReasons == ["full:nonregular-history:supabase/tests/030_definition_root_draft_store.test.sql"] and
  (.executedChecks | length) == (.requiredChecks | length) and
  (.reusedChecks | length) == 0
' <<<"$direct_check_recreated_selection" >/dev/null

git -C "$repository" checkout --quiet -b direct-check-type-change-fixture "$base"
rm "$repository/supabase/tests/030_definition_root_draft_store.test.sql"
ln -s 031_definition_release_contract.test.sql \
  "$repository/supabase/tests/030_definition_root_draft_store.test.sql"
git -C "$repository" add supabase/tests/030_definition_root_draft_store.test.sql
git -C "$repository" commit --quiet -m "Replace a direct check with a symlink"
direct_check_type_change_commit="$(git -C "$repository" rev-parse HEAD)"
direct_check_type_change_selection="$(run_selector "$base" "$direct_check_type_change_commit")"
jq --exit-status '
  .mode == "full" and
  .fullCoverageReasons == ["full:nonregular-history:supabase/tests/030_definition_root_draft_store.test.sql"] and
  (.executedChecks | length) == (.requiredChecks | length)
' <<<"$direct_check_type_change_selection" >/dev/null

git -C "$repository" checkout --quiet -b global-fallback-fixture "$base"
printf '\n# runner fallback fixture\n' >>"$repository/workflows/kestra/scripts/run-database-delivery.sh"
printf '\n# helper fallback fixture\n' >>"$repository/supabase/tests/helpers/definition-release-writer.psql"
printf '\n# config fallback fixture\n' >>"$repository/supabase/config.toml"
git -C "$repository" add workflows/kestra/scripts/run-database-delivery.sh \
  supabase/tests/helpers/definition-release-writer.psql supabase/config.toml
git -C "$repository" commit --quiet -m "Change global verification inputs"
global_fallback_commit="$(git -C "$repository" rev-parse HEAD)"
global_fallback_selection="$(run_selector "$base" "$global_fallback_commit")"
jq --exit-status '
  .mode == "full" and
  (.fullCoverageReasons | index("full:protected-input:workflows/kestra/scripts/run-database-delivery.sh")) != null and
  (.fullCoverageReasons | index("full:protected-input:supabase/tests/helpers/definition-release-writer.psql")) != null and
  (.fullCoverageReasons | index("full:protected-input:supabase/config.toml")) != null and
  (.executedChecks | length) == (.requiredChecks | length)
' <<<"$global_fallback_selection" >/dev/null

git -C "$repository" checkout --quiet -b unrelated-fixture "$base"
git -C "$repository" commit --quiet --allow-empty -m "Unrelated history"
unrelated="$(git -C "$repository" rev-parse HEAD)"
jq --exit-status '
  .mode == "full" and .historyStatus == "non-ancestor" and
  .fullCoverageReasons == ["full:ambiguous-history:non-ancestor"]
' <<<"$(run_selector "$request_role_commit" "$unrelated")" >/dev/null

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
