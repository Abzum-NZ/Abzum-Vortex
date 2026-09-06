#!/usr/bin/env bash

set -euo pipefail

run_uuid="${VORTEX_ROLE_ACTIVATION_CHANGE_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the role-activation proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_ROLE_ACTIVATION_CHANGE_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_name_token="${run_token:0:20}"
readonly fixture_short_name="activation_${fixture_name_token}"
proof_root="$(mktemp -d /tmp/vortex-role-activation-change.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id="c1${run_uuid:2}"
readonly organization_id="c2${run_uuid:2}"
readonly identity_id="c3${run_uuid:2}"
readonly account_id="c4${run_uuid:2}"
readonly group_id="c5${run_uuid:2}"
readonly membership_id="c6${run_uuid:2}"
readonly role_id="c7${run_uuid:2}"
readonly policy_one_id="c8${run_uuid:2}"
readonly policy_two_id="c9${run_uuid:2}"
readonly policy_three_id="ca${run_uuid:2}"
readonly assignment_role_id="cb${run_uuid:2}"
readonly assignment_revoke_id="cc${run_uuid:2}"
readonly assignment_group_id="cd${run_uuid:2}"
readonly assignment_expiry_id="ce${run_uuid:2}"
readonly activation_role_first_id="d1${run_uuid:2}"
readonly activation_role_stale_id="d2${run_uuid:2}"
readonly activation_assignment_id="d3${run_uuid:2}"
readonly activation_membership_id="d4${run_uuid:2}"
readonly activation_expiry_id="d5${run_uuid:2}"
readonly actor_id="d9${run_uuid:2}"
readonly correlation_initialize="e0${run_uuid:2}"
readonly correlation_platform="e1${run_uuid:2}"
readonly correlation_r1_activation="e2${run_uuid:2}"
readonly correlation_r1_role="e3${run_uuid:2}"
readonly correlation_r2_role="e4${run_uuid:2}"
readonly correlation_r2_activation="e5${run_uuid:2}"
readonly correlation_r3_revoke="e6${run_uuid:2}"
readonly correlation_r3_activation="e7${run_uuid:2}"
readonly correlation_r4_remove="e8${run_uuid:2}"
readonly correlation_r4_activation="e9${run_uuid:2}"
readonly correlation_expiry_grant="ea${run_uuid:2}"
readonly correlation_expiry_activation="eb${run_uuid:2}"

fixture_claimed=0
declare -a worker_pids=()
declare -A reaped_worker_pids=()

psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then psql_command+=("$database_url"); fi

run_sql() { "${psql_command[@]}" --command "$1"; }

wait_for_file() {
  local candidate="$1"
  local deadline=$((SECONDS + 25))
  while ((SECONDS < deadline)); do
    [ -f "$candidate" ] && return 0
    sleep 0.05
  done
  echo 'role-activation proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'role-activation proof captured an invalid backend identifier: %q\n' "$backend_pid" >&2
    return 1
  }
  printf '%s\n' "$backend_pid"
}

wait_for_database_blocker() {
  local blocked_pid="$1"
  local blocking_pid="$2"
  local deadline=$((SECONDS + 25))
  local state
  while ((SECONDS < deadline)); do
    state="$(run_sql "select case when $blocking_pid = any(pg_catalog.pg_blocking_pids($blocked_pid)) then 'blocked' else '' end;")"
    [ "$state" = 'blocked' ] && return 0
    sleep 0.1
  done
  echo 'role-activation proof did not observe the required lock ordering' >&2
  return 1
}

