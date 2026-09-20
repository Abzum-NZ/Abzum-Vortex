#!/usr/bin/env bash

set -euo pipefail

readonly EXPECTED_REPOSITORY="Abzum-NZ/Abzum-Vortex"
readonly EXPECTED_SUPABASE_VERSION="2.116.0"
readonly EXPECTED_PG_PROVE_VERSION="pg_prove 3.36"
readonly EXPECTED_POSTGRES_MAJOR="17"
readonly EXPECTED_TESTING_DATABASE_PROJECT_REF="abflfptnguasinoussws"
readonly COMMIT_RUNNER_PATH="workflows/kestra/scripts/run-database-delivery.sh"
readonly VERIFICATION_MANIFEST_PATH="workflows/kestra/database-verification.json"
readonly VERIFICATION_SELECTION_PATH="workflows/kestra/database-verification-selection.json"
readonly VERIFICATION_SELECTOR_PATH="workflows/kestra/scripts/select-database-verification.sh"
readonly DATABASE_STATE_SNAPSHOT_PATH="workflows/kestra/database-state-snapshot.sql"
readonly KESTRA_EXECUTION_BASE_URL="https://kestra.abzum.com/ui/main/executions/vortex.operations"

monotonic_ms() {
  awk 'NR == 1 { printf "%.0f\n", $1 * 1000; found = 1 } END { exit !found }' /proc/uptime
}

run_started_ms="$(monotonic_ms)"
stage_timings_ms_json='{}'

die() {
  echo "database-delivery: FAILED: $*" >&2
  exit 1
}

say() {
  echo "database-delivery: $*"
}

record_stage_timing() {
  local stage="$1"
  local started_ms="$2"
  local elapsed_ms="$(( $(monotonic_ms) - started_ms ))"

  stage_timings_ms_json="$(
    jq --compact-output --arg stage "$stage" --argjson elapsed_ms "$elapsed_ms" \
      '. + {($stage): $elapsed_ms}' <<<"$stage_timings_ms_json"
  )"
  say "timing ${stage}: ${elapsed_ms}ms"
}

run_timed_stage() {
  local stage="$1"
  shift
  local started_ms="$(monotonic_ms)"
  local status

  if "$@"; then
    status=0
  else
    status=$?
  fi
  record_stage_timing "$stage" "$started_ms"
  return "$status"
}

prepare_database_only_checkout() {
  local config_path="${checkout}/supabase/config.toml"
  local temporary_config="${config_path}.database-delivery"

  [ -f "$config_path" ] || die "Supabase configuration is missing"

  # Hosted migrations do not use the Local-only Auth signing key. The Supabase CLI parses the
  # complete configuration before `db push`, so remove only that path from this disposable checkout
  # instead of generating or copying a private signing key into the workflow runner.
  sed \
    '/^[[:space:]]*signing_keys_path[[:space:]]*=/d' \
    "$config_path" >"$temporary_config"
  mv "$temporary_config" "$config_path"
}

require_variable() {
  local name="$1"
  [ -n "${!name:-}" ] || die "${name} is not set"
}

normalize_string_array_variable() {
  local name="$1"
  jq --compact-output --exit-status \
    'if type == "array" and all(.[]; type == "string") then . else empty end' \
    <<<"${!name}" 2>/dev/null
}

require_commit_regular_file() {
  local path="$1"
  local label="$2"
  local tree_entry
  local committed_sha256

  tree_entry="$(git -C "$checkout" ls-tree "$commit" -- "$path")"
  [[ "$tree_entry" =~ ^100(644|755)[[:space:]]blob[[:space:]][0-9a-f]{40}[[:space:]] ]] ||
    die "${label} is not a regular file in the selected commit"
  [ -f "${checkout}/${path}" ] && [ ! -L "${checkout}/${path}" ] ||
    die "${label} is not a regular checked-out file"
  committed_sha256="$(git -C "$checkout" show "${commit}:${path}" | sha256sum | cut -d' ' -f1)"
  [ "$(sha256sum "${checkout}/${path}" | cut -d' ' -f1)" = "$committed_sha256" ] ||
    die "${label} differs from the selected commit"
}

validate_verification_manifest() {
  jq --exit-status '
    type == "object" and
    (keys == ["concurrencyProofs", "lintSchemas", "schemaVersion"]) and
    .schemaVersion == 1 and
    (.concurrencyProofs | type == "array" and length > 0 and
      all(
        type == "object" and
        (keys == ["label", "migration", "proof"]) and
        (.migration | type == "string" and test("^supabase/migrations/[0-9]{14}_[a-z0-9_]+[.]sql$")) and
        (.proof | type == "string" and test("^supabase/tests/[a-z0-9-]+-concurrency[.]test[.]sh$")) and
        (.label | type == "string" and test("^[A-Za-z0-9 .-]{1,100}$"))
      ) and
      (map(.migration) | unique | length) == length and
      (map(.proof) | unique | length) == length) and
    (.lintSchemas | type == "array" and length > 0 and
      all(type == "string" and test("^(public|record_data|vortex_[a-z0-9_]+)$")) and
      (unique | length) == length)
  ' "$manifest_file" >/dev/null || die "database verification manifest is invalid"

  local migration
  local proof
  local label
  while IFS=$'\t' read -r migration proof label; do
    [ -e "${checkout}/${migration}" ] || die "${label} concurrency proof has no migration"
    [ -e "${checkout}/${proof}" ] || die "${label} migration has no concurrency proof"
    require_commit_regular_file "$migration" "${label} migration"
    require_commit_regular_file "$proof" "${label} concurrency proof"
  done < <(jq --raw-output '.concurrencyProofs[] | [.migration, .proof, .label] | @tsv' "$manifest_file")

  local manifest_proofs
  local repository_proofs
  manifest_proofs="$(jq --raw-output '.concurrencyProofs[].proof' "$manifest_file" | LC_ALL=C sort)"
  repository_proofs="$(
    git -C "$checkout" ls-tree -r --name-only "$commit" -- supabase/tests |
      grep --extended-regexp '^supabase/tests/[a-z0-9-]+-concurrency[.]test[.]sh$' |
      LC_ALL=C sort
  )"
  [ "$manifest_proofs" = "$repository_proofs" ] ||
    die "database verification manifest does not list every concurrency proof exactly once"

  local manifest_schemas
  local repository_schemas
  manifest_schemas="$(jq --raw-output '.lintSchemas[]' "$manifest_file" | LC_ALL=C sort)"
  repository_schemas="$(
    {
      printf '%s\n' public
      while IFS= read -r migration; do
        git -C "$checkout" show "${commit}:${migration}" | tr '[:space:]' ' '
        printf '\n'
      done < <(
        git -C "$checkout" ls-tree -r --name-only "$commit" -- supabase/migrations |
          grep --extended-regexp '^supabase/migrations/[0-9]{14}_[a-z0-9_]+[.]sql$' |
          LC_ALL=C sort
      ) |
        grep -o -i -E \
          '(^|[^[:alnum:]_])create[[:space:]]+schema[[:space:]]+(if[[:space:]]+not[[:space:]]+exists[[:space:]]+)?(vortex_[a-z0-9_]+|record_data)\b' || true
    } |
      sed --regexp-extended 's/.*(vortex_[a-z0-9_]+|record_data)$/\1/I' |
      tr '[:upper:]' '[:lower:]' |
      LC_ALL=C sort --unique
  )"
  [ "$manifest_schemas" = "$repository_schemas" ] ||
    die "database verification manifest does not list every operated schema exactly once"
}

is_commit() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] && [[ ! "$1" =~ ^0{40}$ ]]
}

validate_plain_value() {
  local name="$1"
  local value="${!name}"
  [[ "$value" =~ ^[A-Za-z0-9._:/@+-]+$ ]] || die "${name} contains unsupported characters"
}

# Stored Testing receipts arrive as local files named by variables. A complete receipt is larger
# than Linux's 131072-byte limit on one environment string, and a string over that limit makes
# every later process launch fail, so the receipt is never carried in the environment.
read_testing_receipt() {
  local target="$1"
  local path_variable="$2"
  local label="$3"
  local path="${!path_variable}"

  [[ "$path" =~ ^[a-z0-9][a-z0-9-]{0,99}[.]json$ ]] ||
    die "${label} path must be a local JSON filename"
  [ -e "$path" ] || [ -L "$path" ] || die "${label} file is missing"
  { [ -f "$path" ] && [ ! -L "$path" ]; } || die "${label} file must be a regular file"
  [ -s "$path" ] || die "${label} file is empty"
  jq --exit-status 'type == "object"' "$path" >/dev/null 2>&1 ||
    die "${label} file is not a JSON object"
  printf -v "$target" '%s' "$(<"$path")"
}

