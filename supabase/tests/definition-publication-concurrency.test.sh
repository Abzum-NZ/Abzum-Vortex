#!/usr/bin/env bash

set -euo pipefail

readonly proof_root="$(mktemp -d /tmp/vortex-definition-publication.XXXXXX)"
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id='41000000-0000-4000-8000-000000000019'
readonly organization_id='42000000-0000-4000-8000-000000000019'
readonly module_root_id='43000000-0000-4000-8000-000000000019'
readonly race_application_root_id='43000000-0000-4000-8000-000000000020'
readonly pinned_application_root_id='43000000-0000-4000-8000-000000000021'
readonly actor_id='49000000-0000-4000-8000-000000000019'

psql_command=(psql --no-psqlrc --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then
  psql_command+=("$database_url")
fi

run_sql() {
  "${psql_command[@]}" --quiet --tuples-only --no-align --command "$1"
}

cleanup() {
  local pid
  while read -r pid; do
    kill "$pid" >/dev/null 2>&1 || true
  done < <(jobs -pr)
  run_sql "
    begin;
    set local session_replication_role = replica;
    drop function if exists public.vortex_test_definition_release_payload(
      text, uuid, text, uuid, bigint, text, text, text, text, jsonb
    );
    drop function if exists public.vortex_test_definition_context();
    delete from vortex_definition.release_dependencies
      where root_id in ('$module_root_id', '$race_application_root_id', '$pinned_application_root_id');
    update vortex_definition.roots set current_release_revision = null
      where root_id in ('$module_root_id', '$race_application_root_id', '$pinned_application_root_id');
    delete from vortex_definition.releases
      where root_id in ('$module_root_id', '$race_application_root_id', '$pinned_application_root_id');
    delete from vortex_definition.source_identity_aliases
      where root_id in ('$module_root_id', '$race_application_root_id', '$pinned_application_root_id');
    delete from vortex_definition.source_identities
      where root_id in ('$module_root_id', '$race_application_root_id', '$pinned_application_root_id');
    delete from vortex_definition.drafts
      where root_id in ('$module_root_id', '$race_application_root_id', '$pinned_application_root_id');
    delete from vortex_definition.roots
      where root_id in ('$module_root_id', '$race_application_root_id', '$pinned_application_root_id');
    delete from vortex_identity.organizations where organization_id = '$organization_id';
    delete from vortex_identity.tenants where tenant_id = '$tenant_id';
    commit;
  " >/dev/null 2>&1 || true
  case "$proof_root" in
    /tmp/vortex-definition-publication.*) rm -r -- "$proof_root" ;;
    *) echo "refusing to remove an unexpected proof directory" >&2 ;;
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
  echo "definition publication proof did not reach its transaction barrier" >&2
  return 1
}

wait_for_database_lock() {
  local application_name="$1"
  local attempt
  local wait_type
  for attempt in $(seq 1 200); do
    wait_type="$(run_sql "
      select coalesce(wait_event_type, '')
      from pg_catalog.pg_stat_activity
      where datname = current_database()
        and application_name = '$application_name'
        and state = 'active';
    ")"
    if [ "$wait_type" = 'Lock' ]; then
      return 0
    fi
    sleep 0.05
  done
  echo "the second publication did not wait for the root lock" >&2
  return 1
}

assert_failed_with_state() {
  local pid="$1"
  local log_file="$2"
  local state="$3"
  if wait "$pid"; then
    echo "a conflicting publication unexpectedly committed" >&2
    return 1
  fi
  grep -q "$state" "$log_file" || {
    echo "the conflicting publication failed without SQLSTATE $state" >&2
    return 1
  }
}