wait_for_database_time() {
  local target="$1"
  local deadline=$((SECONDS + 20))
  local reached
  while ((SECONDS < deadline)); do
    reached="$(run_sql "select case when pg_catalog.clock_timestamp() >= '$target'::timestamptz then 'yes' else '' end;")"
    [ "$reached" = 'yes' ] && return 0
    sleep 0.05
  done
  echo 'role-activation proof did not reach the fixed source expiry' >&2
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
  echo 'role-activation proof failed; bounded owned worker diagnostics follow' >&2
  for log_path in "$proof_root"/*.log; do
    [ -f "$log_path" ] || continue
    printf '%s\n' "--- ${log_path##*/} (last 120 lines) ---" >&2
    tail -n 120 -- "$log_path" >&2
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
      ) or not exists (
        select 1 from vortex_identity.organization_accounts
        where organization_id = '$organization_id'
          and organization_account_id = '$account_id' and identity_id = '$identity_id'
      ) then
        raise exception 'Role-activation proof fixture ownership marker mismatch';
      end if;
    end
    \$proof\$;
    delete from vortex_access.organization_role_activations where organization_id = '$organization_id';
    delete from vortex_access.organization_role_assignments where organization_id = '$organization_id';
    delete from vortex_access.organization_group_memberships where organization_id = '$organization_id';
    delete from vortex_access.organization_groups where organization_id = '$organization_id';
    delete from vortex_access.organization_role_permission_entries where organization_id = '$organization_id';
    delete from vortex_access.organization_role_revisions where organization_id = '$organization_id';
    delete from vortex_access.organization_role_activation_policy_revisions where organization_id = '$organization_id';
    delete from vortex_access.organization_roles where organization_id = '$organization_id';
    delete from vortex_access.permission_continuities where organization_id = '$organization_id';
    delete from vortex_access.permission_catalogue_entries where organization_id = '$organization_id';
    delete from vortex_access.permission_registrations where organization_id = '$organization_id';
    delete from vortex_access.permission_registration_revisions where organization_id = '$organization_id';
    delete from vortex_access.organization_access_versions where organization_id = '$organization_id';
    delete from vortex_identity.organization_accounts where organization_id = '$organization_id';
    delete from vortex_identity.identity_projections where identity_id = '$identity_id';
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
  touch "$proof_root/r1-release" "$proof_root/r2-release" \
    "$proof_root/r3-release" "$proof_root/r4-release" "$proof_root/r5-release"
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then emit_owned_failure_diagnostics; fi
  cleanup_fixture
  operation_status=$?
  if [ "$operation_status" -ne 0 ]; then cleanup_status="$operation_status"; fi
  case "$proof_root" in
    /tmp/vortex-role-activation-change.*) rm -rf -- "$proof_root"; operation_status=$? ;;
    *) echo "refusing to remove unexpected proof directory: $proof_root" >&2; operation_status=1 ;;
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

"${psql_command[@]}" >/dev/null <<SQL
begin;
insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values ('$tenant_id', '$fixture_short_name', 'Role activation proof', 'active',
  pg_catalog.statement_timestamp(), '$actor_id', pg_catalog.statement_timestamp(), 1);
insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state, created_at,
  created_by, state_changed_at, revision
) values ('$organization_id', '$tenant_id', '$fixture_short_name',
  'Role activation proof', 'active', pg_catalog.statement_timestamp(),
  '$actor_id', pg_catalog.statement_timestamp(), 1);
insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values ('$identity_id', 'active', pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp(), '$actor_id', '$correlation_initialize', 1);
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values ('$account_id', '$organization_id', '$identity_id', 'Activation account',
  'active', pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp(), '$actor_id', '$correlation_initialize', 1);
select * from vortex_access.initialize_organization_access_version(
  '$organization_id', '$actor_id', '$correlation_initialize'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  '$organization_id', '$actor_id', '$correlation_platform'
);
insert into vortex_access.permission_continuities (
  organization_id, application_root_id, owner_kind, owner_id, permission_id,
  registration_kind, registration_owner_id, state, continuity_revision,
  meaning_fingerprint, last_processed_registration_revision, changed_at
)
select entry.organization_id, null, entry.owner_kind, entry.owner_id,
  entry.permission_id, entry.registration_kind, entry.registration_owner_id,
  'available', 1, entry.meaning_fingerprint, entry.registration_revision,
  pg_catalog.statement_timestamp()
from vortex_access.permission_catalogue_entries as entry
where entry.organization_id = '$organization_id'
  and entry.registration_kind = 'platform';
insert into vortex_access.organization_groups (
  organization_id, group_id, group_key, label, state, revision,
  created_by, created_at, changed_by, changed_at, change_correlation_id
) values ('$organization_id', '$group_id', 'activation_group', 'Activation Group',
  'active', 1, '$actor_id', pg_catalog.statement_timestamp(), '$actor_id',
  pg_catalog.statement_timestamp(), '$correlation_initialize');
