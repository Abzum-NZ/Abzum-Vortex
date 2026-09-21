#!/usr/bin/env bash
# #408: a final permanent-removal eligibility check waits on the exact removal
# guard while a legal-hold release is uncommitted, then rechecks and observes the
# committed release revision before returning eligible.
set -euo pipefail

readonly proof_root="$(mktemp -d /tmp/vortex-record-removal-protection.XXXXXX)"
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly organization_id='a4780000-0000-4000-8000-000000000002'
readonly account_id='a4780000-0000-4000-8000-000000000004'
readonly identity_id='a4780000-0000-4000-8000-000000000003'
readonly actor_id='a4780000-0000-4000-8000-000000000005'
readonly storage_id='a4780000-0000-4000-8000-00000000000b'
readonly record_type_id='a4780000-0000-4000-8000-000000000009'
readonly record_id='a4780000-0000-4000-8000-000000000014'
readonly hold_id='a4780000-0000-4000-8000-000000000020'
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
  'callerKind','human','identityAuthorityId','$actor_id','tenantId','a4780000-0000-4000-8000-000000000001',
  'organizationId','$organization_id','organizationAccountId','$account_id','identityId','$identity_id',
  'sessionId','a4780000-0000-4000-8000-000000000050','authenticationStrength','single_factor',
  'issuedAt',pg_catalog.clock_timestamp()-interval '1 minute','expiresAt',pg_catalog.clock_timestamp()+interval '1 hour',
  'accessVersion',1,'correlationId','a4780000-0000-4000-8000-000000000051',
  'accessTokenIssuedAt',pg_catalog.clock_timestamp()-interval '1 minute',
  'primaryAuthenticatedAt',pg_catalog.clock_timestamp()-interval '1 minute'));"
system_context="select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind','system','tenantId','a4780000-0000-4000-8000-000000000001',
  'organizationId','$organization_id','sessionId','a4780000-0000-4000-8000-000000000052',
  'authenticationStrength','service','systemActorId','$actor_id',
  'issuedAt',pg_catalog.clock_timestamp()-interval '1 minute','expiresAt',pg_catalog.clock_timestamp()+interval '1 hour',
  'accessVersion',1,'correlationId','a4780000-0000-4000-8000-000000000053'));"

"${psql_command[@]}" >"$proof_root/release.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/release.pid'
$human_context
set local role vortex_record_adapter;
select pg_catalog.concat_ws('|', result->>'outcome', result->>'holdRevision')
from (select vortex_record.change_record_legal_hold_internal(
  'release','$hold_id','$storage_id','$record_type_id','$record_id',1,
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
  '$organization_id',null,'organization_shared','$storage_id','$record_type_id','$record_id',2,
  (select deleted_at from vortex_record.record_recovery_provenance
    where organization_id='$organization_id' and storage_contract_id='$storage_id'
      and record_id='$record_id')
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
[ "$blocked" = true ] || { echo 'final removal eligibility did not wait on the legal-hold release guard' >&2; exit 1; }

touch "$proof_root/release.commit"
wait "$release_pid"
wait "$removal_pid"
worker_pids=()

[ "$(tr -d '[:space:]' <"$proof_root/release.result")" = 'released|2' ] || {
  echo 'the legal hold did not commit exact release revision two' >&2
  exit 1
}
removal_result="$(tr -d '[:space:]' <"$proof_root/removal.result")"
case "$removal_result" in
  eligible\|4) ;;
  *) printf 'final removal did not recheck the committed release: %q\n' "$removal_result" >&2; exit 1 ;;
esac

final_state="$("${psql_command[@]}" -c "select pg_catalog.concat_ws('|', hold.hold_revision, hold.released_at is not null, guard.protection_revision) from vortex_record.record_legal_holds as hold join vortex_record.record_removal_guards as guard on guard.organization_id=hold.organization_id and guard.storage_contract_id=hold.storage_contract_id and guard.record_id=hold.record_id where hold.organization_id='$organization_id' and hold.legal_hold_id='$hold_id';")"
[ "$final_state" = '2|t|4' ] || {
  printf 'release/removal race left unexpected committed state: %q\n' "$final_state" >&2
  exit 1
}

echo "record removal protection concurrency proof passed: $removal_result, state=$final_state"
