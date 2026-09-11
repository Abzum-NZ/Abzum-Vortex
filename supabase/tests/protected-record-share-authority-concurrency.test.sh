#!/usr/bin/env bash
# #37: a concurrent authority or account change cannot let a stale protected
# share grant or revocation commit.
#
# Five races, each through the fixed trusted adapter under the real
# vortex_request role, against a real concurrent writer that holds the
# organisation's governance lock with an uncommitted change:
#   grant                 -- the grantor's own role assignment is revoked;
#   grant-closed          -- the grantor's own account is closed;
#   revoke                -- a non-grantor revoker's share-permission
#                            assignment is revoked;
#   revoke-closed         -- a non-grantor revoker's own account is closed;
#   grantor-revoke-closed -- the share's own grantor revokes it while that
#                            grantor's account is closed.
# The role-assignment writer and the account-lifecycle writer both take that
# lock and advance the Access version in the same transaction. In every race
# the protected operation is observed blocked by the writer. Once the writer
# commits, the protected operation must be refused with 42501 and must leave
# no share, share-state, Activity or extra Access change behind. Every race
# runs even when an earlier one commits, and the proof fails naming each race
# whose stale operation committed.
#
# What enforces this, established by targeted mutation on fresh clusters:
#   * Both protected functions lock the organisation's Access version and then
#     compare it with the request context's version. That post-lock comparison
#     alone is sufficient on both paths. Even with the lock moved after the
#     authority check, every race is refused there: the authority check passes
#     against the state before the change, but the writer has advanced the
#     version by the time the lock is granted.
#   * Taking the lock first, without the comparison, is sufficient only for the
#     grant. The grant's record decision re-validates the request context
#     after the lock -- account state and Access version -- and refuses both
#     grant races. The revocation validates its context once, before the lock.
#     Its grantor branch checks identity only, and its eligibility check reuses
#     that pre-lock context and never re-reads account state. With only the
#     revocation's comparison removed, revoke-closed and grantor-revoke-closed
#     commit, and this proof fails. The assignment race is still refused,
#     because eligibility re-reads the revoked assignment.
#   * Moving the lock after the authority check and removing the comparison
#     together lets the stale operations of that path commit. This proof fails
#     under that mutation on either path.
#
# Fixture: tenants, organisations, the first account, the definition root and
# draft, and the neutral content table and adapters are inserted directly (no
# writer exists for them). Every other account comes from invitation
# acceptance. The release comes from vortex_definition.append_release. The
# permissions come from the coordinated registration writer, the role and
# assignments from their owning writers, and the setup shares from the
# protected grant itself. Accounts are closed only by the account-lifecycle
# writer, inside the races.
set -euo pipefail

run_uuid="${VORTEX_PROTECTED_SHARE_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the protected-share proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_PROTECTED_SHARE_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly short_name="shareauth_${run_token:0:18}"
readonly tenant_id="10${run_uuid:2}" organization_id="20${run_uuid:2}"
readonly actor_id="90${run_uuid:2}"
readonly admin_identity="40${run_uuid:2}" grantor_identity="41${run_uuid:2}"
readonly revoker_identity="42${run_uuid:2}" recipient_identity="43${run_uuid:2}"
readonly closing_grantor_identity="44${run_uuid:2}" closing_revoker_identity="45${run_uuid:2}"
readonly revoking_grantor_identity="46${run_uuid:2}"
readonly admin_account="50${run_uuid:2}"
readonly application_root="30${run_uuid:2}" module_root="31${run_uuid:2}"
readonly record_type="32${run_uuid:2}" storage_contract="33${run_uuid:2}"
readonly field_one="d1${run_uuid:2}" field_two="d2${run_uuid:2}"
readonly permission_read="c1${run_uuid:2}" permission_share="c2${run_uuid:2}"
readonly permission_update="c3${run_uuid:2}"
readonly role_id="60${run_uuid:2}"
readonly grantor_assignment="70${run_uuid:2}" revoker_assignment="71${run_uuid:2}"
readonly closing_grantor_assignment="72${run_uuid:2}" closing_revoker_assignment="73${run_uuid:2}"
readonly revoking_grantor_assignment="74${run_uuid:2}"
readonly record_id="e1${run_uuid:2}"
readonly setup_share="81${run_uuid:2}" race_share="82${run_uuid:2}"
readonly closing_revoker_share="83${run_uuid:2}" revoking_grantor_share="84${run_uuid:2}"
readonly closed_grant_share="85${run_uuid:2}"
readonly setup_activity="a1${run_uuid:2}" race_grant_activity="a2${run_uuid:2}"
readonly race_revoke_activity="a3${run_uuid:2}"
readonly closing_revoker_share_activity="a4${run_uuid:2}" revoking_grantor_share_activity="a5${run_uuid:2}"
readonly closed_grant_activity="a6${run_uuid:2}" closed_revoke_activity="a7${run_uuid:2}"
readonly closed_grantor_revoke_activity="a8${run_uuid:2}"
readonly identity_authority="cc${run_uuid:2}" session_id="b1${run_uuid:2}"
readonly application_key="example.share_auth_${run_token:0:12}"
proof_root="$(mktemp -d /tmp/vortex-protected-share.XXXXXX)"
readonly proof_root database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"

psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then psql_command+=("$database_url"); fi
run_sql() { "${psql_command[@]}" --command "$1"; }

fixture_claimed=0
declare -a worker_pids=()
declare -A reaped_worker_pids=()
declare -a started_races=() committed_races=()

wait_for_file() {
  local candidate="$1" deadline=$((SECONDS + 20))
  while ((SECONDS < deadline)); do [ -f "$candidate" ] && return 0; sleep 0.05; done
  echo "protected-share proof barrier timed out: $candidate" >&2
  return 1
}

read_backend_pid() {
  local candidate="$1" backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'protected-share proof captured invalid backend: %q\n' "$backend_pid" >&2
    return 1
  }
  printf '%s\n' "$backend_pid"
}

wait_for_database_blocker() {
  local blocked_pid="$1" blocking_pid="$2" deadline=$((SECONDS + 20)) state
  while ((SECONDS < deadline)); do
    state="$(run_sql "select case when $blocking_pid = any(pg_catalog.pg_blocking_pids($blocked_pid)) then 'blocked' else '' end;")"
    [ "$state" = 'blocked' ] && return 0
    sleep 0.1
  done
  echo 'protected-share proof did not observe the protected operation blocked by the authority writer' >&2
  return 1
}

wait_owned_worker() {
  local pid="$1" status
  if wait "$pid"; then status=0; else status=$?; fi
  reaped_worker_pids["$pid"]=1
  return "$status"
}

stop_owned_workers() {
  local pid
  for pid in "${worker_pids[@]:-}"; do
    [ -n "$pid" ] || continue
    if [ "${reaped_worker_pids[$pid]:-0}" != 1 ] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  for pid in "${worker_pids[@]:-}"; do
    [ -n "$pid" ] || continue
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
    do \$cleanup\$
    declare
      target record;
    begin
      if not exists (
        select 1 from vortex_identity.organizations
        where organization_id = '$organization_id' and tenant_id = '$tenant_id'
          and short_name = '$short_name' and created_by = '$actor_id'
      ) then
        raise exception 'protected-share proof fixture ownership mismatch';
      end if;
      for target in
        select column_row.table_schema, column_row.table_name
        from information_schema.columns as column_row
        join information_schema.tables as table_row
          on table_row.table_schema = column_row.table_schema
          and table_row.table_name = column_row.table_name
          and table_row.table_type = 'BASE TABLE'
        where column_row.table_schema in ('vortex_access', 'vortex_activity', 'vortex_identity')
          and column_row.column_name = 'organization_id'
          and column_row.table_name <> 'organizations'
      loop
        execute pg_catalog.format('delete from %I.%I where organization_id = %L',
          target.table_schema, target.table_name, '$organization_id');
      end loop;
      for target in
        select column_row.table_name
        from information_schema.columns as column_row
        join information_schema.tables as table_row
          on table_row.table_schema = column_row.table_schema
          and table_row.table_name = column_row.table_name
          and table_row.table_type = 'BASE TABLE'
        where column_row.table_schema = 'vortex_definition'
          and column_row.column_name = 'root_id'
          and column_row.table_name <> 'roots'
      loop
        execute pg_catalog.format('delete from vortex_definition.%I where root_id = %L',
          target.table_name, '$application_root');
      end loop;
      delete from vortex_definition.roots where root_id = '$application_root';
    end
    \$cleanup\$;
    drop function if exists vortex_access.protected_share_race_grant(uuid,uuid,text,uuid,uuid,uuid[],uuid[],timestamptz,timestamptz,text,text,uuid);
    drop function if exists vortex_access.protected_share_race_revoke(uuid,bigint,text,text,uuid);
    drop table if exists vortex_access.protected_share_race_rows;
    delete from vortex_identity.identity_projections
      where identity_id in ('$admin_identity','$grantor_identity','$revoker_identity','$recipient_identity',
        '$closing_grantor_identity','$closing_revoker_identity','$revoking_grantor_identity');
    delete from vortex_identity.organizations where organization_id = '$organization_id';
    delete from vortex_identity.tenants where tenant_id = '$tenant_id' and short_name = '$short_name';
    commit;
  " >/dev/null
}

finalize() {
  local original_status=$? cleanup_status=0 operation_status
  trap - EXIT INT TERM
  set +e
  for race_name in "${started_races[@]:-}"; do
    [ -n "$race_name" ] && touch "$proof_root/$race_name-writer-release"
  done
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then
    echo 'protected-share authority proof failed; bounded diagnostics follow' >&2
    for log_path in "$proof_root"/*.log; do
      [ -f "$log_path" ] || continue
      printf '%s\n' "--- ${log_path##*/} ---" >&2
      tail -n 60 -- "$log_path" >&2
    done
  fi
  cleanup_fixture
  operation_status=$?
  if [ "$operation_status" -ne 0 ]; then cleanup_status="$operation_status"; fi
  case "$proof_root" in
    /tmp/vortex-protected-share.*) rm -rf -- "$proof_root"; operation_status=$? ;;
    *) echo 'refusing to remove unexpected protected-share proof directory' >&2; operation_status=1 ;;
  esac
  if [ "$operation_status" -ne 0 ] && [ "$cleanup_status" -eq 0 ]; then cleanup_status="$operation_status"; fi
  if [ "$original_status" -ne 0 ]; then exit "$original_status"; fi
  exit "$cleanup_status"
}
trap finalize EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

