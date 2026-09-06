#!/usr/bin/env bash

set -euo pipefail

run_uuid="${VORTEX_MANAGEMENT_APPLICATION_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the management-application proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_MANAGEMENT_APPLICATION_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_name_token="${run_token:0:24}"
readonly fixture_short_name="management_${fixture_name_token}"
proof_root="$(mktemp -d /tmp/vortex-management-application.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id="c1${run_uuid:2}"
readonly organization_id="c2${run_uuid:2}"
readonly identity_id="c3${run_uuid:2}"
readonly account_id="c4${run_uuid:2}"
readonly steward_role_id="c5${run_uuid:2}"
readonly steward_assignment_id="c6${run_uuid:2}"
readonly steward_delegation_id="c7${run_uuid:2}"
readonly application_a_id="c8${run_uuid:2}"
readonly application_b_id="c9${run_uuid:2}"
readonly source_role_a_id="ca${run_uuid:2}"
readonly source_role_b_id="cb${run_uuid:2}"
readonly role_a_id="cc${run_uuid:2}"
readonly role_b_id="cd${run_uuid:2}"
readonly permission_a_id="ce${run_uuid:2}"
readonly permission_b_id="cf${run_uuid:2}"
readonly assignment_a_id="d1${run_uuid:2}"
readonly assignment_b_id="d2${run_uuid:2}"
readonly actor_id="d3${run_uuid:2}"
readonly correlation_initialize="d4${run_uuid:2}"
readonly correlation_catalogue="d5${run_uuid:2}"
readonly correlation_adopt="d6${run_uuid:2}"
readonly correlation_activate_a="d7${run_uuid:2}"
readonly correlation_withdraw_a="d8${run_uuid:2}"
readonly correlation_withdraw_b="d9${run_uuid:2}"
readonly correlation_replace_b="da${run_uuid:2}"

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
  echo 'management-application proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'management-application proof captured an invalid backend identifier: %q\n' "$backend_pid" >&2
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
  echo 'management-application proof did not observe the required governance lock' >&2
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
  echo 'management-application proof failed; bounded owned worker diagnostics follow' >&2
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
        select 1 from vortex_access.organization_stewardship_requirements
        where organization_id = '$organization_id'
          and original_organization_account_id = '$account_id'
          and original_role_id = '$steward_role_id'
          and original_role_assignment_id = '$steward_assignment_id'
          and original_delegation_authority_id = '$steward_delegation_id'
          and adopted_by = '$actor_id'
          and adoption_correlation_id = '$correlation_adopt'
      ) or 2 <> (
        select pg_catalog.count(*) from vortex_access.permission_registrations
        where organization_id = '$organization_id'
          and registration_kind = 'application'
          and registration_owner_id in ('$application_a_id', '$application_b_id')
      ) then
        raise exception 'Management-application proof fixture ownership marker mismatch';
      end if;
    end
    \$proof\$;
    delete from vortex_access.organization_stewardship_requirements
      where organization_id = '$organization_id';
    delete from vortex_access.organization_role_activations
      where organization_id = '$organization_id';
    delete from vortex_access.organization_delegation_authorities
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
    delete from vortex_access.application_role_template_continuities
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
  touch "$proof_root/activate-a-release" "$proof_root/withdraw-b-release"
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then emit_owned_failure_diagnostics; fi
  cleanup_fixture
  operation_status=$?
  if [ "$operation_status" -ne 0 ]; then cleanup_status="$operation_status"; fi
  case "$proof_root" in
    /tmp/vortex-management-application.*) rm -rf -- "$proof_root"; operation_status=$? ;;
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