insert into vortex_access.organization_group_memberships (
  organization_id, membership_id, group_id, organization_account_id, revision,
  starts_at, expires_at, state, granted_by, granted_at, grant_correlation_id,
  changed_by, changed_at, change_correlation_id
) values ('$organization_id', '$membership_id', '$group_id', '$account_id', 1,
  pg_catalog.statement_timestamp() - interval '1 hour', null, 'live', '$actor_id',
  pg_catalog.statement_timestamp() - interval '1 hour', '$correlation_initialize',
  '$actor_id', pg_catalog.statement_timestamp() - interval '1 hour',
  '$correlation_initialize');
insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, live_revision, created_by, created_at
) values ('$organization_id', '$role_id', 'custom', 'activation_role', 1,
  '$actor_id', pg_catalog.statement_timestamp());
insert into vortex_access.organization_role_activation_policy_revisions (
  organization_id, role_id, activation_policy_id, revision, policy_fingerprint,
  maximum_activation_duration_seconds, reason_required,
  authentication_requirement, authentication_maximum_age_seconds,
  independent_approval_required, changed_by, changed_at, change_correlation_id
) values ('$organization_id', '$role_id', '$policy_one_id', 1,
  'sha256:' || pg_catalog.repeat('1', 64), 600, false, 'none', null, false,
  '$actor_id', pg_catalog.statement_timestamp(), '$correlation_initialize');
insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  application_root_id, owner_kind, owner_id, permission_id, registration_kind,
  registration_owner_id, accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
)
select entry.organization_id, '$role_id', 1, 1, 'custom', null, entry.owner_kind,
  entry.owner_id, entry.permission_id, entry.registration_kind,
  entry.registration_owner_id, entry.registration_revision,
  registration.permission_catalogue_fingerprint, 1, entry.meaning_fingerprint
from vortex_access.permission_catalogue_entries as entry
join vortex_access.permission_registration_revisions as registration
  on registration.organization_id = entry.organization_id
  and registration.registration_kind = entry.registration_kind
  and registration.registration_owner_id = entry.registration_owner_id
  and registration.revision = entry.registration_revision
where entry.organization_id = '$organization_id'
  and entry.registration_kind = 'platform'
order by entry.permission_id limit 1;
insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, activation_policy_id,
  activation_policy_revision, activation_policy_fingerprint,
  role_key, label, description, changed_by, changed_at, change_correlation_id
) values ('$organization_id', '$role_id', 1, 'custom', 'active', 'privileged',
  'activation_required', 1, 1, '$policy_one_id', 1,
  'sha256:' || pg_catalog.repeat('1', 64), 'activation_role', 'Activation role',
  'Role activation concurrency fixture.', '$actor_id',
  pg_catalog.statement_timestamp(), '$correlation_initialize');
set constraints all immediate;
set constraints all deferred;
insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision, starts_at,
  expires_at, state, granted_by, granted_at, grant_correlation_id, changed_by,
  changed_at, change_correlation_id
) values
  ('$organization_id', '$assignment_role_id', '$role_id', 'organization_account',
   '$account_id', null, 'eligible', 1, pg_catalog.statement_timestamp() - interval '1 hour',
   null, 'live', '$actor_id', pg_catalog.statement_timestamp() - interval '1 hour',
   '$correlation_initialize', '$actor_id', pg_catalog.statement_timestamp() - interval '1 hour',
   '$correlation_initialize'),
  ('$organization_id', '$assignment_revoke_id', '$role_id', 'organization_account',
   '$account_id', null, 'eligible', 1, pg_catalog.statement_timestamp() - interval '1 hour',
   null, 'live', '$actor_id', pg_catalog.statement_timestamp() - interval '1 hour',
   '$correlation_initialize', '$actor_id', pg_catalog.statement_timestamp() - interval '1 hour',
   '$correlation_initialize'),
  ('$organization_id', '$assignment_group_id', '$role_id', 'group', null,
   '$group_id', 'eligible', 1, pg_catalog.statement_timestamp() - interval '1 hour',
   null, 'live', '$actor_id', pg_catalog.statement_timestamp() - interval '1 hour',
   '$correlation_initialize', '$actor_id', pg_catalog.statement_timestamp() - interval '1 hour',
   '$correlation_initialize');
set constraints all immediate;
commit;
SQL
fixture_claimed=1