sha() { printf "'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(%s, 'UTF8')), 'hex')" "$1"; }

# One verified human request context for the current transaction.
human_context() {
  local account="$1" identity="$2" access_version="$3" correlation="$4"
  printf "select vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind','human','identityAuthorityId','%s','tenantId','%s','organizationId','%s',
    'organizationAccountId','%s','identityId','%s',
    'applicationRootId','%s','sessionId','%s','authenticationStrength','single_factor',
    'issuedAt',pg_catalog.statement_timestamp(),'expiresAt',pg_catalog.statement_timestamp()+interval '10 minutes',
    'accessVersion',%s,'correlationId','%s',
    'accessTokenIssuedAt',pg_catalog.statement_timestamp(),'primaryAuthenticatedAt',pg_catalog.statement_timestamp()));" \
    "$identity_authority" "$tenant_id" "$organization_id" "$account" "$identity" \
    "$application_root" "$session_id" "$access_version" "$correlation"
}

current_version() {
  run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';"
}

# ----------------------------------------------------------------------------
# Identity. Direct inserts: the tenant, the organisation and its first account
# (no writer creates these). Every other account is invited by that first
# account and accepted through the Access-owned acceptance writer.
# ----------------------------------------------------------------------------
run_sql "
  begin;
  insert into vortex_identity.tenants (tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision)
  values ('$tenant_id','$short_name','Protected share authority proof','active',pg_catalog.clock_timestamp(),'$actor_id',pg_catalog.clock_timestamp(),1);
  insert into vortex_identity.organizations (organization_id, tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision)
  values ('$organization_id','$tenant_id','$short_name','Protected share authority proof','active',pg_catalog.clock_timestamp(),'$actor_id',pg_catalog.clock_timestamp(),1);
  select * from vortex_access.initialize_organization_access_version('$organization_id','$actor_id','f0${run_uuid:2}');
  select * from vortex_identity.ensure_identity_projection('$admin_identity','f1${run_uuid:2}');
  select * from vortex_identity.ensure_identity_projection('$grantor_identity','f2${run_uuid:2}');
  select * from vortex_identity.ensure_identity_projection('$revoker_identity','f3${run_uuid:2}');
  select * from vortex_identity.ensure_identity_projection('$recipient_identity','f4${run_uuid:2}');
  select * from vortex_identity.ensure_identity_projection('$closing_grantor_identity','fa${run_uuid:2}');
  select * from vortex_identity.ensure_identity_projection('$closing_revoker_identity','fb${run_uuid:2}');
  select * from vortex_identity.ensure_identity_projection('$revoking_grantor_identity','fc${run_uuid:2}');
  insert into vortex_identity.organization_accounts (organization_account_id, organization_id, identity_id, display_name, state, activated_at, changed_at, state_changed_at, state_changed_by, state_change_correlation_id, revision)
  values ('$admin_account','$organization_id','$admin_identity','Administrator','active',pg_catalog.clock_timestamp()-interval '1 minute',pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),'$admin_account','f5${run_uuid:2}',1);
  $(human_context "$admin_account" "$admin_identity" 1 "f6${run_uuid:2}")
  select * from vortex_identity.create_organization_invitation('grantor-$run_token@example.test', $(sha "'grantor:$run_uuid'"), pg_catalog.clock_timestamp()+interval '1 day');
  select * from vortex_identity.create_organization_invitation('revoker-$run_token@example.test', $(sha "'revoker:$run_uuid'"), pg_catalog.clock_timestamp()+interval '1 day');
  select * from vortex_identity.create_organization_invitation('recipient-$run_token@example.test', $(sha "'recipient:$run_uuid'"), pg_catalog.clock_timestamp()+interval '1 day');
  select * from vortex_identity.create_organization_invitation('closinggrantor-$run_token@example.test', $(sha "'closinggrantor:$run_uuid'"), pg_catalog.clock_timestamp()+interval '1 day');
  select * from vortex_identity.create_organization_invitation('closingrevoker-$run_token@example.test', $(sha "'closingrevoker:$run_uuid'"), pg_catalog.clock_timestamp()+interval '1 day');
  select * from vortex_identity.create_organization_invitation('revokinggrantor-$run_token@example.test', $(sha "'revokinggrantor:$run_uuid'"), pg_catalog.clock_timestamp()+interval '1 day');
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  select * from vortex_access.accept_organization_invitation($(sha "'grantor:$run_uuid'"), '$grantor_identity', 'grantor-$run_token@example.test', 'Grantor', 'f7${run_uuid:2}');
  select * from vortex_access.accept_organization_invitation($(sha "'revoker:$run_uuid'"), '$revoker_identity', 'revoker-$run_token@example.test', 'Revoker', 'f8${run_uuid:2}');
  select * from vortex_access.accept_organization_invitation($(sha "'recipient:$run_uuid'"), '$recipient_identity', 'recipient-$run_token@example.test', 'Recipient', 'f9${run_uuid:2}');
  select * from vortex_access.accept_organization_invitation($(sha "'closinggrantor:$run_uuid'"), '$closing_grantor_identity', 'closinggrantor-$run_token@example.test', 'Closing grantor', 'fd${run_uuid:2}');
  select * from vortex_access.accept_organization_invitation($(sha "'closingrevoker:$run_uuid'"), '$closing_revoker_identity', 'closingrevoker-$run_token@example.test', 'Closing revoker', 'fe${run_uuid:2}');
  select * from vortex_access.accept_organization_invitation($(sha "'revokinggrantor:$run_uuid'"), '$revoking_grantor_identity', 'revokinggrantor-$run_token@example.test', 'Revoking grantor', 'ff${run_uuid:2}');
  commit;
