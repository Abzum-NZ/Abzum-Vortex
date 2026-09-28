begin;

create or replace function vortex_activity.read_organization_activity_aggregates(
  p_occurred_from timestamptz,
  p_occurred_to timestamptz,
  p_actor_kind text,
  p_actor_id uuid,
  p_action text,
  p_correlation_id uuid,
  p_outcome text,
  p_source text,
  p_group_by text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  context_organization_id uuid;
  context_identity_id uuid;
  context_account_id uuid;
  decision_outcome text;
  decision_organization_id uuid;
  decision_account_id uuid;
  audit_projection boolean := false;
  groups jsonb;
  total bigint;
  truncated boolean;
begin
  if p_group_by is null
    or p_group_by <> all (array['action', 'actorKind', 'source', 'outcome'])
    or (p_occurred_from is not null
      and p_occurred_from in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or (p_occurred_to is not null
      and p_occurred_to in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or (p_occurred_from is not null and p_occurred_to is not null
      and p_occurred_from > p_occurred_to)
    or (p_actor_kind is not null
      and p_actor_kind <> all (array['identity', 'organization_account', 'system', 'public_session']))
    or (p_actor_id is not null
      and p_actor_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_action is not null and (
      pg_catalog.char_length(p_action) not between 1 and 40
      or p_action !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    ))
    or (p_correlation_id is not null
      and p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_outcome is not null
      and p_outcome <> all (array['completed', 'refused', 'failed']))
    or (p_source is not null
      and p_source <> all (array[
        'web', 'mcp', 'programmatic_interface', 'connection', 'federation',
        'durable_workflow', 'system'
      ])) then
    raise exception using errcode = '22023',
      message = 'Activity history aggregate selector is invalid';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if checked_context ->> 'callerKind' is distinct from 'human' then
    raise exception using errcode = '42501',
      message = 'Activity history is unavailable';
  end if;
  context_organization_id := (checked_context ->> 'organizationId')::uuid;
  context_identity_id := (checked_context ->> 'identityId')::uuid;
  context_account_id := (checked_context ->> 'organizationAccountId')::uuid;

  select evaluated.outcome, evaluated.organization_id, evaluated.organization_account_id
  into decision_outcome, decision_organization_id, decision_account_id
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.activity.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '687d5649-62ee-43dd-b684-b8af3a5394c1'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  audit_projection := coalesce(
    decision_outcome = 'eligible'
      and decision_organization_id = context_organization_id
      and decision_account_id = context_account_id,
    false
  );

  with filtered as (
    select entry.*
    from vortex_activity.organization_activity_entries as entry
    where entry.organization_id = context_organization_id
      and (audit_projection
        or (entry.actor_kind = 'organization_account' and entry.actor_id = context_account_id)
        or (entry.actor_kind = 'identity' and entry.actor_id = context_identity_id))
      and (p_occurred_from is null or entry.occurred_at >= p_occurred_from)
      and (p_occurred_to is null or entry.occurred_at <= p_occurred_to)
      and (p_actor_kind is null or entry.actor_kind = p_actor_kind)
      and (p_actor_id is null or entry.actor_id = p_actor_id)
      and (p_action is null or entry.action = p_action)
      and (p_correlation_id is null or entry.correlation_id = p_correlation_id)
      and (p_outcome is null or entry.outcome = p_outcome)
      and (p_source is null or entry.source = p_source)
  ),
  grouped as (
    select case p_group_by
        when 'action' then filtered.action
        when 'actorKind' then filtered.actor_kind
        when 'source' then filtered.source
        when 'outcome' then filtered.outcome
      end as value,
      pg_catalog.count(*)::bigint as entry_count
    from filtered
    group by 1
  ),
  ranked as (
    select grouped.value, grouped.entry_count,
      pg_catalog.row_number() over (
        order by grouped.entry_count desc, grouped.value
      ) as ordinal
    from grouped
  )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('value', ranked.value, 'count', ranked.entry_count)
        order by ranked.entry_count desc, ranked.value
      ) filter (where ranked.ordinal <= 100),
      '[]'::jsonb
    ),
    coalesce(pg_catalog.sum(ranked.entry_count), 0),
    pg_catalog.count(*) > 100
  into groups, total, truncated
  from ranked;

  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'projection', case when audit_projection then 'audit' else 'own' end,
    'total', total,
    'groups', groups,
    'truncated', truncated
  );
end
$function$;

