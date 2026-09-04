#!/usr/bin/env bash

set -euo pipefail

readonly proof_root="$(mktemp -d /tmp/vortex-definition-consumer-read.XXXXXX)"
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id='41000000-0000-4000-8000-000000000022'
readonly organization_id='42000000-0000-4000-8000-000000000022'
readonly root_id='43000000-0000-4000-8000-000000000022'
readonly actor_id='49000000-0000-4000-8000-000000000022'

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
    drop function if exists public.vortex_test_consumer_read_context();
    update vortex_definition.roots set current_release_revision = null where root_id = '$root_id';
    delete from vortex_definition.releases where root_id = '$root_id';
    delete from vortex_definition.roots where root_id = '$root_id';
    delete from vortex_identity.organizations where organization_id = '$organization_id';
    delete from vortex_identity.tenants where tenant_id = '$tenant_id';
    commit;
  " >/dev/null 2>&1 || true
  case "$proof_root" in
    /tmp/vortex-definition-consumer-read.*) rm -r -- "$proof_root" ;;
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
  echo "consumer-read proof did not reach its transaction barrier" >&2
  return 1
}

run_sql "
  create function public.vortex_test_consumer_read_context()
  returns jsonb
  language sql
  volatile
  set search_path = ''
  as \$function\$
    select pg_catalog.jsonb_build_object(
      'callerKind', 'system',
      'tenantId', '$tenant_id'::uuid,
      'organizationId', '$organization_id'::uuid,
      'sessionId', '46000000-0000-4000-8000-000000000022'::uuid,
      'issuedAt', pg_catalog.clock_timestamp() - interval '1 minute',
      'expiresAt', pg_catalog.clock_timestamp() + interval '10 minutes',
      'accessVersion', 1,
      'correlationId', '47000000-0000-4000-8000-000000000022'::uuid,
      'systemActorId', '$actor_id'::uuid,
      'authenticationStrength', 'service'
    )
  \$function\$;

  grant execute on function public.vortex_test_consumer_read_context() to vortex_runtime;

  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', 'consumer_read_proof', 'Consumer read proof', 'active',
    pg_catalog.clock_timestamp(), '$actor_id', pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, parent_organization_id, short_name, display_name,
    state, created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', null, 'consumer_read_proof_org',
    'Consumer read proof organization', 'active', pg_catalog.clock_timestamp(),
    '$actor_id', pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_definition.roots (
    root_id, organization_id, kind, key, created_at, created_by
  ) values (
    '$root_id', '$organization_id', 'module', 'example.consumer_read_proof',
    pg_catalog.clock_timestamp(), '$actor_id'
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
    '{\"source_contract_version\":\"1.0.0\",\"kind\":\"module\",\"key\":\"example.consumer_read_proof\",\"body\":{}}',
    'sha256:' || pg_catalog.repeat('1', 64), '1.0.0',
    '{\"kind\":\"module\",\"canonical\":{\"content\":{\"marker\":\"old\"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('2', 64)),
    'sha256:' || pg_catalog.repeat('3', 64), 'sha256:' || pg_catalog.repeat('2', 64),
    '1.0.0', 'sha256:' || pg_catalog.repeat('4', 64), '[]', 'Old release',
    pg_catalog.clock_timestamp(), '$actor_id'
  ),
  (
    '$root_id', 2, '1.1.0',
    '{\"source_contract_version\":\"1.0.0\",\"kind\":\"module\",\"key\":\"example.consumer_read_proof\",\"body\":{}}',
    'sha256:' || pg_catalog.repeat('5', 64), '1.0.0',
    '{\"kind\":\"module\",\"canonical\":{\"content\":{\"marker\":\"new\"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('6', 64)),
    'sha256:' || pg_catalog.repeat('7', 64), 'sha256:' || pg_catalog.repeat('6', 64),
    '1.0.0', 'sha256:' || pg_catalog.repeat('8', 64), '[]', 'New release',
    pg_catalog.clock_timestamp(), '$actor_id'
  );
  update vortex_definition.roots set current_release_revision = 1 where root_id = '$root_id';
"

(
  "${psql_command[@]}" <<SQL
begin;
update vortex_definition.roots set current_release_revision = 2 where root_id = '$root_id';
\! touch '$proof_root/writer-ready'
select pg_catalog.pg_sleep(2);
commit;
SQL
) >"$proof_root/writer.log" 2>&1 &
writer_pid=$!

wait_for_file "$proof_root/writer-ready"

old_current="$(run_sql "
  begin;
  set local role vortex_runtime;
  select vortex_context.initialize(public.vortex_test_consumer_read_context());
  set local role vortex_request;
  select pg_catalog.concat_ws(':',
    value ->> 'releaseRevision',
    value -> 'compilationOutput' -> 'canonical' -> 'content' ->> 'marker'
  )
  from (select vortex_definition.read_consumer_release('module', '$root_id', null) as value) read;
  rollback;
" | tr -d '\r\n')"

[ "$old_current" = '1:old' ] || {
  printf 'current read observed mixed or uncommitted evidence: %q\n' "$old_current" >&2
  exit 1
}

wait "$writer_pid"

new_and_exact="$(run_sql "
  begin;
  set local role vortex_runtime;
  select vortex_context.initialize(public.vortex_test_consumer_read_context());
  set local role vortex_request;
  select pg_catalog.concat_ws(':',
    current_value ->> 'releaseRevision',
    current_value -> 'compilationOutput' -> 'canonical' -> 'content' ->> 'marker',
    exact_value ->> 'releaseRevision',
    exact_value -> 'compilationOutput' -> 'canonical' -> 'content' ->> 'marker'
  )
  from (
    select
      vortex_definition.read_consumer_release('module', '$root_id', null) as current_value,
      vortex_definition.read_consumer_release('module', '$root_id', 1) as exact_value
  ) read;
  rollback;
" | tr -d '\r\n')"

[ "$new_and_exact" = '2:new:1:old' ] || {
  printf 'committed current and exact reads were not independently consistent: %q\n' "$new_and_exact" >&2
  exit 1
}

echo "Definition consumer-read concurrency proof passed"