" >/dev/null
fixture_claimed=1

account_for() {
  run_sql "select organization_account_id from vortex_identity.organization_accounts where organization_id='$organization_id' and identity_id='$1' and state='active';"
}
grantor_account="$(account_for "$grantor_identity")"
revoker_account="$(account_for "$revoker_identity")"
recipient_account="$(account_for "$recipient_identity")"
closing_grantor_account="$(account_for "$closing_grantor_identity")"
closing_revoker_account="$(account_for "$closing_revoker_identity")"
revoking_grantor_account="$(account_for "$revoking_grantor_identity")"
for invited_account in "$grantor_account" "$revoker_account" "$recipient_account" \
  "$closing_grantor_account" "$closing_revoker_account" "$revoking_grantor_account"; do
  [[ "$invited_account" =~ ^[0-9a-f-]{36}$ ]] || {
    echo 'protected-share proof could not read its invited accounts' >&2
    exit 1
  }
done
readonly grantor_account revoker_account recipient_account
readonly closing_grantor_account closing_revoker_account revoking_grantor_account

# ----------------------------------------------------------------------------
# Authority. One application release (append_release, under a system context)
# declares all_records read (F1, F2), update (F1, F2; changeable F1) and share
# permissions on one neutral record type. The coordinated registration writer
# installs it, the role writer builds one standing role over all three, and
# the assignment writer gives that role to every account that grants or
# revokes below.
# The definition root and its first draft are inserted directly, as the #45
# release-writer fixture does.
# ----------------------------------------------------------------------------
permission_json() {
  printf "pg_catalog.jsonb_build_object('permissionId','%s','key','%s','label','%s','description','Protected share race permission.',
    'recordTypeId','$record_type','recordScope','{\"routes\":[{\"kind\":\"all_records\"}]}'::jsonb,
    'fieldPolicy',pg_catalog.jsonb_build_object('readableFieldIds',%s::jsonb,'changeableFieldIds',%s::jsonb),
    'actionKind','%s','administrative',false)" "$1" "$2" "$2" "$3" "$4" "$5"
}
readonly permissions_sql="pg_catalog.jsonb_build_array(
  $(permission_json "$permission_read" 'share_race.read' "'[\"$field_one\",\"$field_two\"]'" "'[]'" read),
  $(permission_json "$permission_share" 'share_race.share' "'[]'" "'[]'" share),
  $(permission_json "$permission_update" 'share_race.update' "'[\"$field_one\",\"$field_two\"]'" "'[\"$field_one\"]'" update))"
readonly content_fingerprint="$(sha "'content:$run_uuid'")"
readonly resolution_fingerprint="$(sha "'resolution:$run_uuid'")"
readonly source_fingerprint="$(sha "'source:$run_uuid'")"

