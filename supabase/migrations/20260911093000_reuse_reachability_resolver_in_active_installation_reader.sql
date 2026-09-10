-- vortex_module.read_current_active_installation still carried four inline
-- copies of the recursive Module dependency walk that
-- vortex_definition.reachable_module_dependency_edges now owns. Replace all
-- four with calls to that shared resolver. Each site keeps projecting only
-- the columns it always projected and keeps its own exists/group-by shape;
-- only the FROM clause changes, from a `with recursive` block to a call to
-- the shared function. Signature, volatility, security mode, search path,
-- validation order, error codes/messages and returned JSON are unchanged.
-- postgres does not retain CREATE on vortex_module between migrations (it is
-- granted and revoked inside the owning migration's own transaction), so the
-- replace runs as the function's existing owner, matching the choreography
-- already used to replace vortex_module.provision_module_installation_storage
-- in 20260911090000_resolve_reachable_module_dependencies.sql.

set local role vortex_module_owner;

create or replace function vortex_module.read_current_active_installation()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  selected_organization_id uuid;
  selected_application_root_id uuid;
  selected_application_release_revision bigint;
  selected_bindings jsonb;
begin
  checked_context := vortex_access.validated_human_request_context();
  if not checked_context ? 'applicationRootId' then
    raise exception using errcode = '22023', message = 'Active Application context is required';
  end if;
  selected_organization_id := (checked_context ->> 'organizationId')::uuid;
  selected_application_root_id := (checked_context ->> 'applicationRootId')::uuid;

  select pg_catalog.min(binding.application_release_revision)
  into selected_application_release_revision
  from vortex_module.installation_bindings as binding
  where binding.organization_id = selected_organization_id
    and binding.application_root_id = selected_application_root_id
    and binding.state = 'active';
  if selected_application_release_revision is null then
    raise exception using errcode = 'P0002', message = 'Active Application installation is unavailable';
  end if;
  if exists (
    select 1 from vortex_module.installation_bindings as binding
    where binding.organization_id = selected_organization_id
      and binding.application_root_id = selected_application_root_id
      and binding.state = 'active'
      and binding.application_release_revision <> selected_application_release_revision
  ) then
    raise exception using errcode = '55000', message = 'Active Application installation is mixed';
  end if;

  if not exists (
    select 1
    from vortex_definition.roots as root
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = selected_application_release_revision
    where root.root_id = selected_application_root_id
      and root.kind = 'application'
      and root.organization_id = selected_organization_id
      and release.compilation_output #>> '{kind}' = 'application'
  ) then
    raise exception using errcode = '23514', message = 'Active Application release evidence is invalid';
  end if;

  if not exists (
    select 1 from vortex_definition.release_dependencies as dependency
    where dependency.root_id = selected_application_root_id
      and dependency.release_revision = selected_application_release_revision
      and dependency.dependency_kind = 'module'
  ) or exists (
    select 1
    from vortex_definition.reachable_module_dependency_edges(
      selected_application_root_id, selected_application_release_revision
    ) as edge
    left join vortex_definition.releases as module_release
      on module_release.root_id = edge.target_root_id
      and module_release.release_revision = edge.target_release_revision
    left join vortex_definition.roots as module_root
      on module_root.root_id = edge.target_root_id
    where module_root.kind is distinct from 'module'
      or module_root.key is distinct from edge.dependency_reference
      or module_release.release_version is distinct from edge.dependency_version
      or module_release.content_fingerprint is distinct from edge.dependency_content_fingerprint
      or module_release.resolution_fingerprint is distinct from edge.evidence_fingerprint
  ) or exists (
    select 1
    from vortex_definition.reachable_module_dependency_edges(
      selected_application_root_id, selected_application_release_revision
    ) as edge
    group by edge.target_root_id
    having pg_catalog.count(distinct edge.target_release_revision) <> 1
  ) or exists (
    select 1
    from vortex_definition.reachable_module_dependency_edges(
      selected_application_root_id, selected_application_release_revision
    ) as node
    left join vortex_module.installation_bindings as binding
      on binding.organization_id = selected_organization_id
      and binding.application_root_id = selected_application_root_id
      and binding.module_root_id = node.target_root_id
    where binding.state is distinct from 'active'
      or binding.application_release_revision is distinct from selected_application_release_revision
      or binding.module_release_revision is distinct from node.target_release_revision
      or binding.content_fingerprint is distinct from node.dependency_content_fingerprint
      or binding.resolution_fingerprint is distinct from node.evidence_fingerprint
  ) or exists (
    select 1
    from vortex_module.installation_bindings as binding
    where binding.organization_id = selected_organization_id
      and binding.application_root_id = selected_application_root_id
      and binding.state = 'active'
      and not exists (
        select 1
        from vortex_definition.reachable_module_dependency_edges(
          selected_application_root_id, selected_application_release_revision
        ) as node
        where node.target_root_id = binding.module_root_id
          and node.target_release_revision = binding.module_release_revision
      )
  ) then
    raise exception using errcode = '55000', message = 'Active Application Module bindings are incomplete';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'organizationId', binding.organization_id,
      'applicationRootId', binding.application_root_id,
      'moduleRootId', binding.module_root_id,
      'bindingRevision', binding.binding_revision,
      'applicationReleaseRevision', binding.application_release_revision,
      'moduleReleaseRevision', binding.module_release_revision,
      'state', binding.state
    ) order by binding.module_root_id
  ) into selected_bindings
  from vortex_module.installation_bindings as binding
  where binding.organization_id = selected_organization_id
    and binding.application_root_id = selected_application_root_id
    and binding.application_release_revision = selected_application_release_revision
    and binding.state = 'active';

  return pg_catalog.jsonb_build_object(
    'organizationId', selected_organization_id,
    'applicationRootId', selected_application_root_id,
    'applicationReleaseRevision', selected_application_release_revision,
    'moduleBindings', selected_bindings
  );
end
$function$;

revoke all on function vortex_module.read_current_active_installation()
  from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.read_current_active_installation()
  to vortex_request;
comment on function vortex_module.read_current_active_installation() is
  'Returns the complete exact active Module binding set selected from validated human Application context.';
reset role;
