#!/usr/bin/env bash
# #408 real two-session proofs:
#   1. an empty-scope newer/stale policy first-writer race is monotonic;
#   2. a final-removal check waits for a legal-hold release and rechecks it;
#   3. the reverse guard-first/removal versus hold-apply interleaving completes
#      without the former physical-row/guard lock inversion.
set -euo pipefail

readonly proof_root="$(mktemp -d /tmp/vortex-record-removal-protection.XXXXXX)"
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id='a4780000-0000-4000-8000-000000000001'
readonly organization_id='a4780000-0000-4000-8000-000000000002'
readonly account_id='a4780000-0000-4000-8000-000000000004'
readonly identity_id='a4780000-0000-4000-8000-000000000003'
readonly actor_id='a4780000-0000-4000-8000-000000000005'
readonly storage_id='a4780000-0000-4000-8000-00000000000b'
readonly record_type_id='a4780000-0000-4000-8000-000000000009'
readonly held_record_id='a4780000-0000-4000-8000-000000000014'
readonly pending_record_id='a4780000-0000-4000-8000-000000000013'
readonly hold_id='a4780000-0000-4000-8000-000000000020'
readonly race_hold_id='a4780000-0000-4000-8000-000000000022'
readonly organization_two_id='a4780000-0000-4000-8000-000000000060'
readonly storage_two_id='a4780000-0000-4000-8000-000000000066'
readonly record_type_two_id='a4780000-0000-4000-8000-000000000065'
readonly policy_two_id='a4780000-0000-4000-8000-000000000067'
worker_pids=()

cleanup() {
  for pid in "${worker_pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  rm -rf -- "$proof_root"
}
trap cleanup EXIT

if [ -z "$database_url" ]; then
  echo 'VORTEX_CONCURRENCY_DATABASE_URL is required' >&2
  exit 1
fi
readonly -a psql_command=(psql "$database_url" -X -v ON_ERROR_STOP=1 -Atq)
readonly fixture_path="$(cd "$(dirname "$0")" && pwd)/helpers/record-removal-protection-fixture.psql"

"${psql_command[@]}" <<SQL
begin;
\ir $fixture_path
commit;
SQL

human_context="select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind','human','identityAuthorityId','$actor_id','tenantId','$tenant_id',
  'organizationId','$organization_id','organizationAccountId','$account_id','identityId','$identity_id',
  'sessionId','a4780000-0000-4000-8000-000000000050','authenticationStrength','single_factor',
  'issuedAt',pg_catalog.clock_timestamp()-interval '1 minute','expiresAt',pg_catalog.clock_timestamp()+interval '1 hour',
  'accessVersion',(select current_version from vortex_access.organization_access_versions where organization_id='$organization_id'),
  'correlationId','a4780000-0000-4000-8000-000000000051',
  'accessTokenIssuedAt',pg_catalog.clock_timestamp()-interval '1 minute',
  'primaryAuthenticatedAt',pg_catalog.clock_timestamp()-interval '1 minute'));"
system_context="select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind','system','tenantId','$tenant_id','organizationId','$organization_id',
  'sessionId','a4780000-0000-4000-8000-000000000052','authenticationStrength','service',
  'systemActorId','$actor_id','issuedAt',pg_catalog.clock_timestamp()-interval '1 minute',
  'expiresAt',pg_catalog.clock_timestamp()+interval '1 hour',
  'accessVersion',(select current_version from vortex_access.organization_access_versions where organization_id='$organization_id'),
  'correlationId','a4780000-0000-4000-8000-000000000053'));"
system_context_two="select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind','system','tenantId','$tenant_id','organizationId','$organization_two_id',
  'sessionId','a4780000-0000-4000-8000-000000000054','authenticationStrength','service',
  'systemActorId','$actor_id','issuedAt',pg_catalog.clock_timestamp()-interval '1 minute',
  'expiresAt',pg_catalog.clock_timestamp()+interval '1 hour',
  'accessVersion',(select current_version from vortex_access.organization_access_versions where organization_id='$organization_two_id'),
  'correlationId','a4780000-0000-4000-8000-000000000055'));"

