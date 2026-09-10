#!/usr/bin/env bash

set -euo pipefail

run_uuid="${VORTEX_GROUP_ADMINISTRATION_CHANGE_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the Group-administration proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_GROUP_ADMINISTRATION_CHANGE_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_short_name="group_admin_${run_token:0:18}"
proof_root="$(mktemp -d /tmp/vortex-group-administration-change.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id="15${run_uuid:2}"
readonly organization_id="25${run_uuid:2}"
readonly identity_id="45${run_uuid:2}"
readonly account_id="55${run_uuid:2}"
readonly role_id="65${run_uuid:2}"
readonly group_id="66${run_uuid:2}"
readonly assignment_id="75${run_uuid:2}"
readonly delegation_id="85${run_uuid:2}"
readonly actor_id="95${run_uuid:2}"
readonly correlation_initialize="a5${run_uuid:2}"
readonly correlation_adopt="a6${run_uuid:2}"
readonly correlation_create="a7${run_uuid:2}"
readonly correlation_winner="a8${run_uuid:2}"
readonly correlation_loser="a9${run_uuid:2}"
readonly activity_winner="b5${run_uuid:2}"
readonly activity_loser="b6${run_uuid:2}"
readonly revoke_assignment_id="b9${run_uuid:2}"
readonly revoke_activity_winner="ba${run_uuid:2}"
readonly revoke_activity_loser="bb${run_uuid:2}"
readonly identity_authority_id="b7${run_uuid:2}"
readonly session_id="b8${run_uuid:2}"

fixture_claimed=0
declare -a worker_pids=()
declare -A reaped_worker_pids=()

psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then psql_command+=("$database_url"); fi

run_sql() { "${psql_command[@]}" --command "$1"; }

wait_for_file() {
  local candidate="$1"
  local deadline=$((SECONDS + 20))
  while ((SECONDS < deadline)); do
    [ -f "$candidate" ] && return 0
    sleep 0.05
  done
  echo 'Group-administration proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'Group-administration proof captured an invalid backend identifier: %q\n' "$backend_pid" >&2
    return 1
  }
  printf '%s\n' "$backend_pid"
}

wait_for_database_blocker() {
  local blocked_pid="$1"
  local blocking_pid="$2"
  local deadline=$((SECONDS + 20))
  local state
  while ((SECONDS < deadline)); do
    state="$(run_sql "select case when $blocking_pid = any(pg_catalog.pg_blocking_pids($blocked_pid)) then 'blocked' else '' end;")"
    [ "$state" = 'blocked' ] && return 0
    sleep 0.1
  done
  echo 'Group-administration proof did not observe the exact governance blocker' >&2
  return 1
}

wait_owned_worker() {
  local pid="$1"
  local status
  if wait "$pid"; then status=0; else status=$?; fi
  reaped_worker_pids["$pid"]=1
  return "$status"
}

stop_owned_workers() {
  local pid
  for pid in "${worker_pids[@]}"; do
    if [ "${reaped_worker_pids[$pid]:-0}" != 1 ] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  for pid in "${worker_pids[@]}"; do
    if [ "${reaped_worker_pids[$pid]:-0}" != 1 ]; then
      wait "$pid" >/dev/null 2>&1 || true
      reaped_worker_pids["$pid"]=1
    fi
  done
}

emit_owned_failure_diagnostics() {
  local log_path
  echo 'Group-administration proof failed; bounded owned diagnostics follow' >&2
  for log_path in "$proof_root"/*.log; do
    [ -f "$log_path" ] || continue
    printf '%s\n' "--- ${log_path##*/} (last 100 lines) ---" >&2
    tail -n 100 -- "$log_path" >&2
  done
}

