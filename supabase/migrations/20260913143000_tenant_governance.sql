-- Human tenant authority.  Runtime supplies only a verified session identity and
-- selected tenant; current structural authority is resolved from private facts.

create function vortex_identity.require_current_tenant_capability(
  p_identity_id uuid, p_tenant_id uuid, p_capability_key text, p_evaluated_at timestamptz
)
returns void
language plpgsql volatile security definer set search_path = ''
as $function$
begin
  if not exists (
    select 1
    from vortex_identity.tenants tenant
    join vortex_identity.identity_projections projection on projection.identity_id = p_identity_id
    where tenant.tenant_id = p_tenant_id and tenant.state = 'active'
      and projection.state = 'active'
      and exists (
        select 1 from vortex_identity.tenant_administrator_assignments assignment
        where assignment.tenant_id = tenant.tenant_id
          and assignment.identity_id = projection.identity_id
          and assignment.revoked_at is null
          and assignment.starts_at <= p_evaluated_at
          and (assignment.expires_at is null or assignment.expires_at > p_evaluated_at)
          and p_capability_key = any(assignment.capability_keys)
      )
  ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
end
$function$;

create function vortex_identity.list_tenant_launcher(
  p_identity_id uuid, p_limit integer, p_after uuid default null
)
returns table (tenant_id uuid, display_name text)
language plpgsql volatile security definer set search_path = ''
as $function$
declare evaluated_at timestamptz := pg_catalog.clock_timestamp();
begin
  if p_identity_id is null or not vortex_context.is_non_nil_uuid(p_identity_id::text)
    or p_limit is null or p_limit not between 1 and 101
    or (p_after is not null and not vortex_context.is_non_nil_uuid(p_after::text)) then
    raise exception using errcode = '22023', message = 'Tenant launcher request is invalid';
  end if;
  if not exists (select 1 from vortex_identity.identity_projections p where p.identity_id = p_identity_id and p.state = 'active') then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  return query
  select tenant.tenant_id, tenant.display_name
  from vortex_identity.tenants tenant
  where tenant.state = 'active' and (p_after is null or tenant.tenant_id > p_after)
    and exists (
      select 1 from vortex_identity.tenant_administrator_assignments assignment
      where assignment.tenant_id = tenant.tenant_id and assignment.identity_id = p_identity_id
        and assignment.revoked_at is null and assignment.starts_at <= evaluated_at
        and (assignment.expires_at is null or assignment.expires_at > evaluated_at)
    )
  order by tenant.tenant_id limit p_limit;
end
$function$;

create function vortex_identity.list_tenant_hierarchy(
  p_identity_id uuid, p_tenant_id uuid, p_limit integer, p_after uuid default null
)
returns table (organization_id uuid, parent_organization_id uuid, short_name text, display_name text, state text, revision bigint)
language plpgsql volatile security definer set search_path = ''
as $function$
begin
  if p_identity_id is null or not vortex_context.is_non_nil_uuid(p_identity_id::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_limit is null or p_limit not between 1 and 101
    or (p_after is not null and not vortex_context.is_non_nil_uuid(p_after::text)) then
    raise exception using errcode = '22023', message = 'Tenant hierarchy request is invalid';
  end if;
  perform vortex_identity.require_current_tenant_capability(p_identity_id, p_tenant_id, 'platform.tenant.hierarchy.read', pg_catalog.clock_timestamp());
  return query select organization.organization_id, organization.parent_organization_id,
    organization.short_name, organization.display_name, organization.state, organization.revision
  from vortex_identity.organizations organization
  where organization.tenant_id = p_tenant_id
    and (p_after is null or organization.organization_id > p_after)
  order by organization.organization_id limit p_limit;
end
$function$;

create function vortex_identity.read_tenant_organization(
  p_identity_id uuid, p_tenant_id uuid, p_organization_id uuid
)
returns table (organization_id uuid, parent_organization_id uuid, short_name text, display_name text, state text, revision bigint)
language plpgsql volatile security definer set search_path = ''
as $function$
begin
  if p_identity_id is null or not vortex_context.is_non_nil_uuid(p_identity_id::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text) then
    raise exception using errcode = '22023', message = 'Tenant organization request is invalid';
  end if;
  perform vortex_identity.require_current_tenant_capability(p_identity_id, p_tenant_id, 'platform.tenant.hierarchy.read', pg_catalog.clock_timestamp());
  return query select organization.organization_id, organization.parent_organization_id,
    organization.short_name, organization.display_name, organization.state, organization.revision
  from vortex_identity.organizations organization
  where organization.tenant_id = p_tenant_id and organization.organization_id = p_organization_id;
  if not found then raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable'; end if;
end
$function$;

create function vortex_identity.list_tenant_administrator_assignments(
  p_identity_id uuid, p_tenant_id uuid, p_limit integer, p_after uuid default null
)
returns table (assignment_id uuid, identity_id uuid, capability_keys text[], starts_at timestamptz, expires_at timestamptz, revision bigint, outcome text)
language plpgsql volatile security definer set search_path = ''
as $function$
declare evaluated_at timestamptz := pg_catalog.clock_timestamp();
begin
  if p_identity_id is null or not vortex_context.is_non_nil_uuid(p_identity_id::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_limit is null or p_limit not between 1 and 101
    or (p_after is not null and not vortex_context.is_non_nil_uuid(p_after::text)) then
    raise exception using errcode = '22023', message = 'Tenant assignment request is invalid';
  end if;
  perform vortex_identity.require_current_tenant_capability(p_identity_id, p_tenant_id, 'platform.tenant.administrators.read', evaluated_at);
  return query select assignment.assignment_id, assignment.identity_id, assignment.capability_keys,
    assignment.starts_at, assignment.expires_at, assignment.revision,
    case when assignment.revoked_at is not null and assignment.revoked_at <= evaluated_at then 'revoked'
      when assignment.starts_at > evaluated_at then 'scheduled'
      when assignment.expires_at is not null and assignment.expires_at <= evaluated_at then 'expired'
      else 'active' end
  from vortex_identity.tenant_administrator_assignments assignment
  where assignment.tenant_id = p_tenant_id and (p_after is null or assignment.assignment_id > p_after)
  order by assignment.assignment_id limit p_limit;
end
$function$;

create function vortex_identity.tenant_capabilities_from_json(p_capabilities jsonb)
returns text[] language plpgsql immutable strict parallel safe security definer set search_path = ''
as $function$
declare result text[];
begin
  if pg_catalog.jsonb_typeof(p_capabilities) <> 'array' then return null; end if;
  select pg_catalog.array_agg(item.value order by item.ordinality) into result
  from pg_catalog.jsonb_array_elements_text(p_capabilities) with ordinality item(value, ordinality);
  if result is null or not vortex_identity.tenant_structural_capability_set_is_canonical(result) then return null; end if;
  return result;
exception when others then return null;
end
$function$;

create function vortex_identity.grant_tenant_administrator(
  p_actor_identity_id uuid, p_duplicate_key uuid, p_command_fingerprint text,
  p_tenant_id uuid, p_subject_identity_id uuid, p_capabilities jsonb,
  p_starts_at timestamptz, p_expires_at timestamptz
)
returns table (outcome text, operation text, assignment_id uuid, revision bigint, correlation_id uuid, accepted_at timestamptz)
language plpgsql volatile security definer set search_path = ''
as $function$
declare capabilities text[]; evaluated_at timestamptz; receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_assignment_id uuid := pg_catalog.gen_random_uuid(); new_correlation_id uuid := pg_catalog.gen_random_uuid();
begin
  capabilities := vortex_identity.tenant_capabilities_from_json(p_capabilities);
  if p_actor_identity_id is null or not vortex_context.is_non_nil_uuid(p_actor_identity_id::text)
    or p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_subject_identity_id is null or not vortex_context.is_non_nil_uuid(p_subject_identity_id::text)
    or p_command_fingerprint is null or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$' or capabilities is null
    or p_starts_at is null or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and (p_expires_at <= p_starts_at or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))) then
    raise exception using errcode = '22023', message = 'Tenant assignment command is invalid';
  end if;
  perform 1 from vortex_identity.tenants tenant where tenant.tenant_id = p_tenant_id for update;
  if not found then raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable'; end if;
  perform 1 from vortex_identity.identity_projections projection
    where projection.identity_id in (p_actor_identity_id, p_subject_identity_id)
    order by projection.identity_id for share;
  perform 1 from vortex_identity.tenant_administrator_assignments assignment
    where assignment.tenant_id = p_tenant_id and assignment.identity_id = p_actor_identity_id
    order by assignment.assignment_id for update;
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(p_actor_identity_id, p_tenant_id, 'platform.tenant.administrators.manage', evaluated_at);
  if not exists (select 1 from vortex_identity.identity_projections p where p.identity_id = p_subject_identity_id and p.state = 'active')
    or exists (select 1 from pg_catalog.unnest(capabilities) c where not exists (
      select 1 from vortex_identity.tenant_administrator_assignments a
      where a.tenant_id = p_tenant_id and a.identity_id = p_actor_identity_id and a.revoked_at is null
        and a.starts_at <= evaluated_at and (a.expires_at is null or a.expires_at > evaluated_at) and c = any(a.capability_keys)
    )) then raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable'; end if;
  select stored.* into receipt from vortex_identity.accepted_administration_receipts stored
    where stored.actor_id = p_actor_identity_id and stored.tenant_id = p_tenant_id
      and stored.operation_key = 'grant_tenant_administrator' and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> p_command_fingerprint then raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts'; end if;
    return query select 'replayed'::text, 'grant_tenant_administrator'::text, receipt.subject_ids[1], receipt.subject_revisions[1], receipt.receipt_id, receipt.accepted_at; return;
  end if;
  insert into vortex_identity.tenant_administrator_assignments values (
    new_assignment_id, p_tenant_id, p_subject_identity_id, capabilities, p_starts_at, p_expires_at, 1,
    evaluated_at, p_actor_identity_id, new_correlation_id, evaluated_at, p_actor_identity_id, new_correlation_id, null, null, null
  );
  insert into vortex_identity.accepted_administration_receipts(receipt_id,actor_id,tenant_id,operation_key,duplicate_key,command_fingerprint,subject_ids,subject_revisions,accepted_at)
    values(new_correlation_id,p_actor_identity_id,p_tenant_id,'grant_tenant_administrator',p_duplicate_key,p_command_fingerprint,array[new_assignment_id],array[1::bigint],evaluated_at);
  return query select 'accepted'::text, 'grant_tenant_administrator'::text, new_assignment_id, 1::bigint, new_correlation_id, evaluated_at;
end
$function$;

create function vortex_identity.change_tenant_administrator(
  p_actor_identity_id uuid, p_duplicate_key uuid, p_command_fingerprint text,
  p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint,
  p_capabilities jsonb, p_starts_at timestamptz, p_expires_at timestamptz
)
returns table (outcome text, operation text, assignment_id uuid, revision bigint, correlation_id uuid, accepted_at timestamptz)
language plpgsql volatile security definer set search_path = ''
as $function$
declare capabilities text[]; evaluated_at timestamptz; target_identity_id uuid; current_revision bigint; current_revoked_at timestamptz;
  receipt vortex_identity.accepted_administration_receipts%rowtype; new_correlation_id uuid := pg_catalog.gen_random_uuid(); resulting_revision bigint;
begin
  capabilities := vortex_identity.tenant_capabilities_from_json(p_capabilities);
  if p_actor_identity_id is null or not vortex_context.is_non_nil_uuid(p_actor_identity_id::text)
    or p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_command_fingerprint is null or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or capabilities is null or p_starts_at is null or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and (p_expires_at <= p_starts_at or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))) then
    raise exception using errcode = '22023', message = 'Tenant assignment command is invalid';
  end if;
  perform 1 from vortex_identity.tenants tenant where tenant.tenant_id = p_tenant_id for update;
  if not found then raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable'; end if;
  select a.identity_id into target_identity_id from vortex_identity.tenant_administrator_assignments a where a.assignment_id = p_assignment_id and a.tenant_id = p_tenant_id;
  perform 1 from vortex_identity.identity_projections p where p.identity_id in (p_actor_identity_id,target_identity_id) order by p.identity_id for share;
  perform 1 from vortex_identity.tenant_administrator_assignments a where a.tenant_id = p_tenant_id and (a.identity_id = p_actor_identity_id or a.assignment_id = p_assignment_id) order by a.assignment_id for update;
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(p_actor_identity_id,p_tenant_id,'platform.tenant.administrators.manage',evaluated_at);
  if target_identity_id is null or not exists (select 1 from vortex_identity.identity_projections p where p.identity_id = target_identity_id and p.state='active')
    or exists (select 1 from pg_catalog.unnest(capabilities) c where not exists (
      select 1 from vortex_identity.tenant_administrator_assignments a where a.tenant_id=p_tenant_id and a.identity_id=p_actor_identity_id
        and a.revoked_at is null and a.starts_at<=evaluated_at and (a.expires_at is null or a.expires_at>evaluated_at) and c=any(a.capability_keys)
    )) then raise exception using errcode='V3101',message='Tenant operation is unavailable'; end if;
  select a.revision,a.revoked_at into current_revision,current_revoked_at from vortex_identity.tenant_administrator_assignments a where a.assignment_id=p_assignment_id and a.tenant_id=p_tenant_id;
  select stored.* into receipt from vortex_identity.accepted_administration_receipts stored where stored.actor_id=p_actor_identity_id and stored.tenant_id=p_tenant_id and stored.operation_key='change_tenant_administrator' and stored.duplicate_key=p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint<>p_command_fingerprint then raise exception using errcode='V3001',message='Administration duplicate conflicts'; end if;
    return query select 'replayed'::text,'change_tenant_administrator'::text,p_assignment_id,receipt.subject_revisions[1],receipt.receipt_id,receipt.accepted_at; return;
  end if;
  if current_revision is null or current_revoked_at is not null then raise exception using errcode='V3101',message='Tenant operation is unavailable'; end if;
  if current_revision<>p_expected_revision then raise exception using errcode='V3102',message='Tenant assignment revision is stale'; end if;
  if not ('platform.tenant.administrators.manage'=any(capabilities) and p_starts_at<=evaluated_at and p_expires_at is null)
    and not exists (select 1 from vortex_identity.tenant_administrator_assignments a join vortex_identity.identity_projections p on p.identity_id=a.identity_id
      where a.tenant_id=p_tenant_id and a.assignment_id<>p_assignment_id and a.revoked_at is null and a.starts_at<=evaluated_at and a.expires_at is null
        and 'platform.tenant.administrators.manage'=any(a.capability_keys) and p.state='active') then
    raise exception using errcode='V3103',message='Permanent tenant manager is required';
  end if;
  resulting_revision:=current_revision+1;
  update vortex_identity.tenant_administrator_assignments set capability_keys=capabilities,starts_at=p_starts_at,expires_at=p_expires_at,
    revision=resulting_revision,changed_at=evaluated_at,changed_by_actor_id=p_actor_identity_id,change_correlation_id=new_correlation_id where tenant_administrator_assignments.assignment_id=p_assignment_id;
  insert into vortex_identity.accepted_administration_receipts(receipt_id,actor_id,tenant_id,operation_key,duplicate_key,command_fingerprint,subject_ids,subject_revisions,accepted_at)
    values(new_correlation_id,p_actor_identity_id,p_tenant_id,'change_tenant_administrator',p_duplicate_key,p_command_fingerprint,array[p_assignment_id],array[resulting_revision],evaluated_at);
  return query select 'accepted'::text,'change_tenant_administrator'::text,p_assignment_id,resulting_revision,new_correlation_id,evaluated_at;
