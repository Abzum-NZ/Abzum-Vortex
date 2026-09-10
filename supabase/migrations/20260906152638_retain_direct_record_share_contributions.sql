-- Retain private current direct-record-share facts and expose only independent
-- current recipient contributions. Permission and field-ceiling composition
-- remains with the later protected record operation.

create function vortex_access.direct_share_field_ids_are_canonical(
  p_field_ids uuid[]
)
returns boolean
language plpgsql
immutable
strict
parallel safe
security invoker
set search_path = ''
as $function$
declare
  field_id uuid;
  previous_field_id uuid;
begin
  if coalesce(pg_catalog.array_ndims(p_field_ids), 1) <> 1
    or coalesce(pg_catalog.array_lower(p_field_ids, 1), 1) <> 1 then
    return false;
  end if;

  foreach field_id in array p_field_ids loop
    if field_id is null
      or not vortex_context.is_non_nil_uuid(field_id::text)
      or (
        previous_field_id is not null
        and (previous_field_id::text collate "C") >= (field_id::text collate "C")
      ) then
      return false;
    end if;
    previous_field_id := field_id;
  end loop;

  return true;
end
$function$;

create table vortex_access.organization_direct_record_shares (
  organization_id uuid not null,
  direct_share_id uuid not null,
  storage_scope text not null,
  application_root_id uuid,
  module_root_id uuid not null,
  record_type_id uuid not null,
  storage_contract_id uuid not null,
  record_id uuid not null,
  recipient_kind text not null,
  organization_account_id uuid,
  group_id uuid,
  readable_field_ids uuid[] not null,
  changeable_field_ids uuid[] not null,
  starts_at timestamptz not null,
  expires_at timestamptz,
  state text not null,
  revision bigint not null,
  granted_by uuid not null,
  granted_at timestamptz not null,
  grant_correlation_id uuid not null,
  reason text not null,
  revoked_by uuid,
  revoked_at timestamptz,
  revocation_correlation_id uuid,
  revocation_reason text,
  changed_at timestamptz not null,
  constraint organization_direct_record_shares_pk primary key (
    organization_id, direct_share_id
  ),
  constraint organization_direct_record_shares_ids_valid check (
    vortex_context.is_non_nil_uuid(organization_id::text)
    and vortex_context.is_non_nil_uuid(direct_share_id::text)
    and (application_root_id is null
      or vortex_context.is_non_nil_uuid(application_root_id::text))
    and vortex_context.is_non_nil_uuid(module_root_id::text)
    and vortex_context.is_non_nil_uuid(record_type_id::text)
    and vortex_context.is_non_nil_uuid(storage_contract_id::text)
    and vortex_context.is_non_nil_uuid(record_id::text)
    and (organization_account_id is null
      or vortex_context.is_non_nil_uuid(organization_account_id::text))
    and (group_id is null or vortex_context.is_non_nil_uuid(group_id::text))
    and vortex_context.is_non_nil_uuid(granted_by::text)
    and vortex_context.is_non_nil_uuid(grant_correlation_id::text)
    and (revoked_by is null or vortex_context.is_non_nil_uuid(revoked_by::text))
    and (revocation_correlation_id is null
      or vortex_context.is_non_nil_uuid(revocation_correlation_id::text))
  ),
  constraint organization_direct_record_shares_scope_shape check (
    (
      storage_scope = 'organization_shared'
      and application_root_id is null
    ) or (
      storage_scope = 'application_contained'
      and application_root_id is not null
    )
  ),
  constraint organization_direct_record_shares_recipient_shape check (
    (
      recipient_kind = 'organization_account'
      and organization_account_id is not null
      and group_id is null
    ) or (
      recipient_kind = 'group'
      and organization_account_id is null
      and group_id is not null
    )
  ),
  constraint organization_direct_record_shares_fields_valid check (
    pg_catalog.cardinality(readable_field_ids) > 0
    and vortex_access.direct_share_field_ids_are_canonical(readable_field_ids)
    and vortex_access.direct_share_field_ids_are_canonical(changeable_field_ids)
    and changeable_field_ids <@ readable_field_ids
  ),
  constraint organization_direct_record_shares_revision_range check (
    revision between 1 and 9007199254740991
  ),
  constraint organization_direct_record_shares_state_valid check (
    state in ('active', 'revoked')
  ),
  constraint organization_direct_record_shares_reason_valid check (
    pg_catalog.char_length(reason) between 1 and 500
    and (revocation_reason is null
      or pg_catalog.char_length(revocation_reason) between 1 and 500)
  ),
  constraint organization_direct_record_shares_revocation_shape check (
    (
      state = 'active'
      and revoked_by is null
      and revoked_at is null
      and revocation_correlation_id is null
      and revocation_reason is null
    ) or (
      state = 'revoked'
      and revoked_by is not null
      and revoked_at is not null
      and revocation_correlation_id is not null
      and revocation_reason is not null
    )
  ),
  constraint organization_direct_record_shares_time_valid check (
    starts_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and (expires_at is null
      or expires_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    and granted_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and changed_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and (revoked_at is null
      or revoked_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    and (expires_at is null or expires_at > starts_at)
    and changed_at >= granted_at
    and (revoked_at is null or revoked_at = changed_at)
  ),
  constraint organization_direct_record_shares_organization_fk foreign key (
    organization_id
  ) references vortex_identity.organizations (organization_id),
  constraint organization_direct_record_shares_account_fk foreign key (
    organization_id, organization_account_id
  ) references vortex_identity.organization_accounts (
    organization_id, organization_account_id
  ),
  constraint organization_direct_record_shares_group_fk foreign key (
    organization_id, group_id
  ) references vortex_access.organization_groups (organization_id, group_id),
  constraint organization_direct_record_shares_grantor_fk foreign key (
    organization_id, granted_by
  ) references vortex_identity.organization_accounts (
    organization_id, organization_account_id
  ),
  constraint organization_direct_record_shares_revoker_fk foreign key (
    organization_id, revoked_by
  ) references vortex_identity.organization_accounts (
    organization_id, organization_account_id
  )
);

create index organization_direct_record_shares_active_record_idx
on vortex_access.organization_direct_record_shares (
  organization_id, storage_scope, application_root_id, module_root_id,
  record_type_id, storage_contract_id, record_id
)
where state = 'active';

alter table vortex_access.organization_direct_record_shares enable row level security;
alter table vortex_access.organization_direct_record_shares force row level security;

revoke all on table vortex_access.organization_direct_record_shares
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

create function vortex_access.validate_organization_direct_record_share_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.state <> 'active'
    or new.revision <> 1
    or new.changed_at is distinct from new.granted_at then
    raise exception using errcode = '23514',
      message = 'Initial direct record-share evidence is invalid';
  end if;

  return new;
end
$function$;

create trigger organization_direct_record_shares_validate_insert
before insert on vortex_access.organization_direct_record_shares
for each row execute function
  vortex_access.validate_organization_direct_record_share_insert();

create function vortex_access.protect_organization_direct_record_share()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Direct record shares cannot be deleted';
  end if;

  if old.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Direct record-share revision is exhausted';
  end if;

  if old.state = 'revoked'
    or new.organization_id is distinct from old.organization_id
    or new.direct_share_id is distinct from old.direct_share_id
    or new.storage_scope is distinct from old.storage_scope
    or new.application_root_id is distinct from old.application_root_id
    or new.module_root_id is distinct from old.module_root_id
    or new.record_type_id is distinct from old.record_type_id
    or new.storage_contract_id is distinct from old.storage_contract_id
    or new.record_id is distinct from old.record_id
    or new.recipient_kind is distinct from old.recipient_kind
    or new.organization_account_id is distinct from old.organization_account_id
    or new.group_id is distinct from old.group_id
    or new.readable_field_ids is distinct from old.readable_field_ids
    or new.changeable_field_ids is distinct from old.changeable_field_ids
    or new.starts_at is distinct from old.starts_at
    or new.expires_at is distinct from old.expires_at
    or new.granted_by is distinct from old.granted_by
    or new.granted_at is distinct from old.granted_at
    or new.grant_correlation_id is distinct from old.grant_correlation_id
    or new.reason is distinct from old.reason
    or new.state <> 'revoked'
    or new.revision <> old.revision + 1
    or new.changed_at < old.changed_at then
    raise exception using errcode = '23514',
      message = 'Direct record-share identity, grant evidence or lifecycle is immutable';
  end if;

  return new;
end
$function$;

create trigger organization_direct_record_shares_protect_change
before update or delete on vortex_access.organization_direct_record_shares
for each row execute function vortex_access.protect_organization_direct_record_share();

create function vortex_access.read_current_direct_record_share_contributions(
  p_binding_organization_id uuid,
  p_binding_application_root_id uuid,
  p_binding_module_root_id uuid,
  p_binding_record_type_id uuid,
  p_binding_storage_contract_id uuid,
  p_binding_storage_scope text,
  p_record_id uuid,
  p_current_organization_id uuid,
  p_current_application_root_id uuid,
  p_current_organization_account_id uuid,
  p_checked_at timestamptz
)
returns table (
  direct_share_id uuid,
  direct_share_revision bigint,
  recipient_kind text,
  organization_account_id uuid,
  group_id uuid,
  readable_field_ids uuid[],
  changeable_field_ids uuid[],
  valid_until timestamptz
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
begin
  if not vortex_context.is_non_nil_uuid(p_binding_organization_id::text)
    or not vortex_context.is_non_nil_uuid(p_binding_application_root_id::text)
    or not vortex_context.is_non_nil_uuid(p_binding_module_root_id::text)
    or not vortex_context.is_non_nil_uuid(p_binding_record_type_id::text)
    or not vortex_context.is_non_nil_uuid(p_binding_storage_contract_id::text)
    or not vortex_context.is_non_nil_uuid(p_record_id::text)
    or not vortex_context.is_non_nil_uuid(p_current_organization_id::text)
    or not vortex_context.is_non_nil_uuid(p_current_application_root_id::text)
    or not vortex_context.is_non_nil_uuid(p_current_organization_account_id::text)
    or p_binding_storage_scope is null
    or p_binding_storage_scope not in ('organization_shared', 'application_contained')
    or p_checked_at is null
    or p_checked_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_binding_organization_id <> p_current_organization_id
    or p_binding_application_root_id <> p_current_application_root_id then
    raise exception using errcode = '22023',
      message = 'Direct record-share contribution evidence is invalid';
  end if;

  return query
  select
    share.direct_share_id,
    share.revision,
    share.recipient_kind,
    share.organization_account_id,
    share.group_id,
    share.readable_field_ids,
    share.changeable_field_ids,
    case
      when share.recipient_kind = 'organization_account' then share.expires_at
      when share.expires_at is null then membership.expires_at
      when membership.expires_at is null then share.expires_at
      else least(share.expires_at, membership.expires_at)
    end
  from vortex_access.organization_direct_record_shares as share
  left join vortex_access.organization_groups as recipient_group
    on share.recipient_kind = 'group'
    and recipient_group.organization_id = share.organization_id
    and recipient_group.group_id = share.group_id
    and recipient_group.state = 'active'
  left join vortex_access.organization_group_memberships as membership
    on recipient_group.organization_id is not null
    and membership.organization_id = share.organization_id
    and membership.group_id = share.group_id
    and membership.organization_account_id = p_current_organization_account_id
    and membership.state = 'live'
    and membership.starts_at <= p_checked_at
    and (membership.expires_at is null or membership.expires_at > p_checked_at)
  where share.organization_id = p_binding_organization_id
    and share.storage_scope = p_binding_storage_scope
    and share.application_root_id is not distinct from case
      when p_binding_storage_scope = 'application_contained'
        then p_binding_application_root_id
      else null::uuid
    end
    and share.module_root_id = p_binding_module_root_id
    and share.record_type_id = p_binding_record_type_id
    and share.storage_contract_id = p_binding_storage_contract_id
    and share.record_id = p_record_id
    and share.state = 'active'
    and share.starts_at <= p_checked_at
    and (share.expires_at is null or share.expires_at > p_checked_at)
    and (
      (
        share.recipient_kind = 'organization_account'
        and share.organization_account_id = p_current_organization_account_id
      ) or (
        share.recipient_kind = 'group'
        and membership.membership_id is not null
      )
    )
  order by share.direct_share_id;
end
$function$;

revoke execute on function vortex_access.direct_share_field_ids_are_canonical(uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_access.validate_organization_direct_record_share_insert()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_access.protect_organization_direct_record_share()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_access.read_current_direct_record_share_contributions(
  uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, uuid, timestamptz
)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on table vortex_access.organization_direct_record_shares is
  'Private current direct-record-share facts; this table is not a runtime permission or field-authority endpoint.';
comment on index vortex_access.organization_direct_record_shares_active_record_idx is
  'Supports exact-record current-share contribution lookup; recipient and time remain residual predicates.';
comment on function vortex_access.read_current_direct_record_share_contributions(
  uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid, uuid, timestamptz
) is
  'Returns independent current account or Group direct-share field contributions for one exact trusted record binding; it does not union fields or grant permission.';
