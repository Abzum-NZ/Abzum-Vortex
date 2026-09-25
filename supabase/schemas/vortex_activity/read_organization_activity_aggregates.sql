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
