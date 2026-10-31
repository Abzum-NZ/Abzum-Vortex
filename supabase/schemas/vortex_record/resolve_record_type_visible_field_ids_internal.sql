create or replace function vortex_record.resolve_record_type_visible_field_ids_internal(
  p_record_type_id uuid, p_plan jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  ctx jsonb := vortex_access.validated_human_request_context();
  checked_at timestamptz := pg_catalog.clock_timestamp();
  declaration jsonb;
  eligibility jsonb;
  candidate jsonb;
  source_value jsonb;
  route jsonb;
  catalogue_entry vortex_access.permission_catalogue_entries%rowtype;
  policy_readable text[];
  routes jsonb;
  visible text[] := array[]::text[];
begin
  -- Owner-only: the decision below is local to this call. No GUC, temporary
  -- table or argument can supply or retain an access decision.
  declaration := vortex_record.record_type_read_declaration_internal(
    p_plan, p_record_type_id, (ctx ->> 'applicationRootId')::uuid
  );
  if declaration is null then
    return '[]'::jsonb;
  end if;
  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    declaration, ctx, checked_at
  );
  if eligibility ->> 'outcome' is distinct from 'eligible' then
    return '[]'::jsonb;
  end if;

  -- A column is decided by access route, never record by record: it is visible
  -- when at least one (permission, route) pair the reader holds exposes it. An
  -- all-records, ownership or relationship route exposes its permission's
  -- declared readable fields. An unknown route kind contributes nothing.
  for candidate in
    select listed.value
    from pg_catalog.jsonb_array_elements(
      coalesce(eligibility -> 'eligiblePermissions', '[]'::jsonb)
    ) as listed(value)
  loop
    source_value := candidate -> 'source';
    -- The meaning the caller's role accepted, at the registration revision the
    -- eligibility names; its registration must still be active.
    select entry.* into catalogue_entry
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and entry.registration_revision <= registration.revision
      and registration.state = 'active'
    where entry.organization_id = (ctx ->> 'organizationId')::uuid
      and entry.registration_revision = (candidate ->> 'registrationRevision')::bigint
      and entry.application_root_id = (candidate #>> '{permission,applicationRootId}')::uuid
      and entry.owner_kind = candidate #>> '{permission,ownerKind}'
      and entry.owner_id = (candidate #>> '{permission,ownerId}')::uuid
      and entry.permission_id = (candidate #>> '{permission,permissionId}')::uuid;
    if not found then
      raise exception using errcode = '22023',
        message = 'Record field visibility found no catalogue entry';
    end if;
    if catalogue_entry.source_kind is distinct from (source_value ->> 'kind')
      or catalogue_entry.source_definition_key is distinct from (source_value ->> 'definitionKey')
      or catalogue_entry.source_root_id is distinct from (source_value ->> 'rootId')::uuid
      or catalogue_entry.source_version is distinct from (source_value ->> 'releaseVersion')
      or catalogue_entry.source_revision is distinct from (source_value ->> 'releaseRevision')::bigint
      or catalogue_entry.source_validation_contract_version
        is distinct from (source_value ->> 'validationContractVersion') then
      raise exception using errcode = '22023',
        message = 'Record field visibility found a superseded permission source';
    end if;
    -- No declared field policy contributes no field, as the record decision does.
    select coalesce(pg_catalog.array_agg(pg_catalog.lower(field.value)), array[]::text[])
    into policy_readable
    from pg_catalog.jsonb_array_elements_text(
      coalesce(catalogue_entry.field_policy -> 'readableFieldIds', '[]'::jsonb)
    ) as field(value);
    if pg_catalog.cardinality(policy_readable) = 0 then
      continue;
    end if;
    routes := candidate -> 'recordScope' -> 'routes';
    if pg_catalog.jsonb_typeof(routes) is distinct from 'array' then
      continue;
    end if;
    for route in select item.value from pg_catalog.jsonb_array_elements(routes) as item(value)
    loop
      if route ->> 'kind' in ('all_records', 'ownership', 'relationship') then
        visible := visible || policy_readable;
      end if;
    end loop;
  end loop;

  -- The upper bound, then the one rule for produced fields: a calculation or
  -- total the reader cannot fully read stays withheld.
  return vortex_record.decide_visible_produced_field_ids_internal(
    p_plan, p_record_type_id,
    coalesce((
      select pg_catalog.jsonb_agg(ids.value order by ids.value)
      from (select distinct listed.value from pg_catalog.unnest(visible) as listed(value)) as ids
    ), '[]'::jsonb)
  );
end
$function$;

alter function vortex_record.resolve_record_type_visible_field_ids_internal(uuid, jsonb)
  owner to vortex_owner;
revoke all on function vortex_record.resolve_record_type_visible_field_ids_internal(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_record.resolve_record_type_visible_field_ids_internal(uuid, jsonb) is
  'Owner-only column visibility of one record type for the validated human context, decided by access route: the declared readable fields of each eligible permission route, then the produced-field rule. It reads no record, so its cost is bounded by routes.';