role_change_two="pg_catalog.jsonb_build_object(
  'contractVersion','1.0.0','candidate',pg_catalog.jsonb_build_object(
    'operation','revise_metadata_policy','organizationId','$organization_id',
    'roleId','$role_id','expectedRoleRevision',1,'key','activation_role',
    'label','Activation role','description','Role activation concurrency fixture.',
    'privilegeClassification','privileged',
    'assignmentPolicy',pg_catalog.jsonb_build_object(
      'kind','activation_required','activationPolicy',pg_catalog.jsonb_build_object(
        'selection','new','policy',pg_catalog.jsonb_build_object(
          'activationPolicyId','$policy_two_id','revision',1,
          'maximumActivationDurationSeconds',500,'reasonRequired',false,
          'recentAuthentication',pg_catalog.jsonb_build_object('kind','none'),
          'independentApprovalRequired',false)))),
  'newActivationPolicyFingerprint','sha256:' || pg_catalog.repeat('2',64),
  'roleCandidateFingerprint','sha256:' || pg_catalog.repeat('3',64))"

role_change_three="pg_catalog.jsonb_build_object(
  'contractVersion','1.0.0','candidate',pg_catalog.jsonb_build_object(
    'operation','revise_metadata_policy','organizationId','$organization_id',
    'roleId','$role_id','expectedRoleRevision',2,'key','activation_role',
    'label','Activation role','description','Role activation concurrency fixture.',
    'privilegeClassification','privileged',
    'assignmentPolicy',pg_catalog.jsonb_build_object(
      'kind','activation_required','activationPolicy',pg_catalog.jsonb_build_object(
        'selection','new','policy',pg_catalog.jsonb_build_object(
          'activationPolicyId','$policy_three_id','revision',1,
          'maximumActivationDurationSeconds',400,'reasonRequired',false,
          'recentAuthentication',pg_catalog.jsonb_build_object('kind','none'),
          'independentApprovalRequired',false)))),
  'newActivationPolicyFingerprint','sha256:' || pg_catalog.repeat('4',64),
  'roleCandidateFingerprint','sha256:' || pg_catalog.repeat('5',64))"

# R1: activation owns governance first and waits for the role. Its reviewed
# policy remains historical evidence when a queued policy change commits next.
before_r1="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';")"
PGAPPNAME="vortex-role-activation-r1-holder-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r1-holder.log" 2>&1 <<SQL &
begin;
set lock_timeout = '30s';
set statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r1-holder.pid'
select 1 from vortex_access.organization_roles
where organization_id='$organization_id' and role_id='$role_id' for update;
\! touch '$proof_root/r1-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/r1-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/r1-release' ]
commit;
SQL
r1_holder=$!; worker_pids+=("$r1_holder"); wait_for_file "$proof_root/r1-holder-ready"
r1_holder_db="$(read_backend_pid "$proof_root/r1-holder.pid")"

PGAPPNAME="vortex-role-activation-r1-activation-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r1-activation.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r1-activation.pid'
select outcome, operation, access_version from vortex_access.coordinate_organization_role_activation_change(
  'activate_role','$organization_id','$activation_role_first_id',null,
  '$account_id','$role_id',1,300,'direct','$assignment_role_id',1,null,null,
  '$actor_id','$correlation_r1_activation');
commit;
SQL
r1_activation=$!; worker_pids+=("$r1_activation")
r1_activation_db="$(read_backend_pid "$proof_root/r1-activation.pid")"
wait_for_database_blocker "$r1_activation_db" "$r1_holder_db"

PGAPPNAME="vortex-role-activation-r1-role-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r1-role.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r1-role.pid'
select outcome, operation, access_version from vortex_access.coordinate_organization_role_change(
  $role_change_two,'$actor_id','$correlation_r1_role');
commit;
SQL
r1_role=$!; worker_pids+=("$r1_role")
r1_role_db="$(read_backend_pid "$proof_root/r1-role.pid")"
wait_for_database_blocker "$r1_role_db" "$r1_activation_db"
touch "$proof_root/r1-release"
wait_owned_worker "$r1_holder"; wait_owned_worker "$r1_activation"; wait_owned_worker "$r1_role"
r1_state="$(run_sql "select pg_catalog.concat_ws('|',version.current_version,role.live_revision,revision.policy_continuity_revision,activation.historical_role_revision,activation.policy_continuity_revision,activation.activation_policy_id,activation.state) from vortex_access.organization_access_versions version join vortex_access.organization_roles role on role.organization_id=version.organization_id and role.role_id='$role_id' join vortex_access.organization_role_revisions revision on revision.organization_id=role.organization_id and revision.role_id=role.role_id and revision.revision=role.live_revision join vortex_access.organization_role_activations activation on activation.organization_id=role.organization_id and activation.role_activation_id='$activation_role_first_id' where version.organization_id='$organization_id';")"
[ "$r1_state" = "$((before_r1 + 2))|2|2|1|1|$policy_one_id|live" ] || {
  printf 'activation-first policy race left unexpected state: %q\n' "$r1_state" >&2
  exit 1
}