migration_digest() {
  local revision="$1"
  local file
  local files=()

  mapfile -t files < <(
    git -C "$checkout" ls-tree -r --name-only "$revision" -- supabase/migrations |
      LC_ALL=C sort
  )

  [ "${#files[@]}" -gt 0 ] || die "${revision} contains no database migrations"

  for file in "${files[@]}"; do
    [[ "$file" =~ ^supabase/migrations/[0-9]{14}_[a-z0-9_]+\.sql$ ]] ||
      die "migration path does not follow the required format"
    printf '%s\n' "$file"
    git -C "$checkout" show "${revision}:${file}" | sha256sum | cut -d' ' -f1
  done | sha256sum | cut -d' ' -f1
}

verification_input_digest() {
  local revision="$1"
  local file
  local tree_entry
  local files=()

  mapfile -t files < <(
    git -C "$checkout" ls-tree -r --name-only "$revision" -- \
      supabase workflows/kestra |
      LC_ALL=C sort
  )

  [ "${#files[@]}" -gt 0 ] || return 1
  for file in "${files[@]}"; do
    [[ "$file" =~ ^[A-Za-z0-9_./-]+$ ]] || return 1
    tree_entry="$(git -C "$checkout" ls-tree "$revision" -- "$file")"
    [[ "$tree_entry" =~ ^100(644|755)[[:space:]]blob[[:space:]][0-9a-f]{40}[[:space:]] ]] ||
      return 1
  done

  {
    for file in "${files[@]}"; do
      printf '%s\n' "$file"
      git -C "$checkout" show "${revision}:${file}" | sha256sum | cut -d' ' -f1
    done
  } | sha256sum | cut -d' ' -f1
}

execution_url() {
  local environment="$1"
  local execution_id="$2"
  printf '%s/%s_database_delivery/%s' \
    "$KESTRA_EXECUTION_BASE_URL" "$environment" "$execution_id"
}

receipt_key() {
  local mode="$1"
  local receipt_commit="$2"
  local execution_id="$3"
  printf 'database-testing-%s-%s-%s' "$mode" "$receipt_commit" "$execution_id"
}

database_state_snapshot() {
  psql "$database_url" --no-psqlrc --tuples-only --no-align \
    --file "$database_state_snapshot_file" |
    sha256sum | cut -d' ' -f1
}

candidate_baseline_commit() {
  local baseline_commit

  jq --exit-status \
    --arg repository "$EXPECTED_REPOSITORY" \
    --arg project_ref "${VORTEX_EXPECTED_DATABASE_PROJECT_REF:-}" '
      type == "object" and
      (keys == ["commit", "database_project_ref", "database_state", "environment",
        "execution_id", "receipt", "receipt_key", "repository", "schema_version", "sources"]) and
      .schema_version == 1 and
      .environment == "testing" and
      .repository == $repository and
      .database_project_ref == $project_ref and
      (.commit | type == "string" and test("^[0-9a-f]{40}$") and ((test("^0{40}$")) | not)) and
      (.execution_id | type == "string" and test("^[A-Za-z0-9-]{1,100}$")) and
      (.receipt_key | type == "string" and test("^database-testing-(full|selected)-[0-9a-f]{40}-[A-Za-z0-9-]{1,100}$")) and
      (.database_state | type == "object" and
        (keys == ["post_verification_sha256", "pre_verification_sha256",
          "query_path", "query_sha256", "sha256"]) and
        .query_path == "workflows/kestra/database-state-snapshot.sql" and
        (.query_sha256 | test("^[0-9a-f]{64}$")) and
        (.pre_verification_sha256 | test("^[0-9a-f]{64}$")) and
        (.post_verification_sha256 | test("^[0-9a-f]{64}$")) and
        .sha256 == .post_verification_sha256 and
        (.sha256 | test("^[0-9a-f]{64}$"))) and
      (.sources | type == "array" and length > 0 and length <= 200 and
        all(type == "object") and
        (map(.verification.receipt_key) | unique | length) == length) and
      (.receipt | type == "object") and
      (.receipt.schema_version == 3) and
      (.receipt.environment == "testing") and
      (.receipt.repository == $repository) and
      (.receipt.ref == "refs/heads/testing") and
      (.receipt.status == "succeeded") and
      (.receipt.approval == null) and
      (.receipt.database_project_ref == $project_ref) and
      (.receipt.verification.mode == "full" or .receipt.verification.mode == "selected") and
      (.receipt.commit == .commit) and
      (.receipt.execution_id == .execution_id) and
      (.receipt.verification.receipt_key == .receipt_key) and
      (.receipt_key == ("database-testing-" + .receipt.verification.mode + "-" +
        .commit + "-" + .execution_id)) and
      (.receipt.verification.selection.target == .commit) and
      (.receipt.database_state == .database_state) and
      ((.receipt.executed_checks + .receipt.reused_checks | sort_by(.id)) == .receipt.required_checks) and
      ([.receipt.required_checks[].source.evidence_key] | unique | sort) ==
        ([.sources[].verification.receipt_key] | sort)
    ' <<<"$reuse_candidate_json" >/dev/null 2>&1 || return 1

  baseline_commit="$(jq --raw-output '.commit' <<<"$reuse_candidate_json")"
  [ "$baseline_commit" != "$commit" ] || return 1
  git -C "$checkout" cat-file -e "${baseline_commit}^{commit}" 2>/dev/null || return 1
  git -C "$checkout" merge-base --is-ancestor "$baseline_commit" "$commit" || return 1
  printf '%s\n' "$baseline_commit"
}

select_verification_coverage() {
  local baseline_commit="${1:-}"
  local selector_started_ms="$(monotonic_ms)"
  local selector_args=(--repository "$checkout" --target "$commit")
  [ -z "$baseline_commit" ] || selector_args+=(--baseline "$baseline_commit")

  selection_json="$(bash "$verification_selector_file" "${selector_args[@]}")" ||
    die "database verification selector failed"
  jq --exit-status '
    .schemaVersion == 1 and
    (.selectionSha256 | test("^[0-9a-f]{64}$")) and
    (.inventorySha256 | test("^[0-9a-f]{64}$")) and
    (.selectorSha256 | test("^[0-9a-f]{64}$")) and
    (.changedInputSha256 | test("^[0-9a-f]{64}$")) and
    (.requiredChecks | type == "array" and length > 0) and
    ((.executedChecks + .reusedChecks | sort_by(.id)) == .requiredChecks) and
    ([.executedChecks[].id] | unique | length) == (.executedChecks | length) and
    ([.reusedChecks[].id] | unique | length) == (.reusedChecks | length) and
    ([.executedChecks[].id] - [.reusedChecks[].id] | length) == (.executedChecks | length)
  ' <<<"$selection_json" >/dev/null || die "database verification selector returned an invalid contract"
  [ "$(jq --raw-output '.target' <<<"$selection_json")" = "$commit" ] ||
    die "database verification selector returned the wrong target"
  selector_mode="$(jq --raw-output '.mode' <<<"$selection_json")"
  record_stage_timing verification_selection "$selector_started_ms"
}

force_full_coverage() {
  local reason="$1"
  selection_json="$(jq --compact-output --arg reason "$reason" '
    .mode = "full" |
    .fullCoverageReasons = ((.fullCoverageReasons + [$reason]) | unique | sort) |
    .requiredChecks = [.requiredChecks[] |
      .disposition = "executed" |
      .reasons = ((.reasons + [$reason]) | unique | sort)] |
    .executedChecks = .requiredChecks |
    .reusedChecks = []
  ' <<<"$selection_json")"
}

set_selected_lists_from_coverage() {
  selected_sql_suites_json="$(jq --compact-output '[.executedChecks[] | select(.kind == "sql") | .target]' <<<"$selection_json")"
  selected_concurrency_proofs_json="$(jq --compact-output '[.executedChecks[] | select(.kind == "concurrency") | .target]' <<<"$selection_json")"
  selected_lint_schemas_json="$(jq --compact-output '[.executedChecks[] | select(.kind == "lint") | .target]' <<<"$selection_json")"
}

source_receipt_for_check() {
  local check_id="$1"
  local relevant_input_sha256="$2"
  jq --compact-output \
    --arg id "$check_id" --arg relevant "$relevant_input_sha256" '
      [.sources[] | select(
        any(.executed_checks[]?;
          .id == $id and
          .disposition == "executed" and
          .relevantInputSha256 == $relevant
        )
      )] | if length == 1 then .[0] else empty end
    ' <<<"$reuse_candidate_json"
}

