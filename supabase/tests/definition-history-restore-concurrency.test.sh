#!/usr/bin/env bash

set -euo pipefail

readonly proof_root="$(mktemp -d /tmp/vortex-definition-history-restore.XXXXXX)"
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id='41000000-0000-4000-8000-000000000080'
readonly organization_id='42000000-0000-4000-8000-000000000080'
readonly root_id='43000000-0000-4000-8000-000000000080'
readonly save_root_id='43000000-0000-4000-8000-000000000081'
readonly restore_wins_root_id='43000000-0000-4000-8000-000000000082'
readonly publication_wins_root_id='43000000-0000-4000-8000-000000000083'
readonly actor_id='49000000-0000-4000-8000-000000000080'
readonly source_fingerprint="sha256:$(printf '1%.0s' {1..64})"
readonly identity_requirements='[{"definitionKey":"example.history_restore_proof","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.history_restore_proof"]}]'

psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then
  psql_command+=("$database_url")
fi

run_sql() {
  "${psql_command[@]}" --command "$1"
}

cleanup() {
  local pid
  while read -r pid; do
    kill "$pid" >/dev/null 2>&1 || true
  done < <(jobs -pr)
  run_sql "
    begin;
    set local session_replication_role = replica;
    drop function if exists public.vortex_test_history_restore_context();
    drop function if exists public.vortex_test_history_restore_release_payload(
      uuid, text, text, text, text, text
    );
    update vortex_definition.roots
      set current_release_revision = null
      where root_id in ('$root_id', '$save_root_id', '$restore_wins_root_id', '$publication_wins_root_id');
    delete from vortex_definition.releases
      where root_id in ('$root_id', '$save_root_id', '$restore_wins_root_id', '$publication_wins_root_id');
    delete from vortex_definition.source_identity_aliases
      where root_id in ('$root_id', '$save_root_id', '$restore_wins_root_id', '$publication_wins_root_id');
    delete from vortex_definition.source_identities
      where root_id in ('$root_id', '$save_root_id', '$restore_wins_root_id', '$publication_wins_root_id');
    delete from vortex_definition.drafts
      where root_id in ('$root_id', '$save_root_id', '$restore_wins_root_id', '$publication_wins_root_id');
    delete from vortex_definition.roots
      where root_id in ('$root_id', '$save_root_id', '$restore_wins_root_id', '$publication_wins_root_id');
    delete from vortex_identity.organizations where organization_id = '$organization_id';
    delete from vortex_identity.tenants where tenant_id = '$tenant_id';
    commit;
  " >/dev/null 2>&1 || true
  case "$proof_root" in
    /tmp/vortex-definition-history-restore.*) rm -r -- "$proof_root" ;;
    *) echo 'refusing to remove an unexpected proof directory' >&2 ;;
  esac
}
trap cleanup EXIT

wait_for_file() {
  local candidate="$1"
  local attempt
  for attempt in $(seq 1 200); do
    [ -f "$candidate" ] && return 0
    sleep 0.05
  done
  echo 'definition history restore proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'definition history restore proof captured an invalid backend identifier: %q\n' \
      "$backend_pid" >&2
    return 1
  }
  printf '%s\n' "$backend_pid"
}

wait_for_database_blocker() {
  local blocked_pid="$1"
  local blocking_pid="$2"
  local description="$3"
  local deadline=$((SECONDS + 20))
  while ((SECONDS < deadline)); do
    if [ "$(run_sql "
      select case
        when $blocking_pid = any(pg_catalog.pg_blocking_pids($blocked_pid)) then 'blocked'
        else ''
      end;
    ")" = 'blocked' ]; then
      return 0
    fi
    sleep 0.1
  done
  echo "$description did not wait on the expected transaction" >&2
  return 1
}

assert_failed_with_state() {
  local pid="$1"
  local log_file="$2"
  local state="$3"
  local message="$4"
  if wait "$pid"; then
    echo 'the expected stale operation unexpectedly committed' >&2
    return 1
  fi
  grep -q "$state" "$log_file" || {
    echo "the stale operation failed without SQLSTATE $state" >&2
    return 1
  }
  grep -Fq "$message" "$log_file" || {
    echo 'the stale operation failed without its stable invariant message' >&2
    return 1
  }
}