cleanup_fixture() {
  [ "$fixture_claimed" = 1 ] || return 0
  run_sql "
    begin;
    set local session_replication_role = replica;
    do \$proof\$
    begin
      if not exists (
        select 1 from vortex_identity.tenants
        where tenant_id = '$tenant_id'
          and short_name = '$fixture_short_name'
          and created_by = '$actor_id'
      ) or not exists (
        select 1 from vortex_identity.organizations
        where organization_id = '$organization_id'
          and tenant_id = '$tenant_id'
          and short_name = '$fixture_short_name'
          and created_by = '$actor_id'
      ) or not exists (
        select 1 from vortex_identity.organization_accounts
        where organization_account_id = '$account_id'
          and organization_id = '$organization_id'
          and identity_id = '$identity_id'
      ) then
        raise exception 'Group-administration proof fixture ownership mismatch';
      end if;
    end
    \$proof\$;
    delete from vortex_activity.organization_activity_entries
      where organization_id = '$organization_id';
    delete from vortex_access.organization_stewardship_requirements
      where organization_id = '$organization_id';
    delete from vortex_access.organization_delegation_authorities
      where organization_id = '$organization_id';
    delete from vortex_access.organization_role_activations
      where organization_id = '$organization_id';
    delete from vortex_access.organization_role_assignments
      where organization_id = '$organization_id';
    delete from vortex_access.organization_role_permission_entries
      where organization_id = '$organization_id';
    delete from vortex_access.organization_role_revisions
      where organization_id = '$organization_id';
    delete from vortex_access.organization_role_activation_policy_revisions
      where organization_id = '$organization_id';
    delete from vortex_access.organization_roles
      where organization_id = '$organization_id';
    delete from vortex_access.organization_groups
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
    delete from vortex_identity.organization_accounts
      where organization_id = '$organization_id';
    delete from vortex_identity.identity_projections
      where identity_id = '$identity_id';
    delete from vortex_identity.organizations
      where organization_id = '$organization_id';
    delete from vortex_identity.tenants where tenant_id = '$tenant_id';
    commit;
  " >/dev/null
}

finalize() {
  local original_status=$?
  local cleanup_status=0
  local operation_status
  trap - EXIT INT TERM
  set +e
  touch "$proof_root/winner-release"
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then emit_owned_failure_diagnostics; fi
  cleanup_fixture
  operation_status=$?
  if [ "$operation_status" -ne 0 ]; then cleanup_status="$operation_status"; fi
  case "$proof_root" in
    /tmp/vortex-group-administration-change.*) rm -rf -- "$proof_root"; operation_status=$? ;;
    *) echo 'refusing to remove an unexpected Group-administration proof directory' >&2; operation_status=1 ;;
  esac
  if [ "$operation_status" -ne 0 ] && [ "$cleanup_status" -eq 0 ]; then
    cleanup_status="$operation_status"
  fi
  if [ "$original_status" -ne 0 ]; then exit "$original_status"; fi
  exit "$cleanup_status"
}
trap finalize EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_sql "
  begin;
  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', '$fixture_short_name', 'Group administration proof', 'active',
    pg_catalog.statement_timestamp(), '$actor_id',
    pg_catalog.statement_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, short_name, display_name, state,
    created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', '$fixture_short_name',
    'Group administration proof', 'active', pg_catalog.statement_timestamp(),
    '$actor_id', pg_catalog.statement_timestamp(), 1
  );
  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '$identity_id', 'active', pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '$actor_id', '$correlation_initialize', 1
  );
  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, activated_at, suspended_at, changed_at, state_changed_at,
    state_changed_by, state_change_correlation_id, revision
  ) values (
    '$account_id', '$organization_id', '$identity_id', 'Group administrator',
    'active', pg_catalog.statement_timestamp(), null,
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '$actor_id', '$correlation_initialize', 1
  );
  select * from vortex_access.initialize_organization_access_version(
    '$organization_id', '$actor_id', '$correlation_initialize'
  );
  select * from vortex_access.initialize_platform_permission_catalogue(
    '$organization_id', '$actor_id', '$correlation_initialize'
  );
  insert into vortex_access.permission_continuities (
    organization_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id, state,
    continuity_revision, meaning_fingerprint,
    last_processed_registration_revision, changed_at
  )
  select entry.organization_id, null, entry.owner_kind, entry.owner_id,
    entry.permission_id, 'platform', entry.registration_owner_id,
    'available', 1, entry.meaning_fingerprint, entry.registration_revision,
    pg_catalog.statement_timestamp()
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = '$organization_id'
    and entry.registration_kind = 'platform';
  select * from vortex_access.coordinate_organization_stewardship_adoption(
    '$organization_id', '$account_id', '$role_id',
    'group_admin_${run_token:0:20}', 'Group administration steward',
    'Neutral authority for the Group-administration concurrency proof.',
    '$assignment_id', '$delegation_id', '$actor_id', '$correlation_adopt'
  );
  select * from vortex_access.coordinate_organization_group_change(
    'create_group', '$organization_id', '$group_id', null,
    'group_${run_token:0:24}', 'Group before rename',
    '$actor_id', '$correlation_create'
  );
  set constraints all immediate;
  commit;
" >/dev/null
fixture_claimed=1

