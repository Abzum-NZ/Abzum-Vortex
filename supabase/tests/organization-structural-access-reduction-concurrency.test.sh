#!/usr/bin/env bash

set -euo pipefail

run_uuid="${VORTEX_STRUCTURAL_REDUCTION_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the structural-reduction proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_STRUCTURAL_REDUCTION_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_short_name="structural_${run_token:0:18}"
proof_root="$(mktemp -d /tmp/vortex-structural-reduction.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id="11${run_uuid:2}"
readonly organization_id="21${run_uuid:2}"
readonly identity_id="41${run_uuid:2}"
readonly member_identity_id="42${run_uuid:2}"
readonly account_id="51${run_uuid:2}"
readonly member_account_id="52${run_uuid:2}"
readonly steward_role_id="61${run_uuid:2}"
readonly group_id="63${run_uuid:2}"
readonly steward_assignment_id="71${run_uuid:2}"
readonly assignment_id="72${run_uuid:2}"
readonly membership_id="73${run_uuid:2}"
readonly steward_delegation_id="81${run_uuid:2}"
readonly actor_id="91${run_uuid:2}"
readonly identity_authority_id="c1${run_uuid:2}"
readonly session_id="c2${run_uuid:2}"
readonly correlation_initialize="a1${run_uuid:2}"
readonly correlation_adopt="a2${run_uuid:2}"
readonly correlation_group="a3${run_uuid:2}"
readonly correlation_role="a4${run_uuid:2}"
readonly correlation_membership="a5${run_uuid:2}"
readonly correlation_assignment="a6${run_uuid:2}"
readonly correlation_group_retire="a7${run_uuid:2}"
readonly correlation_role_retire="a8${run_uuid:2}"
readonly group_activity_id="b1${run_uuid:2}"
readonly role_activity_id="b2${run_uuid:2}"

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
  echo 'structural-reduction proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'structural-reduction proof captured invalid backend: %q\n' "$backend_pid" >&2
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
  echo 'structural-reduction proof did not observe the exact blocker' >&2
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

cleanup_fixture() {
  [ "$fixture_claimed" = 1 ] || return 0
  run_sql "
    begin;
    set local session_replication_role = replica;
    do \$proof\$
    begin
      if not exists (
        select 1 from vortex_identity.tenants
        where tenant_id = '$tenant_id' and short_name = '$fixture_short_name'
          and created_by = '$actor_id'
      ) or not exists (
        select 1 from vortex_identity.organizations
        where organization_id = '$organization_id' and tenant_id = '$tenant_id'
          and short_name = '$fixture_short_name' and created_by = '$actor_id'
      ) then
        raise exception 'structural-reduction proof fixture ownership mismatch';
      end if;
    end
    \$proof\$;
    delete from vortex_activity.organization_activity_entries where organization_id = '$organization_id';
    delete from vortex_access.organization_stewardship_requirements where organization_id = '$organization_id';
    delete from vortex_access.organization_delegation_authorities where organization_id = '$organization_id';
    delete from vortex_access.organization_role_activations where organization_id = '$organization_id';
    delete from vortex_access.organization_role_assignments where organization_id = '$organization_id';
    delete from vortex_access.organization_group_memberships where organization_id = '$organization_id';
    delete from vortex_access.organization_role_permission_entries where organization_id = '$organization_id';
    delete from vortex_access.organization_role_revisions where organization_id = '$organization_id';
    delete from vortex_access.organization_role_activation_policy_revisions where organization_id = '$organization_id';
    delete from vortex_access.organization_roles where organization_id = '$organization_id';
    delete from vortex_access.organization_groups where organization_id = '$organization_id';
    delete from vortex_access.permission_continuities where organization_id = '$organization_id';
    delete from vortex_access.permission_catalogue_entries where organization_id = '$organization_id';
    delete from vortex_access.permission_registrations where organization_id = '$organization_id';
    delete from vortex_access.permission_registration_revisions where organization_id = '$organization_id';
    delete from vortex_access.organization_access_versions where organization_id = '$organization_id';
    delete from vortex_identity.organization_accounts where organization_id = '$organization_id';
    delete from vortex_identity.identity_projections where identity_id in ('$identity_id','$member_identity_id');
    delete from vortex_identity.organizations where organization_id = '$organization_id';
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
  touch "$proof_root/group-holder-release" "$proof_root/role-holder-release"
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then
    echo 'structural-reduction proof failed; bounded diagnostics follow' >&2
    for log_path in "$proof_root"/*.log; do
      [ -f "$log_path" ] || continue
      printf '%s\n' "--- ${log_path##*/} ---" >&2
      tail -n 100 -- "$log_path" >&2
    done
  fi
  cleanup_fixture
  operation_status=$?
  if [ "$operation_status" -ne 0 ]; then cleanup_status="$operation_status"; fi
  case "$proof_root" in
    /tmp/vortex-structural-reduction.*) rm -rf -- "$proof_root"; operation_status=$? ;;
    *) echo 'refusing to remove unexpected structural-reduction proof directory' >&2; operation_status=1 ;;
  esac
  if [ "$operation_status" -ne 0 ] && [ "$cleanup_status" -eq 0 ]; then cleanup_status="$operation_status"; fi
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
  ) values ('$tenant_id','$fixture_short_name','Structural reduction proof','active',
    pg_catalog.clock_timestamp(),'$actor_id',pg_catalog.clock_timestamp(),1);
  insert into vortex_identity.organizations (
    organization_id, tenant_id, short_name, display_name, state,
    created_at, created_by, state_changed_at, revision
  ) values ('$organization_id','$tenant_id','$fixture_short_name',
    'Structural reduction proof','active',pg_catalog.clock_timestamp(),
    '$actor_id',pg_catalog.clock_timestamp(),1);
  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    ('$identity_id','active',pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),
      '$actor_id','$correlation_initialize',1),
    ('$member_identity_id','active',pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),
      '$actor_id','$correlation_initialize',1);
  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, activated_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    ('$account_id','$organization_id','$identity_id','Structural steward','active',
      pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),
      '$actor_id','$correlation_initialize',1),
    ('$member_account_id','$organization_id','$member_identity_id','Structural member','active',
      pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),
      '$actor_id','$correlation_initialize',1);
  select * from vortex_access.initialize_organization_access_version(
    '$organization_id','$actor_id','$correlation_initialize');
  select * from vortex_access.initialize_platform_permission_catalogue(
    '$organization_id','$actor_id','$correlation_initialize');
  insert into vortex_access.permission_continuities (
    organization_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id, state,
    continuity_revision, meaning_fingerprint,
    last_processed_registration_revision, changed_at
  ) select entry.organization_id,null,entry.owner_kind,entry.owner_id,
      entry.permission_id,'platform',entry.registration_owner_id,'available',1,
      entry.meaning_fingerprint,entry.registration_revision,pg_catalog.clock_timestamp()
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id='$organization_id' and entry.registration_kind='platform';
  select * from vortex_access.coordinate_organization_stewardship_adoption(
    '$organization_id','$account_id','$steward_role_id',
    'structural_steward_${run_token:0:16}','Structural steward',
    'Neutral authority for structural-reduction concurrency.',
    '$steward_assignment_id','$steward_delegation_id','$actor_id','$correlation_adopt');
  select * from vortex_access.coordinate_organization_group_change(
    'create_group','$organization_id','$group_id',null,
    'structural_group_${run_token:0:16}','Structural Group',
    '$actor_id','$correlation_group');
  set constraints all immediate;
  commit;