validate_direct_source_receipt() {
  local source_json="$1"
  local check_json="$2"
  local check_id kind target relevant source_commit source_execution_id source_mode expected_key
  check_id="$(jq --raw-output '.id' <<<"$check_json")"
  kind="$(jq --raw-output '.kind' <<<"$check_json")"
  target="$(jq --raw-output '.target' <<<"$check_json")"
  relevant="$(jq --raw-output '.relevantInputSha256' <<<"$check_json")"
  source_commit="$(jq --raw-output '.commit // empty' <<<"$source_json")"
  source_execution_id="$(jq --raw-output '.execution_id // empty' <<<"$source_json")"
  source_mode="$(jq --raw-output '.verification.mode // empty' <<<"$source_json")"
  case "$source_mode" in full | selected) ;; *) return 1 ;; esac
  is_commit "$source_commit" || return 1
  [[ "$source_execution_id" =~ ^[A-Za-z0-9-]{1,100}$ ]] || return 1
  git -C "$checkout" cat-file -e "${source_commit}^{commit}" 2>/dev/null || return 1
  git -C "$checkout" merge-base --is-ancestor "$source_commit" "$baseline_commit" || return 1
  expected_key="$(receipt_key "$source_mode" "$source_commit" "$source_execution_id")"

  jq --exit-status \
    --arg repository "$EXPECTED_REPOSITORY" --arg commit "$source_commit" \
    --arg execution_id "$source_execution_id" --arg receipt_key "$expected_key" \
    --arg execution_url "$(execution_url testing "$source_execution_id")" \
    --arg project_ref "$VORTEX_EXPECTED_DATABASE_PROJECT_REF" \
    --arg migration_set_sha256 "$migration_set_sha256" \
    --arg runner_sha256 "$runner_sha256" --arg manifest_sha256 "$verification_manifest_sha256" \
    --arg selector_sha256 "$verification_selector_sha256" \
    --arg inventory_sha256 "$(jq --raw-output '.inventorySha256' <<<"$selection_json")" \
    --arg state_query_sha256 "$database_state_snapshot_query_sha256" \
    --arg state_sha256 "$database_state_sha256" \
    --arg server_version_num "$server_version_num" \
    --arg supabase_version "$EXPECTED_SUPABASE_VERSION" \
    --arg postgres_major "$EXPECTED_POSTGRES_MAJOR" \
    --arg check_id "$check_id" --arg kind "$kind" --arg target "$target" --arg relevant "$relevant" '
      .schema_version == 3 and .environment == "testing" and
      .repository == $repository and .ref == "refs/heads/testing" and
      .commit == $commit and .execution_id == $execution_id and .status == "succeeded" and
      .approval == null and .database_project_ref == $project_ref and
      .migration_set_sha256 == $migration_set_sha256 and
      .runner.sha256 == $runner_sha256 and
      .verification_manifest.sha256 == $manifest_sha256 and
      .verification.mode == (if (.verification.mode == "full") then "full" else "selected" end) and
      .verification.receipt_key == $receipt_key and
      .verification.execution_url == $execution_url and
      .verification.selection.selector_sha256 == $selector_sha256 and
      .verification.selection.inventory_sha256 == $inventory_sha256 and
      .database_state.query_path == "workflows/kestra/database-state-snapshot.sql" and
      .database_state.query_sha256 == $state_query_sha256 and
      .database_state.sha256 == $state_sha256 and
      .supabase_cli_version == $supabase_version and
      (.postgres_major | tostring) == $postgres_major and
      (.postgres_server_version_num | tostring) == $server_version_num and
      ([.executed_checks[] | select(
        .id == $check_id and .kind == $kind and .target == $target and
        .disposition == "executed" and .relevantInputSha256 == $relevant and
        .source.evidence_key == $receipt_key and .source.commit == $commit and
        .source.execution_id == $execution_id and .source.execution_url == $execution_url and
        (.duration_ms | type == "number" and . >= 0)
      )] | length) == 1 and
      (if $kind == "sql" then (.completed_sql_suites | index($target)) != null
       elif $kind == "concurrency" then (.completed_concurrency_proofs | index($target)) != null
       else (.completed_lint_schemas | index($target)) != null end)
    ' <<<"$source_json" >/dev/null 2>&1
}

validate_reused_coverage() {
  local check_json source_json used_source_keys='[]'

  [ "$(jq --raw-output '.database_state.query_sha256' <<<"$reuse_candidate_json")" = "$database_state_snapshot_query_sha256" ] || return 1
  [ "$(jq --raw-output '.database_state.sha256' <<<"$reuse_candidate_json")" = "$database_state_sha256" ] || return 1
  while IFS= read -r check_json; do
    source_json="$(source_receipt_for_check "$(jq --raw-output '.id' <<<"$check_json")" "$(jq --raw-output '.relevantInputSha256' <<<"$check_json")")"
    [ -n "$source_json" ] || return 1
    validate_direct_source_receipt "$source_json" "$check_json" || return 1
    used_source_keys="$(jq --compact-output --arg key "$(jq --raw-output '.verification.receipt_key' <<<"$source_json")" '. + [$key] | unique' <<<"$used_source_keys")"
  done < <(jq --compact-output '.reusedChecks[]' <<<"$selection_json")

  jq --exit-status --argjson used "$used_source_keys" \
    '([.sources[].verification.receipt_key] | sort) == ($used | sort)' \
    <<<"$reuse_candidate_json" >/dev/null 2>&1
}

finalize_coverage_evidence() {
  local check_json check_id disposition stage duration source_receipt source_json
  local current_receipt_key current_execution_url
  current_receipt_key="$(receipt_key "$verification_mode" "$commit" "$VORTEX_EXECUTION_ID")"
  current_execution_url="$(execution_url testing "$VORTEX_EXECUTION_ID")"
  required_checks_json='[]'
  executed_checks_json='[]'
  reused_checks_json='[]'

  while IFS= read -r check_json; do
    check_id="$(jq --raw-output '.id' <<<"$check_json")"
    disposition="$(jq --raw-output '.disposition' <<<"$check_json")"
    if [ "$disposition" = "executed" ]; then
      case "$(jq --raw-output '.kind' <<<"$check_json")" in
        sql) stage="sql:$(jq --raw-output '.target' <<<"$check_json")" ;;
        concurrency) stage="proof:$(jq --raw-output '.target' <<<"$check_json")" ;;
        lint) stage="lint:$(jq --raw-output '.target' <<<"$check_json")" ;;
        *) die "required coverage has an unsupported check kind" ;;
      esac
      duration="$(jq --raw-output --arg stage "$stage" '.[$stage] // empty' <<<"$stage_timings_ms_json")"
      [[ "$duration" =~ ^[0-9]+$ ]] || die "executed check ${check_id} has no timing"
      source_json="$(jq --null-input --compact-output \
        --arg key "$current_receipt_key" --arg commit "$commit" \
        --arg execution_id "$VORTEX_EXECUTION_ID" --arg execution_url "$current_execution_url" \
        '{evidence_key:$key,commit:$commit,execution_id:$execution_id,execution_url:$execution_url}')"
      check_json="$(jq --compact-output --argjson source "$source_json" --argjson duration "$duration" \
        '. + {source:$source,duration_ms:$duration}' <<<"$check_json")"
      executed_checks_json="$(jq --compact-output --argjson check "$check_json" '. + [$check]' <<<"$executed_checks_json")"
    else
      source_receipt="$(source_receipt_for_check "$check_id" "$(jq --raw-output '.relevantInputSha256' <<<"$check_json")")"
      [ -n "$source_receipt" ] || die "reused check ${check_id} has no direct source receipt"
      source_json="$(jq --compact-output '{
        evidence_key:.verification.receipt_key,
        commit:.commit,
        execution_id:.execution_id,
        execution_url:.verification.execution_url
      }' <<<"$source_receipt")"
      check_json="$(jq --compact-output --argjson source "$source_json" '. + {source:$source}' <<<"$check_json")"
      reused_checks_json="$(jq --compact-output --argjson check "$check_json" '. + [$check]' <<<"$reused_checks_json")"
    fi
    required_checks_json="$(jq --compact-output --argjson check "$check_json" '. + [$check]' <<<"$required_checks_json")"
  done < <(jq --compact-output '.requiredChecks[]' <<<"$selection_json")
}