# Empty-scope first-writer race: revision two inserts and stays uncommitted;
# revision one reaches the same unique scope, waits, then must fail stale.
"${psql_command[@]}" >"$proof_root/policy-newer.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/policy-newer.pid'
$system_context_two
set local role vortex_record_adapter;
select pg_catalog.concat_ws('|', result->>'outcome', result->>'policyRevision', result->>'replayed')
from (select vortex_record.record_current_recovery_policy_internal(
  '$storage_two_id','$record_type_two_id','$policy_two_id',2,14
) as result) as recorded \g '$proof_root/policy-newer.result'
reset role;
\! touch '$proof_root/policy-newer.ready'
\! deadline=600; while [ ! -f '$proof_root/policy-newer.commit' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/policy-newer.commit' ]
commit;
SQL
policy_newer_pid=$!
worker_pids+=("$policy_newer_pid")

for _ in $(seq 1 600); do
  [ -f "$proof_root/policy-newer.ready" ] && break
  sleep 0.05
done
[ -f "$proof_root/policy-newer.ready" ] || { echo 'newer policy writer did not reach its commit barrier' >&2; exit 1; }
policy_newer_backend="$(tr -d '[:space:]' <"$proof_root/policy-newer.pid")"

"${psql_command[@]}" >"$proof_root/policy-stale.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/policy-stale.pid'
$system_context_two
set local role vortex_record_adapter;
\set ON_ERROR_STOP off
\o '$proof_root/policy-stale.result'
select vortex_record.record_current_recovery_policy_internal(
  '$storage_two_id','$record_type_two_id','$policy_two_id',1,30
);
\qecho :SQLSTATE
\o
rollback;
SQL
policy_stale_pid=$!
worker_pids+=("$policy_stale_pid")

for _ in $(seq 1 600); do
  [ -s "$proof_root/policy-stale.pid" ] && break
  sleep 0.05
done
[ -s "$proof_root/policy-stale.pid" ] || { echo 'stale policy writer did not start' >&2; exit 1; }
policy_stale_backend="$(tr -d '[:space:]' <"$proof_root/policy-stale.pid")"

blocked=false
for _ in $(seq 1 600); do
  if [ "$("${psql_command[@]}" -c "select '$policy_newer_backend'::integer = any(pg_catalog.pg_blocking_pids('$policy_stale_backend'::integer));")" = 't' ]; then
    blocked=true
    break
  fi
  sleep 0.05
done
[ "$blocked" = true ] || { echo 'stale first writer did not wait on the newer absent-scope insert' >&2; exit 1; }

touch "$proof_root/policy-newer.commit"
wait "$policy_newer_pid"
wait "$policy_stale_pid"
worker_pids=()

[ "$(tr -d '[:space:]' <"$proof_root/policy-newer.result")" = 'recorded|2|false' ] || {
  echo 'newer first writer did not record revision two' >&2
  exit 1
}
[ "$(tr -d '[:space:]' <"$proof_root/policy-stale.result")" = '40001' ] || {
  echo 'stale first writer was not refused with serialization failure' >&2
  exit 1
}

policy_replay="$("${psql_command[@]}" -c "begin; $system_context_two set local role vortex_record_adapter; select pg_catalog.concat_ws('|',result->>'outcome',result->>'policyRevision',result->>'replayed') from (select vortex_record.record_current_recovery_policy_internal('$storage_two_id','$record_type_two_id','$policy_two_id',2,14) as result) replayed; rollback;")"
[ "$policy_replay" = 'recorded|2|true' ] || {
  printf 'exact policy replay was not accepted as replay: %q\n' "$policy_replay" >&2
  exit 1
}
policy_state="$("${psql_command[@]}" -c "select pg_catalog.concat_ws('|',policy_id,policy_revision,recovery_period_days) from vortex_record.record_recovery_policy_states where organization_id='$organization_two_id' and storage_contract_id='$storage_two_id';")"
[ "$policy_state" = "$policy_two_id|2|14" ] || {
  printf 'policy race retained unexpected state: %q\n' "$policy_state" >&2
  exit 1
}

# Release-first interleaving: final removal waits on the exact guard and then
# observes the committed release revision.
"${psql_command[@]}" >"$proof_root/release.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/release.pid'
$human_context
set local role vortex_record_adapter;
select pg_catalog.concat_ws('|', result->>'outcome', result->>'holdRevision')
from (select vortex_record.change_record_legal_hold_internal(
  'release','$hold_id','$storage_id','$record_type_id','$held_record_id',1,
  'Concurrent release committed',null
) as result) as released \g '$proof_root/release.result'
reset role;
\! touch '$proof_root/release.ready'
\! deadline=600; while [ ! -f '$proof_root/release.commit' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/release.commit' ]
commit;
SQL
release_pid=$!
worker_pids+=("$release_pid")

for _ in $(seq 1 600); do
  [ -f "$proof_root/release.ready" ] && break
  sleep 0.05
done
[ -f "$proof_root/release.ready" ] || { echo 'hold release did not reach its commit barrier' >&2; exit 1; }
release_backend="$(tr -d '[:space:]' <"$proof_root/release.pid")"

"${psql_command[@]}" >"$proof_root/removal.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/removal.pid'
$system_context
set local role vortex_record_adapter;
select pg_catalog.concat_ws('|', result->>'outcome', result->>'protectionRevision')
from (select vortex_record.resolve_permanent_record_removal_internal(
  '$organization_id',null,'organization_shared','$storage_id','$record_type_id','$held_record_id',2,
  (select deleted_at from vortex_record.record_recovery_provenance
    where organization_id='$organization_id' and storage_contract_id='$storage_id'
      and record_id='$held_record_id')
) as result) as eligibility \g '$proof_root/removal.result'
reset role;
commit;
SQL
removal_pid=$!
worker_pids+=("$removal_pid")

for _ in $(seq 1 600); do
  [ -s "$proof_root/removal.pid" ] && break
  sleep 0.05
done
[ -s "$proof_root/removal.pid" ] || { echo 'removal eligibility session did not start' >&2; exit 1; }
removal_backend="$(tr -d '[:space:]' <"$proof_root/removal.pid")"

blocked=false
for _ in $(seq 1 600); do
  if [ "$("${psql_command[@]}" -c "select '$release_backend'::integer = any(pg_catalog.pg_blocking_pids('$removal_backend'::integer));")" = 't' ]; then
    blocked=true
    break
  fi
  sleep 0.05
done
[ "$blocked" = true ] || { echo 'final removal did not wait on the legal-hold release guard' >&2; exit 1; }

touch "$proof_root/release.commit"
wait "$release_pid"
wait "$removal_pid"
worker_pids=()

[ "$(tr -d '[:space:]' <"$proof_root/release.result")" = 'released|2' ] || {
  echo 'legal hold did not commit exact release revision two' >&2
  exit 1
}
removal_result="$(tr -d '[:space:]' <"$proof_root/removal.result")"
[ "$removal_result" = 'eligible|4' ] || {
  printf 'final removal did not recheck the committed release: %q\n' "$removal_result" >&2
  exit 1
}
release_state="$("${psql_command[@]}" -c "select pg_catalog.concat_ws('|',hold.hold_revision,hold.released_at is not null,guard.protection_revision) from vortex_record.record_legal_holds hold join vortex_record.record_removal_guards guard on guard.organization_id=hold.organization_id and guard.storage_contract_id=hold.storage_contract_id and guard.record_id=hold.record_id where hold.organization_id='$organization_id' and hold.legal_hold_id='$hold_id';")"
[ "$release_state" = '2|t|4' ] || {
  printf 'release/removal race left unexpected state: %q\n' "$release_state" >&2
  exit 1
}

# Reverse interleaving: hold the guard, start hold apply, verify that apply waits
# before touching the Record row, then let final-removal take the row and commit.
"${psql_command[@]}" >"$proof_root/guard-first.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/guard-first.pid'
$system_context
set local role vortex_record_adapter;
select protection_revision from vortex_record.record_removal_guards
where organization_id='$organization_id' and storage_contract_id='$storage_id'
  and record_id='$pending_record_id' for update;
\! touch '$proof_root/guard-first.ready'
\! deadline=600; while [ ! -f '$proof_root/guard-first.continue' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/guard-first.continue' ]
select pg_catalog.concat_ws('|', result->>'outcome', result->>'protectionRevision')
from (select vortex_record.resolve_permanent_record_removal_internal(
  '$organization_id',null,'organization_shared','$storage_id','$record_type_id','$pending_record_id',2,
  (select deleted_at from vortex_record.record_recovery_provenance
    where organization_id='$organization_id' and storage_contract_id='$storage_id'
      and record_id='$pending_record_id')
) as result) as eligibility \g '$proof_root/guard-first.result'
reset role;
commit;
SQL
guard_first_pid=$!
worker_pids+=("$guard_first_pid")

for _ in $(seq 1 600); do
  [ -f "$proof_root/guard-first.ready" ] && break
  sleep 0.05
done
[ -f "$proof_root/guard-first.ready" ] || { echo 'guard-first removal did not reach its barrier' >&2; exit 1; }
guard_first_backend="$(tr -d '[:space:]' <"$proof_root/guard-first.pid")"

"${psql_command[@]}" >"$proof_root/hold-apply.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/hold-apply.pid'
$human_context
set local role vortex_record_adapter;
select pg_catalog.concat_ws('|', result->>'outcome', result->>'holdRevision')
from (select vortex_record.change_record_legal_hold_internal(
  'apply','$race_hold_id','$storage_id','$record_type_id','$pending_record_id',null,
  'Reverse interleaving preservation',pg_catalog.statement_timestamp()+interval '30 days'
) as result) as held \g '$proof_root/hold-apply.result'
reset role;
commit;
SQL
hold_apply_pid=$!
worker_pids+=("$hold_apply_pid")

for _ in $(seq 1 600); do
  [ -s "$proof_root/hold-apply.pid" ] && break
  sleep 0.05
done
[ -s "$proof_root/hold-apply.pid" ] || { echo 'hold-apply session did not start' >&2; exit 1; }
hold_apply_backend="$(tr -d '[:space:]' <"$proof_root/hold-apply.pid")"

blocked=false
for _ in $(seq 1 600); do
  if [ "$("${psql_command[@]}" -c "select '$guard_first_backend'::integer = any(pg_catalog.pg_blocking_pids('$hold_apply_backend'::integer));")" = 't' ]; then
    blocked=true
    break
  fi
  sleep 0.05
done
[ "$blocked" = true ] || { echo 'hold apply did not wait at the common guard-first lock' >&2; exit 1; }

touch "$proof_root/guard-first.continue"
wait "$guard_first_pid"
wait "$hold_apply_pid"
worker_pids=()

guard_result="$(tr -d '[:space:]' <"$proof_root/guard-first.result")"
[ "$guard_result" = 'eligible|2' ] || {
  printf 'guard-first final removal returned unexpected result: %q\n' "$guard_result" >&2
  exit 1
}
[ "$(tr -d '[:space:]' <"$proof_root/hold-apply.result")" = 'held|1' ] || {
  echo 'hold apply did not commit after the guard-first removal check' >&2
  exit 1
}
apply_state="$("${psql_command[@]}" -c "select pg_catalog.concat_ws('|',hold.hold_revision,hold.released_at is null,guard.protection_revision) from vortex_record.record_legal_holds hold join vortex_record.record_removal_guards guard on guard.organization_id=hold.organization_id and guard.storage_contract_id=hold.storage_contract_id and guard.record_id=hold.record_id where hold.organization_id='$organization_id' and hold.legal_hold_id='$race_hold_id';")"
[ "$apply_state" = '1|t|3' ] || {
  printf 'reverse interleaving left unexpected state: %q\n' "$apply_state" >&2
  exit 1
}

echo "record protection concurrency proofs passed: policy=$policy_state replay=$policy_replay release=$release_state reverse=$apply_state"