[ "$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id = '$organization_id';")" = '4' ] || {
  echo 'Group-administration proof did not establish Access version four' >&2
  exit 1
}

# Two protected renames review the same Group revision. The first/decision path
# that owns governance commits; the waiting path then rechecks and refuses stale.
PGAPPNAME="vortex-group-admin-winner-${run_token:0:12}" "${psql_command[@]}" >"$proof_root/winner.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
set local role vortex_runtime;
select * from vortex_access.resolve_human_organization_change_scope(
  '$identity_id', '$organization_id'
) \gset scope_
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human',
  'identityAuthorityId', '$identity_authority_id',
  'tenantId', '$tenant_id',
  'organizationId', '$organization_id',
  'organizationAccountId', '$account_id',
  'identityId', '$identity_id',
  'sessionId', '$session_id',
  'authenticationStrength', 'multi_factor',
  'issuedAt', pg_catalog.clock_timestamp(),
  'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
  'accessVersion', :scope_access_version,
  'correlationId', '$correlation_winner'
));
set local role vortex_request;
select access_version
from vortex_access.rename_organization_group_for_administration(
  '$group_id', 1, 'Winning label', '$activity_winner'
) \g '$proof_root/winner.version'
reset role;
select pg_catalog.pg_backend_pid() \g '$proof_root/winner.pid'
\! deadline=600; while [ ! -f '$proof_root/winner-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/winner-release' ]
commit;
SQL
winner_pid=$!
worker_pids+=("$winner_pid")
winner_db="$(read_backend_pid "$proof_root/winner.pid")"

PGAPPNAME="vortex-group-admin-loser-${run_token:0:12}" "${psql_command[@]}" >"$proof_root/loser.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
set local role vortex_runtime;
select pg_catalog.pg_backend_pid() \g '$proof_root/loser.pid'
select * from vortex_access.resolve_human_organization_change_scope(
  '$identity_id', '$organization_id'
) \gset scope_
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human',
  'identityAuthorityId', '$identity_authority_id',
  'tenantId', '$tenant_id',
  'organizationId', '$organization_id',
  'organizationAccountId', '$account_id',
  'identityId', '$identity_id',
  'sessionId', '$session_id',
  'authenticationStrength', 'multi_factor',
  'issuedAt', pg_catalog.clock_timestamp(),
  'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
  'accessVersion', :scope_access_version,
  'correlationId', '$correlation_loser'
));
set local role vortex_request;
do \$proof\$
begin
  perform 1 from vortex_access.rename_organization_group_for_administration(
    '$group_id', 1, 'Losing label', '$activity_loser'
  );
  raise exception 'waiting protected rename unexpectedly committed';
exception when sqlstate '40001' then
  perform pg_catalog.set_config('vortex.proof_result', '40001', false);
end
\$proof\$;
select pg_catalog.current_setting('vortex.proof_result')
\g '$proof_root/loser.result'
commit;
SQL
loser_pid=$!
worker_pids+=("$loser_pid")
loser_db="$(read_backend_pid "$proof_root/loser.pid")"

wait_for_database_blocker "$loser_db" "$winner_db"
touch "$proof_root/winner-release"
wait_owned_worker "$winner_pid"
wait_owned_worker "$loser_pid"

[ "$(tr -d '[:space:]' <"$proof_root/winner.version")" = '5' ] || {
  echo 'winning protected rename did not increment Access exactly once' >&2
  exit 1
}
[ "$(tr -d '[:space:]' <"$proof_root/loser.result")" = '40001' ] || {
  echo 'waiting protected rename did not return stable stale evidence' >&2
  exit 1
}

final_state="$(run_sql "
  select version.current_version::text || '|' || organization_group.revision::text ||
    '|' || organization_group.label || '|' ||
    pg_catalog.count(activity.activity_id)::text || '|' ||
    (pg_catalog.count(activity.activity_id) filter (
      where activity.activity_id = '$activity_winner'
    ))::text || '|' ||
    (pg_catalog.count(activity.activity_id) filter (
      where activity.activity_id = '$activity_loser'
    ))::text
  from vortex_access.organization_access_versions as version
  join vortex_access.organization_groups as organization_group
    on organization_group.organization_id = version.organization_id
    and organization_group.group_id = '$group_id'
  left join vortex_activity.organization_activity_entries as activity
    on activity.organization_id = version.organization_id
  where version.organization_id = '$organization_id'
  group by version.current_version, organization_group.revision,
    organization_group.label;