run_sql "
  begin;
  insert into vortex_definition.roots (root_id, organization_id, kind, key, created_at, created_by)
  values ('$application_root','$organization_id','application','$application_key',pg_catalog.clock_timestamp()-interval '1 minute','$actor_id');
  insert into vortex_definition.drafts (root_id, draft_revision, draft_source, source_contract_version, source_fingerprint, updated_at, updated_by)
  values ('$application_root',1,pg_catalog.jsonb_build_object('source_contract_version','1.0.0','kind','application','key','$application_key'),
    '1.0.0',$source_fingerprint,pg_catalog.statement_timestamp(),'$actor_id');
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  select vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind','system','tenantId','$tenant_id','organizationId','$organization_id',
    'sessionId','$session_id','issuedAt',pg_catalog.clock_timestamp()-interval '1 minute',
    'expiresAt',pg_catalog.clock_timestamp()+interval '5 minutes','accessVersion',1,
    'correlationId','e2${run_uuid:2}','systemActorId','$actor_id','authenticationStrength','service'));
  select * from vortex_definition.append_release('$application_root', 1, $source_fingerprint,
    pg_catalog.jsonb_build_object(
      'releaseVersion','1.0.0',
      'compilationOutput',pg_catalog.jsonb_build_object(
        'kind','application','validationContractVersion','1.0.0','resolutionFingerprint',$resolution_fingerprint,
        'artifact',pg_catalog.jsonb_build_object('kind','application','rootId','$application_root',
          'definitionKey','$application_key','exactVersion','1.0.0',
          'contentFingerprint',$content_fingerprint,'resolutionFingerprint',$resolution_fingerprint),
        'canonical',pg_catalog.jsonb_build_object(
          'envelope',pg_catalog.jsonb_build_object('kind','application','key','$application_key',
            'rootId','$application_root','organizationId','$organization_id'),
          'content',pg_catalog.jsonb_build_object('permissions',$permissions_sql))),
      'resolutionSnapshot',pg_catalog.jsonb_build_object('fingerprint',$resolution_fingerprint,
        'definitions',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind','application',
          'key','$application_key','rootId','$application_root','exactVersion','1.0.0'))),
      'contentFingerprint',$content_fingerprint,'resolutionFingerprint',$resolution_fingerprint,
      'validationContractVersion','1.0.0','comparisonFingerprint',$content_fingerprint,
      'impactReasons','[]'::jsonb,'releaseNote','Protected share race release.','dependencies','[]'::jsonb));
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  with release_value as (
    select pg_catalog.jsonb_build_object('kind','application','definitionKey','$application_key',
      'rootId','$application_root','releaseRevision',1,'releaseVersion','1.0.0',
      'validationContractVersion','1.0.0','contentFingerprint',$content_fingerprint,
      'resolutionFingerprint',$resolution_fingerprint) as value
  ), entries as (
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'applicationRootId','$application_root','ownerKind','application','ownerId','$application_root',
        'permission',permission.value,'sourceRelease',release_value.value,
        'meaningFingerprint',$(sha "'meaning:' || (permission.value ->> 'permissionId')"))
      order by (permission.value ->> 'key') collate \"C\", (permission.value ->> 'permissionId') collate \"C\") as value
    from release_value, pg_catalog.jsonb_array_elements($permissions_sql) as permission(value)
  ), candidate as (
    select pg_catalog.jsonb_build_object('contractVersion','1.0.0','organizationId','$organization_id',
      'applicationRootId','$application_root','applicationRelease',release_value.value,
      'applicationCatalogueFingerprint',$(sha "'catalogue:$run_uuid'"),
      'applicationPermissionIds',(select pg_catalog.jsonb_agg(entry.value #> '{permission,permissionId}' order by entry.ordinality)
        from pg_catalog.jsonb_array_elements(entries.value) with ordinality as entry(value, ordinality)),
      'entries',entries.value,'candidateFingerprint',$(sha "'candidate:$run_uuid'")) as value,
      entries.value as entry_values
    from release_value, entries
  )
  select 1 from candidate, vortex_access.coordinate_application_access_change('register', null,
    pg_catalog.jsonb_build_object('contractVersion','1.0.0',
      'preparationBasis','{\"kind\":\"registration_candidate\"}'::jsonb,
      'permissionRegistration',candidate.value,
      'templates',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'template',pg_catalog.jsonb_build_object('roleId','61${run_uuid:2}','key','share_race_template',
          'name','Share race template','homePageId','62${run_uuid:2}',
          'permissionKeys','[\"share_race.read\",\"share_race.share\",\"share_race.update\"]'::jsonb,
          'permissionSelection','{\"kind\":\"exact\"}'::jsonb),
        'sourceTemplateFingerprint',$(sha "'template:$run_uuid'"),
        'sourcePermissions',candidate.entry_values,'livePermissions',candidate.entry_values)),
      'candidateFingerprint',$(sha "'preparation:$run_uuid'")),
    '$organization_id','$application_root','$actor_id','e3${run_uuid:2}');
  select 1 from vortex_access.coordinate_organization_role_change(
    pg_catalog.jsonb_build_object('contractVersion','1.0.0',
      'candidate',pg_catalog.jsonb_build_object('operation','create_custom','organizationId','$organization_id',
        'roleId','$role_id','key','share_race_${run_token:0:12}','label','Share race role',
        'description','Standing share-path role for the protected share race.',
        'privilegeClassification','standard','assignmentPolicy','{\"kind\":\"standing\"}'::jsonb,
        'permissions',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'kind','exact','applicationRootId',entry.application_root_id,'ownerKind',entry.owner_kind,
            'ownerId',entry.owner_id,'permissionId',entry.permission_id,
            'acceptedRegistrationRevision',registration.revision,
            'catalogueFingerprint',registration.permission_catalogue_fingerprint,
            'continuityRevision',continuity.continuity_revision,'meaningFingerprint',entry.meaning_fingerprint)
          order by entry.application_root_id, entry.owner_kind collate \"C\", entry.owner_id, entry.permission_id)
          from vortex_access.permission_registrations as registration
          join vortex_access.permission_catalogue_entries as entry
            on entry.organization_id = registration.organization_id
            and entry.registration_kind = registration.registration_kind
            and entry.registration_owner_id = registration.registration_owner_id
            and entry.registration_revision = registration.revision
          join vortex_access.permission_continuities as continuity
            on continuity.organization_id = entry.organization_id
            and continuity.application_root_id = entry.application_root_id
            and continuity.owner_kind = entry.owner_kind and continuity.owner_id = entry.owner_id
            and continuity.permission_id = entry.permission_id
          where registration.organization_id = '$organization_id'
            and registration.registration_owner_id = '$application_root')),
      'roleCandidateFingerprint',$(sha "'role:$run_uuid'")),
    '$actor_id','e4${run_uuid:2}');
  select 1 from vortex_access.coordinate_organization_role_assignment_change('grant','$organization_id',
    '$grantor_assignment',null,'$role_id',1,'organization_account','$grantor_account',null,'standing',
    pg_catalog.clock_timestamp()-interval '1 minute',null,'$actor_id','e5${run_uuid:2}');
  select 1 from vortex_access.coordinate_organization_role_assignment_change('grant','$organization_id',
    '$revoker_assignment',null,'$role_id',1,'organization_account','$revoker_account',null,'standing',
    pg_catalog.clock_timestamp()-interval '1 minute',null,'$actor_id','e6${run_uuid:2}');
  select 1 from vortex_access.coordinate_organization_role_assignment_change('grant','$organization_id',
    '$closing_grantor_assignment',null,'$role_id',1,'organization_account','$closing_grantor_account',null,'standing',
    pg_catalog.clock_timestamp()-interval '1 minute',null,'$actor_id','eb${run_uuid:2}');
  select 1 from vortex_access.coordinate_organization_role_assignment_change('grant','$organization_id',
    '$closing_revoker_assignment',null,'$role_id',1,'organization_account','$closing_revoker_account',null,'standing',
    pg_catalog.clock_timestamp()-interval '1 minute',null,'$actor_id','ec${run_uuid:2}');
  select 1 from vortex_access.coordinate_organization_role_assignment_change('grant','$organization_id',
    '$revoking_grantor_assignment',null,'$role_id',1,'organization_account','$revoking_grantor_account',null,'standing',
    pg_catalog.clock_timestamp()-interval '1 minute',null,'$actor_id','ed${run_uuid:2}');
  set constraints all immediate;
  commit;