" >/dev/null
fixture_claimed=1

# A supported membership writer owns Access and waits on the Group. The protected
# retirement waits behind that writer, then rejects its stale request context.
before_group="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';")"
PGAPPNAME="vortex-structural-group-holder-${run_token:0:10}" "${psql_command[@]}" >"$proof_root/group-holder.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/group-holder.pid'
select 1 from vortex_access.organization_groups
where organization_id='$organization_id' and group_id='$group_id' for update;
\! touch '$proof_root/group-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/group-holder-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/group-holder-release' ]
commit;
SQL
group_holder=$!; worker_pids+=("$group_holder"); wait_for_file "$proof_root/group-holder-ready"
group_holder_db="$(read_backend_pid "$proof_root/group-holder.pid")"

PGAPPNAME="vortex-structural-membership-${run_token:0:10}" "${psql_command[@]}" >"$proof_root/membership-writer.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/membership-writer.pid'
select * from vortex_access.coordinate_organization_group_membership_change(
  'add_membership','$organization_id','$membership_id',null,'$group_id',
  '$member_account_id',pg_catalog.clock_timestamp(),null,null,
  '$actor_id','$correlation_membership');
commit;
SQL
membership_writer=$!; worker_pids+=("$membership_writer")
membership_writer_db="$(read_backend_pid "$proof_root/membership-writer.pid")"
wait_for_database_blocker "$membership_writer_db" "$group_holder_db"

PGAPPNAME="vortex-structural-group-retire-${run_token:0:10}" "${psql_command[@]}" >"$proof_root/group-retire.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/group-retire.pid'
set local role vortex_runtime;
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind','human','identityAuthorityId','$identity_authority_id','tenantId','$tenant_id',
  'organizationId','$organization_id','organizationAccountId','$account_id','identityId','$identity_id',
  'sessionId','$session_id','authenticationStrength','multi_factor',
  'issuedAt',pg_catalog.clock_timestamp(),'expiresAt',pg_catalog.clock_timestamp()+interval '5 minutes',
  'accessVersion',$before_group,'correlationId','$correlation_group_retire'));
set local role vortex_request;
select * from vortex_access.retire_organization_group_for_administration(
  '$group_id',1,'$group_activity_id');