revoke execute on function vortex_activity.read_organization_activity_aggregates(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_activity.read_organization_activity_aggregates(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, text
) to vortex_request;

comment on function vortex_activity.read_organization_activity_aggregates(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, text
) is
  'Returns bounded group counts over the same protected Activity filters and projection as read_organization_activity_page.';

alter function vortex_activity.read_organization_activity_aggregates(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, text
) owner to vortex_activity_owner;

create or replace function vortex_activity.read_organization_activity_page(
  p_occurred_from timestamptz,
  p_occurred_to timestamptz,
  p_actor_kind text,
  p_actor_id uuid,
  p_action text,
  p_correlation_id uuid,
  p_outcome text,
  p_source text,
  p_page_size integer,
  p_after_occurred_at timestamptz,
  p_after_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  context_organization_id uuid;
  context_identity_id uuid;
  context_account_id uuid;
  decision_outcome text;
  decision_organization_id uuid;
  decision_account_id uuid;
  audit_projection boolean := false;
  entries jsonb;
  has_more boolean := false;
  last_occurred_at timestamptz;
  last_activity_id uuid;
begin
  if p_page_size is null or p_page_size not between 1 and 200
    or (p_occurred_from is not null
      and p_occurred_from in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or (p_occurred_to is not null
      and p_occurred_to in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or (p_occurred_from is not null and p_occurred_to is not null
      and p_occurred_from > p_occurred_to)
    or (p_actor_kind is not null
      and p_actor_kind <> all (array['identity', 'organization_account', 'system', 'public_session']))
    or (p_actor_id is not null
      and p_actor_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_action is not null and (
      pg_catalog.char_length(p_action) not between 1 and 40
      or p_action !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    ))
    or (p_correlation_id is not null
      and p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_outcome is not null
      and p_outcome <> all (array['completed', 'refused', 'failed']))
    or (p_source is not null
      and p_source <> all (array[
        'web', 'mcp', 'programmatic_interface', 'connection', 'federation',
        'durable_workflow', 'system'
      ]))
    or (p_after_occurred_at is null) <> (p_after_activity_id is null)
    or (p_after_occurred_at is not null
      and p_after_occurred_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or (p_after_activity_id is not null
      and p_after_activity_id = '00000000-0000-0000-0000-000000000000'::uuid) then
    raise exception using errcode = '22023',
      message = 'Activity history page selector is invalid';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if checked_context ->> 'callerKind' is distinct from 'human' then
    raise exception using errcode = '42501',
      message = 'Activity history is unavailable';
  end if;
  context_organization_id := (checked_context ->> 'organizationId')::uuid;
  context_identity_id := (checked_context ->> 'identityId')::uuid;
  context_account_id := (checked_context ->> 'organizationAccountId')::uuid;

  select evaluated.outcome, evaluated.organization_id, evaluated.organization_account_id
  into decision_outcome, decision_organization_id, decision_account_id
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.activity.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '687d5649-62ee-43dd-b684-b8af3a5394c1'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  audit_projection := coalesce(
    decision_outcome = 'eligible'
      and decision_organization_id = context_organization_id
      and decision_account_id = context_account_id,
    false
  );

  with filtered as (
    select entry.*, authority.authority_kind,
      authority.assignment_id as authority_assignment_id
    from vortex_activity.organization_activity_entries as entry
    left join vortex_activity.organization_activity_super_administrator_authority as authority
      on authority.organization_id = entry.organization_id
      and authority.activity_id = entry.activity_id
    where entry.organization_id = context_organization_id
      and (audit_projection
        or (entry.actor_kind = 'organization_account' and entry.actor_id = context_account_id)
        or (entry.actor_kind = 'identity' and entry.actor_id = context_identity_id))
      and (p_occurred_from is null or entry.occurred_at >= p_occurred_from)
      and (p_occurred_to is null or entry.occurred_at <= p_occurred_to)
      and (p_actor_kind is null or entry.actor_kind = p_actor_kind)
      and (p_actor_id is null or entry.actor_id = p_actor_id)
      and (p_action is null or entry.action = p_action)
      and (p_correlation_id is null or entry.correlation_id = p_correlation_id)
      and (p_outcome is null or entry.outcome = p_outcome)
      and (p_source is null or entry.source = p_source)
  ),
  ordered as (
    select filtered.*
    from filtered
    where p_after_occurred_at is null
      or (filtered.occurred_at, filtered.activity_id)
        < (p_after_occurred_at, p_after_activity_id)
    order by filtered.occurred_at desc, filtered.activity_id desc
    limit p_page_size + 1
  ),
  numbered as (
    select ordered.*,
      pg_catalog.row_number() over (
        order by ordered.occurred_at desc, ordered.activity_id desc
      ) as ordinal
    from ordered
  )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'activityId', numbered.activity_id,
          'occurredAt', numbered.occurred_at,
          'actorKind', numbered.actor_kind,
          'actorId', numbered.actor_id,
          'action', numbered.action,
          'subjectIds', pg_catalog.to_jsonb(numbered.subject_ids),
          'source', numbered.source,
          'correlationId', numbered.correlation_id,
          'outcome', numbered.outcome
        ) || case
          when numbered.authority_assignment_id is not null then pg_catalog.jsonb_build_object(
            'authority', pg_catalog.jsonb_build_object(
              'kind', numbered.authority_kind,
              'assignmentId', numbered.authority_assignment_id
            )
          )
          else '{}'::jsonb
        end || case
          when audit_projection then pg_catalog.jsonb_build_object(
            'changedFieldIds', pg_catalog.to_jsonb(numbered.changed_field_ids)
          )
          else '{}'::jsonb
        end
        order by numbered.ordinal
      ) filter (where numbered.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    coalesce(pg_catalog.max(numbered.ordinal) > p_page_size, false),
    (pg_catalog.array_agg(numbered.occurred_at order by numbered.ordinal)
      filter (where numbered.ordinal = p_page_size))[1],
    (pg_catalog.array_agg(numbered.activity_id order by numbered.ordinal)
      filter (where numbered.ordinal = p_page_size))[1]
  into entries, has_more, last_occurred_at, last_activity_id
  from numbered;

  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'projection', case when audit_projection then 'audit' else 'own' end,
    'entries', entries,
    'next', case
      when has_more then pg_catalog.jsonb_build_object(
        'occurredAt', last_occurred_at,
        'activityId', last_activity_id
      )
      else null
    end
  );
end
$function$;

revoke execute on function vortex_activity.read_organization_activity_page(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, integer, timestamptz, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_activity.read_organization_activity_page(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, integer, timestamptz, uuid
) to vortex_request;

comment on function vortex_activity.read_organization_activity_page(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, integer, timestamptz, uuid
) is
  'Returns one bounded newest-first keyset page of the caller''s own organisation Activity, or the organisation-wide audit projection when the actor holds the organisation access-administration read authority.';

alter function vortex_activity.read_organization_activity_page(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, integer, timestamptz, uuid
) owner to vortex_activity_owner;

create or replace function vortex_invalidation.application_is_installed(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_organization_id is not null
    and p_application_root_id is not null
    and exists (
      select 1
      from vortex_access.permission_registrations as registration
      join vortex_definition.roots as root
        on root.root_id = registration.registration_owner_id
        and root.organization_id = registration.organization_id
        and root.kind = 'application'
      where registration.organization_id = p_organization_id
        and registration.registration_kind = 'application'
        and registration.registration_owner_id = p_application_root_id
        and registration.state = 'active'
        and exists (
          select 1
          from vortex_module.installation_bindings as binding
          where binding.organization_id = p_organization_id
            and binding.application_root_id = p_application_root_id
            and binding.application_release_revision = registration.source_revision
            and binding.state = 'active'
        )
    )
$function$;

create or replace function vortex_invalidation.may_receive_topic(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from vortex_identity.identity_projections as projection
    join vortex_identity.organization_accounts as account
      on account.identity_id = projection.identity_id
    join vortex_identity.organizations as organization
      on organization.organization_id = account.organization_id
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where projection.identity_id = auth.uid()
      and projection.state = 'active'
      and account.state = 'active'
      and organization.state = 'active'
      and tenant.state = 'active'
      and organization.organization_id = vortex_invalidation.topic_organization_id(p_topic)
      and vortex_invalidation.application_is_installed(
        organization.organization_id,
        vortex_invalidation.topic_application_root_id(p_topic)
      )
  )
$function$;

revoke all on function vortex_invalidation.application_is_installed(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on function vortex_invalidation.may_receive_topic(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_invalidation.may_receive_topic(text)
  to authenticated;

comment on function vortex_invalidation.application_is_installed(uuid, uuid) is
  'Private check that an application has an active registration and an active installation binding for its registered release in one organisation.';
comment on function vortex_invalidation.may_receive_topic(text) is
  'Authorises one authenticated identity to read a private topic only for an active organisation account it holds and an application currently installed there.';

alter function vortex_invalidation.application_is_installed(uuid, uuid)
  owner to postgres;
alter function vortex_invalidation.may_receive_topic(text)
  owner to postgres;

grant usage on schema vortex_access to vortex_activity_owner;

grant execute on function vortex_access.validated_human_request_context()
  to vortex_activity_owner;
grant execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  to vortex_activity_owner;

revoke all privileges on table
  vortex_activity.organization_activity_entries,
  vortex_activity.organization_activity_super_administrator_authority
from vortex_activity_owner;

grant select on table vortex_activity.organization_activity_entries
  to vortex_activity_owner;
grant select on table vortex_activity.organization_activity_super_administrator_authority
  to vortex_activity_owner;

create policy organization_activity_entries_activity_owner_select
  on vortex_activity.organization_activity_entries
  for select to vortex_activity_owner using (true);

create policy organization_activity_super_administrator_authority_activity_owner_select
  on vortex_activity.organization_activity_super_administrator_authority
  for select to vortex_activity_owner using (true);

commit;