# R2: the next policy change owns governance first. A request reviewed against
# revision two waits behind it and then refuses as stale.
before_r2="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';")"
PGAPPNAME="vortex-role-activation-r2-holder-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r2-holder.log" 2>&1 <<SQL &
begin;
set lock_timeout = '30s';
set statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-holder.pid'
select 1 from vortex_access.organization_roles
where organization_id='$organization_id' and role_id='$role_id' for update;
\! touch '$proof_root/r2-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/r2-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/r2-release' ]
commit;
SQL
r2_holder=$!; worker_pids+=("$r2_holder"); wait_for_file "$proof_root/r2-holder-ready"
r2_holder_db="$(read_backend_pid "$proof_root/r2-holder.pid")"

PGAPPNAME="vortex-role-activation-r2-role-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r2-role.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-role.pid'
select outcome, operation, access_version from vortex_access.coordinate_organization_role_change(
  $role_change_three,'$actor_id','$correlation_r2_role');
commit;
SQL
r2_role=$!; worker_pids+=("$r2_role")
r2_role_db="$(read_backend_pid "$proof_root/r2-role.pid")"
wait_for_database_blocker "$r2_role_db" "$r2_holder_db"

PGAPPNAME="vortex-role-activation-r2-activation-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r2-activation.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-activation.pid'
select * from vortex_access.coordinate_organization_role_activation_change(
  'activate_role','$organization_id','$activation_role_stale_id',null,
  '$account_id','$role_id',2,300,'direct','$assignment_role_id',1,null,null,
  '$actor_id','$correlation_r2_activation');
commit;
SQL
r2_activation=$!; worker_pids+=("$r2_activation")
r2_activation_db="$(read_backend_pid "$proof_root/r2-activation.pid")"
wait_for_database_blocker "$r2_activation_db" "$r2_role_db"
touch "$proof_root/r2-release"
wait_owned_worker "$r2_holder"; wait_owned_worker "$r2_role"
if wait_owned_worker "$r2_activation"; then
  echo 'policy-first stale activation unexpectedly committed' >&2
  exit 1
fi
grep -q '40001' "$proof_root/r2-activation.log" || {
  echo 'policy-first stale activation lacked 40001' >&2
  exit 1
}
r2_state="$(run_sql "select pg_catalog.concat_ws('|',version.current_version,role.live_revision,revision.policy_continuity_revision,(select count(*) from vortex_access.organization_role_activations where organization_id='$organization_id' and role_activation_id='$activation_role_stale_id')) from vortex_access.organization_access_versions version join vortex_access.organization_roles role on role.organization_id=version.organization_id and role.role_id='$role_id' join vortex_access.organization_role_revisions revision on revision.organization_id=role.organization_id and revision.role_id=role.role_id and revision.revision=role.live_revision where version.organization_id='$organization_id';")"
[ "$r2_state" = "$((before_r2 + 1))|3|3|0" ] || {
  printf 'policy-first race left unexpected state: %q\n' "$r2_state" >&2
  exit 1
}

# R3: eligibility revocation owns governance first and blocks on its fact. The
# activation then rechecks the current source revision and refuses.
before_r3="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';")"
PGAPPNAME="vortex-role-activation-r3-holder-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r3-holder.log" 2>&1 <<SQL &
begin;
set lock_timeout = '30s';
set statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r3-holder.pid'
select 1 from vortex_access.organization_role_assignments
where organization_id='$organization_id' and role_assignment_id='$assignment_revoke_id' for update;
\! touch '$proof_root/r3-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/r3-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/r3-release' ]
commit;
SQL
r3_holder=$!; worker_pids+=("$r3_holder"); wait_for_file "$proof_root/r3-holder-ready"
r3_holder_db="$(read_backend_pid "$proof_root/r3-holder.pid")"

PGAPPNAME="vortex-role-activation-r3-revoke-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r3-revoke.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r3-revoke.pid'
select outcome, operation, revision, access_version from vortex_access.coordinate_organization_role_assignment_change(
  'revoke','$organization_id','$assignment_revoke_id',1,null,null,null,null,null,null,null,null,
  '$actor_id','$correlation_r3_revoke');