write_reusable_baseline() {
  [ "$VORTEX_DELIVERY_ENVIRONMENT" = "testing" ] || return 0
  require_variable VORTEX_REUSABLE_BASELINE_PATH
  [[ "$VORTEX_REUSABLE_BASELINE_PATH" =~ ^[a-z0-9][a-z0-9-]{0,99}[.]json$ ]] ||
    die "reusable baseline path must be a local JSON filename"
  [ ! -L "$VORTEX_REUSABLE_BASELINE_PATH" ] ||
    die "reusable baseline path cannot be a symbolic link"

  local sources_json='[]'
  local check_json source_json source_key
  while IFS= read -r check_json; do
    source_json="$(source_receipt_for_check "$(jq --raw-output '.id' <<<"$check_json")" "$(jq --raw-output '.relevantInputSha256' <<<"$check_json")")"
    [ -n "$source_json" ] || die "reused baseline check has no direct source receipt"
    source_key="$(jq --raw-output '.verification.receipt_key' <<<"$source_json")"
    if ! jq --exit-status --arg key "$source_key" \
      'any(.[]; .verification.receipt_key == $key)' <<<"$sources_json" >/dev/null; then
      sources_json="$(jq --compact-output --slurp '.[0] + [.[1]]' \
        <(printf '%s\n' "$sources_json") <(printf '%s\n' "$source_json"))"
    fi
  done < <(jq --compact-output '.reusedChecks[]' <<<"$selection_json")
  if [ "$(jq 'length' <<<"$executed_checks_json")" -gt 0 ]; then
    source_json="$(jq --compact-output '{
      schema_version,environment,repository,ref,commit,execution_id,status,approval,
      database_project_ref,migration_set_sha256,runner,verification_manifest,
      supabase_cli_version,postgres_major,postgres_server_version_num,
      database_state,executed_checks,
      completed_sql_suites,completed_concurrency_proofs,completed_lint_schemas,
      verification:{mode:.verification.mode,receipt_key:.verification.receipt_key,
        execution_url:.verification.execution_url,selection:.verification.selection}
    }' "$VORTEX_EVIDENCE_PATH")"
    sources_json="$(jq --compact-output --slurp '.[0] + [.[1]]' \
      <(printf '%s\n' "$sources_json") <(printf '%s\n' "$source_json"))"
  fi

  jq --null-input \
    --arg schema_version "1" --arg repository "$EXPECTED_REPOSITORY" \
    --arg project_ref "$VORTEX_EXPECTED_DATABASE_PROJECT_REF" --arg commit "$commit" \
    --arg execution_id "$VORTEX_EXECUTION_ID" \
    --arg receipt_key "$(receipt_key "$verification_mode" "$commit" "$VORTEX_EXECUTION_ID")" \
    --slurpfile sources <(printf '%s\n' "$sources_json") \
    --slurpfile receipt "$VORTEX_EVIDENCE_PATH" \
    '{schema_version:($schema_version|tonumber),environment:"testing",repository:$repository,
      database_project_ref:$project_ref,commit:$commit,execution_id:$execution_id,
      receipt_key:$receipt_key,database_state:$receipt[0].database_state,
      receipt:$receipt[0],sources:$sources[0]}' \
    >"$VORTEX_REUSABLE_BASELINE_PATH"
}

write_evidence() {
  local status="$1"
  local applied_count="${2:-0}"
  local migrations_json
  local database_project_ref="${VORTEX_EXPECTED_DATABASE_PROJECT_REF:-}"
  local total_elapsed_ms="$(( $(monotonic_ms) - run_started_ms ))"
  local verification_source_json='null'
  local verification_receipt_key='null'
  local verification_execution_url='null'
  local verification_baseline_json='null'
  local database_state_json='null'
  local selection_summary_json

  [ ! -L "$VORTEX_EVIDENCE_PATH" ] || die "evidence path cannot be a symbolic link"

  migrations_json="$({
    git -C "$checkout" ls-tree -r --name-only "$commit" -- supabase/migrations |
      LC_ALL=C sort
  } | jq --raw-input --slurp 'split("\n") | map(select(length > 0))')"

  if [ "$status" = "succeeded" ]; then
    verification_receipt_key="$(jq --null-input --compact-output --arg value "$(receipt_key "$verification_mode" "$commit" "$VORTEX_EXECUTION_ID")" '$value')"
    verification_execution_url="$(jq --null-input --compact-output --arg value "$(execution_url "$VORTEX_DELIVERY_ENVIRONMENT" "$VORTEX_EXECUTION_ID")" '$value')"
    if [ "$verification_mode" = "full" ]; then
      verification_source_json="$(
        jq --null-input --compact-output \
          --arg evidence_key "database-${VORTEX_DELIVERY_ENVIRONMENT}-full-${commit}-${VORTEX_EXECUTION_ID:-local}" \
          --arg commit "$commit" \
          --arg execution_id "${VORTEX_EXECUTION_ID:-local}" \
          --arg execution_url "$(execution_url "$VORTEX_DELIVERY_ENVIRONMENT" "${VORTEX_EXECUTION_ID:-local}")" \
          '{
            evidence_key: $evidence_key,
            commit: $commit,
            execution_id: $execution_id,
            execution_url: $execution_url
          }'
      )"
    fi
    if [ -n "$baseline_commit" ]; then
      verification_baseline_json="$(jq --null-input --compact-output \
        --arg commit "$baseline_commit" --arg execution_id "$baseline_execution_id" \
        --arg receipt_key "$baseline_receipt_key" \
        '{commit:$commit,execution_id:$execution_id,receipt_key:$receipt_key}')"
    fi
    database_state_json="$(jq --null-input --compact-output \
      --arg path "$DATABASE_STATE_SNAPSHOT_PATH" --arg query "$database_state_snapshot_query_sha256" \
      --arg pre "$pre_verification_database_state_sha256" \
      --arg post "$database_state_sha256" \
      '{query_path:$path,query_sha256:$query,sha256:$post,
        pre_verification_sha256:$pre,post_verification_sha256:$post}')"
  fi

  selection_summary_json="$(jq --compact-output --arg selector_mode "$selector_mode" '{
    schema_version:.schemaVersion,baseline,target,history_status:.historyStatus,mode,
    selector_mode:$selector_mode,
    inventory_sha256:.inventorySha256,selector_sha256:.selectorSha256,
    changed_input_sha256:.changedInputSha256,selection_sha256:.selectionSha256,
    changed_paths:.changedPaths,full_coverage_reasons:.fullCoverageReasons
  }' <<<"$selection_json")"

  jq --null-input \
    --arg schema_version "3" \
    --arg environment "$VORTEX_DELIVERY_ENVIRONMENT" \
    --arg repository "$VORTEX_GITHUB_REPOSITORY" \
    --arg ref "$VORTEX_GITHUB_REF" \
    --arg commit "$commit" \
    --arg migration_set_sha256 "$migration_set_sha256" \
    --arg runner_path "$COMMIT_RUNNER_PATH" \
    --arg runner_sha256 "$runner_sha256" \
    --arg manifest_path "$VERIFICATION_MANIFEST_PATH" \
    --arg manifest_sha256 "$verification_manifest_sha256" \
    --arg coverage_sha256 "$expected_coverage_sha256" \
    --arg verification_mode "$verification_mode" \
    --arg verification_input_sha256 "$verification_input_sha256" \
    --arg database_project_ref "$database_project_ref" \
    --arg supabase_cli_version "$EXPECTED_SUPABASE_VERSION" \
    --arg postgres_major "$EXPECTED_POSTGRES_MAJOR" \
    --arg postgres_server_version_num "${server_version_num:-}" \
    --arg status "$status" \
    --arg execution_id "${VORTEX_EXECUTION_ID:-local}" \
    --arg approved_by "${VORTEX_APPROVING_ACTOR:-}" \
    --arg testing_commit "${VORTEX_TESTING_COMMIT:-}" \
    --arg testing_execution_id "${testing_execution_id:-${VORTEX_TESTING_EXECUTION_ID:-}}" \
    --argjson applied_migration_count "$applied_count" \
    --argjson migrations "$migrations_json" \
    --argjson verification_source "$verification_source_json" \
    --argjson verification_receipt_key "$verification_receipt_key" \
    --argjson verification_execution_url "$verification_execution_url" \
    --argjson verification_baseline "$verification_baseline_json" \
    --argjson verification_selection "$selection_summary_json" \
    --argjson database_state "$database_state_json" \
    --slurpfile required_checks <(printf '%s\n' "$required_checks_json") \
    --slurpfile executed_checks <(printf '%s\n' "$executed_checks_json") \
    --slurpfile reused_checks <(printf '%s\n' "$reused_checks_json") \
    --argjson selected_sql_suites "$selected_sql_suites_json" \
    --argjson completed_sql_suites "$completed_sql_suites_json" \
    --argjson selected_concurrency_proofs "$selected_concurrency_proofs_json" \
    --argjson selected_lint_schemas "$selected_lint_schemas_json" \
    --argjson completed_concurrency_proofs "$completed_concurrency_proofs_json" \
    --argjson completed_lint_schemas "$completed_lint_schemas_json" \
    --argjson stage_timings_ms "$stage_timings_ms_json" \
    --argjson total_elapsed_ms "$total_elapsed_ms" \
    '{
      schema_version: ($schema_version | tonumber),
      environment: $environment,
      repository: $repository,
      ref: $ref,
      commit: $commit,
      migration_set_sha256: $migration_set_sha256,
      migrations: $migrations,
      runner: {path: $runner_path, sha256: $runner_sha256},
      verification_manifest: {path: $manifest_path, sha256: $manifest_sha256},
      verification_coverage_sha256: $coverage_sha256,
      verification: {
        mode: $verification_mode,
        input_sha256: $verification_input_sha256,
        receipt_key: $verification_receipt_key,
        execution_url: $verification_execution_url,
        baseline: $verification_baseline,
        selection: $verification_selection,
        source: $verification_source
      },
      database_state: $database_state,
      required_checks: $required_checks[0],
      executed_checks: $executed_checks[0],
      reused_checks: $reused_checks[0],
      selected_sql_suites: $selected_sql_suites,
      completed_sql_suites: $completed_sql_suites,
      selected_concurrency_proofs: $selected_concurrency_proofs,
      selected_lint_schemas: $selected_lint_schemas,
      completed_concurrency_proofs: $completed_concurrency_proofs,
      completed_lint_schemas: $completed_lint_schemas,
      supabase_cli_version: $supabase_cli_version,
      postgres_major: ($postgres_major | tonumber),
      postgres_server_version_num: (
        if $postgres_server_version_num == "" then null
        else ($postgres_server_version_num | tonumber)
        end
      ),
      database_project_ref: (if $database_project_ref == "" then null else $database_project_ref end),
      status: $status,
      execution_id: $execution_id,
      approval: (if $approved_by == "" then null else {
        approved_by: $approved_by,
        testing_commit: $testing_commit,
        testing_execution_id: $testing_execution_id
      } end),
      applied_migration_count: $applied_migration_count,
      stage_timings_ms: ($stage_timings_ms + {total: $total_elapsed_ms})
    }' >"$VORTEX_EVIDENCE_PATH"
}