" >/dev/null

# ----------------------------------------------------------------------------
# Controlled neutral storage and the fixed trusted adapters (direct: test-owned
# storage; #45 generates the real storage and adapters). The grant adapter
# loads the target row by its identifier alone and supplies its real facts;
# the revoke adapter is a pass-through. Neither is callable by any role but
# vortex_request.
# ----------------------------------------------------------------------------
run_sql "
  begin;
  create table vortex_access.protected_share_race_rows (
    organization_id uuid not null, application_root_id uuid not null,
    record_id uuid primary key, owner_organization_account_id uuid not null,
    f1 text, f2 text
  );
  alter table vortex_access.protected_share_race_rows enable row level security;
  alter table vortex_access.protected_share_race_rows force row level security;
  insert into vortex_access.protected_share_race_rows values
    ('$organization_id','$application_root','$record_id','$admin_account','race-f1','race-f2');
  create function vortex_access.protected_share_race_grant(
    p_direct_share_id uuid, p_record_id uuid, p_recipient_kind text,
    p_organization_account_id uuid, p_group_id uuid, p_readable_field_ids uuid[],
    p_changeable_field_ids uuid[], p_starts_at timestamptz, p_expires_at timestamptz,
    p_reason text, p_activity_source text, p_activity_id uuid
  ) returns jsonb language plpgsql volatile security definer set search_path = '' as \$body\$
  declare
    row_value vortex_access.protected_share_race_rows;
  begin
    select * into row_value from vortex_access.protected_share_race_rows where record_id = p_record_id;
    return vortex_access.grant_record_share_for_administration(
      p_direct_share_id, p_record_id, p_recipient_kind, p_organization_account_id, p_group_id,
      p_readable_field_ids, p_changeable_field_ids, p_starts_at, p_expires_at, p_reason,
      p_activity_source, p_activity_id,
      pg_catalog.jsonb_build_object(
        'binding',pg_catalog.jsonb_build_object('moduleRootId','$module_root','recordTypeId','$record_type',
          'storageContractId','$storage_contract','storageScope','application_contained'),
        'recordTypes',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'moduleRootId','$module_root','recordTypeId','$record_type',
          'storageContractId','$storage_contract','storageScope','application_contained',
          'ownershipMode','organization_account',
          'fields',pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('fieldId','$field_one','type','text'),
            pg_catalog.jsonb_build_object('fieldId','$field_two','type','text')))),
        'relationships','[]'::jsonb,'sharingConditions','[]'::jsonb,
        'records',case when row_value.record_id is null then '[]'::jsonb else pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'recordScope',pg_catalog.jsonb_build_object('storageScope','application_contained',
              'organizationId',row_value.organization_id,'moduleRootId','$module_root',
              'recordTypeId','$record_type','storageContractId','$storage_contract',
              'recordId',row_value.record_id,'applicationRootId',row_value.application_root_id),
            'ownerOrganizationAccountId',row_value.owner_organization_account_id,
            'lifecycleState','active',
            'fieldValues',pg_catalog.jsonb_build_object('$field_one',row_value.f1,'$field_two',row_value.f2)))
        end,
        'edges','[]'::jsonb));
  end \$body\$;
  create function vortex_access.protected_share_race_revoke(
    p_direct_share_id uuid, p_expected_revision bigint, p_reason text,
    p_activity_source text, p_activity_id uuid
  ) returns jsonb language plpgsql volatile security definer set search_path = '' as \$body\$
  begin
    return vortex_access.revoke_record_share_for_administration(
      p_direct_share_id, p_expected_revision, p_reason, p_activity_source, p_activity_id);
  end \$body\$;
  revoke all on table vortex_access.protected_share_race_rows
    from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
  revoke execute on function vortex_access.protected_share_race_grant(uuid,uuid,text,uuid,uuid,uuid[],uuid[],timestamptz,timestamptz,text,text,uuid)
    from public, anon, authenticated, service_role, vortex_runtime;
  revoke execute on function vortex_access.protected_share_race_revoke(uuid,bigint,text,text,uuid)
    from public, anon, authenticated, service_role, vortex_runtime;
  grant execute on function vortex_access.protected_share_race_grant(uuid,uuid,text,uuid,uuid,uuid[],uuid[],timestamptz,timestamptz,text,text,uuid)
    to vortex_request;
  grant execute on function vortex_access.protected_share_race_revoke(uuid,bigint,text,text,uuid)
    to vortex_request;
  commit;