run_sql "
  create function public.vortex_test_history_restore_context()
  returns jsonb
  language sql
  volatile
  set search_path = ''
  as \$function\$
    select pg_catalog.jsonb_build_object(
      'callerKind', 'system',
      'tenantId', '$tenant_id'::uuid,
      'organizationId', '$organization_id'::uuid,
      'sessionId', '46000000-0000-4000-8000-000000000080'::uuid,
      'issuedAt', pg_catalog.clock_timestamp() - interval '1 minute',
      'expiresAt', pg_catalog.clock_timestamp() + interval '10 minutes',
      'accessVersion', 1,
      'correlationId', '47000000-0000-4000-8000-000000000080'::uuid,
      'systemActorId', '$actor_id'::uuid,
      'authenticationStrength', 'service'
    )
  \$function\$;

  grant execute on function public.vortex_test_history_restore_context() to vortex_runtime;

  create function public.vortex_test_history_restore_release_payload(
    p_root_id uuid,
    p_key text,
    p_version text,
    p_marker text,
    p_content_character text,
    p_resolution_character text
  )
  returns jsonb
  language sql
  stable
  set search_path = ''
  as \$function\$
    select pg_catalog.jsonb_build_object(
      'releaseVersion', p_version,
      'compilationOutput', pg_catalog.jsonb_build_object(
        'kind', 'module',
        'resolutionFingerprint', 'sha256:' || pg_catalog.repeat(p_resolution_character, 64),
        'artifact', pg_catalog.jsonb_build_object(
          'kind', 'module',
          'rootId', p_root_id,
          'definitionKey', p_key,
          'exactVersion', p_version,
          'contentFingerprint', 'sha256:' || pg_catalog.repeat(p_content_character, 64),
          'resolutionFingerprint', 'sha256:' || pg_catalog.repeat(p_resolution_character, 64)
        ),
        'canonical', pg_catalog.jsonb_build_object(
          'envelope', pg_catalog.jsonb_build_object(
            'kind', 'module',
            'key', p_key,
            'rootId', p_root_id,
            'organizationId', '$organization_id'::uuid
          ),
          'content', pg_catalog.jsonb_build_object('marker', p_marker)
        )
      ),
      'resolutionSnapshot', pg_catalog.jsonb_build_object(
        'contractVersion', '1.0.0',
        'fingerprint', 'sha256:' || pg_catalog.repeat(p_resolution_character, 64),
        'definitions', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'kind', 'module',
          'key', p_key,
          'rootId', p_root_id,
          'exactVersion', p_version
        )),
        'identities', '[]'::jsonb
      ),
      'contentFingerprint', 'sha256:' || pg_catalog.repeat(p_content_character, 64),
      'resolutionFingerprint', 'sha256:' || pg_catalog.repeat(p_resolution_character, 64),
      'validationContractVersion', '1.0.0',
      'comparisonFingerprint', 'sha256:' || pg_catalog.repeat('9', 64),
      'impactReasons', '[]'::jsonb,
      'releaseNote', 'Generic concurrency proof release',
      'dependencies', '[]'::jsonb
    )
  \$function\$;
  grant execute on function public.vortex_test_history_restore_release_payload(
    uuid, text, text, text, text, text
  ) to vortex_request;

  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', 'history_restore_proof', 'History restore proof', 'active',
    pg_catalog.clock_timestamp(), '$actor_id', pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, parent_organization_id, short_name, display_name,
    state, created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', null, 'history_restore_proof_org',
    'History restore proof organisation', 'active', pg_catalog.clock_timestamp(),
    '$actor_id', pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_definition.roots (
    root_id, organization_id, kind, key, created_at, created_by
  ) values (
    '$root_id', '$organization_id', 'module', 'example.history_restore_proof',
    pg_catalog.clock_timestamp(), '$actor_id'
  ), (
    '$save_root_id', '$organization_id', 'module', 'example.history_save_proof',
    pg_catalog.clock_timestamp(), '$actor_id'
  ), (
    '$restore_wins_root_id', '$organization_id', 'module', 'example.restore_publication_proof',
    pg_catalog.clock_timestamp(), '$actor_id'
  ), (
    '$publication_wins_root_id', '$organization_id', 'module', 'example.publication_restore_proof',
    pg_catalog.clock_timestamp(), '$actor_id'
  );
  insert into vortex_definition.drafts (
    root_id, draft_revision, draft_source, identity_requirements,
    source_contract_version, source_fingerprint, updated_at, updated_by
  ) values (
    '$root_id', 1,
    '{\"source_contract_version\":\"1.0.0\",\"kind\":\"module\",\"key\":\"example.history_restore_proof\",\"body\":{\"marker\":\"draft\"}}',
    '$identity_requirements'::jsonb,
    '1.0.0', 'sha256:$(printf 'd%.0s' {1..64})', pg_catalog.clock_timestamp(), '$actor_id'
  ), (
    '$save_root_id', 1,
    '{\"source_contract_version\":\"1.0.0\",\"kind\":\"module\",\"key\":\"example.history_save_proof\",\"body\":{\"marker\":\"save-draft\"}}',
    '[{\"definitionKey\":\"example.history_save_proof\",\"ownerScope\":\"document\",\"scope\":\"document\",\"kind\":\"root\",\"componentOwner\":\"root\",\"aliases\":[\"example.history_save_proof\"]}]'::jsonb,
    '1.0.0', 'sha256:$(printf 'd%.0s' {1..64})', pg_catalog.clock_timestamp(), '$actor_id'
  ), (
    '$restore_wins_root_id', 1,
    '{\"source_contract_version\":\"1.0.0\",\"kind\":\"module\",\"key\":\"example.restore_publication_proof\",\"body\":{\"marker\":\"restore-wins-draft\"}}',
    '[{\"definitionKey\":\"example.restore_publication_proof\",\"ownerScope\":\"document\",\"scope\":\"document\",\"kind\":\"root\",\"componentOwner\":\"root\",\"aliases\":[\"example.restore_publication_proof\"]}]'::jsonb,
    '1.0.0', 'sha256:$(printf 'd%.0s' {1..64})', pg_catalog.clock_timestamp(), '$actor_id'
  ), (
    '$publication_wins_root_id', 1,
    '{\"source_contract_version\":\"1.0.0\",\"kind\":\"module\",\"key\":\"example.publication_restore_proof\",\"body\":{\"marker\":\"publication-first\"}}',
    '[{\"definitionKey\":\"example.publication_restore_proof\",\"ownerScope\":\"document\",\"scope\":\"document\",\"kind\":\"root\",\"componentOwner\":\"root\",\"aliases\":[\"example.publication_restore_proof\"]}]'::jsonb,
    '1.0.0', 'sha256:$(printf '3%.0s' {1..64})', pg_catalog.clock_timestamp(), '$actor_id'
  );
  insert into vortex_definition.source_identities (
    identity_id, root_id, owner_scope, kind, component_owner, created_at, created_by
  ) values (
    '$root_id', '$root_id', 'document', 'root', 'root', pg_catalog.clock_timestamp(), '$actor_id'
  ), (
    '$save_root_id', '$save_root_id', 'document', 'root', 'root', pg_catalog.clock_timestamp(), '$actor_id'
  ), (
    '$restore_wins_root_id', '$restore_wins_root_id', 'document', 'root', 'root', pg_catalog.clock_timestamp(), '$actor_id'
  ), (
    '$publication_wins_root_id', '$publication_wins_root_id', 'document', 'root', 'root', pg_catalog.clock_timestamp(), '$actor_id'
  );
  insert into vortex_definition.source_identity_aliases (
    root_id, owner_scope, scope, kind, alias, component_owner, identity_id, created_at, created_by
  ) values (
    '$root_id', 'document', 'document', 'root', 'example.history_restore_proof',
    'root', '$root_id', pg_catalog.clock_timestamp(), '$actor_id'
  ), (
    '$save_root_id', 'document', 'document', 'root', 'example.history_save_proof',
    'root', '$save_root_id', pg_catalog.clock_timestamp(), '$actor_id'
  ), (
    '$restore_wins_root_id', 'document', 'document', 'root', 'example.restore_publication_proof',
    'root', '$restore_wins_root_id', pg_catalog.clock_timestamp(), '$actor_id'
  ), (
    '$publication_wins_root_id', 'document', 'document', 'root', 'example.publication_restore_proof',
    'root', '$publication_wins_root_id', pg_catalog.clock_timestamp(), '$actor_id'
  );
  insert into vortex_definition.releases (
    root_id, release_revision, release_version, authored_source,
    authored_source_fingerprint, source_contract_version, compilation_output,
    resolution_snapshot, content_fingerprint, resolution_fingerprint,
    validation_contract_version, comparison_fingerprint, impact_reasons,
    release_note, published_at, published_by
  ) values
  (
    '$root_id', 1, '1.0.0',
    '{\"source_contract_version\":\"1.0.0\",\"kind\":\"module\",\"key\":\"example.history_restore_proof\",\"body\":{\"marker\":\"old\"}}',
    '$source_fingerprint', '1.0.0',
    '{\"kind\":\"module\",\"canonical\":{\"content\":{\"marker\":\"old\"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:$(printf 'a%.0s' {1..64})'),
    'sha256:$(printf 'b%.0s' {1..64})', 'sha256:$(printf 'a%.0s' {1..64})',
    '1.0.0', 'sha256:$(printf 'c%.0s' {1..64})', '[]', 'Original generic release',
    pg_catalog.clock_timestamp(), '$actor_id'
  ),
  (
    '$root_id', 2, '1.1.0',
    '{\"source_contract_version\":\"1.0.0\",\"kind\":\"module\",\"key\":\"example.history_restore_proof\",\"body\":{\"marker\":\"current\"}}',
    'sha256:$(printf '2%.0s' {1..64})', '1.0.0',
    '{\"kind\":\"module\",\"canonical\":{\"content\":{\"marker\":\"current\"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:$(printf 'e%.0s' {1..64})'),
    'sha256:$(printf 'f%.0s' {1..64})', 'sha256:$(printf 'e%.0s' {1..64})',
    '1.0.0', 'sha256:$(printf '0%.0s' {1..64})', '[]', 'Current generic release',
    pg_catalog.clock_timestamp(), '$actor_id'
  );
  update vortex_definition.roots set current_release_revision = 2 where root_id = '$root_id';
  with release_seed(root_id, definition_key, source_fingerprint, marker, content_character, resolution_character) as (
    values
      ('$save_root_id'::uuid, 'example.history_save_proof', 'sha256:$(printf '1%.0s' {1..64})', 'save-old', '1', 'a'),
      ('$restore_wins_root_id'::uuid, 'example.restore_publication_proof', 'sha256:$(printf '2%.0s' {1..64})', 'restore-wins-old', '2', 'b')
  ), payload as (
    select
      release_seed.*,
      public.vortex_test_history_restore_release_payload(
        root_id, definition_key, '1.0.0', marker, content_character, resolution_character
      ) as value
    from release_seed
  )
  insert into vortex_definition.releases (
    root_id, release_revision, release_version, authored_source,
    authored_source_fingerprint, source_contract_version, compilation_output,
    resolution_snapshot, content_fingerprint, resolution_fingerprint,
    validation_contract_version, comparison_fingerprint, impact_reasons,
    release_note, published_at, published_by
  )
  select
    root_id,
    1,
    value ->> 'releaseVersion',
    pg_catalog.jsonb_build_object(
      'source_contract_version', '1.0.0',
      'kind', 'module',
      'key', definition_key,
      'body', pg_catalog.jsonb_build_object('marker', marker)
    ),
    source_fingerprint,
    '1.0.0',
    value -> 'compilationOutput',
    value -> 'resolutionSnapshot',
    value ->> 'contentFingerprint',
    value ->> 'resolutionFingerprint',
    value ->> 'validationContractVersion',
    value ->> 'comparisonFingerprint',
    value -> 'impactReasons',
    value ->> 'releaseNote',
    pg_catalog.clock_timestamp(),
    '$actor_id'::uuid
  from payload;
  update vortex_definition.roots
  set current_release_revision = 1
  where root_id in ('$save_root_id', '$restore_wins_root_id');