for name in \
  VORTEX_DELIVERY_OPERATION \
  VORTEX_DELIVERY_ENVIRONMENT \
  VORTEX_EXPECTED_REF \
  VORTEX_GITHUB_REPOSITORY \
  VORTEX_GITHUB_REF \
  VORTEX_GITHUB_COMMIT \
  VORTEX_EVIDENCE_PATH \
  VORTEX_VERIFIED_CHECKOUT \
  VORTEX_VERIFIED_RUNNER_SHA256; do
  require_variable "$name"
done

case "$VORTEX_DELIVERY_OPERATION" in
  prepare | apply) ;;
  *) die "VORTEX_DELIVERY_OPERATION must be prepare or apply" ;;
esac

case "$VORTEX_DELIVERY_ENVIRONMENT" in
  testing)
    [ "$VORTEX_EXPECTED_REF" = "refs/heads/testing" ] || die "testing must use refs/heads/testing"
    ;;
  production)
    [ "$VORTEX_EXPECTED_REF" = "refs/heads/main" ] || die "production must use refs/heads/main"
    ;;
  *) die "unknown delivery environment" ;;
esac

case "${VORTEX_FORCE_FULL_VERIFICATION:-false}" in
  true | false) ;;
  *) die "VORTEX_FORCE_FULL_VERIFICATION must be true or false" ;;
esac

[ "$VORTEX_GITHUB_REPOSITORY" = "$EXPECTED_REPOSITORY" ] || die "unexpected repository"
[ "$VORTEX_GITHUB_REF" = "$VORTEX_EXPECTED_REF" ] || die "unexpected Git ref"
is_commit "$VORTEX_GITHUB_COMMIT" || die "Git commit must be a complete non-zero lowercase SHA-1"
[[ "$VORTEX_EVIDENCE_PATH" =~ ^[a-z0-9][a-z0-9-]{0,99}[.]json$ ]] ||
  die "evidence path must be a local JSON filename"
[[ "$VORTEX_VERIFIED_CHECKOUT" = /tmp/vortex-database-delivery.*/repository ]] ||
  die "verified checkout path is invalid"
checkout="$VORTEX_VERIFIED_CHECKOUT"
readonly checkout
[ -d "${checkout}/.git" ] || die "verified checkout is not a Git worktree"
commit="$(git -C "$checkout" rev-parse HEAD)"
readonly commit
[ "$commit" = "$VORTEX_GITHUB_COMMIT" ] || die "verified checkout does not match the webhook commit"
[ -z "$(git -C "$checkout" status --porcelain --untracked-files=all)" ] ||
  die "verified checkout contains uncommitted content"

runner_sha256="$(git -C "$checkout" show "${commit}:${COMMIT_RUNNER_PATH}" | sha256sum | cut -d' ' -f1)"
readonly runner_sha256
[[ "$runner_sha256" =~ ^[0-9a-f]{64}$ ]] || die "selected runner fingerprint is invalid"
[ "$runner_sha256" = "$VORTEX_VERIFIED_RUNNER_SHA256" ] ||
  die "verified runner fingerprint does not match the selected commit"
[ "$(sha256sum "${checkout}/${COMMIT_RUNNER_PATH}" | cut -d' ' -f1)" = "$runner_sha256" ] ||
  die "executing runner differs from the selected commit"

require_commit_regular_file "$COMMIT_RUNNER_PATH" "database delivery runner"
require_commit_regular_file "supabase/config.toml" "Supabase configuration"
mapfile -t executed_sql_files < <(
  git -C "$checkout" ls-tree -r --name-only "$commit" -- supabase/migrations supabase/tests |
    grep --extended-regexp '^supabase/(migrations|tests)/[A-Za-z0-9_.-]+[.]sql$' |
    LC_ALL=C sort
)
[ "${#executed_sql_files[@]}" -gt 0 ] || die "selected commit contains no database SQL"
for executed_sql_file in "${executed_sql_files[@]}"; do
  require_commit_regular_file "$executed_sql_file" "database SQL ${executed_sql_file}"
done

manifest_file="${checkout}/${VERIFICATION_MANIFEST_PATH}"
readonly manifest_file
require_commit_regular_file "$VERIFICATION_MANIFEST_PATH" "database verification manifest"
verification_manifest_sha256="$(git -C "$checkout" show "${commit}:${VERIFICATION_MANIFEST_PATH}" | sha256sum | cut -d' ' -f1)"
readonly verification_manifest_sha256
[ "$(sha256sum "$manifest_file" | cut -d' ' -f1)" = "$verification_manifest_sha256" ] ||
  die "checked-out database verification manifest differs from the selected commit"
validate_verification_manifest

verification_selection_file="${checkout}/${VERIFICATION_SELECTION_PATH}"
readonly verification_selection_file
verification_selector_file="${checkout}/${VERIFICATION_SELECTOR_PATH}"
readonly verification_selector_file
database_state_snapshot_file="${checkout}/${DATABASE_STATE_SNAPSHOT_PATH}"
readonly database_state_snapshot_file
require_commit_regular_file "$VERIFICATION_SELECTION_PATH" "database verification selection inventory"
require_commit_regular_file "$VERIFICATION_SELECTOR_PATH" "database verification selector"
require_commit_regular_file "$DATABASE_STATE_SNAPSHOT_PATH" "database state snapshot query"
verification_selector_sha256="$(git -C "$checkout" show "${commit}:${VERIFICATION_SELECTOR_PATH}" | sha256sum | cut -d' ' -f1)"
readonly verification_selector_sha256
database_state_snapshot_query_sha256="$(git -C "$checkout" show "${commit}:${DATABASE_STATE_SNAPSHOT_PATH}" | sha256sum | cut -d' ' -f1)"
readonly database_state_snapshot_query_sha256

selected_sql_suites_json='[]'
selected_concurrency_proofs_json='[]'
selected_lint_schemas_json='[]'
expected_coverage_sha256="$(
  jq --compact-output --sort-keys \
    '{concurrency_proofs: [.concurrencyProofs[].proof], lint_schemas: .lintSchemas}' \
    "$manifest_file" |
    sha256sum | cut -d' ' -f1
)"
readonly expected_coverage_sha256
required_checks_json='[]'
executed_checks_json='[]'
reused_checks_json='[]'
completed_concurrency_proofs_json='[]'
completed_lint_schemas_json='[]'
completed_sql_suites_json='[]'