run_sql "
  begin;
  do \$proof\$
  begin
    if exists (select 1 from vortex_identity.tenants where tenant_id = '$tenant_id')
      or exists (select 1 from vortex_identity.organizations where organization_id = '$organization_id')
      or exists (select 1 from vortex_access.organization_access_versions where organization_id = '$organization_id')
      or exists (select 1 from vortex_access.organization_roles where organization_id = '$organization_id')
      or exists (select 1 from vortex_access.permission_registrations where organization_id = '$organization_id') then
      raise exception 'Management-application proof fixture scope already exists';
    end if;
  end
  \$proof\$;

  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', '$fixture_short_name', 'Management application proof', 'active',
    pg_catalog.clock_timestamp(), '$actor_id', pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, short_name, display_name, state,
    created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', '$fixture_short_name',
    'Management application proof', 'active', pg_catalog.clock_timestamp(),
    '$actor_id', pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '$identity_id', 'active', pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '$actor_id', '$correlation_initialize', 1
  );
  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, activated_at, suspended_at, changed_at, state_changed_at,
    state_changed_by, state_change_correlation_id, revision
  ) values (
    '$account_id', '$organization_id', '$identity_id', 'Management steward',
    'active', pg_catalog.clock_timestamp(), null, pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '$actor_id', '$correlation_initialize', 1
  );
  select * from vortex_access.initialize_organization_access_version(
    '$organization_id', '$actor_id', '$correlation_initialize'
  );
  select * from vortex_access.initialize_platform_permission_catalogue(
    '$organization_id', '$actor_id', '$correlation_catalogue'
  );
  select * from vortex_access.coordinate_organization_stewardship_adoption(
    '$organization_id', '$account_id', '$steward_role_id',
    'organization_steward', 'Organisation steward',
    'Permanent minimum organisation administration.',
    '$steward_assignment_id', '$steward_delegation_id', '$actor_id',
    '$correlation_adopt'
  );

  create function pg_temp.seed_management_application(
    p_application_root_id uuid, p_source_role_id uuid, p_role_id uuid,
    p_permission_id uuid, p_assignment_id uuid, p_definition_key text,
    p_role_key text, p_fingerprint_character text
  ) returns void language plpgsql volatile set search_path = '' as \$seed\$
  declare operation_at timestamptz := pg_catalog.clock_timestamp();
  begin
    insert into vortex_access.permission_registration_revisions (
      organization_id, registration_kind, registration_owner_id, revision,
      state, operation, source_definition_key, source_version, source_revision,
      validation_contract_version, source_content_fingerprint,
      source_resolution_fingerprint, permission_catalogue_fingerprint,
      candidate_fingerprint, changed_at, changed_by, change_correlation_id
    ) values (
      '$organization_id', 'application', p_application_root_id, 1, 'active',
      'register', p_definition_key, '1.0.0', 1, '1.0.0',
      'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64),
      'sha256:' || pg_catalog.repeat('1', 64),
      'sha256:' || pg_catalog.repeat('2', 64),
      'sha256:' || pg_catalog.repeat('3', 64), operation_at, '$actor_id',
      '$correlation_initialize'
    );
    insert into vortex_access.permission_registrations (
      organization_id, registration_kind, registration_owner_id, state,
      revision, source_definition_key, source_version, source_revision,
      validation_contract_version, source_content_fingerprint,
      source_resolution_fingerprint, permission_catalogue_fingerprint,
      candidate_fingerprint, changed_at, changed_by, change_correlation_id
    ) values (
      '$organization_id', 'application', p_application_root_id, 'active', 1,
      p_definition_key, '1.0.0', 1, '1.0.0',
      'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64),
      'sha256:' || pg_catalog.repeat('1', 64),
      'sha256:' || pg_catalog.repeat('2', 64),
      'sha256:' || pg_catalog.repeat('3', 64), operation_at, '$actor_id',
      '$correlation_initialize'
    );
    insert into vortex_access.permission_catalogue_entries (
      organization_id, registration_kind, registration_owner_id,
      registration_revision, application_root_id, owner_kind, owner_id,
      permission_id, permission_key, label, description, record_type_id,
      action_kind, named_action, administrative, source_kind,
      source_definition_key, source_root_id, source_version, source_revision,
      source_validation_contract_version, source_content_fingerprint,
      source_resolution_fingerprint, source_catalogue_fingerprint,
      meaning_fingerprint
    ) values (
      '$organization_id', 'application', p_application_root_id, 1,
      p_application_root_id, 'application', p_application_root_id,
      p_permission_id, p_definition_key || '.records.read', 'View records',
      'View records in the management concurrency fixture.', null, 'read', null,
      false, 'application', p_definition_key, p_application_root_id,
      '1.0.0', 1, '1.0.0',
      'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64),
      'sha256:' || pg_catalog.repeat('1', 64), null,
      'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64)
    );
    insert into vortex_access.permission_continuities (
      organization_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id, state,
      continuity_revision, meaning_fingerprint,
      last_processed_registration_revision, changed_at
    ) values (
      '$organization_id', p_application_root_id, 'application',
      p_application_root_id, p_permission_id, 'application',
      p_application_root_id, 'available', 1,
      'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64), 1,
      operation_at
    );
    insert into vortex_access.application_role_template_continuities (
      organization_id, application_root_id, source_role_id, state,
      continuity_revision, source_template_fingerprint,
      last_processed_registration_revision, changed_at
    ) values (
      '$organization_id', p_application_root_id, p_source_role_id, 'available',
      1, 'sha256:' || pg_catalog.repeat('4', 64), 1, operation_at
    );
    insert into vortex_access.organization_roles (
      organization_id, role_id, role_kind, role_key, application_root_id,
      source_role_id, live_revision, created_by, created_at
    ) values (
      '$organization_id', p_role_id, 'application', p_role_key,
      p_application_root_id, p_source_role_id, 1, '$actor_id', operation_at
    );
    insert into vortex_access.organization_role_permission_entries (
      organization_id, role_id, role_revision, entry_ordinal, role_kind,
      role_application_root_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id,
      accepted_registration_revision, catalogue_fingerprint,
      continuity_revision, meaning_fingerprint
    ) values (
      '$organization_id', p_role_id, 1, 1, 'application', p_application_root_id,
      p_application_root_id, 'application', p_application_root_id,
      p_permission_id, 'application', p_application_root_id, 1,
      'sha256:' || pg_catalog.repeat('2', 64), 1,
      'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64)
    );
    insert into vortex_access.organization_role_revisions (
      organization_id, role_id, revision, role_kind, application_root_id,
      lifecycle, privilege_classification, assignment_policy,
      policy_continuity_revision, authority_continuity_revision,
      role_key, label, description, source_definition_key,
      source_release_revision, source_release_version,
      source_validation_contract_version, source_content_fingerprint,
      source_resolution_fingerprint, source_template_fingerprint,
      source_catalogue_fingerprint, accepted_registration_revision,
      template_continuity_revision, accepted_grant_fingerprint,
      changed_by, changed_at, change_correlation_id
    ) values (
      '$organization_id', p_role_id, 1, 'application', p_application_root_id,
      'active', 'standard', 'standing', 1, 1, p_role_key,
      'Management application role',
      'A neutral accepted standing application role.', p_definition_key,
      1, '1.0.0', '1.0.0',
      'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64),
      'sha256:' || pg_catalog.repeat('1', 64),
      'sha256:' || pg_catalog.repeat('4', 64),
      'sha256:' || pg_catalog.repeat('2', 64), 1, 1,
      'sha256:' || pg_catalog.repeat('5', 64), '$actor_id', operation_at,
      '$correlation_initialize'
    );
    insert into vortex_access.organization_role_assignments (
      organization_id, role_assignment_id, role_id, assignee_kind,
      organization_account_id, group_id, assignment_kind, revision,
      starts_at, expires_at, state, granted_by, granted_at,
      grant_correlation_id, changed_by, changed_at, change_correlation_id
    ) values (
      '$organization_id', p_assignment_id, p_role_id, 'organization_account',
      '$account_id', null, 'standing', 1, operation_at - interval '1 minute',
      null, 'live', '$actor_id', operation_at, '$correlation_initialize',
      '$actor_id', operation_at, '$correlation_initialize'
    );
  end
  \$seed\$;

  select pg_temp.seed_management_application(
    '$application_a_id', '$source_role_a_id', '$role_a_id', '$permission_a_id',
    '$assignment_a_id', 'proof.management_a', 'management_a', 'a'
  );
  select pg_temp.seed_management_application(
    '$application_b_id', '$source_role_b_id', '$role_b_id', '$permission_b_id',
    '$assignment_b_id', 'proof.management_b', 'management_b', 'b'
  );
  set constraints all immediate;
  commit;