" >/dev/null

PGAPPNAME='vortex-history-restore-first' "${psql_command[@]}" >"$proof_root/first.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/first.pid'
set local role vortex_runtime;
select vortex_context.initialize(public.vortex_test_history_restore_context());
set local role vortex_request;
select coalesce(
  vortex_definition.restore_release_draft(
    'module', '$root_id', 1, 1, '$source_fingerprint', '$identity_requirements'::jsonb
  ) ->> 'draftRevision',
  'stale'
);
\! touch '$proof_root/first-ready'
\! while [ ! -f '$proof_root/first-release' ]; do sleep 0.05; done
commit;
SQL
first_pid=$!
wait_for_file "$proof_root/first-ready"
first_backend_pid="$(read_backend_pid "$proof_root/first.pid")"

PGAPPNAME='vortex-history-restore-stale' "${psql_command[@]}" >"$proof_root/stale.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/stale.pid'
set local lock_timeout = '30s';
set local role vortex_runtime;
select vortex_context.initialize(public.vortex_test_history_restore_context());
set local role vortex_request;
select coalesce(
  vortex_definition.restore_release_draft(
    'module', '$root_id', 1, 1, '$source_fingerprint', '$identity_requirements'::jsonb
  ) ->> 'draftRevision',
  'stale'
);
commit;
SQL
stale_pid=$!
stale_backend_pid="$(read_backend_pid "$proof_root/stale.pid")"
wait_for_database_blocker "$stale_backend_pid" "$first_backend_pid" 'the competing restore'

