#!/usr/bin/env bash

set -euo pipefail

harness_root="$(mktemp -d /tmp/vortex-permission-registry-harness.XXXXXX)"
readonly harness_root
workspace_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly workspace_root
readonly proof_script="$workspace_root/supabase/tests/permission-registry-concurrency.test.sh"
readonly fake_bin="$harness_root/bin"

cleanup_harness() {
  case "$harness_root" in
    /tmp/vortex-permission-registry-harness.*) rm -rf -- "$harness_root" ;;
    *) echo "refusing to remove unexpected harness directory: $harness_root" >&2 ;;
  esac
}
trap cleanup_harness EXIT

fail() {
  echo "permission-registry script harness: $*" >&2
  exit 1
}

assert_status() {
  local expected="$1"
  local actual="$2"
  local scenario="$3"
  [ "$actual" -eq "$expected" ] || fail "$scenario returned $actual instead of $expected"
}

assert_contains() {
  local path="$1"
  local expected="$2"
  grep -Fq -- "$expected" "$path" || fail "$path does not contain: $expected"
}

assert_not_contains() {
  local path="$1"
  local rejected="$2"
  if grep -Fq -- "$rejected" "$path"; then
    fail "$path unexpectedly contains: $rejected"
  fi
}

scope_for_run() {
  local organization_id="62${1:2}"
  printf '%s' "${organization_id//-/}"
}

name_token_for_run() {
  local token="${1//-/}"
  printf '%s' "${token:0:28}"
}

mkdir -p "$fake_bin"
cp "$workspace_root/tooling/supabase/fixtures/permission-registry-fake-psql.sh" "$fake_bin/psql"
chmod +x "$fake_bin/psql"

run_proof() {
  local scenario="$1"
  local run_id="$2"
  local state_root="$3"
  local stdout_path="$4"
  local stderr_path="$5"

  PATH="$fake_bin:$PATH" \
    VORTEX_FAKE_PSQL_STATE="$state_root" \
    VORTEX_FAKE_PSQL_SCENARIO="$scenario" \
    VORTEX_PERMISSION_REGISTRY_PROOF_RUN_ID="$run_id" \
    bash "$proof_script" >"$stdout_path" 2>"$stderr_path"
}

collision_state="$harness_root/collision"
mkdir -p "$collision_state"
readonly collision_run_id='11111111-1111-4111-8111-000000000101'
readonly collision_scope="$(scope_for_run "$collision_run_id")"
touch "$collision_state/preexisting-$collision_scope"
set +e
run_proof collision "$collision_run_id" "$collision_state" \
  "$collision_state/stdout.log" "$collision_state/stderr.log"
collision_status=$?
set -e
assert_status 23 "$collision_status" collision
[ -f "$collision_state/preexisting-$collision_scope" ] || fail 'collision removed pre-existing data'
assert_contains "$collision_state/events.log" "setup_refused_collision|$collision_scope"
assert_not_contains "$collision_state/events.log" 'cleanup_started'

partial_state="$harness_root/partial"
mkdir -p "$partial_state"
readonly partial_run_id='22222222-2222-4222-8222-000000000202'
readonly partial_scope="$(scope_for_run "$partial_run_id")"
set +e
run_proof partial_setup "$partial_run_id" "$partial_state" \
  "$partial_state/stdout.log" "$partial_state/stderr.log"
partial_status=$?
set -e
assert_status 24 "$partial_status" partial_setup
[ -f "$partial_state/partial-$partial_scope" ] || fail 'partial setup simulation did not run'
assert_contains "$partial_state/events.log" "setup_failed_before_commit|$partial_scope"
assert_not_contains "$partial_state/events.log" 'cleanup_started'
assert_contains "$partial_state/setup-$partial_scope.sql" 'begin;'
assert_contains "$partial_state/setup-$partial_scope.sql" 'commit;'

worker_state="$harness_root/worker"
mkdir -p "$worker_state"
readonly worker_run_id='33333333-3333-4333-8333-000000000303'
readonly worker_scope="$(scope_for_run "$worker_run_id")"
set +e
run_proof worker_failure "$worker_run_id" "$worker_state" \
  "$worker_state/stdout.log" "$worker_state/stderr.log"