" >/dev/null

# The setup shares the revocation races target, each sharing F1 with the
# recipient through the protected grant before any race: the grantor grants
# the shares revoked by the revoker and by the closing revoker, and the
# revoking grantor grants the share it later revokes itself.
setup_share_grant() {
  local share="$1" account="$2" identity="$3" activity="$4" correlation="$5"
  run_sql "
    begin;
    set local role vortex_runtime;
    $(human_context "$account" "$identity" "$(current_version)" "$correlation")
    set local role vortex_request;
    select vortex_access.protected_share_race_grant('$share','$record_id','organization_account',
      '$recipient_account',null,array['$field_one']::uuid[],array[]::uuid[],pg_catalog.clock_timestamp(),
      null,'Protected share race setup share','web','$activity');
    commit;
  " >/dev/null
  [ "$(run_sql "select state||'|'||revision||'|'||granted_by from vortex_access.organization_direct_record_shares where organization_id='$organization_id' and direct_share_id='$share';")" = "active|1|$account" ] || {
    echo 'protected-share proof setup share was not created' >&2
    exit 1
  }
}
setup_share_grant "$setup_share" "$grantor_account" "$grantor_identity" "$setup_activity" "e7${run_uuid:2}"
setup_share_grant "$closing_revoker_share" "$grantor_account" "$grantor_identity" \
  "$closing_revoker_share_activity" "ee${run_uuid:2}"
setup_share_grant "$revoking_grantor_share" "$revoking_grantor_account" "$revoking_grantor_identity" \
  "$revoking_grantor_share_activity" "ef${run_uuid:2}"

# One race: a writer holds the governance lock with an uncommitted change --
# the role-assignment writer revoking an assignment, or the account-lifecycle
# writer closing an account -- and the protected operation, established at the
# pre-change Access version, must block behind it and then be refused. A stale
# operation that commits is recorded rather than fatal, so every race runs.
race_before='' race_outcome=''
race() {
  local name="$1" writer_kind="$2" writer_target="$3" account="$4" identity="$5"
  local correlation="$6" operation_sql="$7"
  local before writer_statement account_revision holder holder_db loser loser_db
  before="$(current_version)"
  case "$writer_kind" in
    assignment)
      writer_statement="select 1 from vortex_access.coordinate_organization_role_assignment_change('revoke','$organization_id',
  '$writer_target',1,null,null,null,null,null,null,null,null,'$actor_id','$correlation');"
      ;;
    closure)
      account_revision="$(run_sql "select revision from vortex_identity.organization_accounts where organization_id='$organization_id' and organization_account_id='$writer_target' and state='active';")"
      [[ "$account_revision" =~ ^[1-9][0-9]*$ ]] || {
        echo "$name race: the account to close is not active" >&2
        exit 1
      }
      writer_statement="$(human_context "$admin_account" "$admin_identity" "$before" "$correlation")
select 1 from vortex_access.change_organization_account_state('$writer_target',$account_revision,'closed');"
      ;;
    *)
      echo "$name race: unknown writer $writer_kind" >&2
      exit 1
      ;;
  esac
  started_races+=("$name")
  "${psql_command[@]}" >"$proof_root/$name-writer.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/$name-writer.pid'
$writer_statement
\! touch '$proof_root/$name-writer-ready'
\! deadline=600; while [ ! -f '$proof_root/$name-writer-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/$name-writer-release' ]
commit;
SQL
  holder=$!; worker_pids+=("$holder"); wait_for_file "$proof_root/$name-writer-ready"
  holder_db="$(read_backend_pid "$proof_root/$name-writer.pid")"

  "${psql_command[@]}" >"$proof_root/$name-operation.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/$name-operation.pid'
set local role vortex_runtime;
$(human_context "$account" "$identity" "$before" "e9${run_uuid:2}")
set local role vortex_request;
$operation_sql
commit;
SQL
  loser=$!; worker_pids+=("$loser")
  loser_db="$(read_backend_pid "$proof_root/$name-operation.pid")"
  wait_for_database_blocker "$loser_db" "$holder_db"
  touch "$proof_root/$name-writer-release"
  wait_owned_worker "$holder" || { echo "$name race: the concurrent writer failed" >&2; exit 1; }
  if wait_owned_worker "$loser"; then
    echo "$name race: the stale protected operation committed" >&2
    committed_races+=("$name")
    race_outcome=committed
  else
    race_outcome=refused
  fi
  race_before="$before"
}

# The racing operation must have been refused by a protected 42501 refusal --
# never by an unrelated error -- and the refusal is reported.
refused_by() {
  local name="$1" pattern="$2" line
  line="$(grep -E '^ERROR: +42501: ' "$proof_root/$name-operation.log" | head -n 1 || true)"
  [[ "$line" =~ $pattern ]] || {
    printf '%s race: expected a protected 42501 refusal, got: %q\n' "$name" "$line" >&2
    exit 1
  }
  printf '%s race refused: %s\n' "$name" "${line#ERROR: }"
}
readonly grant_refusals='Protected record-share grant is unavailable|Request access version is stale or unavailable|Protected record-share grant requires a current (share|read) permission|Organisation-account context is inactive or unavailable'
readonly revoke_refusals='Protected record-share revocation is unavailable|Request access version is stale or unavailable'