touch "$proof_root/first-release"
wait "$first_pid"
wait "$stale_pid"

grep -qx '2' "$proof_root/first.log" || {
  echo 'the first restore did not return the one advanced draft revision' >&2
  exit 1
}
grep -qx 'stale' "$proof_root/stale.log" || {
  echo 'the competing restore did not return the stale-draft outcome' >&2
  exit 1
}

[ "$(run_sql "
  select pg_catalog.concat_ws(':',
    draft.draft_revision,
    draft.draft_source #>> '{body,marker}',
    draft.restored_from_release_revision,
    root.current_release_revision,
    (select count(*) from vortex_definition.releases where root_id = '$root_id'),
    (select count(*) from vortex_definition.source_identities where root_id = '$root_id'),
    (select count(*) from vortex_definition.source_identity_aliases where root_id = '$root_id')
  )
  from vortex_definition.drafts as draft
  join vortex_definition.roots as root on root.root_id = draft.root_id
  where draft.root_id = '$root_id';
")" = '2:old:1:2:2:1:1' ] || {
  echo 'the competing restores did not preserve one restored draft and immutable surrounding state' >&2
  exit 1
}

# A restore and an ordinary save both target draft revision 1. The save must
# wait on the restore, then return its ordinary stale result without allocating
# identities or making a second same-revision mutation.
PGAPPNAME='vortex-history-restore-save-first' "${psql_command[@]}" >"$proof_root/restore-save-first.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/restore-save-first.pid'
set local role vortex_runtime;
select vortex_context.initialize(public.vortex_test_history_restore_context());
set local role vortex_request;
select coalesce(
  vortex_definition.restore_release_draft(
    'module', '$save_root_id', 1, 1, 'sha256:$(printf '1%.0s' {1..64})',
    '[{"definitionKey":"example.history_save_proof","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.history_save_proof"]}]'::jsonb
  ) ->> 'draftRevision',
  'stale'
);
\! touch '$proof_root/restore-save-first-ready'
\! while [ ! -f '$proof_root/restore-save-first-release' ]; do sleep 0.05; done
commit;
SQL
restore_save_first_pid=$!
wait_for_file "$proof_root/restore-save-first-ready"
restore_save_first_backend_pid="$(read_backend_pid "$proof_root/restore-save-first.pid")"

