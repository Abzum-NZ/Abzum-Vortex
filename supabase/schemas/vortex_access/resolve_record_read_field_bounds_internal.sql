create or replace function vortex_access.resolve_record_read_field_bounds_internal(
  p_declaration jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  ctx jsonb;
  checked_at timestamptz;
  decision_organization_id uuid;
  account_id uuid;
  binding jsonb;
  eligibility jsonb;
  candidate jsonb;
  permission_value jsonb;
  source_value jsonb;
  routes jsonb;
  route jsonb;
  catalogue_entry vortex_access.permission_catalogue_entries%rowtype;
  policy_readable text[];
  route_intersection text[];
  contribution_readable text[];
  contribution_route_count integer;
  guaranteed text[];
  first_contribution boolean := true;
  wants_share boolean := false;
  member_group_ids uuid[];
  share_row record;
  share_intersection text[];
  share_seen boolean := false;
begin
  -- The planner only knows how to reason about a record read; anything else is
  -- a caller error, never a wider grant.
  if p_declaration is null
    or pg_catalog.jsonb_typeof(p_declaration) <> 'object'
    or p_declaration -> 'action' ->> 'actionKind' is distinct from 'read'
    or (p_declaration -> 'action') ? 'namedAction' then
    raise exception using errcode = '22023',
      message = 'Record read field-bounds declaration is invalid';
  end if;

  ctx := vortex_access.validated_human_request_context();
  checked_at := pg_catalog.clock_timestamp();
  decision_organization_id := (ctx ->> 'organizationId')::uuid;
  account_id := (ctx ->> 'organizationAccountId')::uuid;
  binding := p_declaration -> 'recordBinding';

  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    p_declaration, ctx, checked_at
  );

  -- An ineligible caller is admitted to no record, so it is guaranteed no
  -- field and nothing may be pushed.
  if eligibility ->> 'outcome' <> 'eligible' then
    return pg_catalog.jsonb_build_object('readableFieldIds', '[]'::jsonb);
  end if;

  -- A direct-share route narrows its permission to the individual share's own
  -- readable fields, which are current rows rather than a static declaration.
  -- When any eligible alternative can match through such a route, take the
  -- intersection of every current share's own bounds once, so a field that a
  -- share withholds is never treated as visible.
  select exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      coalesce(eligibility -> 'eligiblePermissions', '[]'::jsonb)
    ) as listed(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      coalesce(listed.value -> 'recordScope' -> 'routes', '[]'::jsonb)
    ) as listed_route(value)
    where listed_route.value ->> 'kind' = 'direct_share'
  ) into wants_share;

  if wants_share then
    -- The groups the caller belongs to now: an active group and a live,
    -- started, unexpired membership, exactly as the share tests require.
    select coalesce(pg_catalog.array_agg(distinct membership.group_id), array[]::uuid[])
    into member_group_ids
    from vortex_access.organization_group_memberships as membership
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = membership.organization_id
      and organization_group.group_id = membership.group_id
      and organization_group.state = 'active'
    where membership.organization_id = decision_organization_id
      and membership.organization_account_id = account_id
      and membership.state = 'live'
      and membership.starts_at <= checked_at
      and (membership.expires_at is null or membership.expires_at > checked_at);

    for share_row in
      select share.readable_field_ids
      from vortex_access.organization_direct_record_shares as share
      where share.organization_id = decision_organization_id
        and share.storage_scope = binding ->> 'storageScope'
        and share.application_root_id is not distinct from case
          when binding ->> 'storageScope' = 'application_contained'
            then (p_declaration -> 'target' ->> 'applicationRootId')::uuid
          else null::uuid
        end
        and share.module_root_id = (binding ->> 'moduleRootId')::uuid
        and share.record_type_id = (binding ->> 'recordTypeId')::uuid
        and share.storage_contract_id = (binding ->> 'storageContractId')::uuid
        and share.state = 'active'
        and share.starts_at <= checked_at
        and (share.expires_at is null or share.expires_at > checked_at)
        and (
          (share.recipient_kind = 'organization_account'
            and share.organization_account_id = account_id)
          or (share.recipient_kind = 'group'
            and share.group_id = any (member_group_ids))
        )
    loop
      if not share_seen then
        share_intersection := share_row.readable_field_ids::text[];
        share_seen := true;
      else
        share_intersection := array(
          select field.value
          from pg_catalog.unnest(share_intersection) as field(value)
          where field.value = any (share_row.readable_field_ids::text[])
        );
      end if;
    end loop;
  end if;

  -- A field is guaranteed only when every eligible alternative exposes it for
  -- every record that alternative can admit. The intersection of each
  -- alternative's own readable set is that guarantee. A direct-share route
  -- contributes its permission's policy intersected with the current shares'
  -- common bounds; with no current share it admits no record and contributes
  -- nothing.
  for candidate in
    select listed.value
    from pg_catalog.jsonb_array_elements(
      coalesce(eligibility -> 'eligiblePermissions', '[]'::jsonb)
    ) as listed(value)
  loop
    permission_value := candidate -> 'permission';
    source_value := candidate -> 'source';

    select entry.*
    into catalogue_entry
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
      and registration.state = 'active'
    where entry.organization_id = decision_organization_id
      and entry.application_root_id = (permission_value ->> 'applicationRootId')::uuid
      and entry.owner_kind = permission_value ->> 'ownerKind'
      and entry.owner_id = (permission_value ->> 'ownerId')::uuid
      and entry.permission_id = (permission_value ->> 'permissionId')::uuid;

    -- The eligibility decision just used this exact permission; a missing or
    -- superseded catalogue entry is an internal inconsistency, not a refusal
    -- that silently widens what may be pushed.
    if not found then
      raise exception using errcode = '22023',
        message = 'Record read field bounds found no catalogue entry';
    end if;

    if catalogue_entry.source_kind is distinct from (source_value ->> 'kind')
      or catalogue_entry.source_definition_key is distinct from (source_value ->> 'definitionKey')
      or catalogue_entry.source_root_id is distinct from (source_value ->> 'rootId')::uuid
      or catalogue_entry.source_version is distinct from (source_value ->> 'releaseVersion')
      or catalogue_entry.source_revision is distinct from (source_value ->> 'releaseRevision')::bigint
      or catalogue_entry.source_validation_contract_version
        is distinct from (source_value ->> 'validationContractVersion')
      or catalogue_entry.source_content_fingerprint
        is distinct from (source_value ->> 'contentFingerprint')
      or catalogue_entry.source_resolution_fingerprint
        is distinct from (source_value ->> 'resolutionFingerprint') then
      raise exception using errcode = '22023',
        message = 'Record read field bounds found a superseded permission source';
    end if;

    -- A permission with no declared field policy contributes no field at all,
    -- so nothing is guaranteed for the whole record type.
    if catalogue_entry.field_policy is null then
      return pg_catalog.jsonb_build_object('readableFieldIds', '[]'::jsonb);
    end if;

    select coalesce(pg_catalog.array_agg(pg_catalog.lower(field.value)), array[]::text[])
    into policy_readable
    from pg_catalog.jsonb_array_elements_text(
      catalogue_entry.field_policy -> 'readableFieldIds'
    ) as field(value);

    contribution_readable := array[]::text[];
    contribution_route_count := 0;
    routes := candidate -> 'recordScope' -> 'routes';
    if pg_catalog.jsonb_typeof(routes) is distinct from 'array' then
      return pg_catalog.jsonb_build_object('readableFieldIds', '[]'::jsonb);
    end if;
    for route in
      select listed_route.value
      from pg_catalog.jsonb_array_elements(routes) as listed_route(value)
    loop
      if route ->> 'kind' = 'direct_share' then
        if not share_seen then
          continue;
        end if;
        route_intersection := array(
          select shared.value
          from pg_catalog.unnest(policy_readable) as shared(value)
          where shared.value = any (share_intersection)
        );
        contribution_readable := contribution_readable || route_intersection;
        contribution_route_count := contribution_route_count + 1;
      else
        contribution_readable := contribution_readable || policy_readable;
        contribution_route_count := contribution_route_count + 1;
      end if;
    end loop;

    -- A contribution with no route that can admit a record constrains nothing.
    if contribution_route_count = 0 then
      continue;
    end if;

    contribution_readable := array(
      select distinct value from pg_catalog.unnest(contribution_readable) as field(value)
      order by value
    );
    if first_contribution then
      guaranteed := contribution_readable;
      first_contribution := false;
    else
      guaranteed := array(
        select field.value
        from pg_catalog.unnest(guaranteed) as field(value)
        where field.value = any (contribution_readable)
      );
    end if;
    if pg_catalog.cardinality(guaranteed) = 0 then
      return pg_catalog.jsonb_build_object('readableFieldIds', '[]'::jsonb);
    end if;
  end loop;

  if first_contribution then
    guaranteed := array[]::text[];
  end if;

  return pg_catalog.jsonb_build_object(
    'readableFieldIds', pg_catalog.to_jsonb(guaranteed)
  );
end
$function$;

revoke all on function vortex_access.resolve_record_read_field_bounds_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_access.resolve_record_read_field_bounds_internal(jsonb)
  to vortex_record_adapter;

comment on function vortex_access.resolve_record_read_field_bounds_internal(jsonb) is
  'Private whole-record-type field bounds for the fixed record query: from the caller''s own current eligible read alternatives it returns the exact fields every alternative is guaranteed to expose on every record it can admit, intersected with each current direct share''s own bounds, or an empty set when any alternative can withhold a field; it only decides which fields a scan may order or filter by and never decides access.';
