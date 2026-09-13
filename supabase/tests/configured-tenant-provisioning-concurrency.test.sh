#!/usr/bin/env bash
set -euo pipefail

run_uuid="${VORTEX_TENANT_PROVISIONING_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'tenant provisioning proof requires a lowercase UUID v4' >&2
  exit 1
}

readonly token="${run_uuid//-/}"
readonly short_name="provision_${token:0:20}"
readonly cluster_id="c5${run_uuid:2}"
readonly operator_id="95${run_uuid:2}"
readonly duplicate_key="d5${run_uuid:2}"
readonly tenant_steward_id="45${run_uuid:2}"
readonly organization_steward_id="46${run_uuid:2}"
proof_root="$(mktemp -d /tmp/vortex-tenant-provisioning.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then psql_command+=("$database_url"); fi
worker_one=''
worker_two=''
fixture_created=0

run_sql() { "${psql_command[@]}" --command "$1"; }

wait_for_file() {
  local path="$1"
  local deadline=$((SECONDS + 20))
  while ((SECONDS < deadline)); do
    [ -f "$path" ] && return 0
    sleep 0.05
  done
  echo "tenant provisioning proof did not reach ${path##*/}" >&2
  return 1
}

cleanup() {
  local original_status=$?
  trap - EXIT INT TERM
  set +e
  touch "$proof_root/release" >/dev/null 2>&1
  [ -z "$worker_one" ] || wait "$worker_one" >/dev/null 2>&1
  [ -z "$worker_two" ] || wait "$worker_two" >/dev/null 2>&1
  if [ "$fixture_created" = 1 ] && [ -f "$proof_root/one.result" ]; then
    local result tenant_id organization_id
    result="$(tr -d '[:space:]' <"$proof_root/one.result")"
    tenant_id="$(printf '%s' "$result" | cut -d'|' -f2)"
    organization_id="$(printf '%s' "$result" | cut -d'|' -f3)"
    run_sql "
      begin;
      set local session_replication_role = replica;
      delete from vortex_identity.accepted_administration_receipts
        where cluster_id = '$cluster_id';
      delete from vortex_access.organization_stewardship_requirements
        where organization_id = '$organization_id';
      delete from vortex_access.organization_delegation_authorities
        where organization_id = '$organization_id';
      delete from vortex_access.organization_role_assignments
        where organization_id = '$organization_id';
      delete from vortex_access.organization_role_permission_entries
        where organization_id = '$organization_id';
      delete from vortex_access.organization_role_revisions
        where organization_id = '$organization_id';
      delete from vortex_access.organization_roles
        where organization_id = '$organization_id';
      delete from vortex_access.permission_continuities
        where organization_id = '$organization_id';
      delete from vortex_access.permission_catalogue_entries
        where organization_id = '$organization_id';
      delete from vortex_access.permission_registrations
        where organization_id = '$organization_id';
      delete from vortex_access.permission_registration_revisions
        where organization_id = '$organization_id';
      delete from vortex_access.organization_access_versions
        where organization_id = '$organization_id';
      delete from vortex_identity.organization_runtime_settings
        where organization_id = '$organization_id';
      delete from vortex_identity.tenant_administrator_assignments
        where tenant_id = '$tenant_id';
      delete from vortex_identity.organization_accounts
        where organization_id = '$organization_id';
      delete from vortex_identity.organizations where organization_id = '$organization_id';
      delete from vortex_identity.tenants where tenant_id = '$tenant_id';
      delete from vortex_identity.identity_projections
        where identity_id in ('$tenant_steward_id', '$organization_steward_id');
      commit;
    " >/dev/null
  fi
  case "$proof_root" in
    /tmp/vortex-tenant-provisioning.*) rm -rf -- "$proof_root" ;;
    *) echo "refusing to remove unexpected proof directory: $proof_root" >&2 ;;
  esac
  exit "$original_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

call_sql="select outcome || '|' || tenant_id || '|' || root_organization_id || '|' || tenant_administrator_assignment_id || '|' || organization_account_id || '|' || access_version || '|' || correlation_id from vortex_identity.provision_tenant(
  '$cluster_id', '$operator_id', '$duplicate_key',
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '$short_name', 'Concurrent tenant', '${short_name}_root', 'Concurrent root',
  '$tenant_steward_id', '$organization_steward_id', 'Concurrent steward',
  'en-NZ', 'Pacific/Auckland', 'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
)"

"${psql_command[@]}" >"$proof_root/one.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/one.pid'
set local role vortex_runtime;
$call_sql \g '$proof_root/one.result'
reset role;
\! touch '$proof_root/one-ready'
\! deadline=600; while [ ! -f '$proof_root/release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/release' ]
commit;
SQL
worker_one=$!
wait_for_file "$proof_root/one-ready"
fixture_created=1

"${psql_command[@]}" >"$proof_root/two.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/two.pid'
set local role vortex_runtime;
$call_sql \g '$proof_root/two.result'
commit;
SQL
worker_two=$!
wait_for_file "$proof_root/two.pid"

one_pid="$(tr -d '[:space:]' <"$proof_root/one.pid")"
two_pid="$(tr -d '[:space:]' <"$proof_root/two.pid")"
deadline=$((SECONDS + 20))
while ((SECONDS < deadline)); do
  [ "$(run_sql "select case when $one_pid = any(pg_catalog.pg_blocking_pids($two_pid)) then 'blocked' else '' end;")" = 'blocked' ] && break
  sleep 0.1
done
[ "$(run_sql "select case when $one_pid = any(pg_catalog.pg_blocking_pids($two_pid)) then 'blocked' else '' end;")" = 'blocked' ] || {
  echo 'the exact concurrent retry did not wait on the accepted-command scope' >&2
  exit 1
}

touch "$proof_root/release"
wait "$worker_one"
worker_one=''
wait "$worker_two"
worker_two=''

first="$(tr -d '[:space:]' <"$proof_root/one.result")"
second="$(tr -d '[:space:]' <"$proof_root/two.result")"
[[ "$first" == accepted\|* ]] || { echo 'first provisioning worker was not accepted' >&2; exit 1; }
[[ "$second" == replayed\|* ]] || { echo 'waiting provisioning worker was not replayed' >&2; exit 1; }
[ "${first#*|}" = "${second#*|}" ] || {
  echo 'concurrent provisioning retry returned different identifiers or evidence' >&2
  exit 1
}
[ "$(run_sql "select count(*) from vortex_identity.accepted_administration_receipts where cluster_id = '$cluster_id' and operation_key = 'provision_tenant';")" = '1' ] || {
  echo 'concurrent provisioning created more than one receipt' >&2
  exit 1
}

echo 'configured tenant provisioning concurrency proof passed'
