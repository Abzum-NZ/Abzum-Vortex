#!/usr/bin/env bash

set -euo pipefail

run_uuid="${VORTEX_PERMISSION_ELIGIBILITY_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the permission-eligibility proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_PERMISSION_ELIGIBILITY_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_short_name="eligibility_${run_token:0:20}"
proof_root="$(mktemp -d /tmp/vortex-permission-eligibility.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id="19${run_uuid:2}"
readonly organization_id="29${run_uuid:2}"
readonly application_a_id="31${run_uuid:2}"
readonly application_b_id="32${run_uuid:2}"
readonly application_c_id="33${run_uuid:2}"
readonly identity_id="49${run_uuid:2}"
readonly account_id="59${run_uuid:2}"
readonly permission_a_id="41${run_uuid:2}"
readonly permission_b_id="42${run_uuid:2}"
readonly permission_c_id="43${run_uuid:2}"
readonly role_a_id="61${run_uuid:2}"
readonly role_b_id="62${run_uuid:2}"
readonly role_c_id="63${run_uuid:2}"
readonly assignment_a_id="71${run_uuid:2}"
readonly assignment_b_id="72${run_uuid:2}"
readonly assignment_c_id="73${run_uuid:2}"
readonly identity_authority_id="89${run_uuid:2}"
readonly session_id="69${run_uuid:2}"
readonly correlation_seed="a1${run_uuid:2}"
readonly correlation_r1_reader="a2${run_uuid:2}"
readonly correlation_r1_writer="a3${run_uuid:2}"
readonly correlation_r1_next="a4${run_uuid:2}"
readonly correlation_r2_writer="a5${run_uuid:2}"
readonly correlation_r2_reader="a6${run_uuid:2}"

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
  echo 'permission-eligibility proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'permission-eligibility proof captured an invalid backend identifier: %q\n' "$backend_pid" >&2
    return 1
  }
  printf '%s\n' "$backend_pid"
}

wait_for_database_blocker() {
  local blocked_pid="$1"
  local blocking_pid="$2"
  local description="$3"
  local deadline=$((SECONDS + 25))
  local state
  while ((SECONDS < deadline)); do
    state="$(run_sql "select case when $blocking_pid = any(pg_catalog.pg_blocking_pids($blocked_pid)) then 'blocked' else '' end;")"
    [ "$state" = 'blocked' ] && return 0
    sleep 0.1
  done
  echo "permission-eligibility proof did not observe $description" >&2
  return 1
}

