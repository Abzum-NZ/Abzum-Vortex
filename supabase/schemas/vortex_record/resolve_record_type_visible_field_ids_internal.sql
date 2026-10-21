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
  binding jsonb;
  eligibility jsonb;
  candidate jsonb;
  source_value jsonb;
  route jsonb;
  catalogue_entry vortex_access.permission_catalogue_entries%rowtype;
  policy_readable text[];
  routes jsonb;
  visible text[] := array[]::text[];
  share_only_fallback text[] := array[]::text[];
  share_loaded boolean := false;
  share_seen boolean := false;
  share_readable text[] := array[]::text[];
begin
  -- Owner-only: the decision below is local to this call. No GUC, temporary
  -- table or argument can supply or retain an access decision.
  declaration := vortex_record.record_type_read_declaration_internal(
    p_plan, p_record_type_id, (ctx ->> 'applicationRootId')::uuid
  );
  if declaration is null then
    return '[]'::jsonb;
  end if;
  binding := declaration -> 'recordBinding';
  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    declaration, ctx, checked_at
  );
  if eligibility ->> 'outcome' is distinct from 'eligible' then
    return '[]'::jsonb;
  end if;

  -- A column is decided by access route, never record by record: it is visible
  -- when at least one (permission, route) pair the reader holds exposes it. An
  -- all-records, ownership or relationship route exposes its permission's
  -- declared readable fields. A direct-share route can only narrow them to the
  -- fields of the shares the reader holds now, so the set read is bounded by
  -- those shares and never by the size of the table. An unknown route kind
  -- contributes nothing.
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
      case route ->> 'kind'
        when 'all_records', 'ownership', 'relationship' then
          visible := visible || policy_readable;
          continue;
        when 'direct_share' then
          null;
        else
          continue;
      end case;
      if not share_loaded then
        select pg_catalog.count(*) > 0,
          coalesce(pg_catalog.array_agg(distinct pg_catalog.lower(field.value::text))
            filter (where field.value is not null), array[]::text[])
        into share_seen, share_readable
        from vortex_access.organization_direct_record_shares as share
        left join lateral pg_catalog.unnest(share.readable_field_ids) as field(value) on true
        where share.organization_id = (ctx ->> 'organizationId')::uuid
          and share.storage_scope = binding ->> 'storageScope'
          and share.application_scope_id = coalesce(case
            when binding ->> 'storageScope' = 'application_contained'
              then (declaration -> 'target' ->> 'applicationRootId')::uuid
            else null::uuid
          end, '00000000-0000-0000-0000-000000000000'::uuid)
          and share.module_root_id = (binding ->> 'moduleRootId')::uuid
          and share.record_type_id = (binding ->> 'recordTypeId')::uuid
          and share.storage_contract_id = (binding ->> 'storageContractId')::uuid
          and share.state = 'active'
          and share.starts_at <= checked_at
          and (share.expires_at is null or share.expires_at > checked_at)
          and (
            (share.recipient_kind = 'organization_account'
              and share.organization_account_id = (ctx ->> 'organizationAccountId')::uuid)
            or (share.recipient_kind = 'group' and exists (
              select 1
              from vortex_access.organization_group_memberships as membership
              join vortex_access.organization_groups as organization_group
                on organization_group.organization_id = membership.organization_id
                and organization_group.group_id = membership.group_id
                and organization_group.state = 'active'
              where membership.organization_id = share.organization_id
                and membership.group_id = share.group_id
                and membership.organization_account_id = (ctx ->> 'organizationAccountId')::uuid
                and membership.state = 'live'
                and membership.starts_at <= checked_at
                and (membership.expires_at is null or membership.expires_at > checked_at)
            ))
          );
        share_loaded := true;
      end if;
      -- With no current share the route admits no record and adds no column;
      -- its declared fields are kept only as the share-only fallback below.
      if share_seen then
        visible := visible || array(
          select shared.value from pg_catalog.unnest(policy_readable) as shared(value)
          where shared.value = any (share_readable)
        );
      else
        share_only_fallback := share_only_fallback || policy_readable;
      end if;
    end loop;
  end loop;

  -- A reader whose only routes are shares, none current, still sees the
  -- declared columns over an empty result; any other route's columns win.
  if pg_catalog.cardinality(visible) = 0 then
    visible := share_only_fallback;
  end if;

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
  'Owner-only column visibility of one record type for the validated human context, decided by access route: the declared readable fields of each eligible permission route, narrowed by the fields of the current direct shares on a share route (a share route with no current share adds nothing unless no route yields a column), then by the produced-field rule. It reads no record, so its cost is bounded by routes and shares.';