")"
[ "$final_state" = '5|2|Winning label|1|1|0' ] || {
  echo 'competing protected renames left unexpected Group, Access or Activity state' >&2
  exit 1
}

run_sql "select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant','$organization_id','$revoke_assignment_id',null,'$role_id',1,
  'organization_account','$account_id',null,'standing',pg_catalog.clock_timestamp(),null,
  '$actor_id','$correlation_create');" >/dev/null
before_revoke="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';")"

PGAPPNAME="vortex-assignment-revoke-winner-${run_token:0:12}" "${psql_command[@]}" >"$proof_root/revoke-winner.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s'; set local statement_timeout = '45s';
set local role vortex_runtime;
select * from vortex_access.resolve_human_organization_change_scope('$identity_id','$organization_id') \gset scope_
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind','human','identityAuthorityId','$identity_authority_id','tenantId','$tenant_id',
  'organizationId','$organization_id','organizationAccountId','$account_id','identityId','$identity_id',
  'sessionId','$session_id','authenticationStrength','multi_factor',
  'issuedAt',pg_catalog.clock_timestamp(),'expiresAt',pg_catalog.clock_timestamp()+interval '5 minutes',
  'accessVersion',:scope_access_version,'correlationId','$correlation_winner'));
set local role vortex_request;
select access_version from vortex_access.revoke_organization_role_assignment_for_administration(
  '$revoke_assignment_id',1,'$revoke_activity_winner') \g '$proof_root/revoke-winner.version'
reset role;
select pg_catalog.pg_backend_pid() \g '$proof_root/revoke-winner.pid'
\! deadline=600; while [ ! -f '$proof_root/revoke-winner-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/revoke-winner-release' ]
commit;
SQL
revoke_winner=$!; worker_pids+=("$revoke_winner")
revoke_winner_db="$(read_backend_pid "$proof_root/revoke-winner.pid")"

PGAPPNAME="vortex-assignment-revoke-loser-${run_token:0:12}" "${psql_command[@]}" >"$proof_root/revoke-loser.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s'; set local statement_timeout = '45s';
set local role vortex_runtime;
select pg_catalog.pg_backend_pid() \g '$proof_root/revoke-loser.pid'
select * from vortex_access.resolve_human_organization_change_scope('$identity_id','$organization_id') \gset scope_
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind','human','identityAuthorityId','$identity_authority_id','tenantId','$tenant_id',
  'organizationId','$organization_id','organizationAccountId','$account_id','identityId','$identity_id',
  'sessionId','$session_id','authenticationStrength','multi_factor',
  'issuedAt',pg_catalog.clock_timestamp(),'expiresAt',pg_catalog.clock_timestamp()+interval '5 minutes',
  'accessVersion',:scope_access_version,'correlationId','$correlation_loser'));
set local role vortex_request;
select * from vortex_access.revoke_organization_role_assignment_for_administration(
  '$revoke_assignment_id',1,'$revoke_activity_loser');
commit;
SQL
revoke_loser=$!; worker_pids+=("$revoke_loser")
revoke_loser_db="$(read_backend_pid "$proof_root/revoke-loser.pid")"
wait_for_database_blocker "$revoke_loser_db" "$revoke_winner_db"
touch "$proof_root/revoke-winner-release"
wait_owned_worker "$revoke_winner"
if wait_owned_worker "$revoke_loser"; then echo 'same-revision protected revoke loser unexpectedly committed' >&2; exit 1; fi
grep -Eq '40001|42501' "$proof_root/revoke-loser.log" || { echo 'same-revision revoke loser lacked stable refusal' >&2; exit 1; }
revoke_state="$(run_sql "select pg_catalog.concat_ws('|',version.current_version,assignment.revision,assignment.state,(select count(*) from vortex_activity.organization_activity_entries where organization_id='$organization_id' and activity_id in ('$revoke_activity_winner','$revoke_activity_loser')),(select count(*) from vortex_activity.organization_activity_entries where organization_id='$organization_id' and activity_id='$revoke_activity_winner')) from vortex_access.organization_access_versions version join vortex_access.organization_role_assignments assignment on assignment.organization_id=version.organization_id and assignment.role_assignment_id='$revoke_assignment_id' where version.organization_id='$organization_id';")"
[ "$revoke_state" = "$((before_revoke + 1))|2|revoked|1|1" ] || { printf 'same-revision protected revokes left unexpected state: %q\n' "$revoke_state" >&2; exit 1; }

echo 'organization Group-administration change concurrency proof passed'