wait_for_database_time() {
  local deadline_epoch="$1"
  local deadline=$((SECONDS + 30))
  local reached
  while ((SECONDS < deadline)); do
    reached="$(run_sql "select case when pg_catalog.clock_timestamp() >= pg_catalog.to_timestamp($deadline_epoch) then 'reached' else '' end;")"
    [ "$reached" = 'reached' ] && return 0
    sleep 0.1
  done
  echo 'permission-eligibility proof did not cross its bounded fact deadline' >&2
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
  echo 'permission-eligibility proof failed; bounded owned worker diagnostics follow' >&2
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
          and created_by = '$account_id'
      ) or not exists (
        select 1 from vortex_identity.organizations
        where organization_id = '$organization_id'
          and tenant_id = '$tenant_id'
          and short_name = '$fixture_short_name'
          and created_by = '$account_id'
      ) or not exists (
        select 1 from vortex_identity.organization_accounts
        where organization_account_id = '$account_id'
          and organization_id = '$organization_id'
          and identity_id = '$identity_id'
      ) then
        raise exception 'Permission-eligibility proof fixture ownership marker mismatch';
      end if;
    end
    \$proof\$;
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
  touch "$proof_root/r1-reader-release" "$proof_root/r2-holder-release"
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then emit_owned_failure_diagnostics; fi
  cleanup_fixture
  operation_status=$?
  if [ "$operation_status" -ne 0 ]; then cleanup_status="$operation_status"; fi
  case "$proof_root" in
    /tmp/vortex-permission-eligibility.*)
      rm -rf -- "$proof_root"
      operation_status=$?
      ;;
    *)
      echo "refusing to remove unexpected proof directory: $proof_root" >&2
      operation_status=1
      ;;
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
      raise exception 'Permission-eligibility proof fixture scope already exists';
    end if;
  end
  \$proof\$;

  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', '$fixture_short_name', 'Permission eligibility proof', 'active',
    pg_catalog.clock_timestamp(), '$account_id', pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, short_name, display_name, state,
    created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', '$fixture_short_name',
    'Permission eligibility proof', 'active', pg_catalog.clock_timestamp(),
    '$account_id', pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '$identity_id', 'active', pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '$account_id', '$correlation_seed', 1
  );
  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, activated_at, suspended_at, changed_at, state_changed_at,
    state_changed_by, state_change_correlation_id, revision
  ) values (
    '$account_id', '$organization_id', '$identity_id', 'Eligibility actor',
    'active', pg_catalog.clock_timestamp(), null, pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '$account_id', '$correlation_seed', 1
  );
  select 1 from vortex_access.initialize_organization_access_version(
    '$organization_id', '$account_id', '$correlation_seed'
  );

  create function pg_temp.seed_eligibility_role(
    p_application_root_id uuid,
    p_permission_id uuid,
    p_role_id uuid,
    p_role_key text,
    p_fingerprint_character text,
    p_assignment_id uuid
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
      'register', p_role_key || '.definition', '1.0.0', 1, '1.0.0',
      'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64),
      'sha256:' || pg_catalog.repeat('1', 64),
      'sha256:' || pg_catalog.repeat('2', 64),
      'sha256:' || pg_catalog.repeat('3', 64), operation_at, '$account_id',
      '$correlation_seed'
    );
    insert into vortex_access.permission_registrations (
      organization_id, registration_kind, registration_owner_id, state,
      revision, source_definition_key, source_version, source_revision,
      validation_contract_version, source_content_fingerprint,
      source_resolution_fingerprint, permission_catalogue_fingerprint,
      candidate_fingerprint, changed_at, changed_by, change_correlation_id
    ) values (
      '$organization_id', 'application', p_application_root_id, 'active', 1,
      p_role_key || '.definition', '1.0.0', 1, '1.0.0',
      'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64),
      'sha256:' || pg_catalog.repeat('1', 64),
      'sha256:' || pg_catalog.repeat('2', 64),
      'sha256:' || pg_catalog.repeat('3', 64), operation_at, '$account_id',
      '$correlation_seed'
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
      p_permission_id, p_role_key || '.permission.read', 'Read application',
      'Read one neutral application fixture.', null, 'read', null, false,
      'application', p_role_key || '.definition', p_application_root_id,
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
    insert into vortex_access.organization_roles (
      organization_id, role_id, role_kind, role_key, live_revision,
      created_by, created_at
    ) values (
      '$organization_id', p_role_id, 'custom', p_role_key, 1,
      '$account_id', operation_at
    );
    insert into vortex_access.organization_role_permission_entries (
      organization_id, role_id, role_revision, entry_ordinal, role_kind,
      role_application_root_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id,
      accepted_registration_revision, catalogue_fingerprint,
      continuity_revision, meaning_fingerprint
    ) values (
      '$organization_id', p_role_id, 1, 1, 'custom', null,
      p_application_root_id, 'application', p_application_root_id,
      p_permission_id, 'application', p_application_root_id, 1,
      'sha256:' || pg_catalog.repeat('2', 64), 1,
      'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64)
    );
    insert into vortex_access.organization_role_revisions (
      organization_id, role_id, revision, role_kind, lifecycle,
      privilege_classification, assignment_policy,
      policy_continuity_revision, authority_continuity_revision,
      role_key, label, description, changed_by, changed_at,
      change_correlation_id
    ) values (
      '$organization_id', p_role_id, 1, 'custom', 'active', 'standard',
      'standing', 1, 1, p_role_key, 'Eligibility role',
      'Neutral permission eligibility role.', '$account_id', operation_at,
      '$correlation_seed'
    );
    if p_assignment_id is not null then
      insert into vortex_access.organization_role_assignments (
        organization_id, role_assignment_id, role_id, assignee_kind,
        organization_account_id, group_id, assignment_kind, revision,
        starts_at, expires_at, state, granted_by, granted_at,
        grant_correlation_id, changed_by, changed_at, change_correlation_id
      ) values (
        '$organization_id', p_assignment_id, p_role_id,
        'organization_account', '$account_id', null, 'standing', 1,
        operation_at - interval '1 minute', null, 'live', '$account_id',
        operation_at, '$correlation_seed', '$account_id', operation_at,
        '$correlation_seed'
      );
    end if;
  end
  \$seed\$;

  select pg_temp.seed_eligibility_role(
    '$application_a_id', '$permission_a_id', '$role_a_id',
    'eligibility_a', 'a', '$assignment_a_id'
  );
  select pg_temp.seed_eligibility_role(
    '$application_b_id', '$permission_b_id', '$role_b_id',
    'eligibility_b', 'b', null
  );
  select pg_temp.seed_eligibility_role(
    '$application_c_id', '$permission_c_id', '$role_c_id',
    'eligibility_c', 'c', null
  );
  set constraints all immediate;
  commit;
" >/dev/null
fixture_claimed=1

# Reader-first: resolve the trusted context, evaluate permission eligibility,
# and hold the transaction. The real assignment revocation must wait for the
# request's Access lock; the decision remains valid only inside that transaction.
PGAPPNAME="vortex-permission-r1-reader-${run_token:0:8}" "${psql_command[@]}" >"$proof_root/r1-reader.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
set local role vortex_runtime;
select pg_catalog.pg_backend_pid() \g '$proof_root/r1-reader.pid'
select access_version as resolved_access_version
from vortex_access.resolve_human_organization_scope('$identity_id', '$organization_id')
\gset
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human', 'identityAuthorityId', '$identity_authority_id',
  'tenantId', '$tenant_id', 'organizationId', '$organization_id',
  'applicationRootId', '$application_a_id',
  'organizationAccountId', '$account_id', 'identityId', '$identity_id',
  'sessionId', '$session_id', 'authenticationStrength', 'single_factor',
  'issuedAt', pg_catalog.clock_timestamp(),
  'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
  'accessVersion', :resolved_access_version,
  'correlationId', '$correlation_r1_reader'
));
set local role vortex_request;
select outcome || '|' || coalesce(reason_code, '') || '|' || access_version
from vortex_access.evaluate_organization_permission_eligibility(
  pg_catalog.jsonb_build_object(
    'operationKey', 'application.configuration.read',
    'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
    'target', pg_catalog.jsonb_build_object(
      'kind', 'application', 'applicationRootId', '$application_a_id'
    ),
    'requiredPermission', pg_catalog.jsonb_build_object(
      'applicationRootId', '$application_a_id', 'ownerKind', 'application',
      'ownerId', '$application_a_id', 'permissionId', '$permission_a_id'
    ),
    'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
    'authority', pg_catalog.jsonb_build_object('kind', 'permission')
  )
) \g '$proof_root/r1-reader.result'
\! touch '$proof_root/r1-reader-ready'
\! deadline=600; while [ ! -f '$proof_root/r1-reader-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/r1-reader-release' ]
commit;
SQL
r1_reader_pid=$!
worker_pids+=("$r1_reader_pid")
wait_for_file "$proof_root/r1-reader-ready"
r1_reader_db="$(read_backend_pid "$proof_root/r1-reader.pid")"