migration_set_sha256="$(migration_digest "$commit")"
readonly migration_set_sha256
verification_input_sha256="$(verification_input_digest "$commit")" ||
  die "database verification inputs are incomplete or invalid"
readonly verification_input_sha256
if [ -n "${VORTEX_REUSE_CANDIDATE_PATH:-}" ]; then
  [ -f "$VORTEX_REUSE_CANDIDATE_PATH" ] ||
    die "database verification reuse candidate file is missing"
  reuse_candidate_json="$(<"$VORTEX_REUSE_CANDIDATE_PATH")"
else
  reuse_candidate_json="${VORTEX_REUSE_CANDIDATE:-null}"
fi
baseline_commit=""
baseline_execution_id=""
baseline_receipt_key=""
if [ "$VORTEX_DELIVERY_ENVIRONMENT" = "testing" ] &&
  [ "${VORTEX_FORCE_FULL_VERIFICATION:-false}" = "false" ]; then
  baseline_commit="$(candidate_baseline_commit || true)"
fi
select_verification_coverage "$baseline_commit"
if [ "$VORTEX_DELIVERY_ENVIRONMENT" != "testing" ] ||
  [ "${VORTEX_FORCE_FULL_VERIFICATION:-false}" = "true" ]; then
  force_full_coverage "full:runner-policy"
fi
if [ -n "$baseline_commit" ]; then
  baseline_execution_id="$(jq --raw-output '.execution_id' <<<"$reuse_candidate_json")"
  baseline_receipt_key="$(jq --raw-output '.receipt_key' <<<"$reuse_candidate_json")"
fi
verification_mode="$(jq --raw-output '.mode' <<<"$selection_json")"
set_selected_lists_from_coverage
database_state_sha256=""
record_stage_timing commit_validation "$run_started_ms"
say "validated ${VORTEX_DELIVERY_ENVIRONMENT} commit ${commit} with migration set ${migration_set_sha256} and verification inputs ${verification_input_sha256}"

if [ "$VORTEX_DELIVERY_OPERATION" = "prepare" ]; then
  verification_mode="prepared"
  write_evidence prepared 0
  say "preparation evidence written without connecting to a database"
  exit 0
fi

if [ "$VORTEX_DELIVERY_ENVIRONMENT" = "production" ]; then
  require_variable VORTEX_APPROVED
  require_variable VORTEX_APPROVING_ACTOR
  require_variable VORTEX_TESTING_COMMIT
  for retired_evidence_variable in VORTEX_TESTING_EVIDENCE VORTEX_TESTING_FULL_SOURCE_EVIDENCE; do
    [ -z "${!retired_evidence_variable+x}" ] ||
      die "${retired_evidence_variable} is no longer accepted; use ${retired_evidence_variable}_PATH"
  done
  require_variable VORTEX_TESTING_EVIDENCE_PATH
  require_variable VORTEX_TESTING_FULL_SOURCE_EVIDENCE_PATH
  [ "$VORTEX_APPROVED" = "true" ] || die "production approval was not granted"
  is_commit "$VORTEX_TESTING_COMMIT" || die "approved Testing commit is invalid"
  validate_plain_value VORTEX_APPROVING_ACTOR
  read_testing_receipt testing_evidence_json VORTEX_TESTING_EVIDENCE_PATH "Testing evidence"
  read_testing_receipt testing_source_evidence_json VORTEX_TESTING_FULL_SOURCE_EVIDENCE_PATH \
    "Testing full-source evidence"
  testing_verification_mode="$(
    jq --raw-output '.verification.mode // empty' <<<"$testing_evidence_json" 2>/dev/null
  )"
  case "$testing_verification_mode" in
    full | reused) ;;
    *) die "stored Testing evidence has an unsupported verification mode" ;;
  esac
  testing_source_commit="$(
    jq --raw-output '.verification.source.commit // empty' <<<"$testing_evidence_json" 2>/dev/null
  )"
  testing_execution_id="$(jq --raw-output '.execution_id // empty' <<<"$testing_evidence_json")"
  testing_source_execution_id="$(
    jq --raw-output '.execution_id // empty' <<<"$testing_source_evidence_json" 2>/dev/null
  )"
  is_commit "$testing_source_commit" || die "stored Testing source commit is invalid"
  [[ "$testing_execution_id" =~ ^[A-Za-z0-9-]{1,100}$ ]] ||
    die "stored Testing execution identifier is invalid"
  [[ "$testing_source_execution_id" =~ ^[A-Za-z0-9-]{1,100}$ ]] ||
    die "stored Testing source execution identifier is invalid"

  jq --exit-status \
    --arg repository "$EXPECTED_REPOSITORY" \
    --arg commit "$VORTEX_TESTING_COMMIT" \
    --arg source_commit "$testing_source_commit" \
    --arg source_execution_id "$testing_source_execution_id" \
    --arg source_key "database-testing-full-${testing_source_commit}-${testing_source_execution_id}" \
    --arg source_url "$(execution_url testing "$testing_source_execution_id")" \
    --arg migration_set_sha256 "$migration_set_sha256" \
    --arg runner_sha256 "$runner_sha256" \
    --arg manifest_sha256 "$verification_manifest_sha256" \
    --arg coverage_sha256 "$expected_coverage_sha256" \
    --arg input_sha256 "$verification_input_sha256" \
    --arg project_ref "$EXPECTED_TESTING_DATABASE_PROJECT_REF" \
    --arg supabase_version "$EXPECTED_SUPABASE_VERSION" \
    --arg postgres_major "$EXPECTED_POSTGRES_MAJOR" \
    --arg mode "$testing_verification_mode" \
    --argjson selected_sql_suites "$selected_sql_suites_json" \
    --argjson selected_concurrency_proofs "$selected_concurrency_proofs_json" \
    --argjson selected_lint_schemas "$selected_lint_schemas_json" \
    '
      .schema_version == 3 and
      .environment == "testing" and
      .repository == $repository and
      .ref == "refs/heads/testing" and
      .commit == $commit and
      .status == "succeeded" and
      .approval == null and
      .database_project_ref == $project_ref and
      .migration_set_sha256 == $migration_set_sha256 and
      .runner.sha256 == $runner_sha256 and
      .verification_manifest.sha256 == $manifest_sha256 and
      .verification_coverage_sha256 == $coverage_sha256 and
      .verification.mode == $mode and
      .verification.input_sha256 == $input_sha256 and
      .verification.source.evidence_key == $source_key and
      .verification.source.commit == $source_commit and
      .verification.source.execution_id == $source_execution_id and
      .verification.source.execution_url == $source_url and
      .selected_sql_suites == $selected_sql_suites and
      .selected_concurrency_proofs == $selected_concurrency_proofs and
      .selected_lint_schemas == $selected_lint_schemas and
      (if $mode == "full" then
        .completed_sql_suites == $selected_sql_suites and
        .completed_concurrency_proofs == $selected_concurrency_proofs and
        .completed_lint_schemas == $selected_lint_schemas and
        $source_commit == $commit
      else
        .completed_sql_suites == [] and
        .completed_concurrency_proofs == [] and
        .completed_lint_schemas == [] and
        $source_commit != $commit
      end) and
      .supabase_cli_version == $supabase_version and
      (.postgres_major | tostring) == $postgres_major and
      (.postgres_server_version_num | type == "number")
    ' <<<"$testing_evidence_json" >/dev/null ||
    die "stored Testing evidence is invalid or does not cover the Production inputs"

  jq --exit-status \
    --arg repository "$EXPECTED_REPOSITORY" \
    --arg commit "$testing_source_commit" \
    --arg execution_id "$testing_source_execution_id" \
    --arg evidence_key "database-testing-full-${testing_source_commit}-${testing_source_execution_id}" \
    --arg execution_url "$(execution_url testing "$testing_source_execution_id")" \
    --arg migration_set_sha256 "$migration_set_sha256" \
    --arg runner_sha256 "$runner_sha256" \
    --arg manifest_sha256 "$verification_manifest_sha256" \
    --arg coverage_sha256 "$expected_coverage_sha256" \
    --arg input_sha256 "$verification_input_sha256" \
    --arg project_ref "$EXPECTED_TESTING_DATABASE_PROJECT_REF" \
    --arg supabase_version "$EXPECTED_SUPABASE_VERSION" \
    --arg postgres_major "$EXPECTED_POSTGRES_MAJOR" \
    --arg current_postgres_server_version_num "$(
      jq --raw-output '.postgres_server_version_num // empty' <<<"$testing_evidence_json"
    )" \
    --argjson selected_sql_suites "$selected_sql_suites_json" \
    --argjson selected_concurrency_proofs "$selected_concurrency_proofs_json" \
    --argjson selected_lint_schemas "$selected_lint_schemas_json" \
    '
      .schema_version == 3 and
      .environment == "testing" and
      .repository == $repository and
      .ref == "refs/heads/testing" and
      .commit == $commit and
      .status == "succeeded" and
      .execution_id == $execution_id and
      .approval == null and
      .database_project_ref == $project_ref and
      .migration_set_sha256 == $migration_set_sha256 and
      .runner.sha256 == $runner_sha256 and
      .verification_manifest.sha256 == $manifest_sha256 and
      .verification_coverage_sha256 == $coverage_sha256 and
      .verification.mode == "full" and
      .verification.input_sha256 == $input_sha256 and
      .verification.source.evidence_key == $evidence_key and
      .verification.source.commit == $commit and
      .verification.source.execution_id == $execution_id and
      .verification.source.execution_url == $execution_url and
      .selected_sql_suites == $selected_sql_suites and
      .completed_sql_suites == $selected_sql_suites and
      .selected_concurrency_proofs == $selected_concurrency_proofs and
      .completed_concurrency_proofs == $selected_concurrency_proofs and
      .selected_lint_schemas == $selected_lint_schemas and
      .completed_lint_schemas == $selected_lint_schemas and
      .supabase_cli_version == $supabase_version and
      (.postgres_major | tostring) == $postgres_major and
      (.postgres_server_version_num | type == "number") and
      (.postgres_server_version_num | tostring) == $current_postgres_server_version_num
    ' <<<"$testing_source_evidence_json" >/dev/null ||
    die "stored Testing full-source evidence is invalid"

  git -C "$checkout" fetch --quiet --no-tags origin "$VORTEX_TESTING_COMMIT"
  git -C "$checkout" merge-base --is-ancestor "$VORTEX_TESTING_COMMIT" "$commit" ||
    die "approved Testing commit is not an ancestor of the Production commit"
  git -C "$checkout" fetch --quiet --no-tags origin "$testing_source_commit"
  git -C "$checkout" merge-base --is-ancestor "$testing_source_commit" "$VORTEX_TESTING_COMMIT" ||
    die "Testing full-source commit is not an ancestor of the approved Testing commit"
  if [ "$testing_verification_mode" = "reused" ]; then
    [ "$testing_source_commit" != "$VORTEX_TESTING_COMMIT" ] ||
      die "reused Testing evidence must name an earlier full source"
  fi
  testing_migration_set_sha256="$(migration_digest "$VORTEX_TESTING_COMMIT")"
  [ "$testing_migration_set_sha256" = "$migration_set_sha256" ] ||
    die "Production migration set differs from the approved Testing migration set"
  source_migration_set_sha256="$(migration_digest "$testing_source_commit")"
  [ "$source_migration_set_sha256" = "$migration_set_sha256" ] ||
    die "Testing full-source migration set differs from Production"
  testing_input_sha256="$(verification_input_digest "$VORTEX_TESTING_COMMIT")" ||
    die "approved Testing verification inputs are invalid"
  source_input_sha256="$(verification_input_digest "$testing_source_commit")" ||
    die "Testing full-source verification inputs are invalid"
  [ "$testing_input_sha256" = "$verification_input_sha256" ] &&
    [ "$source_input_sha256" = "$verification_input_sha256" ] ||
    die "Production verification inputs differ from the Testing evidence"
  testing_runner_sha256="$(git -C "$checkout" show "${VORTEX_TESTING_COMMIT}:${COMMIT_RUNNER_PATH}" | sha256sum | cut -d' ' -f1)"
  [ "$testing_runner_sha256" = "$runner_sha256" ] ||
    die "Production runner differs from the successful Testing runner"
  testing_manifest_sha256="$(git -C "$checkout" show "${VORTEX_TESTING_COMMIT}:${VERIFICATION_MANIFEST_PATH}" | sha256sum | cut -d' ' -f1)"
  [ "$testing_manifest_sha256" = "$verification_manifest_sha256" ] ||
    die "Production verification manifest differs from successful Testing"