" >/dev/null
fixture_claimed=1

baseline_access="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id = '$organization_id';")"
[[ "$baseline_access" =~ ^[1-9][0-9]*$ ]] || {
  echo 'management-application proof could not read its baseline Access version' >&2
  exit 1
}
access_after_activation=$((baseline_access + 1))
access_after_withdraw_b=$((baseline_access + 2))

# D2 activation completes inside its transaction and deliberately retains the
# governance lock. The real B2 withdrawal must wait, then recheck and refuse
# removing the newly bound final management application.
PGAPPNAME="vortex-management-activate-a-$fixture_name_token" "${psql_command[@]}" >"$proof_root/activate-a.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/activate-a.pid'
select outcome, operation, requirement ->> 'revision', access_version
from vortex_access.coordinate_organization_management_application_requirement(
  'activate_management_application_requirement', '$organization_id', 1,
  '$application_a_id', '$role_a_id', 1, '$actor_id', '$correlation_activate_a'
);
\! touch '$proof_root/activate-a-ready'
\! deadline=600; while [ ! -f '$proof_root/activate-a-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/activate-a-release' ]
commit;
SQL
activate_a_pid=$!; worker_pids+=("$activate_a_pid")
wait_for_file "$proof_root/activate-a-ready"
activate_a_db="$(read_backend_pid "$proof_root/activate-a.pid")"