commit;
SQL
r3_revoke=$!; worker_pids+=("$r3_revoke")
r3_revoke_db="$(read_backend_pid "$proof_root/r3-revoke.pid")"
wait_for_database_blocker "$r3_revoke_db" "$r3_holder_db"

PGAPPNAME="vortex-role-activation-r3-activation-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r3-activation.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r3-activation.pid'
select * from vortex_access.coordinate_organization_role_activation_change(
  'activate_role','$organization_id','$activation_assignment_id',null,
  '$account_id','$role_id',3,300,'direct','$assignment_revoke_id',1,null,null,
  '$actor_id','$correlation_r3_activation');
commit;
SQL
r3_activation=$!; worker_pids+=("$r3_activation")
r3_activation_db="$(read_backend_pid "$proof_root/r3-activation.pid")"
wait_for_database_blocker "$r3_activation_db" "$r3_revoke_db"
touch "$proof_root/r3-release"
wait_owned_worker "$r3_holder"; wait_owned_worker "$r3_revoke"
if wait_owned_worker "$r3_activation"; then
  echo 'revoked-eligibility activation unexpectedly committed' >&2
  exit 1
fi
grep -q '40001' "$proof_root/r3-activation.log" || {
  echo 'revoked-eligibility activation lacked 40001' >&2
  exit 1
}
r3_state="$(run_sql "select pg_catalog.concat_ws('|',version.current_version,assignment.state,assignment.revision,(select count(*) from vortex_access.organization_role_activations where organization_id='$organization_id' and role_activation_id='$activation_assignment_id')) from vortex_access.organization_access_versions version join vortex_access.organization_role_assignments assignment on assignment.organization_id=version.organization_id and assignment.role_assignment_id='$assignment_revoke_id' where version.organization_id='$organization_id';")"
[ "$r3_state" = "$((before_r3 + 1))|revoked|2|0" ] || {
  printf 'eligibility-revoke race left unexpected state: %q\n' "$r3_state" >&2
  exit 1
}

# R4: membership removal similarly owns governance first. Group-derived
# activation must not fall back to the still-live Group assignment.
before_r4="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';")"
PGAPPNAME="vortex-role-activation-r4-holder-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r4-holder.log" 2>&1 <<SQL &
begin;
set lock_timeout = '30s';
set statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r4-holder.pid'
select 1 from vortex_access.organization_group_memberships
where organization_id='$organization_id' and membership_id='$membership_id' for update;
\! touch '$proof_root/r4-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/r4-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/r4-release' ]
commit;
SQL
r4_holder=$!; worker_pids+=("$r4_holder"); wait_for_file "$proof_root/r4-holder-ready"
r4_holder_db="$(read_backend_pid "$proof_root/r4-holder.pid")"

PGAPPNAME="vortex-role-activation-r4-remove-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r4-remove.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r4-remove.pid'
select outcome, operation, access_version from vortex_access.coordinate_organization_group_membership_change(
  'remove_membership','$organization_id','$membership_id',1,null,null,null,null,null,
  '$actor_id','$correlation_r4_remove');
commit;
SQL
r4_remove=$!; worker_pids+=("$r4_remove")
r4_remove_db="$(read_backend_pid "$proof_root/r4-remove.pid")"
wait_for_database_blocker "$r4_remove_db" "$r4_holder_db"

PGAPPNAME="vortex-role-activation-r4-activation-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r4-activation.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r4-activation.pid'
select * from vortex_access.coordinate_organization_role_activation_change(
  'activate_role','$organization_id','$activation_membership_id',null,
  '$account_id','$role_id',3,300,'group','$assignment_group_id',1,'$membership_id',1,
  '$actor_id','$correlation_r4_activation');
commit;
SQL
r4_activation=$!; worker_pids+=("$r4_activation")
r4_activation_db="$(read_backend_pid "$proof_root/r4-activation.pid")"
wait_for_database_blocker "$r4_activation_db" "$r4_remove_db"
touch "$proof_root/r4-release"
wait_owned_worker "$r4_holder"; wait_owned_worker "$r4_remove"
if wait_owned_worker "$r4_activation"; then
  echo 'removed-membership activation unexpectedly committed' >&2
  exit 1