PGAPPNAME='vortex-history-restore-save-stale' "${psql_command[@]}" >"$proof_root/restore-save-stale.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/restore-save-stale.pid'
set local lock_timeout = '30s';
set local role vortex_runtime;
select vortex_context.initialize(public.vortex_test_history_restore_context());
set local role vortex_request;
select coalesce((
  select draft_revision::text
  from vortex_definition.save_draft(
    '$save_root_id', 1,
    '{"source_contract_version":"1.0.0","kind":"module","key":"example.history_save_proof","body":{"marker":"ordinary-save"}}'::jsonb,
    'sha256:$(printf 'e%.0s' {1..64})',
    '[{"definitionKey":"example.history_save_proof","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.history_save_proof"]}]'::jsonb
  )
), 'stale');
commit;
SQL
restore_save_stale_pid=$!
restore_save_stale_backend_pid="$(read_backend_pid "$proof_root/restore-save-stale.pid")"
wait_for_database_blocker "$restore_save_stale_backend_pid" "$restore_save_first_backend_pid" 'the competing ordinary save'
touch "$proof_root/restore-save-first-release"
wait "$restore_save_first_pid"
wait "$restore_save_stale_pid"

grep -qx '2' "$proof_root/restore-save-first.log" || {
  echo 'the restore did not win the restore-versus-save race' >&2
  exit 1
}
grep -qx 'stale' "$proof_root/restore-save-stale.log" || {
  echo 'the competing ordinary save did not return the stale outcome' >&2
  exit 1
}
[ "$(run_sql "
  select pg_catalog.concat_ws(':',
    draft.draft_revision,
    draft.draft_source #>> '{body,marker}',
    draft.restored_from_release_revision,
    root.current_release_revision,
    (select count(*) from vortex_definition.releases where root_id = '$save_root_id'),
    (select count(*) from vortex_definition.source_identities where root_id = '$save_root_id'),
    (select count(*) from vortex_definition.source_identity_aliases where root_id = '$save_root_id')
  )
  from vortex_definition.drafts as draft
  join vortex_definition.roots as root on root.root_id = draft.root_id
  where draft.root_id = '$save_root_id';
")" = '2:save-old:1:1:1:1:1' ] || {
  echo 'restore-versus-save did not preserve exactly one draft mutation and its surrounding immutable state' >&2
  exit 1
}

