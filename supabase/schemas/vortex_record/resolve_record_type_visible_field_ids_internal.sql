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
  route jsonb;
  policy jsonb;
  policy_readable text[];
  routes jsonb;
  visible text[] := array[]::text[];
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
  -- those shares and never by the size of the table.
  for candidate in
    select listed.value
    from pg_catalog.jsonb_array_elements(
      coalesce(eligibility -> 'eligiblePermissions', '[]'::jsonb)
    ) as listed(value)
  loop
    select entry.field_policy into policy
    from vortex_access.permission_catalogue_entries as entry
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
    -- No declared field policy contributes no field, as the record decision does.
    select coalesce(pg_catalog.array_agg(pg_catalog.lower(field.value)), array[]::text[])
    into policy_readable
    from pg_catalog.jsonb_array_elements_text(
      coalesce(policy -> 'readableFieldIds', '[]'::jsonb)
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
      if route ->> 'kind' is distinct from 'direct_share' then
        visible := visible || policy_readable;
        continue;
      end if;
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
      -- With no current share the route admits no record, so it narrows
      -- nothing: the declared fields stay offered over an empty result.
      visible := visible || case when share_seen then array(
        select shared.value from pg_catalog.unnest(policy_readable) as shared(value)
        where shared.value = any (share_readable)
      ) else policy_readable end;
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
  'Owner-only column visibility of one record type for the validated human context, decided by access route: the declared readable fields of each eligible permission route, narrowed by the fields of the current direct shares on a share route, then by the produced-field rule. It reads no record, so its cost is bounded by routes and shares.';
