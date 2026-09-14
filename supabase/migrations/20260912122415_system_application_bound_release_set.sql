-- Exact immutable Application release set for protected system consumers.
-- Definition remains the sole owner of dependency traversal: the reader uses
-- the existing pin-set resolver and accepts no caller-provided Module roots.

create function vortex_definition.read_system_application_bound_release_set(
  p_application_root_id uuid,
  p_application_release_revision bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  application_evidence jsonb;
  module_evidence jsonb;
begin
  checked_context := vortex_definition.validated_system_context();
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or (
      checked_context ? 'applicationRootId'
      and (checked_context ->> 'applicationRootId')::uuid <> p_application_root_id
    ) then
    raise exception using
      errcode = '22023',
      message = 'System Application release-set context is invalid';
  end if;

  select vortex_definition.project_consumer_release_evidence(
    'application', root.root_id, p_application_release_revision
  ) into application_evidence
  from vortex_definition.roots as root
  where root.root_id = p_application_root_id
    and root.kind = 'application'
    and root.organization_id = (checked_context ->> 'organizationId')::uuid;
  if application_evidence is null then
    raise exception using
      errcode = 'P0002',
      message = 'Exact system Application release is unavailable';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      vortex_definition.project_consumer_release_evidence(
        'module', pin.target_root_id, pin.target_release_revision
      ) order by pin.target_root_id
    ),
    '[]'::jsonb
  ) into module_evidence
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  ) as pin;

  return pg_catalog.jsonb_build_object(
    'correlationId', checked_context ->> 'correlationId',
    'application', application_evidence,
    'modules', module_evidence
  );
end
$function$;

revoke all on function vortex_definition.read_system_application_bound_release_set(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_system_application_bound_release_set(uuid, bigint)
  to vortex_request;

comment on function vortex_definition.read_system_application_bound_release_set(uuid, bigint) is
  'Returns one exact organisation-owned Application and its database-resolved Module dependency pin set to a validated system context; a valid zero-Module Application returns an empty Module array.';