run_sql "
  create function public.vortex_test_definition_context()
  returns jsonb
  language sql
  volatile
  set search_path = ''
  as \$function\$
    select pg_catalog.jsonb_build_object(
      'callerKind', 'system',
      'tenantId', '$tenant_id'::uuid,
      'organizationId', '$organization_id'::uuid,
      'sessionId', '46000000-0000-4000-8000-000000000019'::uuid,
      'issuedAt', pg_catalog.clock_timestamp() - interval '1 minute',
      'expiresAt', pg_catalog.clock_timestamp() + interval '10 minutes',
      'accessVersion', 1,
      'correlationId', '47000000-0000-4000-8000-000000000019'::uuid,
      'systemActorId', '$actor_id'::uuid,
      'authenticationStrength', 'service'
    )
  \$function\$;

  create function public.vortex_test_definition_release_payload(
    p_kind text,
    p_root_id uuid,
    p_key text,
    p_organization_id uuid,
    p_revision bigint,
    p_version text,
    p_content_character text,
    p_resolution_character text,
    p_comparison_character text,
    p_dependencies jsonb
  )
  returns jsonb
  language sql
  stable
  set search_path = ''
  as \$function\$
    select pg_catalog.jsonb_build_object(
      'releaseVersion', p_version,
      'compilationOutput', pg_catalog.jsonb_build_object(
        'kind', p_kind,
        'resolutionFingerprint', 'sha256:' || pg_catalog.repeat(p_resolution_character, 64),
        'artifact', pg_catalog.jsonb_build_object(
          'kind', p_kind,
          'rootId', p_root_id,
          'definitionKey', p_key,
          'exactVersion', p_version,
          'contentFingerprint', 'sha256:' || pg_catalog.repeat(p_content_character, 64),
          'resolutionFingerprint', 'sha256:' || pg_catalog.repeat(p_resolution_character, 64)
        ),
        'canonical', pg_catalog.jsonb_build_object(
          'envelope', pg_catalog.jsonb_build_object(
            'kind', p_kind,
            'key', p_key,
            'rootId', p_root_id,
            'organizationId', p_organization_id
          ),
          'content', '{}'::jsonb
        )
      ),
      'resolutionSnapshot', pg_catalog.jsonb_build_object(
        'contractVersion', '1.0.0',
        'fingerprint', 'sha256:' || pg_catalog.repeat(p_resolution_character, 64),
        'definitions', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'kind', p_kind,
          'key', p_key,
          'rootId', p_root_id,
          'exactVersion', p_version
        )),
        'identities', '[]'::jsonb
      ),
      'contentFingerprint', 'sha256:' || pg_catalog.repeat(p_content_character, 64),
      'resolutionFingerprint', 'sha256:' || pg_catalog.repeat(p_resolution_character, 64),
      'validationContractVersion', '1.0.0',
      'comparisonFingerprint', 'sha256:' || pg_catalog.repeat(p_comparison_character, 64),
      'impactReasons', '[]'::jsonb,
      'releaseNote', 'Definition concurrency proof release ' || p_revision,
      'dependencies', p_dependencies
    )
  \$function\$;

  grant execute on function public.vortex_test_definition_context() to vortex_runtime;
  grant execute on function public.vortex_test_definition_release_payload(
    text, uuid, text, uuid, bigint, text, text, text, text, jsonb
  ) to vortex_request;

  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', 'definition_concurrency', 'Definition concurrency', 'active',
    pg_catalog.clock_timestamp(), '$actor_id', pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, parent_organization_id, short_name, display_name,
    state, created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', null, 'definition_concurrency_org',
    'Definition concurrency organization', 'active', pg_catalog.clock_timestamp(),
    '$actor_id', pg_catalog.clock_timestamp(), 1
  );

  insert into vortex_definition.roots (
    root_id, organization_id, kind, key, created_at, created_by
  ) values
    ('$module_root_id', '$organization_id', 'module', 'example.concurrent_module',
      pg_catalog.clock_timestamp(), '$actor_id'),
    ('$race_application_root_id', '$organization_id', 'application', 'example.concurrent_application',
      pg_catalog.clock_timestamp(), '$actor_id'),
    ('$pinned_application_root_id', '$organization_id', 'application', 'example.pinned_application',
      pg_catalog.clock_timestamp(), '$actor_id');

  insert into vortex_definition.drafts (
    root_id, draft_revision, draft_source, source_contract_version,
    source_fingerprint, updated_at, updated_by
  ) values
    ('$module_root_id', 2,
      '{\"source_contract_version\":\"1.0.0\",\"kind\":\"module\",\"key\":\"example.concurrent_module\",\"body\":{}}'::jsonb,
      '1.0.0', 'sha256:' || pg_catalog.repeat('a', 64), pg_catalog.clock_timestamp(), '$actor_id'),
    ('$race_application_root_id', 1,
      '{\"source_contract_version\":\"1.0.0\",\"kind\":\"application\",\"key\":\"example.concurrent_application\",\"body\":{}}'::jsonb,
      '1.0.0', 'sha256:' || pg_catalog.repeat('b', 64), pg_catalog.clock_timestamp(), '$actor_id'),
    ('$pinned_application_root_id', 1,
      '{\"source_contract_version\":\"1.0.0\",\"kind\":\"application\",\"key\":\"example.pinned_application\",\"body\":{}}'::jsonb,
      '1.0.0', 'sha256:' || pg_catalog.repeat('c', 64), pg_catalog.clock_timestamp(), '$actor_id');

  with payload as (
    select public.vortex_test_definition_release_payload(
      'module', '$module_root_id', 'example.concurrent_module', '$organization_id',
      1, '1.0.0', 'd', 'e', 'f', '[]'::jsonb
    ) as value
  )
  insert into vortex_definition.releases (
    root_id, release_revision, release_version, authored_source,
    authored_source_fingerprint, source_contract_version, compilation_output,
    resolution_snapshot, content_fingerprint, resolution_fingerprint,
    validation_contract_version, comparison_fingerprint, impact_reasons,
    release_note, published_at, published_by
  )
  select
    '$module_root_id', 1, value ->> 'releaseVersion',
    '{\"source_contract_version\":\"1.0.0\",\"kind\":\"module\",\"key\":\"example.concurrent_module\",\"body\":{}}'::jsonb,
    'sha256:' || pg_catalog.repeat('9', 64), '1.0.0', value -> 'compilationOutput',
    value -> 'resolutionSnapshot', value ->> 'contentFingerprint',
    value ->> 'resolutionFingerprint', value ->> 'validationContractVersion',
    value ->> 'comparisonFingerprint', value -> 'impactReasons',
    'Initial exact Module release', pg_catalog.clock_timestamp(), '$actor_id'
  from payload;
  update vortex_definition.roots set current_release_revision = 1
    where root_id = '$module_root_id';