# The publication payload is prepared first, but restore obtains the draft lock
# first. Once restore commits, append_release must refuse the stale source and
# revision rather than publishing a mixed snapshot.
PGAPPNAME='vortex-history-publication-prepared' "${psql_command[@]}" >"$proof_root/publication-prepared.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/publication-prepared.pid'
\! touch '$proof_root/publication-prepared-ready'
\! while [ ! -f '$proof_root/publication-prepared-attempt' ]; do sleep 0.05; done
set local lock_timeout = '30s';
set local role vortex_runtime;
select vortex_context.initialize(public.vortex_test_history_restore_context());
set local role vortex_request;
select * from vortex_definition.append_release(
  '$restore_wins_root_id', 1, 'sha256:$(printf 'd%.0s' {1..64})',
  public.vortex_test_history_restore_release_payload(
    '$restore_wins_root_id', 'example.restore_publication_proof', '1.1.0', 'prepared-publication', '4', '5'
  )
);
commit;
SQL
publication_prepared_pid=$!
publication_prepared_backend_pid="$(read_backend_pid "$proof_root/publication-prepared.pid")"
wait_for_file "$proof_root/publication-prepared-ready"

PGAPPNAME='vortex-history-restore-before-publication' "${psql_command[@]}" >"$proof_root/restore-before-publication.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/restore-before-publication.pid'
set local role vortex_runtime;
select vortex_context.initialize(public.vortex_test_history_restore_context());
set local role vortex_request;
select coalesce(
  vortex_definition.restore_release_draft(
    'module', '$restore_wins_root_id', 1, 1, 'sha256:$(printf '2%.0s' {1..64})',
    '[{"definitionKey":"example.restore_publication_proof","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.restore_publication_proof"]}]'::jsonb
  ) ->> 'draftRevision',
  'stale'
);
\! touch '$proof_root/restore-before-publication-ready'
\! while [ ! -f '$proof_root/restore-before-publication-release' ]; do sleep 0.05; done
commit;
SQL
restore_before_publication_pid=$!
wait_for_file "$proof_root/restore-before-publication-ready"
restore_before_publication_backend_pid="$(read_backend_pid "$proof_root/restore-before-publication.pid")"
touch "$proof_root/publication-prepared-attempt"
wait_for_database_blocker "$publication_prepared_backend_pid" "$restore_before_publication_backend_pid" 'the prepared stale publication'
touch "$proof_root/restore-before-publication-release"
wait "$restore_before_publication_pid"
assert_failed_with_state "$publication_prepared_pid" "$proof_root/publication-prepared.log" '40001' \
  'Definition release append is stale or source evidence was substituted'