PGAPPNAME="vortex-permission-r1-writer-${run_token:0:8}" "${psql_command[@]}" >"$proof_root/r1-writer.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r1-writer.pid'
select outcome || '|' || state || '|' || revision || '|' || access_version
from vortex_access.coordinate_organization_role_assignment_change(
  'revoke', '$organization_id', '$assignment_a_id', 1,
  null, null, null, null, null, null, null, null,
  '$account_id', '$correlation_r1_writer'
) \g '$proof_root/r1-writer.result'
commit;
SQL
r1_writer_pid=$!
worker_pids+=("$r1_writer_pid")
r1_writer_db="$(read_backend_pid "$proof_root/r1-writer.pid")"
wait_for_database_blocker "$r1_writer_db" "$r1_reader_db" \
  'the serialized assignment revocation waiting behind the completed decision'
touch "$proof_root/r1-reader-release"
wait_owned_worker "$r1_reader_pid"
wait_owned_worker "$r1_writer_pid"

[ "$(tr -d '[:space:]' <"$proof_root/r1-reader.result")" = 'eligible||1' ] || {
  echo 'reader-first predicate did not return exact transaction-bound eligibility' >&2
  exit 1
}
[ "$(tr -d '[:space:]' <"$proof_root/r1-writer.result")" = 'changed|revoked|2|2' ] || {
  echo 'reader-first real assignment revocation did not complete exactly once' >&2
  exit 1
}