" >/dev/null

module_one_dependency="$(run_sql "
  select pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'kind', 'module',
    'key', 'example.concurrent_module',
    'rootId', '$module_root_id'::uuid,
    'releaseRevision', 1,
    'releaseVersion', '1.0.0',
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('d', 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('e', 64)
  ));
")"

# Both transactions publish the same draft. The second waits on the same root,
# then observes the first committed release and fails without a partial effect.
PGAPPNAME='vortex-definition-publication-a' "${psql_command[@]}" >"$proof_root/publication-a.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local role vortex_runtime;
select vortex_context.initialize(public.vortex_test_definition_context());
set local role vortex_request;
select * from vortex_definition.append_release(
  '$race_application_root_id', 1, 'sha256:$(printf 'b%.0s' {1..64})',
  public.vortex_test_definition_release_payload(
    'application', '$race_application_root_id', 'example.concurrent_application',
    '$organization_id', 1, '1.0.0', '1', '2', '3', '$module_one_dependency'::jsonb
  )
);
\! touch '$proof_root/publication-a-ready'
\! while [ ! -f '$proof_root/publication-a-release' ]; do sleep 0.05; done
commit;
SQL
publication_a_pid=$!
wait_for_file "$proof_root/publication-a-ready"

PGAPPNAME='vortex-definition-publication-b' "${psql_command[@]}" >"$proof_root/publication-b.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local role vortex_runtime;
select vortex_context.initialize(public.vortex_test_definition_context());
set local role vortex_request;
select * from vortex_definition.append_release(
  '$race_application_root_id', 1, 'sha256:$(printf 'b%.0s' {1..64})',
  public.vortex_test_definition_release_payload(
    'application', '$race_application_root_id', 'example.concurrent_application',
    '$organization_id', 1, '1.0.0', '1', '2', '3', '$module_one_dependency'::jsonb
  )
);
commit;
SQL
publication_b_pid=$!
wait_for_database_lock 'vortex-definition-publication-b'
touch "$proof_root/publication-a-release"
wait "$publication_a_pid"
assert_failed_with_state "$publication_b_pid" "$proof_root/publication-b.log" '23505'