worker_status=$?
set -e
assert_status 42 "$worker_status" worker_failure
[ ! -f "$worker_state/claimed-$worker_scope" ] || fail 'worker failure left the owned fixture behind'
assert_contains "$worker_state/events.log" "worker_b_exited|$worker_scope"
assert_contains "$worker_state/events.log" "cleanup_finished|$worker_scope"
worker_exit_line="$(grep -nF "worker_b_exited|$worker_scope" "$worker_state/events.log" | cut -d: -f1)"
cleanup_line="$(grep -nF "cleanup_started|$worker_scope" "$worker_state/events.log" | cut -d: -f1)"
[ "$worker_exit_line" -lt "$cleanup_line" ] || fail 'cleanup started before the owned worker exited'

simultaneous_state="$harness_root/simultaneous"
mkdir -p "$simultaneous_state"
readonly simultaneous_run_a='44444444-4444-4444-8444-000000000404'
readonly simultaneous_run_b='55555555-5555-4555-8555-000000000505'
set +e
run_proof success "$simultaneous_run_a" "$simultaneous_state" \
  "$simultaneous_state/a.stdout.log" "$simultaneous_state/a.stderr.log" &
simultaneous_pid_a=$!
run_proof success "$simultaneous_run_b" "$simultaneous_state" \
  "$simultaneous_state/b.stdout.log" "$simultaneous_state/b.stderr.log" &
simultaneous_pid_b=$!
wait "$simultaneous_pid_a"
simultaneous_status_a=$?
wait "$simultaneous_pid_b"
simultaneous_status_b=$?
set -e
assert_status 0 "$simultaneous_status_a" simultaneous_a
assert_status 0 "$simultaneous_status_b" simultaneous_b
for simultaneous_run_id in "$simultaneous_run_a" "$simultaneous_run_b"; do
  simultaneous_scope="$(scope_for_run "$simultaneous_run_id")"
  simultaneous_name_token="$(name_token_for_run "$simultaneous_run_id")"
  [ ! -f "$simultaneous_state/claimed-$simultaneous_scope" ] || fail "simultaneous run $simultaneous_scope was not cleaned"
  assert_contains "$simultaneous_state/events.log" "setup_committed|$simultaneous_scope"
  assert_contains "$simultaneous_state/events.log" "cleanup_finished|$simultaneous_scope"
  assert_contains "$simultaneous_state/setup-$simultaneous_scope.sql" "permission_$simultaneous_name_token"
done

cleanup_state="$harness_root/cleanup"
mkdir -p "$cleanup_state"
readonly cleanup_run_id='66666666-6666-4666-8666-000000000606'
readonly cleanup_scope="$(scope_for_run "$cleanup_run_id")"
set +e
run_proof cleanup_failure "$cleanup_run_id" "$cleanup_state" \
  "$cleanup_state/stdout.log" "$cleanup_state/stderr.log"
cleanup_status=$?
set -e
assert_status 55 "$cleanup_status" cleanup_failure
assert_contains "$cleanup_state/stdout.log" 'permission-registry concurrency proof passed'
assert_contains "$cleanup_state/stderr.log" 'permission-registry proof fixture cleanup failed with status 55'
[ -f "$cleanup_state/claimed-$cleanup_scope" ] || fail 'cleanup failure fixture was not preserved by the fake'

combined_state="$harness_root/combined"
mkdir -p "$combined_state"
readonly combined_run_id='77777777-7777-4777-8777-000000000707'
set +e
run_proof original_and_cleanup_failure "$combined_run_id" "$combined_state" \
  "$combined_state/stdout.log" "$combined_state/stderr.log"
combined_status=$?
set -e
assert_status 42 "$combined_status" original_and_cleanup_failure
assert_contains "$combined_state/stderr.log" 'permission-registry proof fixture cleanup failed with status 55'
assert_contains "$combined_state/stderr.log" 'cleanup also failed while preserving the proof failure'

echo 'permission-registry concurrency script harness passed'
