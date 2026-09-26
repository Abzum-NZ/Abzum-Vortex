-- #1213: the IAM create-custom-role and accept-role-template flows prepare their complete,
-- fingerprinted role-change evidence here, for the verified caller's organisation only, before
-- they call the unchanged #1055 operations. The canonical body lives in
-- supabase/schemas/vortex_access/read_organization_role_change_evidence_for_administration.sql.

create or replace function vortex_access.read_organization_role_change_evidence_for_administration(
  p_preparation jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
  context_organization_id uuid;
  operation_name text;
  accepted_truth text;
  requested jsonb;
  refs jsonb;
  permissions_value jsonb;
  application_root_id uuid;
  source_role_id uuid;
  application_registration vortex_access.permission_registrations%rowtype;
  application_release jsonb;
  registration_entries jsonb;
  application_permission_ids jsonb;
  permission_registration jsonb;
  selected_template jsonb;
  selected_continuity vortex_access.application_role_template_continuities%rowtype;
  source_permissions jsonb;
  live_permissions jsonb;
  prepared_templates_core jsonb;
begin
  -- The caller supplies configuration only: an operation, a role key, label, description, its
  -- privilege classification, and either the exact permission references of a custom role or the
  -- identity of a published application role template. Never a fingerprint and never an
  -- organisation: those come from the verified request context and the stored evidence.
  if p_preparation is null
    or pg_catalog.jsonb_typeof(p_preparation) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_preparation -> 'operation') is distinct from 'string'
    or p_preparation ->> 'operation' not in ('create_custom', 'accept_new_application_role')
    or pg_catalog.jsonb_typeof(p_preparation -> 'roleKey') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_preparation -> 'label') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_preparation -> 'description') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_preparation -> 'privilegeClassification') is distinct from 'string'
    or p_preparation ->> 'privilegeClassification' not in ('standard', 'privileged')
    or pg_catalog.jsonb_typeof(p_preparation -> 'acceptBroadenedAuthority') is distinct from 'string'
    or p_preparation ->> 'acceptBroadenedAuthority' not in ('accept', 'decline') then
    raise exception using errcode = '22023',
      message = 'Organization role-change preparation input is invalid';
  end if;
  operation_name := p_preparation ->> 'operation';
  accepted_truth := p_preparation ->> 'acceptBroadenedAuthority';

  -- Explicit acceptance of broadened authority is a visible choice, never inferred from a
  -- submitted form. Declining is an ordinary unavailability, not an error.
  if accepted_truth is distinct from 'accept' then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;

  -- The verified request context and the caller's own current role-management authority decide the
  -- organisation; the caller never names it.
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.roles.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '87c96495-c806-4692-9bc2-250ddb10613c'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Organization role-change preparation is unavailable';
  end if;
  context_organization_id := decision.organization_id;

  if operation_name = 'create_custom' then
    requested := p_preparation -> 'permissions';
    if pg_catalog.jsonb_typeof(requested) is distinct from 'array'
      or pg_catalog.jsonb_array_length(requested) = 0 then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(requested) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not (item.value ?& array['ownerKind', 'ownerId', 'permissionId'])
        or pg_catalog.jsonb_typeof(item.value -> 'ownerKind') is distinct from 'string'
        or item.value ->> 'ownerKind' not in ('platform', 'application', 'module')
        or pg_catalog.jsonb_typeof(item.value -> 'ownerId') is distinct from 'string'
        or vortex_context.is_non_nil_uuid(item.value ->> 'ownerId') is not true
        or pg_catalog.jsonb_typeof(item.value -> 'permissionId') is distinct from 'string'
        or vortex_context.is_non_nil_uuid(item.value ->> 'permissionId') is not true
        or ((item.value ->> 'ownerKind' = 'platform') = (item.value ? 'applicationRootId'))
        or (
          item.value ->> 'ownerKind' <> 'platform'
          and (
            pg_catalog.jsonb_typeof(item.value -> 'applicationRootId') is distinct from 'string'
            or vortex_context.is_non_nil_uuid(item.value ->> 'applicationRootId') is not true
            or (item.value ->> 'ownerKind' = 'application'
              and (item.value ->> 'ownerId')::uuid
                <> (item.value ->> 'applicationRootId')::uuid)
          )
        )
    ) then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
    select pg_catalog.jsonb_agg(distinct pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'applicationRootId', case when item.value ->> 'ownerKind' = 'platform'
          then null else (item.value ->> 'applicationRootId')::uuid end,
        'ownerKind', item.value ->> 'ownerKind',
        'ownerId', (item.value ->> 'ownerId')::uuid,
        'permissionId', (item.value ->> 'permissionId')::uuid
      )
    ))
    into refs
    from pg_catalog.jsonb_array_elements(requested) as item(value);
    if refs is null
      or pg_catalog.jsonb_array_length(refs) <> pg_catalog.jsonb_array_length(requested) then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
  else
    if pg_catalog.jsonb_typeof(p_preparation -> 'applicationRootId') is distinct from 'string'
      or vortex_context.is_non_nil_uuid(p_preparation ->> 'applicationRootId') is not true
      or pg_catalog.jsonb_typeof(p_preparation -> 'sourceRoleId') is distinct from 'string'
      or vortex_context.is_non_nil_uuid(p_preparation ->> 'sourceRoleId') is not true then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
    application_root_id := (p_preparation ->> 'applicationRootId')::uuid;
    source_role_id := (p_preparation ->> 'sourceRoleId')::uuid;

    select registration.* into application_registration
    from vortex_access.permission_registrations as registration
    where registration.organization_id = context_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = application_root_id
      and registration.state = 'active';
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    application_release := pg_catalog.jsonb_build_object(
      'kind', 'application',
      'definitionKey', application_registration.source_definition_key,
      'rootId', application_registration.registration_owner_id,
      'releaseRevision', application_registration.source_revision,
      'releaseVersion', application_registration.source_version,
      'validationContractVersion', application_registration.validation_contract_version,
      'contentFingerprint', application_registration.source_content_fingerprint,
      'resolutionFingerprint', application_registration.source_resolution_fingerprint
    );

    select coalesce(pg_catalog.jsonb_agg(ordered_entries.entry_json order by ordered_entries.subject),
      '[]'::jsonb)
    into registration_entries
    from (
      select pg_catalog.jsonb_build_object(
          'applicationRootId', entry.application_root_id,
          'ownerKind', entry.owner_kind,
          'ownerId', entry.owner_id,
          'permission', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
            'permissionId', entry.permission_id,
            'key', entry.permission_key,
            'label', entry.label,
            'description', entry.description,
            'recordTypeId', entry.record_type_id,
            'recordScope', entry.record_scope,
            'fieldPolicy', entry.field_policy,
            'actionKind', entry.action_kind,
            'namedAction', entry.named_action,
            'administrative', entry.administrative
          )),
          'sourceRelease', pg_catalog.jsonb_build_object(
            'kind', entry.source_kind,
            'definitionKey', entry.source_definition_key,
            'rootId', entry.source_root_id,
            'releaseRevision', entry.source_revision,
            'releaseVersion', entry.source_version,
            'validationContractVersion', entry.source_validation_contract_version,
            'contentFingerprint', entry.source_content_fingerprint,
            'resolutionFingerprint', entry.source_resolution_fingerprint
          ),
          'meaningFingerprint', entry.meaning_fingerprint
        ) as entry_json,
        entry.owner_kind || ':' || entry.owner_id::text || ':' || entry.permission_key
          || ':' || entry.permission_id::text as subject
      from vortex_access.permission_catalogue_entries as entry
      where entry.organization_id = context_organization_id
        and entry.registration_kind = 'application'
        and entry.registration_owner_id = application_root_id
        and entry.registration_revision = application_registration.revision
    ) as ordered_entries;

    select coalesce(pg_catalog.jsonb_agg(
      entry.permission_id order by entry.permission_key collate "C"
    ), '[]'::jsonb)
    into application_permission_ids
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = context_organization_id
      and entry.registration_kind = 'application'
      and entry.registration_owner_id = application_root_id
      and entry.registration_revision = application_registration.revision
      and entry.owner_kind = 'application'
      and entry.administrative = false;

    permission_registration := pg_catalog.jsonb_build_object(
      'contractVersion', '1.0.0',
      'organizationId', context_organization_id,
      'applicationRootId', application_root_id,
      'applicationRelease', application_release,
      'applicationCatalogueFingerprint', application_registration.permission_catalogue_fingerprint,
      'applicationPermissionIds', application_permission_ids,
      'entries', registration_entries,
      'candidateFingerprint', application_registration.candidate_fingerprint
    );

    select template.value into selected_template
    from vortex_definition.roots as root
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = application_registration.source_revision
      and release.release_version = application_registration.source_version
      and release.validation_contract_version = application_registration.validation_contract_version
      and release.content_fingerprint = application_registration.source_content_fingerprint
      and release.resolution_fingerprint = application_registration.source_resolution_fingerprint
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,roles}'
    ) as template(value)
    where root.root_id = application_root_id
      and root.organization_id = context_organization_id
      and root.kind = 'application'
      and root.key = application_registration.source_definition_key
      and (template.value ->> 'roleId')::uuid = source_role_id;
    if selected_template is null then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    select continuity.* into selected_continuity
    from vortex_access.application_role_template_continuities as continuity
    where continuity.organization_id = context_organization_id
      and continuity.application_root_id = application_root_id
      and continuity.source_role_id = source_role_id
      and continuity.state = 'available'
      and continuity.last_processed_registration_revision = application_registration.revision;
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    select pg_catalog.jsonb_agg(entry.entry_json order by key.ordinal)
    into source_permissions
    from pg_catalog.jsonb_array_elements_text(selected_template -> 'permissionKeys')
      with ordinality as key(permission_key, ordinal)
    join (
      select pg_catalog.jsonb_build_object(
          'applicationRootId', entry.application_root_id,
          'ownerKind', entry.owner_kind,
          'ownerId', entry.owner_id,
          'permission', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
            'permissionId', entry.permission_id,
            'key', entry.permission_key,
            'label', entry.label,
            'description', entry.description,
            'recordTypeId', entry.record_type_id,
            'recordScope', entry.record_scope,
            'fieldPolicy', entry.field_policy,
            'actionKind', entry.action_kind,
            'namedAction', entry.named_action,
            'administrative', entry.administrative
          )),
          'sourceRelease', pg_catalog.jsonb_build_object(
            'kind', entry.source_kind,
            'definitionKey', entry.source_definition_key,
            'rootId', entry.source_root_id,
            'releaseRevision', entry.source_revision,
            'releaseVersion', entry.source_version,
            'validationContractVersion', entry.source_validation_contract_version,
            'contentFingerprint', entry.source_content_fingerprint,
            'resolutionFingerprint', entry.source_resolution_fingerprint
          ),
          'meaningFingerprint', entry.meaning_fingerprint
        ) as entry_json,
        entry.permission_key
      from vortex_access.permission_catalogue_entries as entry
      where entry.organization_id = context_organization_id
        and entry.registration_kind = 'application'
        and entry.registration_owner_id = application_root_id
        and entry.registration_revision = application_registration.revision
    ) as entry on entry.permission_key = key.permission_key;
    if source_permissions is null
      or pg_catalog.jsonb_array_length(source_permissions)
        <> pg_catalog.jsonb_array_length(selected_template -> 'permissionKeys') then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    if selected_template #>> '{permissionSelection,kind}' = 'application_wildcard' then
      select coalesce(pg_catalog.jsonb_agg(item.value), '[]'::jsonb)
      into live_permissions
      from pg_catalog.jsonb_array_elements(source_permissions) as item(value)
      where item.value ->> 'ownerKind' = 'application'
        and (item.value ->> 'ownerId')::uuid = application_root_id
        and (item.value #>> '{permission,administrative}')::boolean = false
        and item.value #>> '{permission,actionKind}' <> 'export';
    else
      live_permissions := source_permissions;
    end if;

    prepared_templates_core := pg_catalog.jsonb_build_object(
      'contractVersion', '1.0.0',
      'preparationBasis', pg_catalog.jsonb_build_object(
        'kind', 'current_active_registration',
        'registrationRevision', application_registration.revision
      ),
      'permissionRegistration', permission_registration,
      'templates', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'template', selected_template,
        'sourceTemplateFingerprint', selected_continuity.source_template_fingerprint,
        'sourcePermissions', source_permissions,
        'livePermissions', live_permissions
      ))
    );

    select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', item.value -> 'applicationRootId',
        'ownerKind', item.value ->> 'ownerKind',
        'ownerId', item.value ->> 'ownerId',
        'permissionId', item.value #>> '{permission,permissionId}'
      )))
    into refs
    from pg_catalog.jsonb_array_elements(live_permissions) as item(value);
  end if;

  -- Every requested identity must still resolve to exactly one current, available accepted
  -- permission. The returned scope is exactly the references the role entry names, never wider.
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'kind', 'exact',
      'applicationRootId', continuity.application_root_id,
      'ownerKind', continuity.owner_kind,
      'ownerId', continuity.owner_id,
      'permissionId', continuity.permission_id,
      'acceptedRegistrationRevision', registration.revision,
      'catalogueFingerprint', registration.permission_catalogue_fingerprint,
      'continuityRevision', continuity.continuity_revision,
      'meaningFingerprint', continuity.meaning_fingerprint
    )) order by continuity.application_root_id nulls first,
      continuity.owner_kind collate "C", continuity.owner_id, continuity.permission_id)
  into permissions_value
  from pg_catalog.jsonb_array_elements(refs) as requested_permission(value)
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = context_organization_id
    and continuity.state = 'available'
    and continuity.application_root_id is not distinct from
      case when requested_permission.value ? 'applicationRootId'
        then (requested_permission.value ->> 'applicationRootId')::uuid else null end
    and continuity.owner_kind = requested_permission.value ->> 'ownerKind'
    and continuity.owner_id = (requested_permission.value ->> 'ownerId')::uuid
    and continuity.permission_id = (requested_permission.value ->> 'permissionId')::uuid
  join vortex_access.permission_registrations as registration
    on registration.organization_id = continuity.organization_id
    and registration.registration_kind = continuity.registration_kind
    and registration.registration_owner_id = continuity.registration_owner_id
    and registration.state = 'active'
  join vortex_access.permission_catalogue_entries as catalogue
    on catalogue.organization_id = continuity.organization_id
    and catalogue.registration_kind = continuity.registration_kind
    and catalogue.registration_owner_id = continuity.registration_owner_id
    and catalogue.registration_revision = registration.revision
    and catalogue.owner_kind = continuity.owner_kind
    and catalogue.owner_id = continuity.owner_id
    and catalogue.permission_id = continuity.permission_id
    and catalogue.application_root_id is not distinct from continuity.application_root_id
    and catalogue.meaning_fingerprint = continuity.meaning_fingerprint;
  if permissions_value is null
    or pg_catalog.jsonb_array_length(permissions_value)
      <> pg_catalog.jsonb_array_length(refs) then
    raise exception using errcode = '40001',
      message = 'Organization role permission evidence is stale or unavailable';
  end if;

  if operation_name = 'create_custom' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'available',
      'organizationId', context_organization_id,
      'permissions', permissions_value,
      'templateContinuityRevision', null,
      'preparedTemplatesCore', null
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'available',
    'organizationId', context_organization_id,
    'permissions', permissions_value,
    'templateContinuityRevision', selected_continuity.continuity_revision,
    'preparedTemplatesCore', prepared_templates_core
  );
exception
  when invalid_text_representation or invalid_parameter_value
      or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Organization role-change preparation input is invalid';
end
$function$;

revoke execute on function vortex_access.read_organization_role_change_evidence_for_administration(jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.read_organization_role_change_evidence_for_administration(jsonb)
to vortex_request;

comment on function vortex_access.read_organization_role_change_evidence_for_administration(jsonb) is
  'Server-side preparation read: given a role key, label, description, privilege classification and either exact permission references or a published template, it returns complete, fingerprinted permission and template evidence for the verified caller organisation only, with the actor and organisation taken from the request context and no scope wider than the request role entry.';