PGAPPNAME="vortex-management-withdraw-a-$fixture_name_token" "${psql_command[@]}" >"$proof_root/withdraw-a.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/withdraw-a.pid'
select outcome, operation, registration_state, registration_revision, access_version
from vortex_access.coordinate_application_access_change(
  'withdraw', 1, null, '$organization_id', '$application_a_id',
  '$actor_id', '$correlation_withdraw_a'
);
commit;
SQL
withdraw_a_pid=$!; worker_pids+=("$withdraw_a_pid")
withdraw_a_db="$(read_backend_pid "$proof_root/withdraw-a.pid")"
wait_for_database_blocker "$withdraw_a_db" "$activate_a_db"
touch "$proof_root/activate-a-release"

wait_owned_worker "$activate_a_pid"
if wait_owned_worker "$withdraw_a_pid"; then
  echo 'the bound application withdrawal unexpectedly committed' >&2
  exit 1
fi
grep -Fq "changed|activate_management_application_requirement|2|$access_after_activation" "$proof_root/activate-a.log" || {
  echo 'management application activation did not return its exact result' >&2
  exit 1
}
grep -q '23514' "$proof_root/withdraw-a.log" || {
  echo 'the bound application withdrawal lacked final-condition refusal evidence' >&2
  exit 1
}

r1_state="$(run_sql "
  select pg_catalog.concat_ws('|', version.current_version,
    requirement.revision, requirement.management_application_root_id,
    requirement.management_role_id, requirement.management_required_role_revision,
    registration.state, registration.revision, role.live_revision,
    role_revision.lifecycle,
    vortex_access.organization_has_permanent_steward(
      requirement.organization_id, pg_catalog.clock_timestamp()
    ))
  from vortex_access.organization_stewardship_requirements as requirement
  join vortex_access.organization_access_versions as version
    on version.organization_id = requirement.organization_id
  join vortex_access.permission_registrations as registration
    on registration.organization_id = requirement.organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = '$application_a_id'
  join vortex_access.organization_roles as role
    on role.organization_id = requirement.organization_id
    and role.role_id = '$role_a_id'
  join vortex_access.organization_role_revisions as role_revision
    on role_revision.organization_id = role.organization_id
    and role_revision.role_id = role.role_id
    and role_revision.revision = role.live_revision
  where requirement.organization_id = '$organization_id';
")"
[ "$r1_state" = "$access_after_activation|2|$application_a_id|$role_a_id|1|active|1|1|active|t" ] || {
  echo "activation-first race left unexpected exact state: $r1_state" >&2
  exit 1
}

# A real B2 withdrawal of unbound application B completes but retains the
# governance lock. Replacement waits on that exact backend, then must reject
# its stale/unavailable target without disturbing the still-usable A binding.
PGAPPNAME="vortex-management-withdraw-b-$fixture_name_token" "${psql_command[@]}" >"$proof_root/withdraw-b.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/withdraw-b.pid'
select outcome, operation, registration_state, registration_revision, access_version
from vortex_access.coordinate_application_access_change(
  'withdraw', 1, null, '$organization_id', '$application_b_id',
  '$actor_id', '$correlation_withdraw_b'
);
\! touch '$proof_root/withdraw-b-ready'
\! deadline=600; while [ ! -f '$proof_root/withdraw-b-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/withdraw-b-release' ]
commit;
SQL
withdraw_b_pid=$!; worker_pids+=("$withdraw_b_pid")
wait_for_file "$proof_root/withdraw-b-ready"
withdraw_b_db="$(read_backend_pid "$proof_root/withdraw-b.pid")"