"${psql_command[@]}" >"$proof_root/r1-next.log" 2>&1 <<SQL
begin;
set local role vortex_runtime;
select access_version as resolved_access_version
from vortex_access.resolve_human_organization_scope('$identity_id', '$organization_id')
\gset
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human', 'identityAuthorityId', '$identity_authority_id',
  'tenantId', '$tenant_id', 'organizationId', '$organization_id',
  'applicationRootId', '$application_a_id',
  'organizationAccountId', '$account_id', 'identityId', '$identity_id',
  'sessionId', '$session_id', 'authenticationStrength', 'single_factor',
  'issuedAt', pg_catalog.clock_timestamp(),
  'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
  'accessVersion', :resolved_access_version,
  'correlationId', '$correlation_r1_next'
));
set local role vortex_request;
select outcome || '|' || reason_code || '|' || access_version
from vortex_access.evaluate_organization_permission_eligibility(
  pg_catalog.jsonb_build_object(
    'operationKey', 'application.configuration.read',
    'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
    'target', pg_catalog.jsonb_build_object(
      'kind', 'application', 'applicationRootId', '$application_a_id'
    ),
    'requiredPermission', pg_catalog.jsonb_build_object(
      'applicationRootId', '$application_a_id', 'ownerKind', 'application',
      'ownerId', '$application_a_id', 'permissionId', '$permission_a_id'
    ),
    'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
    'authority', pg_catalog.jsonb_build_object('kind', 'permission')
  )
);
commit;
SQL
grep -Fq 'refused|permission_not_effective|2' "$proof_root/r1-next.log" || {
  echo 'the next resolved transaction reused revoked permission eligibility' >&2
  exit 1
}

# Writer-first: hold the writer's downstream role lock, then create a short
# current permission path. The real grant owns Access while waiting on the role;
# the request waits behind Access and must evaluate the path only after expiry.
PGAPPNAME="vortex-permission-r2-holder-${run_token:0:8}" "${psql_command[@]}" >"$proof_root/r2-holder.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select role_id from vortex_access.organization_roles
where organization_id = '$organization_id' and role_id = '$role_c_id'
for update;
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-holder.pid'
\! deadline=600; while [ ! -f '$proof_root/r2-holder-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/r2-holder-release' ]
commit;
SQL
r2_holder_pid=$!
worker_pids+=("$r2_holder_pid")
r2_holder_db="$(read_backend_pid "$proof_root/r2-holder.pid")"

r2_deadline_epoch="$(run_sql "
  with operation as materialized (
    select pg_catalog.clock_timestamp() as operation_at
  )
  insert into vortex_access.organization_role_assignments (
    organization_id, role_assignment_id, role_id, assignee_kind,
    organization_account_id, group_id, assignment_kind, revision,
    starts_at, expires_at, state, granted_by, granted_at,
    grant_correlation_id, changed_by, changed_at, change_correlation_id
  ) select
    '$organization_id', '$assignment_b_id', '$role_b_id',
    'organization_account', '$account_id', null, 'standing', 1,
    operation.operation_at - interval '1 minute',
    operation.operation_at + interval '15 seconds', 'live',
    '$account_id', operation.operation_at, '$correlation_seed',
    '$account_id', operation.operation_at, '$correlation_seed'
  from operation
  returning extract(epoch from expires_at);
")"
[[ "$r2_deadline_epoch" =~ ^[0-9]+([.][0-9]+)?$ ]] || {
  echo 'permission-eligibility proof captured an invalid fact deadline' >&2
  exit 1
}

PGAPPNAME="vortex-permission-r2-writer-${run_token:0:8}" "${psql_command[@]}" >"$proof_root/r2-writer.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-writer.pid'
select outcome || '|' || state || '|' || revision || '|' || access_version
from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '$organization_id', '$assignment_c_id', null,
  '$role_c_id', 1, 'organization_account', '$account_id', null,
  'standing', pg_catalog.clock_timestamp() - interval '1 minute', null,
  '$account_id', '$correlation_r2_writer'
) \g '$proof_root/r2-writer.result'
commit;
SQL
r2_writer_pid=$!
worker_pids+=("$r2_writer_pid")
r2_writer_db="$(read_backend_pid "$proof_root/r2-writer.pid")"
wait_for_database_blocker "$r2_writer_db" "$r2_holder_db" \
  'the Access-first assignment grant waiting on its exact role'

