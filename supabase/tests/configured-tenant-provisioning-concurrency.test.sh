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
readonly adopted_tenant_id="15${run_uuid:2}"
readonly adopted_organization_id="25${run_uuid:2}"
readonly adopted_identity_id="47${run_uuid:2}"
readonly adopted_account_id="55${run_uuid:2}"
readonly adopted_duplicate_key="d6${run_uuid:2}"
proof_root="$(mktemp -d /tmp/vortex-tenant-provisioning.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then psql_command+=("$database_url"); fi
worker_one=''
worker_two=''
fixture_created=0
adoption_fixture_created=0

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
  touch "$proof_root/release" "$proof_root/adoption-waiting" \
    "$proof_root/request-release" >/dev/null 2>&1
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
  if [ "$adoption_fixture_created" = 1 ]; then
    run_sql "
      begin;
      set local session_replication_role = replica;
      delete from vortex_identity.accepted_administration_receipts
        where tenant_id = '$adopted_tenant_id';
      delete from vortex_access.organization_stewardship_requirements
        where organization_id = '$adopted_organization_id';
      delete from vortex_access.organization_delegation_authorities
        where organization_id = '$adopted_organization_id';
      delete from vortex_access.organization_role_assignments
        where organization_id = '$adopted_organization_id';
      delete from vortex_access.organization_role_permission_entries
        where organization_id = '$adopted_organization_id';
      delete from vortex_access.organization_role_revisions
        where organization_id = '$adopted_organization_id';
      delete from vortex_access.organization_roles
        where organization_id = '$adopted_organization_id';
      delete from vortex_access.permission_continuities
        where organization_id = '$adopted_organization_id';
      delete from vortex_access.permission_catalogue_entries
        where organization_id = '$adopted_organization_id';
      delete from vortex_access.permission_registrations
        where organization_id = '$adopted_organization_id';
      delete from vortex_access.permission_registration_revisions
        where organization_id = '$adopted_organization_id';
      delete from vortex_access.organization_access_versions
        where organization_id = '$adopted_organization_id';
      delete from vortex_identity.organization_accounts
        where organization_id = '$adopted_organization_id';
      delete from vortex_identity.organizations
        where organization_id = '$adopted_organization_id';
      delete from vortex_identity.tenants where tenant_id = '$adopted_tenant_id';
      delete from vortex_identity.identity_projections
        where identity_id = '$adopted_identity_id';
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

adoption_fixture_created=1
run_sql "
  begin;
  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$adopted_tenant_id', 'adopt_${token:0:20}', 'Adoption race tenant',
    'active', pg_catalog.clock_timestamp(), '$operator_id',
    pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, short_name, display_name, state, created_at,
    created_by, state_changed_at, revision
  ) values (
    '$adopted_organization_id', '$adopted_tenant_id',
    'adopt_${token:0:18}_org', 'Adoption race organisation', 'active',
    pg_catalog.clock_timestamp(), '$operator_id', pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '$adopted_identity_id', 'active', pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '$operator_id', 'a5${run_uuid:2}', 1
  );
  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, activated_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '$adopted_account_id', '$adopted_organization_id', '$adopted_identity_id',
    'Adoption race steward', 'active', pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), '$operator_id',
    'a6${run_uuid:2}', 1
  );
  select * from vortex_access.initialize_organization_access_version(
    '$adopted_organization_id', '$operator_id', 'a7${run_uuid:2}'
  );
  select * from vortex_access.initialize_platform_permission_catalogue(
    '$adopted_organization_id', '$operator_id', 'a8${run_uuid:2}'
  );
  commit;
" >/dev/null

"${psql_command[@]}" >"$proof_root/request.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/request.pid'
select current_version
from vortex_access.organization_access_versions
where organization_id = '$adopted_organization_id'
for share;
\! touch '$proof_root/request-access-ready'
\! deadline=600; while [ ! -f '$proof_root/adoption-waiting' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/adoption-waiting' ]
set local role vortex_runtime;
select tenant_id || '|' || organization_id || '|' || organization_account_id || '|' || access_version
from vortex_access.resolve_human_organization_scope(
  '$adopted_identity_id', '$adopted_organization_id'
) \g '$proof_root/request.result'
reset role;
\! touch '$proof_root/request-resolved'
\! deadline=600; while [ ! -f '$proof_root/request-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/request-release' ]
commit;
SQL
worker_one=$!
wait_for_file "$proof_root/request-access-ready"

"${psql_command[@]}" >"$proof_root/adoption.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/adoption.pid'
set local role vortex_runtime;
select outcome || '|' || tenant_id || '|' || organization_id || '|' || organization_account_id || '|' || access_version
from vortex_identity.adopt_organization(
  '$operator_id', '$adopted_duplicate_key',
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '$adopted_tenant_id', '$adopted_organization_id',
  '$adopted_identity_id', '$adopted_account_id'
) \g '$proof_root/adoption.result'
commit;
SQL
worker_two=$!
wait_for_file "$proof_root/adoption.pid"

request_pid="$(tr -d '[:space:]' <"$proof_root/request.pid")"
adoption_pid="$(tr -d '[:space:]' <"$proof_root/adoption.pid")"
deadline=$((SECONDS + 20))
while ((SECONDS < deadline)); do
  [ "$(run_sql "select case when $request_pid = any(pg_catalog.pg_blocking_pids($adoption_pid)) then 'blocked' else '' end;")" = 'blocked' ] && break
  sleep 0.1
done
[ "$(run_sql "select case when $request_pid = any(pg_catalog.pg_blocking_pids($adoption_pid)) then 'blocked' else '' end;")" = 'blocked' ] || {
  echo 'organisation adoption did not wait on the normal request Access lock' >&2
  exit 1
}

touch "$proof_root/adoption-waiting"
wait_for_file "$proof_root/request-resolved"
[ "$(run_sql "select case when $request_pid = any(pg_catalog.pg_blocking_pids($adoption_pid)) then 'blocked' else '' end;")" = 'blocked' ] || {
  echo 'adoption stopped waiting before the normal request completed Identity resolution' >&2
  exit 1
}
touch "$proof_root/request-release"
wait "$worker_one"
worker_one=''
if wait "$worker_two"; then
  :
else
  worker_status=$?
  echo 'configured organisation adoption worker failed; bounded diagnostics follow' >&2
  tail -n 80 "$proof_root/adoption.log" >&2 || true
  exit "$worker_status"
fi
worker_two=''

[ "$(tr -d '[:space:]' <"$proof_root/request.result")" = "$adopted_tenant_id|$adopted_organization_id|$adopted_account_id|2" ] || {
  echo 'the normal request did not resolve while adoption waited Access-first' >&2
  exit 1
}
[[ "$(tr -d '[:space:]' <"$proof_root/adoption.result")" == "accepted|$adopted_tenant_id|$adopted_organization_id|$adopted_account_id|3" ]] || {
  echo 'organisation adoption did not complete after the normal request released' >&2
  exit 1
}

echo 'configured organisation adoption request lock-order proof passed'