PGAPPNAME="vortex-management-replace-b-$fixture_name_token" "${psql_command[@]}" >"$proof_root/replace-b.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/replace-b.pid'
select outcome, operation, requirement ->> 'revision', access_version
from vortex_access.coordinate_organization_management_application_requirement(
  'replace_management_application_requirement', '$organization_id', 2,
  '$application_b_id', '$role_b_id', 1, '$actor_id', '$correlation_replace_b'
);
commit;
SQL
replace_b_pid=$!; worker_pids+=("$replace_b_pid")
replace_b_db="$(read_backend_pid "$proof_root/replace-b.pid")"
wait_for_database_blocker "$replace_b_db" "$withdraw_b_db"
touch "$proof_root/withdraw-b-release"

wait_owned_worker "$withdraw_b_pid"
if wait_owned_worker "$replace_b_pid"; then
  echo 'replacement with the concurrently withdrawn application unexpectedly committed' >&2
  exit 1
fi
grep -Fq "changed|withdraw|withdrawn|2|$access_after_withdraw_b" "$proof_root/withdraw-b.log" || {
  echo 'the unbound application withdrawal did not return its exact result' >&2
  exit 1
}
grep -q '40001' "$proof_root/replace-b.log" || {
  echo 'the stale management application replacement lacked refusal evidence' >&2
  exit 1
}

final_state="$(run_sql "
  select pg_catalog.concat_ws('|', version.current_version,
    requirement.revision, requirement.management_application_root_id,
    requirement.management_role_id, requirement.management_required_role_revision,
    registration_a.state, registration_a.revision,
    registration_b.state, registration_b.revision,
    role_a.live_revision, revision_a.lifecycle,
    role_b.live_revision, revision_b.lifecycle,
    assignment_a.state, assignment_b.state,
    vortex_access.organization_has_permanent_steward(
      requirement.organization_id, pg_catalog.clock_timestamp()
    ))
  from vortex_access.organization_stewardship_requirements as requirement
  join vortex_access.organization_access_versions as version
    on version.organization_id = requirement.organization_id
  join vortex_access.permission_registrations as registration_a
    on registration_a.organization_id = requirement.organization_id
    and registration_a.registration_kind = 'application'
    and registration_a.registration_owner_id = '$application_a_id'
  join vortex_access.permission_registrations as registration_b
    on registration_b.organization_id = requirement.organization_id
    and registration_b.registration_kind = 'application'
    and registration_b.registration_owner_id = '$application_b_id'
  join vortex_access.organization_roles as role_a
    on role_a.organization_id = requirement.organization_id and role_a.role_id = '$role_a_id'
  join vortex_access.organization_role_revisions as revision_a
    on revision_a.organization_id = role_a.organization_id
    and revision_a.role_id = role_a.role_id and revision_a.revision = role_a.live_revision
  join vortex_access.organization_roles as role_b
    on role_b.organization_id = requirement.organization_id and role_b.role_id = '$role_b_id'
  join vortex_access.organization_role_revisions as revision_b
    on revision_b.organization_id = role_b.organization_id
    and revision_b.role_id = role_b.role_id and revision_b.revision = role_b.live_revision
  join vortex_access.organization_role_assignments as assignment_a
    on assignment_a.organization_id = requirement.organization_id
    and assignment_a.role_assignment_id = '$assignment_a_id'
  join vortex_access.organization_role_assignments as assignment_b
    on assignment_b.organization_id = requirement.organization_id
    and assignment_b.role_assignment_id = '$assignment_b_id'
  where requirement.organization_id = '$organization_id';
")"
[ "$final_state" = "$access_after_withdraw_b|2|$application_a_id|$role_a_id|1|active|1|withdrawn|2|1|active|2|unavailable|live|live|t" ] || {
  echo "withdrawal-first race left unexpected exact state: $final_state" >&2
  exit 1
}

echo 'organization management application concurrency proof passed'