PGAPPNAME="vortex-permission-r2-reader-${run_token:0:8}" "${psql_command[@]}" >"$proof_root/r2-reader.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
set local role vortex_runtime;
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-reader.pid'
select access_version as resolved_access_version
from vortex_access.resolve_human_organization_scope('$identity_id', '$organization_id')
\gset
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human', 'identityAuthorityId', '$identity_authority_id',
  'tenantId', '$tenant_id', 'organizationId', '$organization_id',
  'applicationRootId', '$application_b_id',
  'organizationAccountId', '$account_id', 'identityId', '$identity_id',
  'sessionId', '$session_id', 'authenticationStrength', 'single_factor',
  'issuedAt', pg_catalog.clock_timestamp(),
  'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
  'accessVersion', :resolved_access_version,
  'correlationId', '$correlation_r2_reader'
));
set local role vortex_request;
select outcome || '|' || reason_code || '|' || access_version
from vortex_access.evaluate_organization_permission_eligibility(
  pg_catalog.jsonb_build_object(
    'operationKey', 'application.configuration.read',
    'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
    'target', pg_catalog.jsonb_build_object(
      'kind', 'application', 'applicationRootId', '$application_b_id'
    ),
    'requiredPermission', pg_catalog.jsonb_build_object(
      'applicationRootId', '$application_b_id', 'ownerKind', 'application',
      'ownerId', '$application_b_id', 'permissionId', '$permission_b_id'
    ),
    'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
    'authority', pg_catalog.jsonb_build_object('kind', 'permission')
  )
) \g '$proof_root/r2-reader.result'
commit;
SQL
r2_reader_pid=$!
worker_pids+=("$r2_reader_pid")
r2_reader_db="$(read_backend_pid "$proof_root/r2-reader.pid")"
wait_for_database_blocker "$r2_reader_db" "$r2_writer_db" \
  'the request resolver waiting behind the Access-first authority writer'

[ "$(run_sql "select pg_catalog.clock_timestamp() < pg_catalog.to_timestamp($r2_deadline_epoch);")" = 't' ] || {
  echo 'the writer-first request was not observed before the fact deadline' >&2
  exit 1
}
wait_for_database_time "$r2_deadline_epoch"
touch "$proof_root/r2-holder-release"
wait_owned_worker "$r2_holder_pid"
wait_owned_worker "$r2_writer_pid"
wait_owned_worker "$r2_reader_pid"

[ "$(tr -d '[:space:]' <"$proof_root/r2-writer.result")" = 'changed|live|1|3' ] || {
  echo 'writer-first unrelated assignment grant did not complete exactly once' >&2
  exit 1
}
[ "$(tr -d '[:space:]' <"$proof_root/r2-reader.result")" = 'refused|permission_not_effective|3' ] || {
  echo 'writer-first request did not evaluate the expired fact after its wait' >&2
  exit 1
}

final_state="$(run_sql "
  select pg_catalog.concat_ws('|', version.current_version,
    version.change_reason, version.change_correlation_id,
    assignment_a.state, assignment_a.revision,
    assignment_b.state, assignment_b.revision,
    assignment_b.expires_at <= pg_catalog.clock_timestamp(),
    assignment_c.state, assignment_c.revision,
    role_a.live_revision, role_b.live_revision, role_c.live_revision,
    registration_a.state, registration_b.state, registration_c.state)
  from vortex_access.organization_access_versions as version
  join vortex_access.organization_role_assignments as assignment_a
    on assignment_a.organization_id = version.organization_id
    and assignment_a.role_assignment_id = '$assignment_a_id'
  join vortex_access.organization_role_assignments as assignment_b
    on assignment_b.organization_id = version.organization_id
    and assignment_b.role_assignment_id = '$assignment_b_id'
  join vortex_access.organization_role_assignments as assignment_c
    on assignment_c.organization_id = version.organization_id
    and assignment_c.role_assignment_id = '$assignment_c_id'
  join vortex_access.organization_roles as role_a
    on role_a.organization_id = version.organization_id and role_a.role_id = '$role_a_id'
  join vortex_access.organization_roles as role_b
    on role_b.organization_id = version.organization_id and role_b.role_id = '$role_b_id'
  join vortex_access.organization_roles as role_c
    on role_c.organization_id = version.organization_id and role_c.role_id = '$role_c_id'
  join vortex_access.permission_registrations as registration_a
    on registration_a.organization_id = version.organization_id
    and registration_a.registration_kind = 'application'
    and registration_a.registration_owner_id = '$application_a_id'
  join vortex_access.permission_registrations as registration_b
    on registration_b.organization_id = version.organization_id
    and registration_b.registration_kind = 'application'
    and registration_b.registration_owner_id = '$application_b_id'
  join vortex_access.permission_registrations as registration_c
    on registration_c.organization_id = version.organization_id
    and registration_c.registration_kind = 'application'
    and registration_c.registration_owner_id = '$application_c_id'
  where version.organization_id = '$organization_id';
")"
[ "$final_state" = "3|role_assignment_changed|$correlation_r2_writer|revoked|2|live|1|t|live|1|1|1|1|active|active|active" ] || {
  echo "permission-eligibility proof left unexpected exact facts: $final_state" >&2
  exit 1
}

echo 'organization permission eligibility concurrency proof passed'