end
$function$;

create function vortex_identity.revoke_tenant_administrator(
  p_actor_identity_id uuid, p_duplicate_key uuid, p_command_fingerprint text,
  p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint
)
returns table (outcome text, operation text, assignment_id uuid, revision bigint, correlation_id uuid, accepted_at timestamptz)
language plpgsql volatile security definer set search_path = ''
as $function$
declare evaluated_at timestamptz; target_identity_id uuid; current_revision bigint; current_revoked_at timestamptz;
  receipt vortex_identity.accepted_administration_receipts%rowtype; new_correlation_id uuid:=pg_catalog.gen_random_uuid(); resulting_revision bigint;
begin
  if p_actor_identity_id is null or not vortex_context.is_non_nil_uuid(p_actor_identity_id::text)
    or p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_command_fingerprint is null or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='Tenant assignment command is invalid'; end if;
  perform 1 from vortex_identity.tenants tenant where tenant.tenant_id=p_tenant_id for update;
  if not found then raise exception using errcode='V3101',message='Tenant operation is unavailable'; end if;
  select a.identity_id into target_identity_id from vortex_identity.tenant_administrator_assignments a where a.assignment_id=p_assignment_id and a.tenant_id=p_tenant_id;
  perform 1 from vortex_identity.identity_projections p where p.identity_id in (p_actor_identity_id,target_identity_id) order by p.identity_id for share;
  perform 1 from vortex_identity.tenant_administrator_assignments a where a.tenant_id=p_tenant_id and (a.identity_id=p_actor_identity_id or a.assignment_id=p_assignment_id) order by a.assignment_id for update;
  evaluated_at:=pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(p_actor_identity_id,p_tenant_id,'platform.tenant.administrators.manage',evaluated_at);
  select a.revision,a.revoked_at into current_revision,current_revoked_at from vortex_identity.tenant_administrator_assignments a where a.assignment_id=p_assignment_id and a.tenant_id=p_tenant_id;
  select stored.* into receipt from vortex_identity.accepted_administration_receipts stored where stored.actor_id=p_actor_identity_id and stored.tenant_id=p_tenant_id and stored.operation_key='revoke_tenant_administrator' and stored.duplicate_key=p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint<>p_command_fingerprint then raise exception using errcode='V3001',message='Administration duplicate conflicts'; end if;
    return query select 'replayed'::text,'revoke_tenant_administrator'::text,p_assignment_id,receipt.subject_revisions[1],receipt.receipt_id,receipt.accepted_at; return;
  end if;
  if current_revision is null or current_revoked_at is not null then raise exception using errcode='V3101',message='Tenant operation is unavailable'; end if;
  if current_revision<>p_expected_revision then raise exception using errcode='V3102',message='Tenant assignment revision is stale'; end if;
  if not exists (select 1 from vortex_identity.tenant_administrator_assignments a join vortex_identity.identity_projections p on p.identity_id=a.identity_id
    where a.tenant_id=p_tenant_id and a.assignment_id<>p_assignment_id and a.revoked_at is null and a.starts_at<=evaluated_at and a.expires_at is null
      and 'platform.tenant.administrators.manage'=any(a.capability_keys) and p.state='active') then
    raise exception using errcode='V3103',message='Permanent tenant manager is required'; end if;
  resulting_revision:=current_revision+1;
  update vortex_identity.tenant_administrator_assignments set revision=resulting_revision,changed_at=evaluated_at,changed_by_actor_id=p_actor_identity_id,
    change_correlation_id=new_correlation_id,revoked_at=evaluated_at,revoked_by_actor_id=p_actor_identity_id,revocation_correlation_id=new_correlation_id
    where tenant_administrator_assignments.assignment_id=p_assignment_id;
  insert into vortex_identity.accepted_administration_receipts(receipt_id,actor_id,tenant_id,operation_key,duplicate_key,command_fingerprint,subject_ids,subject_revisions,accepted_at)
    values(new_correlation_id,p_actor_identity_id,p_tenant_id,'revoke_tenant_administrator',p_duplicate_key,p_command_fingerprint,array[p_assignment_id],array[resulting_revision],evaluated_at);
  return query select 'accepted'::text,'revoke_tenant_administrator'::text,p_assignment_id,resulting_revision,new_correlation_id,evaluated_at;
