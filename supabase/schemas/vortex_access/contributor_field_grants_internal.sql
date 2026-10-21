create or replace function vortex_access.contributor_field_grants_internal(
  p_organization_id uuid,
  p_module_root_id uuid,
  p_storage_contract_id uuid,
  p_action_kind text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  checked_at timestamptz := pg_catalog.statement_timestamp();
  contribution jsonb;
  field_id_value text;
  candidate record;
  granted record;
  policy jsonb;
  readable_ids text[] := array[]::text[];
  changeable_ids text[] := array[]::text[];
begin
  if p_organization_id is null or p_module_root_id is null or p_storage_contract_id is null
    or p_action_kind is null or p_action_kind not in ('read', 'update') then
    raise exception using errcode = '22023',
      message = 'Contributor field grants require an organisation, record type and read or update';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if (context_value ->> 'organizationId')::uuid is distinct from p_organization_id then
    raise exception using errcode = '42501',
      message = 'Contributor field grants require the request''s own organisation';
  end if;

  -- The caller already admitted the record under the owner's own permissions.
  -- A field another installed Module contributed to the record's type is added only where the
  -- person also holds a current permission the contributor declared for that field: its field
  -- policy must list the field, and its record scope must be unconditional, because the
  -- contributor's row scope cannot be evaluated on a record the contributor does not own.
  for contribution in
    select item.value
    from pg_catalog.jsonb_array_elements(
      vortex_record.installed_record_type_contributions_internal(
        p_organization_id, p_module_root_id, p_storage_contract_id
      )
    ) as item(value)
    where item.value ->> 'kind' = 'field'
  loop
    field_id_value := pg_catalog.lower(contribution ->> 'contributionId');
    for candidate in
      select distinct entry.application_root_id, entry.owner_kind, entry.owner_id,
        entry.permission_id, entry.record_type_id, entry.action_kind
      from vortex_access.permission_catalogue_entries as entry
      where entry.organization_id = p_organization_id
        and entry.registration_kind = 'application'
        and entry.record_type_id is not null
        and entry.action_kind in ('read', 'update')
        and entry.application_root_id in (
          select pg_catalog.lower(application.value)::uuid
          from pg_catalog.jsonb_array_elements_text(
            contribution -> 'contributorApplicationRootIds'
          ) as application(value)
        )
        and (
          (entry.owner_kind = 'module'
            and entry.owner_id = (contribution ->> 'contributorModuleRootId')::uuid)
          or (entry.owner_kind = 'application'
            and entry.owner_id = entry.application_root_id)
        )
      order by entry.application_root_id, entry.owner_kind, entry.owner_id, entry.permission_id
    loop
      for granted in
        select path.permission_entry, path.path_valid_until
        from vortex_access.evaluate_permission_role_path_internal(
          context_value, checked_at,
          pg_catalog.jsonb_build_object(
            'applicationRootId', candidate.application_root_id,
            'ownerKind', candidate.owner_kind,
            'ownerId', candidate.owner_id,
            'permissionId', candidate.permission_id
          ),
          pg_catalog.jsonb_build_object('actionKind', candidate.action_kind),
          candidate.record_type_id
        ) as path
      loop
        if granted.path_valid_until is null
          or granted.path_valid_until <= checked_at
          or pg_catalog.jsonb_typeof((granted.permission_entry).record_scope) is distinct from 'object'
          or (granted.permission_entry).record_scope ? 'savedCondition'
          or not coalesce(
            (granted.permission_entry).record_scope -> 'routes' @> '[{"kind":"all_records"}]'::jsonb,
            false
          ) then
          continue;
        end if;
        policy := (granted.permission_entry).field_policy;
        if pg_catalog.jsonb_typeof(policy) is distinct from 'object' then
          continue;
        end if;
        if exists (
          select 1 from pg_catalog.jsonb_array_elements_text(policy -> 'readableFieldIds') as item(value)
          where pg_catalog.lower(item.value) = field_id_value
        ) then
          readable_ids := readable_ids || field_id_value;
          if candidate.action_kind = 'update'
            and p_action_kind = 'update' and exists (
            select 1 from pg_catalog.jsonb_array_elements_text(policy -> 'changeableFieldIds') as item(value)
            where pg_catalog.lower(item.value) = field_id_value
          ) then
            changeable_ids := changeable_ids || field_id_value;
          end if;
        end if;
      end loop;
    end loop;
  end loop;

  return pg_catalog.jsonb_build_object(
    'readableFieldIds', pg_catalog.to_jsonb(array(
      select distinct field.value from pg_catalog.unnest(readable_ids) as field(value) order by field.value
    )),
    'changeableFieldIds', pg_catalog.to_jsonb(array(
      select distinct field.value from pg_catalog.unnest(changeable_ids) as field(value) order by field.value
    ))
  );
end
$function$;

alter function vortex_access.contributor_field_grants_internal(uuid, uuid, uuid, text) owner to vortex_owner;

revoke all on function vortex_access.contributor_field_grants_internal(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.contributor_field_grants_internal(uuid, uuid, uuid, text)
  to vortex_owner;

comment on function vortex_access.contributor_field_grants_internal(uuid, uuid, uuid, text) is
  'The one evaluator of the contributor rule: for a record type, the fields other installed Modules contributed that the current request''s person may read (and, for update, change) through a current permission the contributor declared for them. A grant counts only with an unconditional all-records scope, because the contributor''s row scope cannot be evaluated on a record the contributor does not own. It adds to what the owner''s permissions admit and never decides record access.';
