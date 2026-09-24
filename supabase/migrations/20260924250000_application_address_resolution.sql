-- Resolve canonical organisation addresses and expose only live installed
-- application metadata after the current identity's organisation scope passes.

create function vortex_module.read_permitted_applications_at_address(
  p_identity_id uuid,
  p_tenant_short_name text,
  p_organization_short_name text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  addressed_organization record;
  application_row record;
  application_values jsonb := '[]'::jsonb;
  page_values jsonb;
  home_page_key text;
begin
  if p_identity_id is null
    or p_identity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_tenant_short_name is null
    or pg_catalog.char_length(p_tenant_short_name) not between 1 and 40
    or p_tenant_short_name !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    or p_organization_short_name is null
    or pg_catalog.char_length(p_organization_short_name) not between 1 and 40
    or p_organization_short_name !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$' then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  select tenant.tenant_id, tenant.short_name as tenant_short_name,
    organization.organization_id, organization.short_name as organization_short_name
  into addressed_organization
  from vortex_identity.tenants as tenant
  join vortex_identity.organizations as organization
    on organization.tenant_id = tenant.tenant_id
  where tenant.short_name = p_tenant_short_name
    and organization.short_name = p_organization_short_name
    and tenant.state = 'active'
    and organization.state = 'active';

  if not found then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  begin
    perform 1
    from vortex_access.resolve_human_organization_scope(
      p_identity_id, addressed_organization.organization_id
    ) as scope;
  exception
    when sqlstate '42501' or sqlstate 'P0002' then
      return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end;

  for application_row in
    select root.root_id, root.key as application_key, release.compilation_output
    from vortex_access.permission_registrations as registration
    join vortex_definition.roots as root
      on root.root_id = registration.registration_owner_id
      and root.organization_id = addressed_organization.organization_id
      and root.kind = 'application'
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = registration.source_revision
    where registration.organization_id = addressed_organization.organization_id
      and registration.registration_kind = 'application'
      and registration.state = 'active'
      and exists (
        select 1
        from vortex_module.installation_bindings as binding
        where binding.organization_id = addressed_organization.organization_id
          and binding.application_root_id = root.root_id
          and binding.application_release_revision = registration.source_revision
          and binding.state = 'active'
      )
    order by root.key collate "C", root.root_id
  loop
    begin
      perform 1
      from vortex_access.resolve_human_application_scope(
        p_identity_id,
        addressed_organization.organization_id,
        application_row.root_id
      ) as scope;
    exception
      when sqlstate '42501' or sqlstate 'P0002' then
        continue;
    end;

    page_values := application_row.compilation_output #> '{canonical,content,pages}';
    if pg_catalog.jsonb_typeof(page_values) is distinct from 'array' then
      continue;
    end if;
    if pg_catalog.jsonb_array_length(page_values) = 0 then
      continue;
    end if;

    select page.value ->> 'key'
    into home_page_key
    from pg_catalog.jsonb_array_elements(page_values) as page(value)
    where page.value ->> 'pageId' =
      application_row.compilation_output #>> '{canonical,content,homePageId}';

    if home_page_key is null then
      continue;
    end if;

    application_values := application_values || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'applicationRootId', application_row.root_id,
        'key', application_row.application_key,
        'name', application_row.compilation_output #>> '{canonical,content,name}',
        'icon', application_row.compilation_output #>> '{canonical,content,icon}',
        'homePageKey', home_page_key,
        'pageKeys', (
          select pg_catalog.jsonb_agg(page.value ->> 'key' order by page.value ->> 'key' collate "C")
          from pg_catalog.jsonb_array_elements(page_values) as page(value)
          where pg_catalog.jsonb_typeof(page.value -> 'key') = 'string'
        )
      )
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'kind', 'available',
    'organizationId', addressed_organization.organization_id,
    'tenantShortName', addressed_organization.tenant_short_name,
    'organizationShortName', addressed_organization.organization_short_name,
    'defaultApplicationRootId', null,
    'applications', application_values
  );
end
$function$;

revoke all on function vortex_module.read_permitted_applications_at_address(uuid, text, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_module.read_permitted_applications_at_address(uuid, text, text)
  to vortex_runtime;

comment on function vortex_module.read_permitted_applications_at_address(uuid, text, text) is
  'Resolves one exact tenant and organisation address for a live human account and returns only active installed applications registered for that organisation.';