grep -qx '2' "$proof_root/restore-before-publication.log" || {
  echo 'restore did not win before the prepared publication attempted its append' >&2
  exit 1
}
[ "$(run_sql "
  select pg_catalog.concat_ws(':',
    draft.draft_revision,
    draft.draft_source #>> '{body,marker}',
    root.current_release_revision,
    (select count(*) from vortex_definition.releases where root_id = '$restore_wins_root_id')
  )
  from vortex_definition.drafts as draft
  join vortex_definition.roots as root on root.root_id = draft.root_id
  where draft.root_id = '$restore_wins_root_id';
")" = '2:restore-wins-old:1:1' ] || {
  echo 'a stale prepared publication changed the restore-winning root' >&2
  exit 1
}

# Here append_release commits first. A subsequent independent restore creates
# the next editable draft from the just-published immutable source while
# preserving the newly advanced current-release pointer.
PGAPPNAME='vortex-history-publication-first' "${psql_command[@]}" >"$proof_root/publication-first.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/publication-first.pid'
set local role vortex_runtime;
select vortex_context.initialize(public.vortex_test_history_restore_context());
set local role vortex_request;
select * from vortex_definition.append_release(
  '$publication_wins_root_id', 1, 'sha256:$(printf '3%.0s' {1..64})',
  public.vortex_test_history_restore_release_payload(
    '$publication_wins_root_id', 'example.publication_restore_proof', '1.0.0', 'publication-first', '6', '7'
  )
);
\! touch '$proof_root/publication-first-ready'
\! while [ ! -f '$proof_root/publication-first-release' ]; do sleep 0.05; done
commit;
SQL
publication_first_pid=$!
wait_for_file "$proof_root/publication-first-ready"
touch "$proof_root/publication-first-release"
wait "$publication_first_pid"

PGAPPNAME='vortex-history-restore-after-publication' "${psql_command[@]}" >"$proof_root/restore-after-publication.log" 2>&1 <<SQL
\set VERBOSITY verbose
begin;
set local role vortex_runtime;
select vortex_context.initialize(public.vortex_test_history_restore_context());
set local role vortex_request;
select coalesce(
  vortex_definition.restore_release_draft(
    'module', '$publication_wins_root_id', 1, 1, 'sha256:$(printf '3%.0s' {1..64})',
    '[{"definitionKey":"example.publication_restore_proof","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.publication_restore_proof"]}]'::jsonb
  ) ->> 'draftRevision',
  'stale'
);
commit;
SQL

grep -qx '2' "$proof_root/restore-after-publication.log" || {
  echo 'the restore after publication did not create the next draft revision' >&2
  exit 1
}
[ "$(run_sql "
  select pg_catalog.concat_ws(':',
    draft.draft_revision,
    draft.draft_source #>> '{body,marker}',
    draft.restored_from_release_revision,
    root.current_release_revision,
    (select count(*) from vortex_definition.releases where root_id = '$publication_wins_root_id'),
    (select count(*) from vortex_definition.source_identities where root_id = '$publication_wins_root_id'),
    (select count(*) from vortex_definition.source_identity_aliases where root_id = '$publication_wins_root_id')
  )
  from vortex_definition.drafts as draft
  join vortex_definition.roots as root on root.root_id = draft.root_id
  where draft.root_id = '$publication_wins_root_id';
")" = '2:publication-first:1:1:1:1:1' ] || {
  echo 'publication-first then restore did not preserve the published pointer and one next draft' >&2
  exit 1
}

echo 'Definition history restore concurrency proof passed'
