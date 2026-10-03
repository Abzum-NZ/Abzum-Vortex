-- Issue #1950: expose exact current application role templates as ordinary records.
begin;

-- Definition owns the identity proof. Access receives no raw identity-table grant.
grant select (identity_id, root_id, kind)
  on table vortex_definition.source_identities to vortex_definition_owner;

create policy source_identities_human_application_role_select
  on vortex_definition.source_identities
  for select to vortex_definition_owner
  using (
    kind = 'role'
    and exists (
      select 1
      from vortex_definition.roots as root
      where root.root_id = vortex_definition.source_identities.root_id
        and root.kind = 'application'
        and root.organization_id = (
          vortex_access.validated_human_request_context() ->> 'organizationId'
        )::uuid
    )
  );

set local role vortex_definition_owner;

create or replace function vortex_definition.application_role_identity_is_exact_for_human_request_internal(
  p_application_root_id uuid,
  p_source_role_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  visible_organization_id uuid;
begin
  if p_application_root_id is null or p_source_role_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_source_role_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return false;
  end if;
  begin
    visible_organization_id := (
      vortex_access.validated_human_request_context() ->> 'organizationId'
    )::uuid;
  exception
    when insufficient_privilege then
      return false;
  end;
  return exists (
    select 1
    from vortex_definition.source_identities as identity
    join vortex_definition.roots as root on root.root_id = identity.root_id
    where identity.identity_id = p_source_role_id
      and identity.root_id = p_application_root_id
      and identity.kind = 'role'
      and root.kind = 'application'
      and root.organization_id = visible_organization_id
  );
end
$function$;

alter function vortex_definition.application_role_identity_is_exact_for_human_request_internal(
  uuid, uuid
) owner to vortex_definition_owner;

revoke all on function vortex_definition.application_role_identity_is_exact_for_human_request_internal(
  uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_module_owner;

grant execute on function vortex_definition.application_role_identity_is_exact_for_human_request_internal(
  uuid, uuid
) to postgres;

comment on function vortex_definition.application_role_identity_is_exact_for_human_request_internal(uuid, uuid) is
  'Private boolean identity proof for the current validated human organization: true only for an exact permanent role identity belonging to the supplied application root in that organization. Returns no identity records, aliases or source content; missing, foreign, nil and wrong-kind identities return false.';

reset role;

create or replace function vortex_access.list_application_role_templates_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_row record;
  application_row record;
  template_value jsonb;
  source_role_id_value uuid;
  seen_role_ids uuid[];
  valid_roles boolean;
begin
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_roles_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;

  -- Catalogue authority and current installed-application reachability are both
  -- required. Neither the organization nor the application is a caller input.
  for application_row in
    select root.root_id, registration.revision as registration_revision,
      release.compilation_output #> '{canonical,content,roles}' as roles
    from vortex_access.list_installed_applications_projection(
      null::uuid, null::integer
    ) as installed
    join vortex_access.permission_registrations as registration
      on registration.organization_id = installed.organization_id
      and registration.registration_owner_id = installed.record_id
      and registration.revision = installed.revision
      and registration.registration_kind = 'application'
      and registration.state = 'active'
    join vortex_definition.roots as root
      on root.root_id = registration.registration_owner_id
      and root.organization_id = registration.organization_id
      and root.kind = 'application'
      and root.key = registration.source_definition_key
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = registration.source_revision
      and release.release_version = registration.source_version
      and release.validation_contract_version = registration.validation_contract_version
      and release.content_fingerprint = registration.source_content_fingerprint
      and release.resolution_fingerprint = registration.source_resolution_fingerprint
    where registration.organization_id = scope_row.organization_id
      and release.compilation_output ->> 'kind' = 'application'
    order by root.root_id
  loop
    if pg_catalog.jsonb_typeof(application_row.roles) is distinct from 'array' then
      continue;
    end if;
    if pg_catalog.jsonb_array_length(application_row.roles) not between 1 and 100 then
      continue;
    end if;
    seen_role_ids := array[]::uuid[];
    valid_roles := true;
    -- Validate the complete array before returning any row. Duplicate UUIDs,
    -- including alternate casing, cannot become duplicate ordinary record IDs.
    for template_value in
      select template.value
      from pg_catalog.jsonb_array_elements(application_row.roles) as template(value)
    loop
      if pg_catalog.jsonb_typeof(template_value) is distinct from 'object'
        or pg_catalog.jsonb_typeof(template_value -> 'roleId') is distinct from 'string'
        or not vortex_context.is_non_nil_uuid(template_value ->> 'roleId')
        or pg_catalog.jsonb_typeof(template_value -> 'key') is distinct from 'string'
        or pg_catalog.char_length(template_value ->> 'key') not between 1 and 40
        or (template_value ->> 'key') !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
        or pg_catalog.jsonb_typeof(template_value -> 'name') is distinct from 'string'
        or pg_catalog.char_length(template_value ->> 'name') not between 1 and 60 then
        valid_roles := false;
        exit;
      end if;
      source_role_id_value := (template_value ->> 'roleId')::uuid;
      if source_role_id_value = any(seen_role_ids)
        or not vortex_definition.application_role_identity_is_exact_for_human_request_internal(
          application_row.root_id, source_role_id_value
        ) then
        valid_roles := false;
        exit;
      end if;
      seen_role_ids := pg_catalog.array_append(seen_role_ids, source_role_id_value);
    end loop;
    if not valid_roles then
      continue;
    end if;

    -- Generic Query applies its own filter and pagination after this relation;
    -- p_page_size must not truncate it before those predicates are evaluated.
    -- Registration revision is the row concurrency number. Continuity revision
    -- changes only on availability transitions and remains a separate attribute.
    return query
    select scope_row.organization_id,
      (template.value ->> 'roleId')::uuid,
      application_row.registration_revision,
      pg_catalog.jsonb_build_object(
        'application_root_id', application_row.root_id,
        'source_role_id', (template.value ->> 'roleId')::uuid,
        'key', template.value ->> 'key',
        'label', template.value ->> 'name',
        'continuity_revision', continuity.continuity_revision
      )
    from pg_catalog.jsonb_array_elements(application_row.roles) as template(value)
    join vortex_access.application_role_template_continuities as continuity
      on continuity.organization_id = scope_row.organization_id
      and continuity.application_root_id = application_row.root_id
      and continuity.source_role_id = (template.value ->> 'roleId')::uuid
      and continuity.state = 'available'
      and continuity.last_processed_registration_revision = application_row.registration_revision
    where p_record_id is null or p_record_id = (template.value ->> 'roleId')::uuid
    order by (template.value ->> 'roleId')::uuid;
  end loop;
end
$function$;

alter function vortex_access.list_application_role_templates_projection(uuid, integer)
  owner to postgres;

revoke all on function vortex_access.list_application_role_templates_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_application_role_templates_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_application_role_templates_projection(uuid, integer) is
  'Registered application-role-template projection for the current human organization: fixed role-catalogue read authority, reachable active installation, exact registered application release, permanent Definition role identity and available continuity processed at the current registration are all required. Record identity is the source role UUID and row revision is the registration revision; only application root, source role, key, label and continuity revision are projected. Missing, refused, foreign or malformed candidates produce no revealing rows.';

set local role vortex_record_owner;

alter table vortex_record.protected_read_model_views
  drop constraint protected_read_model_views_protected_read_model_key_check;

alter table vortex_record.protected_read_model_views
  add constraint protected_read_model_views_protected_read_model_key_check
  check (protected_read_model_key in (
    'people',
    'organization_accounts',
    'roles',
    'groups',
    'effective_assignments',
    'tenant_structure',
    'organization_invitations',
    'organization_runtime_settings',
    'permissions',
    'role_activations',
    'delegations',
    'tenants',
    'tenant_administrators',
    'installed_applications',
    'landing_zone_applications',
    'application_role_templates'
  ));

alter table vortex_record.storage_catalogue
  drop constraint storage_catalogue_protected_read_model_key_check;

alter table vortex_record.storage_catalogue
  add constraint storage_catalogue_protected_read_model_key_check
  check (
    (physical_schema_token = 'system_projection') = (protected_read_model_key is not null)
    and (
      protected_read_model_key is null
      or protected_read_model_key in (
        'people',
        'organization_accounts',
        'roles',
        'groups',
        'effective_assignments',
        'tenant_structure',
        'organization_invitations',
        'organization_runtime_settings',
        'permissions',
        'role_activations',
        'delegations',
        'tenants',
        'tenant_administrators',
        'installed_applications',
        'landing_zone_applications',
        'application_role_templates'
      )
    )
  );

insert into vortex_record.protected_read_model_views (
  protected_read_model_key, reader_schema, reader_function
) values (
  'application_role_templates',
  'vortex_access',
  'list_application_role_templates_projection'
);

reset role;

commit;