# What a refused race leaves behind: the Access version moved exactly once,
# by the writer and for the writer's reason; the protected operation's share
# and Activity untouched; the writer's own change in place.
share_rows() { printf "select count(*) from vortex_access.organization_direct_record_shares where organization_id='%s' and direct_share_id='%s'" "$organization_id" "$1"; }
share_state() { printf "select state||'/'||revision from vortex_access.organization_direct_record_shares where organization_id='%s' and direct_share_id='%s'" "$organization_id" "$1"; }
assignment_state() { printf "select state from vortex_access.organization_role_assignments where organization_id='%s' and role_assignment_id='%s'" "$organization_id" "$1"; }
account_state() { printf "select state from vortex_identity.organization_accounts where organization_id='%s' and organization_account_id='%s'" "$organization_id" "$1"; }
expect_refused_state() {
  local name="$1" expected="$2" share_sql="$3" activity="$4" target_sql="$5" actual
  actual="$(run_sql "select pg_catalog.concat_ws('|',
    version.current_version - $race_before, version.change_reason, ($share_sql),
    (select count(*) from vortex_activity.organization_activity_entries where organization_id='$organization_id' and activity_id='$activity'),
    ($target_sql))
    from vortex_access.organization_access_versions as version where version.organization_id='$organization_id';")"
  [ "$actual" = "$expected" ] || {
    printf '%s race left unexpected state (version delta|reason|share|Activity|writer target): %q\n' "$name" "$actual" >&2
    exit 1
  }
}

race grant assignment "$grantor_assignment" "$grantor_account" "$grantor_identity" "e8${run_uuid:2}" \
  "select vortex_access.protected_share_race_grant('$race_share','$record_id','organization_account','$recipient_account',null,array['$field_one']::uuid[],array[]::uuid[],pg_catalog.clock_timestamp(),null,'Grant racing the revocation of its own authority','web','$race_grant_activity');"
if [ "$race_outcome" = refused ]; then
  refused_by grant "$grant_refusals"
  expect_refused_state grant '1|role_assignment_changed|0|0|revoked' \
    "$(share_rows "$race_share")" "$race_grant_activity" "$(assignment_state "$grantor_assignment")"
fi

race grant-closed closure "$closing_grantor_account" "$closing_grantor_account" "$closing_grantor_identity" "b2${run_uuid:2}" \
  "select vortex_access.protected_share_race_grant('$closed_grant_share','$record_id','organization_account','$recipient_account',null,array['$field_one']::uuid[],array[]::uuid[],pg_catalog.clock_timestamp(),null,'Grant racing the closure of the grantor account','web','$closed_grant_activity');"
if [ "$race_outcome" = refused ]; then
  refused_by grant-closed "$grant_refusals"
  expect_refused_state grant-closed '1|organization_account_closed|0|0|closed' \
    "$(share_rows "$closed_grant_share")" "$closed_grant_activity" "$(account_state "$closing_grantor_account")"
fi

race revoke assignment "$revoker_assignment" "$revoker_account" "$revoker_identity" "ea${run_uuid:2}" \
  "select vortex_access.protected_share_race_revoke('$setup_share',1,'Revocation racing the revocation of its own authority','web','$race_revoke_activity');"
if [ "$race_outcome" = refused ]; then
  refused_by revoke "$revoke_refusals"
  expect_refused_state revoke '1|role_assignment_changed|active/1|0|revoked' \
    "$(share_state "$setup_share")" "$race_revoke_activity" "$(assignment_state "$revoker_assignment")"
fi

race revoke-closed closure "$closing_revoker_account" "$closing_revoker_account" "$closing_revoker_identity" "b3${run_uuid:2}" \
  "select vortex_access.protected_share_race_revoke('$closing_revoker_share',1,'Revocation racing the closure of the revoker account','web','$closed_revoke_activity');"
if [ "$race_outcome" = refused ]; then
  refused_by revoke-closed "$revoke_refusals"
  expect_refused_state revoke-closed '1|organization_account_closed|active/1|0|closed' \
    "$(share_state "$closing_revoker_share")" "$closed_revoke_activity" "$(account_state "$closing_revoker_account")"
fi

race grantor-revoke-closed closure "$revoking_grantor_account" "$revoking_grantor_account" "$revoking_grantor_identity" "b4${run_uuid:2}" \
  "select vortex_access.protected_share_race_revoke('$revoking_grantor_share',1,'Revocation by its grantor racing the closure of the grantor account','web','$closed_grantor_revoke_activity');"
if [ "$race_outcome" = refused ]; then
  refused_by grantor-revoke-closed "$revoke_refusals"
  expect_refused_state grantor-revoke-closed '1|organization_account_closed|active/1|0|closed' \
    "$(share_state "$revoking_grantor_share")" "$closed_grantor_revoke_activity" "$(account_state "$revoking_grantor_account")"
fi

if [ "${#committed_races[@]}" -ne 0 ]; then
  echo "protected record-share authority proof: stale operations committed in: ${committed_races[*]}" >&2
  exit 1
fi
echo 'protected record-share authority concurrency proof passed'
