create or replace function vortex_access.read_application_address_candidates(
  p_identity_id uuid,
  p_tenant_short_name text,
  p_organization_short_name text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  addressed_organization record;
  application_row record;
  application_values jsonb := '[]'::jsonb;
  page_values jsonb;
  experience_values jsonb;
  role_values jsonb;
  permission_values jsonb;
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
    select root.root_id, root.key as application_key, release.compilation_output,
      registration.revision as registration_revision,
      registration.source_revision as release_revision
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
      and registration.source_content_fingerprint = release.content_fingerprint
      and registration.source_resolution_fingerprint = release.resolution_fingerprint
      and release.compilation_output ->> 'kind' = 'application'
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

    -- Declared experience pages are resolved to their exact compiled page definitions here, so
    -- App can render an application's own not-found, unavailable and error surfaces. A refused
    -- page and a missing page both resolve to the same not_found experience.
    experience_values := application_row.compilation_output #> '{canonical,content,experiences}';
    if pg_catalog.jsonb_typeof(experience_values) is distinct from 'array' then
      experience_values := '[]'::jsonb;
    end if;

    role_values := application_row.compilation_output #> '{canonical,content,roles}';
    if pg_catalog.jsonb_typeof(role_values) is distinct from 'array' then
      continue;
    end if;

    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'key', entry.permission_key,
        'applicationRootId', entry.application_root_id,
        'ownerKind', entry.owner_kind,
        'ownerId', entry.owner_id,
        'permissionId', entry.permission_id,
        'actionKind', entry.action_kind,
        'namedAction', entry.named_action
      ) order by entry.permission_key collate "C", entry.permission_id
    ) into permission_values
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = addressed_organization.organization_id
      and entry.registration_kind = 'application'
      and entry.registration_owner_id = application_row.root_id
      and entry.registration_revision = application_row.registration_revision
      and entry.application_root_id = application_row.root_id;

    application_values := application_values || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'applicationRootId', application_row.root_id,
        'releaseRevision', application_row.release_revision,
        'key', application_row.application_key,
        'name', application_row.compilation_output #>> '{canonical,content,name}',
        'icon', application_row.compilation_output #>> '{canonical,content,icon}',
        'homePageKey', home_page_key,
        'pages', (
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'pageId', page.value ->> 'pageId',
              'key', page.value ->> 'key',
              'accessPermissionKey', page.value ->> 'accessPermissionKey'
            ) order by page.value ->> 'key' collate "C"
          )
          from pg_catalog.jsonb_array_elements(page_values) as page(value)
        ),
        'experiences', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object('state', experience.value ->> 'state', 'page', page.value)
            order by experience.value ->> 'state' collate "C"
          )
          from pg_catalog.jsonb_array_elements(experience_values) as experience(value)
          join pg_catalog.jsonb_array_elements(page_values) as page(value)
            on page.value ->> 'pageId' = experience.value ->> 'pageId'
        ), '[]'::jsonb),
        'shells', case
          when pg_catalog.jsonb_array_length(experience_values) > 0
            then coalesce(
              application_row.compilation_output #> '{canonical,content,shells}',
              '[]'::jsonb
            )
          else '[]'::jsonb
        end,
        'roles', (
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'roleId', role.value ->> 'roleId',
              'key', role.value ->> 'key',
              'homePageId', role.value ->> 'homePageId'
            ) order by role.value ->> 'key' collate "C"
          )
          from pg_catalog.jsonb_array_elements(role_values) as role(value)
        ),
        'permissions', coalesce(permission_values, '[]'::jsonb)
      )
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'kind', 'available',
    'organizationId', addressed_organization.organization_id,
    'tenantShortName', addressed_organization.tenant_short_name,
    'organizationShortName', addressed_organization.organization_short_name,
    'applications', application_values
  );
end
$function$;

revoke all on function vortex_access.read_application_address_candidates(uuid, text, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.read_application_address_candidates(uuid, text, text)
  to vortex_runtime;

comment on function vortex_access.read_application_address_candidates(uuid, text, text) is
  'Private App candidate read for one exact live human organisation address; only App may project metadata after current page Access decisions.';