fi
grep -q '40001' "$proof_root/r4-activation.log" || {
  echo 'removed-membership activation lacked 40001' >&2
  exit 1
}
r4_state="$(run_sql "select pg_catalog.concat_ws('|',version.current_version,membership.state,membership.revision,(select count(*) from vortex_access.organization_role_activations where organization_id='$organization_id' and role_activation_id='$activation_membership_id')) from vortex_access.organization_access_versions version join vortex_access.organization_group_memberships membership on membership.organization_id=version.organization_id and membership.membership_id='$membership_id' where version.organization_id='$organization_id';")"
[ "$r4_state" = "$((before_r4 + 1))|revoked|2|0" ] || {
  printf 'membership-remove race left unexpected state: %q\n' "$r4_state" >&2
  exit 1
}

# R5: a valid source expires while activation waits behind the governance lock.
# The request must use post-lock observation time and leave Access unchanged.
before_r5="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';")"
PGAPPNAME="vortex-role-activation-r5-holder-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r5-holder.log" 2>&1 <<SQL &
begin;
set lock_timeout = '30s';
set statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r5-holder.pid'
select 1 from vortex_access.organization_access_versions
where organization_id='$organization_id' for update;
\! touch '$proof_root/r5-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/r5-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/r5-release' ]
commit;
SQL
r5_holder=$!; worker_pids+=("$r5_holder"); wait_for_file "$proof_root/r5-holder-ready"
r5_holder_db="$(read_backend_pid "$proof_root/r5-holder.pid")"
expiry_target="$(run_sql "select pg_catalog.clock_timestamp() + interval '15 seconds';")"
run_sql "
  with operation_time as (
    select pg_catalog.clock_timestamp() as value
  )
  insert into vortex_access.organization_role_assignments (
    organization_id, role_assignment_id, role_id, assignee_kind,
    organization_account_id, group_id, assignment_kind, revision, starts_at,
    expires_at, state, granted_by, granted_at, grant_correlation_id, changed_by,
    changed_at, change_correlation_id
  )
  select '$organization_id', '$assignment_expiry_id', '$role_id',
    'organization_account', '$account_id', null, 'eligible', 1, observed.value,
    '$expiry_target'::timestamptz, 'live', '$actor_id', observed.value,
    '$correlation_expiry_grant', '$actor_id', observed.value,
    '$correlation_expiry_grant'
  from operation_time as observed;
" >/dev/null

PGAPPNAME="vortex-role-activation-r5-activation-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r5-activation.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r5-activation.pid'
select * from vortex_access.coordinate_organization_role_activation_change(
  'activate_role','$organization_id','$activation_expiry_id',null,
  '$account_id','$role_id',3,300,'direct','$assignment_expiry_id',1,null,null,
  '$actor_id','$correlation_expiry_activation');
commit;
SQL
r5_activation=$!; worker_pids+=("$r5_activation")
r5_activation_db="$(read_backend_pid "$proof_root/r5-activation.pid")"
wait_for_database_blocker "$r5_activation_db" "$r5_holder_db"
[ "$(run_sql "select case when pg_catalog.clock_timestamp() < '$expiry_target'::timestamptz then 'pending' else '' end;")" = 'pending' ] || {
  echo 'activation source expired before its exact governance lock wait was observed' >&2
  exit 1
}
wait_for_database_time "$expiry_target"
touch "$proof_root/r5-release"
wait_owned_worker "$r5_holder"
if wait_owned_worker "$r5_activation"; then
  echo 'post-lock expired-source activation unexpectedly committed' >&2
  exit 1
fi
grep -q '40001' "$proof_root/r5-activation.log" || {
  echo 'post-lock expired-source activation lacked 40001' >&2
  exit 1
}
r5_state="$(run_sql "select pg_catalog.concat_ws('|',version.current_version,assignment.state,assignment.revision,(assignment.expires_at <= pg_catalog.clock_timestamp()),(select count(*) from vortex_access.organization_role_activations where organization_id='$organization_id' and role_activation_id='$activation_expiry_id')) from vortex_access.organization_access_versions version join vortex_access.organization_role_assignments assignment on assignment.organization_id=version.organization_id and assignment.role_assignment_id='$assignment_expiry_id' where version.organization_id='$organization_id';")"
[ "$r5_state" = "$before_r5|live|1|t|0" ] || {
  printf 'expiry-during-governance race left unexpected state: %q\n' "$r5_state" >&2
  exit 1
}

echo 'organization role activation concurrency proof passed'
