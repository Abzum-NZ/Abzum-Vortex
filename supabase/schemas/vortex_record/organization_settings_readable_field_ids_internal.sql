create or replace function vortex_record.organization_settings_readable_field_ids_internal(
  p_record_type_id uuid,
  p_decision jsonb,
  p_base_readable_field_ids jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  module_root_id_value uuid;
  meta jsonb;
  record_type_value jsonb;
  contribution jsonb;
  contribution_permission jsonb;
  contribution_source jsonb;
  contribution_route jsonb;
  catalogue_entry vortex_access.permission_catalogue_entries%rowtype;
  invariant_field_ids text[] := array[]::text[];
  extension_field_ids text[] := array[]::text[];
  eligible_extension_field_ids text[] := array[]::text[];
  permitted_extension_field_ids text[] := array[]::text[];
  readable_field_ids text[] := array[]::text[];
begin
  if p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_decision) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_base_readable_field_ids) is distinct from 'array' then
    return '[]'::jsonb;
  end if;

  if p_decision ->> 'outcome' is distinct from 'allowed'
    or p_decision #>> '{action,actionKind}' is distinct from 'read' then
    return p_base_readable_field_ids;
  end if;

  select catalogue.module_root_id
  into module_root_id_value
  from vortex_record.storage_catalogue as catalogue
  join vortex_definition.roots as root
    on root.root_id = catalogue.module_root_id
    and root.kind = 'module'
    and root.key = 'vortex.organisation_administration'
  where catalogue.record_type_id = p_record_type_id
    and catalogue.physical_schema_token = 'system_projection'
    and catalogue.protected_read_model_key = 'organization_runtime_settings';
  if not found then
    return p_base_readable_field_ids;
  end if;

  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read');
  record_type_value := meta -> 'recordType';
  if (meta ->> 'moduleRootId')::uuid is distinct from module_root_id_value
    or record_type_value ->> 'key' is distinct from 'organization_settings'
    or record_type_value ->> 'recordTypeId' is distinct from p_record_type_id::text
    or record_type_value #>> '{systemProjection,protectedView}' is distinct from
      'organization_runtime_settings'
    or pg_catalog.jsonb_typeof(record_type_value -> 'fields') is distinct from 'array' then
    return p_base_readable_field_ids;
  end if;

  select coalesce(pg_catalog.array_agg(pg_catalog.lower(field.value ->> 'fieldId')), array[]::text[])
  into invariant_field_ids
  from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as field(value)
  where field.value ->> 'key' in (
    'organization_id', 'revision', 'language', 'time_zone', 'currency',
    'date_format', 'number_format', 'default_application_root_id'
  );

  select coalesce(pg_catalog.array_agg(pg_catalog.lower(field.value ->> 'fieldId')), array[]::text[])
  into extension_field_ids
  from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as field(value)
  where pg_catalog.jsonb_typeof(field.value -> 'fieldId') = 'string'
    and pg_catalog.jsonb_typeof(field.value -> 'key') = 'string'
    and field.value ->> 'key' not in (
      'organization_id', 'revision', 'language', 'time_zone', 'currency',
      'date_format', 'number_format', 'default_application_root_id'
    );

  if pg_catalog.cardinality(extension_field_ids) = 0 then
    return p_base_readable_field_ids;
  end if;

  select coalesce(pg_catalog.array_agg(pg_catalog.lower(item.value #>> '{}')), array[]::text[])
  into readable_field_ids
  from pg_catalog.jsonb_array_elements(p_base_readable_field_ids) as item(value);

  if exists (
    select 1
    from pg_catalog.unnest(invariant_field_ids) as invariant(field_id)
    where invariant.field_id <> all (readable_field_ids)
  ) then
    return p_base_readable_field_ids;
  end if;

  for contribution in
    select item.value
    from pg_catalog.jsonb_array_elements(p_decision -> 'matchedContributions') as item(value)
  loop
    contribution_permission := contribution -> 'permission';
    contribution_source := contribution -> 'source';
    contribution_route := contribution -> 'route';

    select entry.*
    into catalogue_entry
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
      and registration.state = 'active'
    where entry.organization_id = (p_decision ->> 'organizationId')::uuid
      and entry.application_root_id = (contribution_permission ->> 'applicationRootId')::uuid
      and entry.owner_kind = contribution_permission ->> 'ownerKind'
      and entry.owner_id = (contribution_permission ->> 'ownerId')::uuid
      and entry.permission_id = (contribution_permission ->> 'permissionId')::uuid;

    if not found
      or catalogue_entry.permission_key is distinct from
        'vortex.organisation_administration.organization_settings.read'
      or catalogue_entry.record_type_id is distinct from p_record_type_id
      or catalogue_entry.action_kind is distinct from 'read'
      or catalogue_entry.source_kind is distinct from 'module'
      or catalogue_entry.source_root_id is distinct from module_root_id_value
      or catalogue_entry.source_kind is distinct from (contribution_source ->> 'kind')
      or catalogue_entry.source_definition_key is distinct from (contribution_source ->> 'definitionKey')
      or catalogue_entry.source_root_id is distinct from (contribution_source ->> 'rootId')::uuid
      or catalogue_entry.source_version is distinct from (contribution_source ->> 'releaseVersion')
      or catalogue_entry.source_revision is distinct from (contribution_source ->> 'releaseRevision')::bigint
      or catalogue_entry.source_validation_contract_version
        is distinct from (contribution_source ->> 'validationContractVersion')
      or catalogue_entry.source_content_fingerprint
        is distinct from (contribution_source ->> 'contentFingerprint')
      or catalogue_entry.source_resolution_fingerprint
        is distinct from (contribution_source ->> 'resolutionFingerprint') then
      continue;
    end if;
    if catalogue_entry.field_policy is null
      or pg_catalog.jsonb_typeof(catalogue_entry.field_policy -> 'readableFieldIds')
        is distinct from 'array' then
      continue;
    end if;
    if exists (
      select 1
      from pg_catalog.unnest(invariant_field_ids) as invariant(field_id)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          catalogue_entry.field_policy -> 'readableFieldIds'
        ) as declared(field_id)
        where pg_catalog.lower(declared.field_id) = invariant.field_id
      )
    ) then
      continue;
    end if;

    if coalesce(contribution_route ->> 'kind', '') not in (
      'all_records', 'ownership', 'relationship', 'direct_share'
    ) then
      continue;
    end if;

    -- An extension is readable only when this exact registered read permission
    -- declares it. A direct-share route can narrow that set further, and every
    -- eligible matched route contributes without erasing earlier routes.
    select coalesce(
      pg_catalog.array_agg(extension.field_id order by extension.field_id),
      array[]::text[]
    )
    into permitted_extension_field_ids
    from pg_catalog.unnest(extension_field_ids) as extension(field_id)
    where exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        catalogue_entry.field_policy -> 'readableFieldIds'
      ) as declared(field_id)
      where pg_catalog.lower(declared.field_id) = extension.field_id
    )
      and (
        contribution_route ->> 'kind' <> 'direct_share'
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements_text(
            contribution_route -> 'readableFieldIds'
          ) as shared(field_id)
          where pg_catalog.lower(shared.field_id) = extension.field_id
        )
      );
    eligible_extension_field_ids :=
      eligible_extension_field_ids || permitted_extension_field_ids;
  end loop;

  if pg_catalog.cardinality(eligible_extension_field_ids) = 0 then
    return p_base_readable_field_ids;
  end if;

  select coalesce(pg_catalog.array_agg(field_id order by field_id), array[]::text[])
  into readable_field_ids
  from (
    select distinct field_id
    from pg_catalog.unnest(readable_field_ids || eligible_extension_field_ids) as fields(field_id)
  ) as fields;
  return pg_catalog.to_jsonb(readable_field_ids);
end
$function$;

revoke all on function vortex_record.organization_settings_readable_field_ids_internal(
  uuid, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.organization_settings_readable_field_ids_internal(
  uuid, jsonb, jsonb
) to vortex_record_adapter;

comment on function vortex_record.organization_settings_readable_field_ids_internal(
  uuid, jsonb, jsonb
) is
  'Adds an explicit list of declared extension fields to the current reader only for the organisation settings system projection and its exact read permission; every other projection and every undeclared key keeps its existing bounds.';