[ "$(run_sql "select count(*) from vortex_definition.releases where root_id = '$race_application_root_id';")" = '1' ] || {
  echo "the same-draft race did not leave exactly one immutable release" >&2
  exit 1
}
[ "$(run_sql "select current_release_revision from vortex_definition.roots where root_id = '$race_application_root_id';")" = '1' ] || {
  echo "the same-draft race did not advance exactly one current pointer" >&2
  exit 1
}
[ "$(run_sql "select count(*) from vortex_definition.release_dependencies where root_id = '$race_application_root_id';")" = '1' ] || {
  echo "the same-draft race did not retain one exact dependency row" >&2
  exit 1
}

# Hold a new 2.0.0 Module publication open while another Application publishes
# the exact 1.0.0 manifest selected earlier. Both succeed and the Application's
# stored dependency remains revision 1 after Module revision 2 commits.
PGAPPNAME='vortex-definition-module-two' "${psql_command[@]}" >"$proof_root/module-two.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local role vortex_runtime;
select vortex_context.initialize(public.vortex_test_definition_context());
set local role vortex_request;
select * from vortex_definition.append_release(
  '$module_root_id', 2, 'sha256:$(printf 'a%.0s' {1..64})',
  public.vortex_test_definition_release_payload(
    'module', '$module_root_id', 'example.concurrent_module', '$organization_id',
    2, '2.0.0', '4', '5', '6', '[]'::jsonb
  )
);
\! touch '$proof_root/module-two-ready'
\! while [ ! -f '$proof_root/module-two-release' ]; do sleep 0.05; done
commit;
SQL
module_two_pid=$!
wait_for_file "$proof_root/module-two-ready"

PGAPPNAME='vortex-definition-pinned-app' "${psql_command[@]}" >"$proof_root/pinned-app.log" 2>&1 <<SQL
\set VERBOSITY verbose
begin;
set local role vortex_runtime;
select vortex_context.initialize(public.vortex_test_definition_context());
set local role vortex_request;
select * from vortex_definition.append_release(
  '$pinned_application_root_id', 1, 'sha256:$(printf 'c%.0s' {1..64})',
  public.vortex_test_definition_release_payload(
    'application', '$pinned_application_root_id', 'example.pinned_application',
    '$organization_id', 1, '1.0.0', '7', '8', '9', '$module_one_dependency'::jsonb
  )
);
commit;
SQL

touch "$proof_root/module-two-release"
wait "$module_two_pid"

[ "$(run_sql "select current_release_revision from vortex_definition.roots where root_id = '$module_root_id';")" = '2' ] || {
  echo "the concurrent Module release did not become the discovery default" >&2
  exit 1
}
[ "$(run_sql "
  select target_release_revision
  from vortex_definition.release_dependencies
  where root_id = '$pinned_application_root_id'
    and release_revision = 1
    and dependency_kind = 'module';
")" = '1' ] || {
  echo "the prepared Application manifest was silently retargeted" >&2
  exit 1
}
[ "$(run_sql "select count(*) from vortex_definition.releases where root_id = '$module_root_id';")" = '2' ] || {
  echo "the Module history did not retain both immutable releases" >&2
  exit 1
}

echo 'Definition publication concurrency proof passed'