fi

require_variable VORTEX_EXECUTION_ID
[[ "$VORTEX_EXECUTION_ID" =~ ^[A-Za-z0-9-]{1,100}$ ]] ||
  die "VORTEX_EXECUTION_ID is invalid"
if [ "$VORTEX_DELIVERY_ENVIRONMENT" = "testing" ]; then
  require_variable VORTEX_REUSABLE_BASELINE_PATH
fi

environment_started_ms="$(monotonic_ms)"
require_variable VORTEX_DOPPLER_TOKEN
require_variable VORTEX_DOPPLER_PROJECT
require_variable VORTEX_DOPPLER_CONFIG
require_variable VORTEX_EXPECTED_DATABASE_PROJECT_REF
[[ "$VORTEX_EXPECTED_DATABASE_PROJECT_REF" =~ ^[a-z0-9]{20}$ ]] ||
  die "expected Supabase project reference is invalid"

export DOPPLER_TOKEN="$VORTEX_DOPPLER_TOKEN"
read_doppler_secret() {
  doppler secrets get "$1" \
    --plain \
    --project "$VORTEX_DOPPLER_PROJECT" \
    --config "$VORTEX_DOPPLER_CONFIG" \
    --no-check-version \
    --silent
}

export VORTEX_DATABASE_PASSWORD="$(read_doppler_secret VORTEX_MIGRATION_DATABASE_PASSWORD)"
export VORTEX_DATABASE_CONNECTION="$(read_doppler_secret VORTEX_MIGRATION_DATABASE_URL)"
export VORTEX_DATABASE_SSL_ROOT_CERT="$(read_doppler_secret VORTEX_DATABASE_SSL_ROOT_CERT)"
unset DOPPLER_TOKEN VORTEX_DOPPLER_TOKEN
require_variable VORTEX_DATABASE_PASSWORD
require_variable VORTEX_DATABASE_CONNECTION
require_variable VORTEX_DATABASE_SSL_ROOT_CERT

connection_without_scheme="${VORTEX_DATABASE_CONNECTION#postgresql://}"
[ "$connection_without_scheme" != "$VORTEX_DATABASE_CONNECTION" ] ||
  die "database connection must use postgresql"
connection_credentials="${connection_without_scheme%%@*}"
connection_host_path="${connection_without_scheme#*@}"
[ "$connection_host_path" != "$connection_without_scheme" ] ||
  die "database connection has no host"
[[ "$connection_credentials" != *:* ]] ||
  die "database connection must not embed a password"
database_user="$connection_credentials"
database_host_port="${connection_host_path%%/*}"
database_name="${connection_host_path#*/}"
database_host="${database_host_port%:*}"
database_port="${database_host_port##*:}"

[[ "$database_user" =~ ^postgres\.[a-z0-9]{20}$ ]] ||
  die "database connection does not name a Supabase project owner"
database_project_ref="${database_user#postgres.}"
[ "$database_project_ref" = "$VORTEX_EXPECTED_DATABASE_PROJECT_REF" ] ||
  die "database connection names the wrong Supabase project"
[[ "$database_host" =~ ^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$ ]] ||
  die "database connection does not name the Supabase session pooler"
[ "$database_port" = "5432" ] || die "database connection is not session mode"
[ "$database_name" = "postgres" ] || die "database connection does not name postgres"
unset VORTEX_DATABASE_CONNECTION

database_url="postgresql://${database_user}@${database_host}:5432/postgres?sslmode=verify-full"
readonly database_url

workdir="${checkout%/repository}"
readonly workdir
database_ssl_root_cert="${workdir}/supabase-root.crt"
readonly database_ssl_root_cert
umask 077
printf '%s\n' "$VORTEX_DATABASE_SSL_ROOT_CERT" >"$database_ssl_root_cert"
openssl x509 -in "$database_ssl_root_cert" -noout -checkend 86400 >/dev/null 2>&1 ||
  die "Supabase root certificate is invalid or expires within one day"
unset VORTEX_DATABASE_SSL_ROOT_CERT
export PGPASSWORD="$VORTEX_DATABASE_PASSWORD"
unset VORTEX_DATABASE_PASSWORD
export PGSSLMODE=verify-full
export PGSSLROOTCERT="$database_ssl_root_cert"
export SSL_CERT_FILE="$database_ssl_root_cert"