end
$function$;

revoke execute on function vortex_identity.require_current_tenant_capability(uuid,uuid,text,timestamptz),
  vortex_identity.tenant_capabilities_from_json(jsonb) from public,anon,authenticated,service_role,vortex_runtime,vortex_request,vortex_record_owner,vortex_record_adapter,vortex_module_owner;
revoke execute on function vortex_identity.list_tenant_launcher(uuid,integer,uuid),
  vortex_identity.list_tenant_hierarchy(uuid,uuid,integer,uuid), vortex_identity.read_tenant_organization(uuid,uuid,uuid),
  vortex_identity.list_tenant_administrator_assignments(uuid,uuid,integer,uuid),
  vortex_identity.grant_tenant_administrator(uuid,uuid,text,uuid,uuid,jsonb,timestamptz,timestamptz),
  vortex_identity.change_tenant_administrator(uuid,uuid,text,uuid,uuid,bigint,jsonb,timestamptz,timestamptz),
  vortex_identity.revoke_tenant_administrator(uuid,uuid,text,uuid,uuid,bigint)
  from public,anon,authenticated,service_role,vortex_request,vortex_record_owner,vortex_record_adapter,vortex_module_owner;
grant execute on function vortex_identity.list_tenant_launcher(uuid,integer,uuid),
  vortex_identity.list_tenant_hierarchy(uuid,uuid,integer,uuid), vortex_identity.read_tenant_organization(uuid,uuid,uuid),
  vortex_identity.list_tenant_administrator_assignments(uuid,uuid,integer,uuid),
  vortex_identity.grant_tenant_administrator(uuid,uuid,text,uuid,uuid,jsonb,timestamptz,timestamptz),
  vortex_identity.change_tenant_administrator(uuid,uuid,text,uuid,uuid,bigint,jsonb,timestamptz,timestamptz),
  vortex_identity.revoke_tenant_administrator(uuid,uuid,text,uuid,uuid,bigint) to vortex_runtime;

comment on function vortex_identity.list_tenant_launcher(uuid,integer,uuid) is 'Bounded active tenant contexts visible through current effective structural assignments.';
comment on function vortex_identity.list_tenant_hierarchy(uuid,uuid,integer,uuid) is 'Bounded deterministic same-tenant structural hierarchy read under the exact hierarchy.read capability.';
comment on function vortex_identity.list_tenant_administrator_assignments(uuid,uuid,integer,uuid) is 'Bounded deterministic same-tenant assignment read under the exact administrators.read capability.';