commit;
SQL
group_retire=$!; worker_pids+=("$group_retire")
group_retire_db="$(read_backend_pid "$proof_root/group-retire.pid")"
wait_for_database_blocker "$group_retire_db" "$membership_writer_db"
touch "$proof_root/group-holder-release"
wait_owned_worker "$group_holder"
wait_owned_worker "$membership_writer"
if wait_owned_worker "$group_retire"; then echo 'stale Group retirement unexpectedly committed' >&2; exit 1; fi
grep -q '42501' "$proof_root/group-retire.log" || { echo 'stale Group retirement lacked 42501' >&2; exit 1; }
group_state="$(run_sql "select pg_catalog.concat_ws('|',version.current_version,organization_group.state,organization_group.revision,membership.state,membership.revision,(select count(*) from vortex_activity.organization_activity_entries where organization_id='$organization_id' and activity_id='$group_activity_id')) from vortex_access.organization_access_versions version join vortex_access.organization_groups organization_group on organization_group.organization_id=version.organization_id and organization_group.group_id='$group_id' join vortex_access.organization_group_memberships membership on membership.organization_id=version.organization_id and membership.membership_id='$membership_id' where version.organization_id='$organization_id';")"
[ "$group_state" = "$((before_group + 1))|active|1|live|1|0" ] || { printf 'membership/Group-retirement race left unexpected state: %q\n' "$group_state" >&2; exit 1; }

# The same governance order protects role retirement against a concurrent
# supported assignment grant without inventing another lock or authority path.
before_role="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';")"
PGAPPNAME="vortex-structural-role-holder-${run_token:0:10}" "${psql_command[@]}" >"$proof_root/role-holder.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/role-holder.pid'
select 1 from vortex_access.organization_roles
where organization_id='$organization_id' and role_id='$steward_role_id' for update;
\! touch '$proof_root/role-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/role-holder-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/role-holder-release' ]
commit;
SQL
role_holder=$!; worker_pids+=("$role_holder"); wait_for_file "$proof_root/role-holder-ready"
role_holder_db="$(read_backend_pid "$proof_root/role-holder.pid")"

PGAPPNAME="vortex-structural-assignment-${run_token:0:10}" "${psql_command[@]}" >"$proof_root/assignment-writer.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/assignment-writer.pid'
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant','$organization_id','$assignment_id',null,'$steward_role_id',1,
  'organization_account','$member_account_id',null,'standing',pg_catalog.clock_timestamp(),null,
  '$actor_id','$correlation_assignment');
commit;
SQL
assignment_writer=$!; worker_pids+=("$assignment_writer")
assignment_writer_db="$(read_backend_pid "$proof_root/assignment-writer.pid")"
wait_for_database_blocker "$assignment_writer_db" "$role_holder_db"

PGAPPNAME="vortex-structural-role-retire-${run_token:0:10}" "${psql_command[@]}" >"$proof_root/role-retire.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/role-retire.pid'
set local role vortex_runtime;
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind','human','identityAuthorityId','$identity_authority_id','tenantId','$tenant_id',
  'organizationId','$organization_id','organizationAccountId','$account_id','identityId','$identity_id',
  'sessionId','$session_id','authenticationStrength','multi_factor',
  'issuedAt',pg_catalog.clock_timestamp(),'expiresAt',pg_catalog.clock_timestamp()+interval '5 minutes',
  'accessVersion',$before_role,'correlationId','$correlation_role_retire'));
set local role vortex_request;
select * from vortex_access.retire_organization_role_for_administration(
  '$steward_role_id',1,
  pg_catalog.jsonb_build_object('contractVersion','1.0.0','candidate',
    pg_catalog.jsonb_build_object('operation','retire_role','organizationId','$organization_id',
      'roleId','$steward_role_id','expectedRoleRevision',1),
    'roleCandidateFingerprint','sha256:' || pg_catalog.repeat('8',64)),
  '$role_activity_id');
commit;
SQL
role_retire=$!; worker_pids+=("$role_retire")
role_retire_db="$(read_backend_pid "$proof_root/role-retire.pid")"
wait_for_database_blocker "$role_retire_db" "$assignment_writer_db"
touch "$proof_root/role-holder-release"
wait_owned_worker "$role_holder"
wait_owned_worker "$assignment_writer"
if wait_owned_worker "$role_retire"; then echo 'stale role retirement unexpectedly committed' >&2; exit 1; fi
grep -q '42501' "$proof_root/role-retire.log" || { echo 'stale role retirement lacked 42501' >&2; exit 1; }
role_state="$(run_sql "select pg_catalog.concat_ws('|',version.current_version,role.live_revision,revision.lifecycle,assignment.state,assignment.revision,(select count(*) from vortex_activity.organization_activity_entries where organization_id='$organization_id' and activity_id='$role_activity_id')) from vortex_access.organization_access_versions version join vortex_access.organization_roles role on role.organization_id=version.organization_id and role.role_id='$steward_role_id' join vortex_access.organization_role_revisions revision on revision.organization_id=role.organization_id and revision.role_id=role.role_id and revision.revision=role.live_revision join vortex_access.organization_role_assignments assignment on assignment.organization_id=version.organization_id and assignment.role_assignment_id='$assignment_id' where version.organization_id='$organization_id';")"
[ "$role_state" = "$((before_role + 1))|1|active|live|1|0" ] || { printf 'assignment/role-retirement race left unexpected state: %q\n' "$role_state" >&2; exit 1; }

echo 'organization structural Access reduction concurrency proof passed'
