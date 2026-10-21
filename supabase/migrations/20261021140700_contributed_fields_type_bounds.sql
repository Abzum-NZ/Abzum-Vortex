-- #3300: contributed fields join the type-level read bounds through the one contributor evaluator.

set local role vortex_owner;

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

create or replace function vortex_access.contributed_field_bounds_internal(
  p_decision jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  decision_organization_id uuid;
begin
  if p_decision is null or p_decision ->> 'outcome' is distinct from 'allowed' then
    raise exception using errcode = '22023',
      message = 'Contributed field bounds require an allowed record decision';
  end if;
  -- A decision that names no record binding concerns no owner record type, so nothing is
  -- contributed to it.
  if not pg_catalog.pg_input_is_valid(p_decision ->> 'organizationId', 'uuid')
    or not pg_catalog.pg_input_is_valid(p_decision #>> '{recordBinding,moduleRootId}', 'uuid')
    or not pg_catalog.pg_input_is_valid(p_decision #>> '{recordBinding,storageContractId}', 'uuid') then
    return '{"readableFieldIds":[],"changeableFieldIds":[]}'::jsonb;
  end if;
  decision_organization_id := (p_decision ->> 'organizationId')::uuid;

  -- The owner record's own decision already admitted this record under the owner's permissions;
  -- the contributor rule itself lives in one place.
  return vortex_access.contributor_field_grants_internal(
    decision_organization_id,
    (p_decision #>> '{recordBinding,moduleRootId}')::uuid,
    (p_decision #>> '{recordBinding,storageContractId}')::uuid,
    case when p_decision #>> '{action,actionKind}' = 'update' then 'update' else 'read' end
  );
end
$function$;

alter function vortex_access.contributed_field_bounds_internal(jsonb) owner to vortex_owner;

revoke all on function vortex_access.contributed_field_bounds_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.contributed_field_bounds_internal(jsonb)
  to vortex_owner;

comment on function vortex_access.contributed_field_bounds_internal(jsonb) is
  'Private contributed-field bounds over one allowed exact-record decision: the fields other installed Modules contributed to the record''s type that the person may read and change through a current permission the contributor declared for them. It adds only to a decision the owner''s permissions already allowed and never decides record access.';

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
  -- Nothing guaranteed and no exactness claim: the fail-closed answer.
  nothing constant jsonb := '{"readableFieldIds":[],"coversAllRecords":false,"conditionFree":false}'::jsonb;
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
  route_readable text[];
  guaranteed text[] := array[]::text[];
  contributed_readable text[];
  first_route boolean := true;
  covers_all_records boolean := false;
  condition_free boolean := true;
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
    return nothing;
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
        and share.application_scope_id = coalesce(case
          when binding ->> 'storageScope' = 'application_contained'
            then (p_declaration -> 'target' ->> 'applicationRootId')::uuid
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
            and share.organization_account_id = account_id)
          or (share.recipient_kind = 'group'
            and share.group_id = any (member_group_ids))
        )
    loop
      if not share_seen then
        share_intersection := array(
          select pg_catalog.lower(field.value)
          from pg_catalog.unnest(share_row.readable_field_ids::text[]) as field(value)
        );
        share_seen := true;
      else
        share_intersection := array(
          select field.value
          from pg_catalog.unnest(share_intersection) as field(value)
          where field.value = any (
            select pg_catalog.lower(shared.value)
            from pg_catalog.unnest(share_row.readable_field_ids::text[]) as shared(value)
          )
        );
      end if;
    end loop;
  end if;

  -- Each record is admitted by at least one (alternative, route) pair, and the
  -- exact decision exposes the union of the fields of the pairs that admit it.
  -- A field is therefore guaranteed on every admitted record only when every
  -- pair that can admit a record exposes it: the intersection over every pair,
  -- never a union within one alternative. An ownership, all-records or
  -- relationship pair exposes its permission's policy; a direct-share pair
  -- exposes that policy narrowed by the share, bounded here by the common
  -- bounds of every current share, and with no current share it admits no
  -- record and constrains nothing. Any unknown route fails closed.
  for candidate in
    select listed.value
    from pg_catalog.jsonb_array_elements(
      coalesce(eligibility -> 'eligiblePermissions', '[]'::jsonb)
    ) as listed(value)
  loop
    permission_value := candidate -> 'permission';
    source_value := candidate -> 'source';

    -- The meaning the caller's role accepted, at the registration revision the
    -- eligibility names; its registration must still be active.
    select entry.*
    into catalogue_entry
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and entry.registration_revision <= registration.revision
      and registration.state = 'active'
    where entry.organization_id = decision_organization_id
      and entry.registration_revision = (candidate ->> 'registrationRevision')::bigint
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

    if catalogue_entry.registration_revision is distinct from
        (candidate ->> 'registrationRevision')::bigint
      or catalogue_entry.source_kind is distinct from (source_value ->> 'kind')
      or catalogue_entry.source_definition_key is distinct from (source_value ->> 'definitionKey')
      or catalogue_entry.source_root_id is distinct from (source_value ->> 'rootId')::uuid
      or catalogue_entry.source_version is distinct from (source_value ->> 'releaseVersion')
      or catalogue_entry.source_revision is distinct from (source_value ->> 'releaseRevision')::bigint
      or catalogue_entry.source_validation_contract_version
        is distinct from (source_value ->> 'validationContractVersion') then
      raise exception using errcode = '22023',
        message = 'Record read field bounds found a superseded permission source';
    end if;

    -- A permission with no declared field policy contributes no field at all,
    -- so nothing is guaranteed for the whole record type.
    if catalogue_entry.field_policy is null then
      return nothing;
    end if;

    select coalesce(pg_catalog.array_agg(pg_catalog.lower(field.value)), array[]::text[])
    into policy_readable
    from pg_catalog.jsonb_array_elements_text(
      catalogue_entry.field_policy -> 'readableFieldIds'
    ) as field(value);

    routes := candidate -> 'recordScope' -> 'routes';
    if pg_catalog.jsonb_typeof(routes) is distinct from 'array' then
      return nothing;
    end if;

    -- A saved condition narrows every route of its alternative, including an
    -- all-records route, per record; the scan's table narrowing cannot apply it.
    if (candidate -> 'recordScope') ? 'savedCondition' then
      condition_free := false;
    elsif exists (
      select 1 from pg_catalog.jsonb_array_elements(routes) as listed_route(value)
      where listed_route.value ->> 'kind' = 'all_records'
    ) then
      covers_all_records := true;
    end if;

    for route in
      select listed_route.value
      from pg_catalog.jsonb_array_elements(routes) as listed_route(value)
    loop
      case route ->> 'kind'
        when 'all_records', 'ownership', 'relationship' then
          route_readable := policy_readable;
        when 'direct_share' then
          if not share_seen then
            continue;
          end if;
          route_readable := array(
            select shared.value
            from pg_catalog.unnest(policy_readable) as shared(value)
            where shared.value = any (share_intersection)
          );
        else
          return nothing;
      end case;

      if first_route then
        guaranteed := array(
          select distinct field.value
          from pg_catalog.unnest(route_readable) as field(value)
        );
        first_route := false;
      else
        guaranteed := array(
          select field.value
          from pg_catalog.unnest(guaranteed) as field(value)
          where field.value = any (route_readable)
        );
      end if;
      if pg_catalog.cardinality(guaranteed) = 0 then
        return nothing;
      end if;
    end loop;
  end loop;

  -- A field another installed Module contributed to this record type is visible on every record
  -- the owner's decision admits when the person holds the contributor's own unconditional read
  -- grant for it, so it is guaranteed whichever owner route admitted the record. The one
  -- contributor evaluator also serves the exact-record bounds; it never changes which records
  -- are admitted.
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(field.value)), array[]::text[])
  into contributed_readable
  from pg_catalog.jsonb_array_elements_text(
    vortex_access.contributor_field_grants_internal(
      decision_organization_id,
      (binding ->> 'moduleRootId')::uuid,
      (binding ->> 'storageContractId')::uuid,
      'read'
    ) -> 'readableFieldIds'
  ) as field(value);

  guaranteed := array(
    select distinct field.value
    from pg_catalog.unnest(guaranteed || contributed_readable) as field(value)
    order by field.value
  );

  return pg_catalog.jsonb_build_object(
    'readableFieldIds', pg_catalog.to_jsonb(guaranteed),
    'coversAllRecords', covers_all_records,
    'conditionFree', condition_free
  );
end
$function$;
alter function vortex_access.resolve_record_read_field_bounds_internal(jsonb) owner to vortex_owner;


revoke all on function vortex_access.resolve_record_read_field_bounds_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.resolve_record_read_field_bounds_internal(jsonb)
  to vortex_record_adapter;

comment on function vortex_access.resolve_record_read_field_bounds_internal(jsonb) is
  'Private whole-record-type field bounds for the fixed record query: from the caller''s own current eligible read alternatives it returns the fields every alternative route is guaranteed to expose on every record it can admit (the intersection over every alternative and route, each direct-share route narrowed by every current share''s own bounds), plus each field another installed Module contributed that the person holds an unconditional read grant for, whether an unconditioned all-records alternative admits every active record, and whether no alternative carries a saved condition; any unknown route or missing policy yields no fields. It only decides which fields a scan may order or filter by and never decides access.';

alter function vortex_access.resolve_record_read_field_bounds_internal(jsonb)
  owner to vortex_owner;

reset role;
