\ir helpers/definition-release-writer.psql

begin;
select plan(10);

set local search_path = pg_catalog, extensions, public;

create function pg_temp.initialize_system_reader(
  p_organization_id uuid,
  p_application_root_id uuid default null,
  p_correlation_id uuid default 'a4800000-0000-4000-8000-000000000001'
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  selected_tenant_id uuid;
  request_context jsonb;
begin
  select organization.tenant_id into strict selected_tenant_id
  from vortex_identity.organizations as organization
  where organization.organization_id = p_organization_id;
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  request_context := pg_catalog.jsonb_build_object(
    'callerKind', 'system',
    'tenantId', selected_tenant_id,
    'organizationId', p_organization_id,
    'systemActorId', '94800000-0000-4000-8000-000000000001',
    'sessionId', '64800000-0000-4000-8000-000000000001',
    'authenticationStrength', 'service',
    'issuedAt', pg_catalog.clock_timestamp() - interval '1 minute',
    'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
    'accessVersion', 1,
    'correlationId', p_correlation_id
  );
  if p_application_root_id is not null then
    request_context := request_context || pg_catalog.jsonb_build_object(
      'applicationRootId', p_application_root_id
    );
  end if;
  perform vortex_context.initialize(request_context);
end
$function$;

select has_function(
  'vortex_definition', 'read_system_application_bound_release_set',
  array['uuid', 'bigint'],
  'Definition exposes one exact system Application release-set reader'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_definition.read_system_application_bound_release_set(uuid,bigint)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'public',
    'vortex_definition.read_system_application_bound_release_set(uuid,bigint)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_definition.read_system_application_bound_release_set(uuid,bigint)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'vortex_definition.read_system_application_bound_release_set(uuid,bigint)',
    'EXECUTE'
  ),
  'only the protected request boundary can invoke the system reader'
);

-- Expose pgTAP only inside this rolled-back test transaction. Definition
-- privileges remain unchanged.
grant usage on schema extensions to vortex_request;

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '14800000-0000-4000-8000-000000000001', 'system_set_tenant',
  'System set tenant', 'active', pg_catalog.statement_timestamp(),
  '94800000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(), 1
);
insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values
  (
    '24800000-0000-4000-8000-000000000001',
    '14800000-0000-4000-8000-000000000001', null, 'system_set_local',
    'System set local', 'active', pg_catalog.statement_timestamp(),
    '94800000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(), 1
  ),
  (
    '24800000-0000-4000-8000-000000000002',
    '14800000-0000-4000-8000-000000000001', null, 'system_set_other',
    'System set other', 'active', pg_catalog.statement_timestamp(),
    '94800000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(), 1
  );

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values
  (
    '34800000-0000-4000-8000-000000000001',
    '24800000-0000-4000-8000-000000000001', 'application',
    'vortex.system_set.application', pg_catalog.statement_timestamp(),
    '94800000-0000-4000-8000-000000000001'
  ),
  (
    '34800000-0000-4000-8000-000000000002',
    '24800000-0000-4000-8000-000000000001', 'application',
    'vortex.system_set.empty_application', pg_catalog.statement_timestamp(),
    '94800000-0000-4000-8000-000000000001'
  ),
  (
    '34800000-0000-4000-8000-000000000003',
    '24800000-0000-4000-8000-000000000002', 'application',
    'vortex.system_set.other_application', pg_catalog.statement_timestamp(),
    '94800000-0000-4000-8000-000000000001'
  ),
  (
    '44800000-0000-4000-8000-000000000001',
    '24800000-0000-4000-8000-000000000001', 'module',
    'vortex.system_set.direct_module', pg_catalog.statement_timestamp(),
    '94800000-0000-4000-8000-000000000001'
  ),
  (
    '44800000-0000-4000-8000-000000000002',
    '24800000-0000-4000-8000-000000000001', 'module',
    'vortex.system_set.transitive_module', pg_catalog.statement_timestamp(),
    '94800000-0000-4000-8000-000000000001'
  );

select pg_temp.append_writer_release(
  '44800000-0000-4000-8000-000000000002', '1.0.0', '[]', '{}'
);
select pg_temp.append_writer_release(
  '44800000-0000-4000-8000-000000000001', '1.0.0',
  '[["44800000-0000-4000-8000-000000000002",1]]', '{}'
);
select pg_temp.append_writer_release(
  '34800000-0000-4000-8000-000000000001', '1.0.0',
  '[["44800000-0000-4000-8000-000000000001",1]]', '{}'
);
select pg_temp.append_writer_release(
  '34800000-0000-4000-8000-000000000002', '1.0.0', '[]', '{}'
);
select pg_temp.append_writer_release(
  '34800000-0000-4000-8000-000000000003', '1.0.0', '[]', '{}'
);

select pg_temp.initialize_system_reader(
  '24800000-0000-4000-8000-000000000001',
  '34800000-0000-4000-8000-000000000001'
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select is(
  vortex_definition.read_system_application_bound_release_set(
    '34800000-0000-4000-8000-000000000001', 1
  ) #>> '{application,rootId}',
  '34800000-0000-4000-8000-000000000001'::text,
  'the system reader returns its exact selected Application'
);
select is(
  pg_catalog.jsonb_array_length(
    vortex_definition.read_system_application_bound_release_set(
      '34800000-0000-4000-8000-000000000001', 1
    ) -> 'modules'
  ),
  2,
  'the system reader returns the complete direct and transitive Module pin set'
);
select is(
  vortex_definition.read_system_application_bound_release_set(
    '34800000-0000-4000-8000-000000000001', 1
  ) #>> '{modules,1,rootId}',
  '44800000-0000-4000-8000-000000000002'::text,
  'the Module reached only through another Module is returned'
);
select throws_ok(
  $$select vortex_definition.read_system_application_bound_release_set(
    '34800000-0000-4000-8000-000000000002', 1
  )$$::text,
  '22023'::char(5), 'System Application release-set context is invalid'::text,
  'a fixed system Application scope cannot be substituted'
);
select throws_ok(
  $$select vortex_definition.read_system_application_bound_release_set(
    '34800000-0000-4000-8000-000000000001', 2
  )$$::text,
  'P0002'::char(5), 'Exact system Application release is unavailable'::text,
  'an absent exact Application release is refused'
);
reset role;

select pg_temp.initialize_system_reader(
  '24800000-0000-4000-8000-000000000001',
  '34800000-0000-4000-8000-000000000002'
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select is(
  pg_catalog.jsonb_array_length(
    vortex_definition.read_system_application_bound_release_set(
      '34800000-0000-4000-8000-000000000002', 1
    ) -> 'modules'
  ),
  0,
  'a valid zero-Module Application returns an empty Module set'
);
reset role;

select pg_temp.initialize_system_reader('24800000-0000-4000-8000-000000000001');
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select throws_ok(
  $$select vortex_definition.read_system_application_bound_release_set(
    '34800000-0000-4000-8000-000000000003', 1
  )$$::text,
  'P0002'::char(5), 'Exact system Application release is unavailable'::text,
  'an Application from another organisation is refused'
);
reset role;

select throws_ok(
  $$update vortex_definition.release_dependencies
    set evidence_fingerprint = 'sha256:' || pg_catalog.repeat('0', 64)
    where root_id = '34800000-0000-4000-8000-000000000001'
      and release_revision = 1
      and dependency_kind = 'module'$$::text,
  '23514'::char(5),
  'Definition releases and dependency manifests are append-only'::text,
  'stored dependency evidence cannot be substituted after publication'
);

select * from finish();
rollback;