[ "$(supabase --version)" = "$EXPECTED_SUPABASE_VERSION" ] || die "unexpected Supabase CLI version"
[ "$(pg_prove --version)" = "$EXPECTED_PG_PROVE_VERSION" ] || die "unexpected pg_prove version"
export PGCONNECT_TIMEOUT=15
server_version_num="$(psql "$database_url" --no-psqlrc --tuples-only --no-align \
  --command "select current_setting('server_version_num')")"
[[ "$server_version_num" =~ ^[0-9]+$ ]] || die "database returned an invalid server version"
[ "$((server_version_num / 10000))" = "$EXPECTED_POSTGRES_MAJOR" ] ||
  die "database PostgreSQL major does not match the reviewed project configuration"

local_history="${workdir}/local-migration-history.txt"
remote_history="${workdir}/remote-migration-history.txt"
git -C "$checkout" ls-tree -r --name-only "$commit" -- supabase/migrations |
  LC_ALL=C sort |
  sed 's#^supabase/migrations/##' >"$local_history"
history_exists="$(psql "$database_url" --no-psqlrc --tuples-only --no-align \
  --command "select to_regclass('supabase_migrations.schema_migrations') is not null")"
case "$history_exists" in
  t)
    psql "$database_url" --no-psqlrc --tuples-only --no-align \
      --command "select version || case when coalesce(name, '') = '' then '' else '_' || name end || '.sql' from supabase_migrations.schema_migrations order by version, name" \
      >"$remote_history"
    ;;
  f) : >"$remote_history" ;;
  *) die "database returned an invalid migration-history state" ;;
esac
record_stage_timing environment_validation "$environment_started_ms"
[ -z "$(LC_ALL=C comm -13 "$local_history" "$remote_history")" ] ||
  die "remote migration history does not exactly match the selected commit"

state_snapshot_started_ms="$(monotonic_ms)"
database_state_sha256="$(database_state_snapshot)"
[[ "$database_state_sha256" =~ ^[0-9a-f]{64}$ ]] ||
  die "database state snapshot returned an invalid fingerprint"
pre_verification_database_state_sha256="$database_state_sha256"
record_stage_timing database_state_snapshot "$state_snapshot_started_ms"

if [ "$VORTEX_DELIVERY_ENVIRONMENT" = "testing" ] &&
  [ "$(jq '.reusedChecks | length' <<<"$selection_json")" -gt 0 ]; then
  if ! cmp --silent "$local_history" "$remote_history" || ! validate_reused_coverage; then
    force_full_coverage "full:unusable-direct-source-or-database-state"
    verification_mode="full"
    set_selected_lists_from_coverage
    say "selected reuse evidence or database state is not eligible; running full verification"
  fi
fi

if [ "$VORTEX_DELIVERY_ENVIRONMENT" = "testing" ] &&
  [ "$(jq '.executedChecks | length' <<<"$selection_json")" -eq 0 ]; then
  say "reusing directly authenticated fresh check receipts; no database check will run in this execution"
fi
if [ "$VORTEX_DELIVERY_ENVIRONMENT" = "testing" ]; then
  if [ "${VORTEX_FORCE_FULL_VERIFICATION:-false}" = "true" ]; then
    say "full verification forced by the operator"
  elif jq --exit-status 'type == "object"' <<<"$reuse_candidate_json" >/dev/null 2>&1; then
    say "stored full baseline is not eligible for these inputs or this environment; running full verification"
  else
    say "no reusable full baseline is available; running full verification"
  fi
fi
last_applied="$(tail -n 1 "$remote_history")"
older_pending="$(LC_ALL=C comm -23 "$local_history" "$remote_history" |
  LC_ALL=C awk -v maximum="$last_applied" '$0 < maximum')"
migration_flags=()
if [ -n "$older_pending" ]; then
  # Reviewed consolidation gap: these two migrations have independent ownership
  # and no migration-time dependency. No other out-of-order history is accepted.
  [ "$older_pending" = "20260908122641_record_storage_provisioning.sql" ] &&
    [ "$last_applied" = "20260908124240_adopt_shipped_platform_permission_catalogue.sql" ] ||
    die "unreviewed out-of-order migration gap"
  migration_flags+=(--include-all)
  say "applying the reviewed storage-provisioning gap before the pending tail"
fi

say "applying pending migrations through Supabase migration history"
execution_directory="$PWD"
readonly execution_directory
cd "$checkout"
prepare_database_only_checkout
if [ "$verification_mode" = "full" ] || ! cmp --silent "$local_history" "$remote_history"; then
  run_timed_stage migration_apply \
    supabase db push --db-url "$database_url" --skip-vault "${migration_flags[@]}" --yes
else
  say "migration history is already current; running only the selected database checks"
fi
# Lint is cheap and static, so a lint failure stops delivery before the long SQL
# suites and concurrency proofs run.
run_database_lint() {
  local lint_schema
  while IFS= read -r lint_schema; do
    run_timed_stage "lint:${lint_schema}" supabase db lint \
      --db-url "$database_url" \
      --schema "$lint_schema" \
      --level warning \
      --fail-on error || return $?
    completed_lint_schemas_json="$(
      jq --compact-output --arg schema "$lint_schema" '. + [$schema]' \
        <<<"$completed_lint_schemas_json"
    )"
  done < <(jq --raw-output '.[]' <<<"$selected_lint_schemas_json")
}
run_timed_stage database_lint run_database_lint

run_sql_suites() {
  local sql_suite
  while IFS= read -r sql_suite; do
    run_timed_stage "sql:${sql_suite}" pg_prove \
      --dbname "$database_name" \
      --username "$database_user" \
      --host "$database_host" \
      --port "$database_port" \
      "$sql_suite" || return $?
    completed_sql_suites_json="$(
      jq --compact-output --arg suite "$sql_suite" '. + [$suite]' \
        <<<"$completed_sql_suites_json"
    )"
  done < <(jq --raw-output '.[]' <<<"$selected_sql_suites_json")
}
run_timed_stage sql_suites run_sql_suites

mapfile -t concurrency_proofs < <(jq --raw-output '.[]' <<<"$selected_concurrency_proofs_json")
run_concurrency_proofs() {
  local concurrency_proof
  for concurrency_proof in "${concurrency_proofs[@]}"; do
    run_timed_stage "proof:${concurrency_proof}" env \
      VORTEX_CONCURRENCY_DATABASE_URL="$database_url" bash "$concurrency_proof" || return $?
    completed_concurrency_proofs_json="$(
      jq --compact-output --arg proof "$concurrency_proof" '. + [$proof]' \
        <<<"$completed_concurrency_proofs_json"
    )"
  done
}
run_timed_stage concurrency_proofs run_concurrency_proofs

cd "$execution_directory"

jq --exit-status --argjson completed "$completed_concurrency_proofs_json" \
  '$completed == .' <<<"$selected_concurrency_proofs_json" >/dev/null ||
  die "not every selected concurrency proof completed"
jq --exit-status --argjson completed "$completed_sql_suites_json" \
  '$completed == .' <<<"$selected_sql_suites_json" >/dev/null ||
  die "not every selected SQL suite completed"
jq --exit-status --argjson completed "$completed_lint_schemas_json" \
  '$completed == .' <<<"$selected_lint_schemas_json" >/dev/null ||
  die "not every selected schema completed database lint"

post_history_started_ms="$(monotonic_ms)"
psql "$database_url" --no-psqlrc --tuples-only --no-align \
  --command "select version || case when coalesce(name, '') = '' then '' else '_' || name end || '.sql' from supabase_migrations.schema_migrations order by version, name" \
  >"$remote_history"
cmp --silent "$local_history" "$remote_history" ||
  die "remote migration history does not exactly match the selected commit"
record_stage_timing post_verification_history "$post_history_started_ms"

post_state_started_ms="$(monotonic_ms)"
database_state_sha256="$(database_state_snapshot)"
[[ "$database_state_sha256" =~ ^[0-9a-f]{64}$ ]] ||
  die "post-verification database state snapshot returned an invalid fingerprint"
record_stage_timing post_verification_state "$post_state_started_ms"
if [ "$verification_mode" = "selected" ] &&
  [ "$database_state_sha256" != "$pre_verification_database_state_sha256" ]; then
  die "database state changed during selected verification"
fi

applied_count="$(wc -l <"$remote_history" | tr -d '[:space:]')"
[[ "$applied_count" =~ ^[0-9]+$ ]] || die "migration history returned an invalid count"
finalize_coverage_evidence
write_evidence succeeded "$applied_count"
write_reusable_baseline
say "migration, database tests, and lint succeeded; evidence contains no credential"
