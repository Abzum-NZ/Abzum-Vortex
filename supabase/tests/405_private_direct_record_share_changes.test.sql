begin;

set local search_path = pg_catalog, extensions, public;
select no_plan();

select has_function(
  'vortex_access', 'grant_organization_direct_record_share',
  array['uuid','uuid','text','uuid','uuid','uuid','uuid','uuid','text','uuid',
    'uuid','uuid[]','uuid[]','timestamptz','timestamptz','text','uuid','uuid','text','uuid'],
  'Access owns the private structural direct-share grant writer'
);
select has_function(
  'vortex_access', 'revoke_organization_direct_record_share',
  array['uuid','uuid','bigint','text','uuid','uuid','text','uuid'],
  'Access owns the private terminal direct-share revocation writer'
);

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.grant_organization_direct_record_share(uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,text,uuid,uuid,uuid[],uuid[],timestamptz,timestamptz,text,uuid,uuid,text,uuid)',
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.revoke_organization_direct_record_share(uuid,uuid,bigint,text,uuid,uuid,text,uuid)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute either private direct-share writer'
)
from (values ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')) as caller(role_name)
order by caller.role_name collate "C";

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '14050000-0000-4000-8000-000000000001', 'share_writer',
  'Share writer', 'active', pg_catalog.clock_timestamp(),
  '94050000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state, created_at,
  created_by, state_changed_at, revision
) values
  ('24050000-0000-4000-8000-000000000001',
   '14050000-0000-4000-8000-000000000001', 'share_writer', 'Share writer',
   'active', pg_catalog.clock_timestamp(),
   '94050000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1),
  ('24050000-0000-4000-8000-000000000002',
   '14050000-0000-4000-8000-000000000001', 'foreign_writer', 'Foreign writer',
   'active', pg_catalog.clock_timestamp(),
   '94050000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) select candidate.identity_id, 'active', pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp(), '94050000-0000-4000-8000-000000000001',
  candidate.correlation_id, 1
from (values
  ('44050000-0000-4000-8000-000000000001'::uuid,
   'a4050000-0000-4000-8000-000000000001'::uuid),
  ('44050000-0000-4000-8000-000000000002'::uuid,
   'a4050000-0000-4000-8000-000000000002'::uuid),
  ('44050000-0000-4000-8000-000000000003'::uuid,
   'a4050000-0000-4000-8000-000000000003'::uuid),
  ('44050000-0000-4000-8000-000000000004'::uuid,
   'a4050000-0000-4000-8000-000000000004'::uuid)
) as candidate(identity_id, correlation_id);

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, suspended_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  ('74050000-0000-4000-8000-000000000001',
   '24050000-0000-4000-8000-000000000001',
   '44050000-0000-4000-8000-000000000001', 'Actor', 'active',
   pg_catalog.clock_timestamp(), null, pg_catalog.clock_timestamp(),
   pg_catalog.clock_timestamp(), '94050000-0000-4000-8000-000000000001',
   'a4050000-0000-4000-8000-000000000011', 1),
  ('74050000-0000-4000-8000-000000000002',
   '24050000-0000-4000-8000-000000000001',
   '44050000-0000-4000-8000-000000000002', 'Recipient', 'active',
   pg_catalog.clock_timestamp(), null, pg_catalog.clock_timestamp(),
   pg_catalog.clock_timestamp(), '74050000-0000-4000-8000-000000000001',
   'a4050000-0000-4000-8000-000000000012', 1),
  ('74050000-0000-4000-8000-000000000003',
   '24050000-0000-4000-8000-000000000001',
   '44050000-0000-4000-8000-000000000003', 'Inactive', 'suspended',
   pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
   pg_catalog.clock_timestamp(), '74050000-0000-4000-8000-000000000001',
   'a4050000-0000-4000-8000-000000000013', 1),
  ('74050000-0000-4000-8000-000000000004',
   '24050000-0000-4000-8000-000000000002',
   '44050000-0000-4000-8000-000000000004', 'Foreign', 'active',
   pg_catalog.clock_timestamp(), null, pg_catalog.clock_timestamp(),
   pg_catalog.clock_timestamp(), '74050000-0000-4000-8000-000000000001',
   'a4050000-0000-4000-8000-000000000014', 1);

insert into vortex_access.organization_groups (
  organization_id, group_id, group_key, label, state, revision, created_by,
  created_at, changed_by, changed_at, change_correlation_id
) values
  ('24050000-0000-4000-8000-000000000001',
   '84050000-0000-4000-8000-000000000001', 'recipient_group',
   'Recipient Group', 'active', 1,
   '74050000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
   '74050000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
   'a4050000-0000-4000-8000-000000000021'),
  ('24050000-0000-4000-8000-000000000001',
   '84050000-0000-4000-8000-000000000002', 'retired_group',
   'Retired Group', 'active', 1,
   '74050000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
   '74050000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
   'a4050000-0000-4000-8000-000000000022');

insert into vortex_access.organization_groups (
  organization_id, group_id, group_key, label, state, revision, created_by,
  created_at, changed_by, changed_at, change_correlation_id
) values (
  '24050000-0000-4000-8000-000000000001',
  '84050000-0000-4000-8000-000000000003', 'next_owner_group',
  'Next Owner Group', 'active', 1,
  '74050000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  '74050000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a4050000-0000-4000-8000-000000000024'
);

update vortex_access.organization_groups
set state = 'retired', revision = 2,
  changed_by = '74050000-0000-4000-8000-000000000001',
  changed_at = pg_catalog.clock_timestamp(),
  change_correlation_id = 'a4050000-0000-4000-8000-000000000023'
where organization_id = '24050000-0000-4000-8000-000000000001'
  and group_id = '84050000-0000-4000-8000-000000000002';

select * from vortex_access.initialize_organization_access_version(
  '24050000-0000-4000-8000-000000000001',
  '74050000-0000-4000-8000-000000000001',
  'a4050000-0000-4000-8000-000000000031'
);

select throws_ok(
  $$select * from vortex_access.grant_organization_direct_record_share(
    '24050000-0000-4000-8000-000000000001',
    '94050000-0000-4000-8000-000000000100', 'organization_shared', null,
    '44050000-0000-4000-8000-000000000101',
    '54050000-0000-4000-8000-000000000101',
    '64050000-0000-4000-8000-000000000101',
    'e4050000-0000-4000-8000-000000000100', 'organization_account',
    '74050000-0000-4000-8000-000000000002', null,
    array['64050000-0000-4000-8000-000000000201']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp() - interval '2 minutes',
    pg_catalog.clock_timestamp() - interval '1 minute', 'Expired grant',
    '74050000-0000-4000-8000-000000000001',
    'a4050000-0000-4000-8000-000000000100', 'web',
    'b4050000-0000-4000-8000-000000000100')$$,
  '40001', 'Direct record-share grant window is stale',
  'a grant already expired at the post-lock operation time is refused'
);
select is(
  (select pg_catalog.concat_ws('|',
    (select pg_catalog.count(*) from vortex_access.organization_direct_record_shares
     where organization_id = '24050000-0000-4000-8000-000000000001'),
    (select current_version from vortex_access.organization_access_versions
     where organization_id = '24050000-0000-4000-8000-000000000001'),
    (select pg_catalog.count(*) from vortex_activity.organization_activity_entries
     where organization_id = '24050000-0000-4000-8000-000000000001'))),
  '0|1|0',
  'expired grant refusal leaves no share, Access or Activity effect'
);

select lives_ok(
  $$select * from vortex_access.grant_organization_direct_record_share(
    '24050000-0000-4000-8000-000000000001',
    '94050000-0000-4000-8000-000000000101', 'application_contained',
    '34050000-0000-4000-8000-000000000001',
    '44050000-0000-4000-8000-000000000101',
    '54050000-0000-4000-8000-000000000101',
    '64050000-0000-4000-8000-000000000101',
    'e4050000-0000-4000-8000-000000000101', 'organization_account',
    '74050000-0000-4000-8000-000000000002', null,
    array['64050000-0000-4000-8000-000000000201','64050000-0000-4000-8000-000000000202']::uuid[],
    array['64050000-0000-4000-8000-000000000202']::uuid[],
    pg_catalog.clock_timestamp() + interval '5 minutes',
    pg_catalog.clock_timestamp() + interval '1 hour', 'Scheduled account share',
    '74050000-0000-4000-8000-000000000001',
    'a4050000-0000-4000-8000-000000000101', 'web',
    'b4050000-0000-4000-8000-000000000101')$$,
  'a scheduled account share is structurally accepted'
);

select lives_ok(
  $$select * from vortex_access.grant_organization_direct_record_share(
    '24050000-0000-4000-8000-000000000001',
    '94050000-0000-4000-8000-000000000102', 'organization_shared', null,
    '44050000-0000-4000-8000-000000000101',
    '54050000-0000-4000-8000-000000000101',
    '64050000-0000-4000-8000-000000000101',
    'e4050000-0000-4000-8000-000000000102', 'group', null,
    '84050000-0000-4000-8000-000000000001',
    array['64050000-0000-4000-8000-000000000201']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Current Group share',
    '74050000-0000-4000-8000-000000000001',
    'a4050000-0000-4000-8000-000000000102', 'workflow',
    'b4050000-0000-4000-8000-000000000102')$$,
  'a current Group share is structurally accepted'
);

select throws_ok(
  $$select * from vortex_access.grant_organization_direct_record_share(
    '24050000-0000-4000-8000-000000000001',
    '94050000-0000-4000-8000-000000000103', 'organization_shared', null,
    '44050000-0000-4000-8000-000000000101',
    '54050000-0000-4000-8000-000000000101',
    '64050000-0000-4000-8000-000000000101',
    'e4050000-0000-4000-8000-000000000103', 'organization_account',
    '74050000-0000-4000-8000-000000000003', null,
    array['64050000-0000-4000-8000-000000000201']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Inactive recipient',
    '74050000-0000-4000-8000-000000000001',
    'a4050000-0000-4000-8000-000000000103', 'interface',
    'b4050000-0000-4000-8000-000000000103')$$,
  '42501', 'Direct record-share recipient is unavailable',
  'inactive recipients are refused'
);

select throws_ok(
  $$select * from vortex_access.grant_organization_direct_record_share(
    '24050000-0000-4000-8000-000000000001',
    '94050000-0000-4000-8000-000000000104', 'organization_shared', null,
    '44050000-0000-4000-8000-000000000101',
    '54050000-0000-4000-8000-000000000101',
    '64050000-0000-4000-8000-000000000101',
    'e4050000-0000-4000-8000-000000000104', 'organization_account',
    '74050000-0000-4000-8000-000000000004', null,
    array['64050000-0000-4000-8000-000000000201']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Foreign recipient',
    '74050000-0000-4000-8000-000000000001',
    'a4050000-0000-4000-8000-000000000104', 'connection',
    'b4050000-0000-4000-8000-000000000104')$$,
  '42501', 'Direct record-share recipient is unavailable',
  'foreign recipients are refused'
);

select throws_ok(
  $$select * from vortex_access.grant_organization_direct_record_share(
    '24050000-0000-4000-8000-000000000001',
    '94050000-0000-4000-8000-000000000105', 'organization_shared', null,
    '44050000-0000-4000-8000-000000000101',
    '54050000-0000-4000-8000-000000000101',
    '64050000-0000-4000-8000-000000000101',
    'e4050000-0000-4000-8000-000000000105', 'group', null,
    '84050000-0000-4000-8000-000000000002',
    array['64050000-0000-4000-8000-000000000201']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Retired recipient',
    '74050000-0000-4000-8000-000000000001',
    'a4050000-0000-4000-8000-000000000105', 'federation',
    'b4050000-0000-4000-8000-000000000105')$$,
  '42501', 'Direct record-share recipient is unavailable',
  'retired Groups are refused'
);

insert into vortex_activity.organization_activity_entries (
  organization_id, activity_id, occurred_at, actor_kind, actor_id, action,
  subject_ids, changed_field_ids, source, correlation_id, outcome
) values (
  '24050000-0000-4000-8000-000000000001',
  'b4050000-0000-4000-8000-000000000106', pg_catalog.clock_timestamp(),
  'organization_account', '74050000-0000-4000-8000-000000000001',
  'conflicting_evidence', array['94050000-0000-4000-8000-000000000106']::uuid[],
  array[]::uuid[], 'system', 'a4050000-0000-4000-8000-000000000106',
  'completed'
);
select throws_ok(
  $$select * from vortex_access.grant_organization_direct_record_share(
    '24050000-0000-4000-8000-000000000001',
    '94050000-0000-4000-8000-000000000106', 'organization_shared', null,
    '44050000-0000-4000-8000-000000000101',
    '54050000-0000-4000-8000-000000000101',
    '64050000-0000-4000-8000-000000000101',
    'e4050000-0000-4000-8000-000000000106', 'organization_account',
    '74050000-0000-4000-8000-000000000002', null,
    array['64050000-0000-4000-8000-000000000201']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Collision rollback',
    '74050000-0000-4000-8000-000000000001',
    'a4050000-0000-4000-8000-000000000106', 'system',
    'b4050000-0000-4000-8000-000000000106')$$,
  '22023', 'Activity identity already records different evidence',
  'conflicting Activity evidence refuses the grant'
);
select is(
  (select pg_catalog.count(*) from vortex_access.organization_direct_record_shares
   where organization_id = '24050000-0000-4000-8000-000000000001'
     and direct_share_id = '94050000-0000-4000-8000-000000000106'),
  0::bigint,
  'Activity failure rolls back the share row'
);

select lives_ok(
  $$select * from vortex_access.revoke_organization_direct_record_share(
    '24050000-0000-4000-8000-000000000001',
    '94050000-0000-4000-8000-000000000101', 1, 'No longer shared',
    '74050000-0000-4000-8000-000000000001',
    'a4050000-0000-4000-8000-000000000111', 'interface',
    'b4050000-0000-4000-8000-000000000111')$$,
  'an active share can be terminally revoked at its exact revision'
);
select throws_ok(
  $$select * from vortex_access.revoke_organization_direct_record_share(
    '24050000-0000-4000-8000-000000000001',
    '94050000-0000-4000-8000-000000000101', 1, 'Retry',
    '74050000-0000-4000-8000-000000000001',
    'a4050000-0000-4000-8000-000000000112', 'connection',
    'b4050000-0000-4000-8000-000000000112')$$,
  '40001', 'Direct record-share revocation is stale or unavailable',
  'revocation is terminal and stale expected revisions cannot revive it'
);

select is(
  (select pg_catalog.jsonb_build_object(
    'state', state, 'revision', revision,
    'readable', readable_field_ids, 'changeable', changeable_field_ids
  ) from vortex_access.organization_direct_record_shares
   where organization_id = '24050000-0000-4000-8000-000000000001'
     and direct_share_id = '94050000-0000-4000-8000-000000000101'),
  pg_catalog.jsonb_build_object(
    'state', 'revoked', 'revision', 2,
    'readable', array['64050000-0000-4000-8000-000000000201','64050000-0000-4000-8000-000000000202']::uuid[],
    'changeable', array['64050000-0000-4000-8000-000000000202']::uuid[]
  ),
  'revocation preserves the exact scope and immutable field bounds'
);
select is(
  (select current_version from vortex_access.organization_access_versions
   where organization_id = '24050000-0000-4000-8000-000000000001'),
  4::bigint,
  'two grants and one revocation each change Access exactly once'
);
select is(
  (select pg_catalog.count(*) from vortex_activity.organization_activity_entries
   where organization_id = '24050000-0000-4000-8000-000000000001'),
  4::bigint,
  'successful changes append one Activity each and the pre-existing collision remains'
);
select is(
  (select pg_catalog.array_agg(source order by activity_id)
   from vortex_activity.organization_activity_entries
   where organization_id = '24050000-0000-4000-8000-000000000001'
     and action = 'grant_direct_record_share'),
  array['web', 'workflow']::text[],
  'each grant preserves its trusted representative Activity source'
);
select is(
  (select source from vortex_activity.organization_activity_entries
   where organization_id = '24050000-0000-4000-8000-000000000001'
     and action = 'revoke_direct_record_share'),
  'interface',
  'revocation preserves its trusted representative Activity source'
);

create temporary table neutral_owned_records (
  organization_id uuid not null,
  record_id uuid not null,
  ownership_mode text not null check (
    ownership_mode in ('organization_account', 'group', 'inherited', 'none')
  ),
  owner_account_id uuid,
  owner_group_id uuid,
  revision bigint not null,
  changed_at timestamptz not null,
  primary key (organization_id, record_id),
  check (
    (ownership_mode = 'organization_account' and owner_account_id is not null
      and owner_group_id is null)
    or (ownership_mode = 'group' and owner_account_id is null
      and owner_group_id is not null)
    or (ownership_mode in ('inherited', 'none') and owner_account_id is null
      and owner_group_id is null)
  )
) on commit drop;

create function pg_temp.coordinate_neutral_record_ownership_transfer(
  p_organization_id uuid,
  p_record_id uuid,
  p_expected_revision bigint,
  p_proposed_account_id uuid,
  p_proposed_group_id uuid,
  p_changed_by uuid,
  p_correlation_id uuid,
  p_activity_id uuid
)
returns bigint
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  current_record record;
  operation_at timestamptz;
  next_version bigint;
  activity_result text;
begin
  perform 1 from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id for update;
  if not found then raise exception using errcode = '42501',
    message = 'Neutral ownership scope is unavailable'; end if;

  select owned.* into current_record from pg_temp.neutral_owned_records as owned
  where owned.organization_id = p_organization_id
    and owned.record_id = p_record_id for update;
  if not found or current_record.revision <> p_expected_revision then
    raise exception using errcode = '40001',
      message = 'Neutral ownership transfer is stale or unavailable';
  end if;
  if current_record.ownership_mode = 'organization_account' then
    if p_proposed_account_id is null or p_proposed_group_id is not null then
      raise exception using errcode = '22023',
        message = 'Neutral ownership proposal has the wrong kind';
    end if;
    perform 1 from vortex_identity.organization_accounts as account
    where account.organization_id = p_organization_id
      and account.organization_account_id = p_proposed_account_id
      and account.state = 'active';
    if current_record.owner_account_id = p_proposed_account_id then
      raise exception using errcode = '40001',
        message = 'Neutral ownership is unchanged';
    end if;
  elsif current_record.ownership_mode = 'group' then
    if p_proposed_group_id is null or p_proposed_account_id is not null then
      raise exception using errcode = '22023',
        message = 'Neutral ownership proposal has the wrong kind';
    end if;
    perform 1 from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = p_organization_id
      and organization_group.group_id = p_proposed_group_id
      and organization_group.state = 'active';
    if current_record.owner_group_id = p_proposed_group_id then
      raise exception using errcode = '40001',
        message = 'Neutral ownership is unchanged';
    end if;
  else
    raise exception using errcode = '42501',
      message = 'Neutral ownership mode has no direct transfer';
  end if;
  if not found then raise exception using errcode = '42501',
    message = 'Neutral ownership target is unavailable'; end if;

  operation_at := greatest(current_record.changed_at, pg_catalog.clock_timestamp());
  update pg_temp.neutral_owned_records as owned
  set owner_account_id = case when current_record.ownership_mode = 'organization_account'
        then p_proposed_account_id else null end,
      owner_group_id = case when current_record.ownership_mode = 'group'
        then p_proposed_group_id else null end,
      revision = current_record.revision + 1, changed_at = operation_at
  where owned.organization_id = p_organization_id and owned.record_id = p_record_id
    and owned.revision = p_expected_revision;

  select version.current_version into next_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id,
    'record_ownership_changed'
  ) as version;
  activity_result := vortex_activity.append_organization_activity_entry(
    p_organization_id, p_activity_id, operation_at, 'organization_account',
    p_changed_by, 'transfer_record_ownership', array[p_record_id]::uuid[],
    array[]::uuid[], 'system', p_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Neutral ownership Activity is stale';
  end if;
  return next_version;
end
$function$;

insert into neutral_owned_records values
  ('24050000-0000-4000-8000-000000000001',
   'e4050000-0000-4000-8000-000000000201', 'organization_account',
   '74050000-0000-4000-8000-000000000001', null, 1,
   pg_catalog.clock_timestamp()),
  ('24050000-0000-4000-8000-000000000001',
   'e4050000-0000-4000-8000-000000000202', 'group', null,
   '84050000-0000-4000-8000-000000000001', 1,
   pg_catalog.clock_timestamp()),
  ('24050000-0000-4000-8000-000000000001',
   'e4050000-0000-4000-8000-000000000203', 'inherited', null, null, 1,
   pg_catalog.clock_timestamp());

select throws_ok(
  $$select pg_temp.coordinate_neutral_record_ownership_transfer(
    '24050000-0000-4000-8000-000000000001',
    'e4050000-0000-4000-8000-000000000201', 1,
    '74050000-0000-4000-8000-000000000001', null,
    '74050000-0000-4000-8000-000000000001',
    'a4050000-0000-4000-8000-000000000200',
    'b4050000-0000-4000-8000-000000000200')$$,
  '40001', 'Neutral ownership is unchanged',
  'an unchanged account owner is refused');
select is(
  (select revision || '|' || owner_account_id from neutral_owned_records
   where record_id = 'e4050000-0000-4000-8000-000000000201'),
  '1|74050000-0000-4000-8000-000000000001',
  'unchanged ownership leaves the record revision and owner intact');
select is(
  (select pg_catalog.concat_ws('|',
    (select current_version from vortex_access.organization_access_versions
     where organization_id = '24050000-0000-4000-8000-000000000001'),
    (select pg_catalog.count(*) from vortex_activity.organization_activity_entries
     where organization_id = '24050000-0000-4000-8000-000000000001'))),
  '4|4',
  'unchanged ownership leaves Access and Activity untouched');

select is(pg_temp.coordinate_neutral_record_ownership_transfer(
  '24050000-0000-4000-8000-000000000001',
  'e4050000-0000-4000-8000-000000000201', 1,
  '74050000-0000-4000-8000-000000000002', null,
  '74050000-0000-4000-8000-000000000001',
  'a4050000-0000-4000-8000-000000000201',
  'b4050000-0000-4000-8000-000000000201'), 5::bigint,
  'account ownership transfers only to an active same-organization account');
select is(pg_temp.coordinate_neutral_record_ownership_transfer(
  '24050000-0000-4000-8000-000000000001',
  'e4050000-0000-4000-8000-000000000202', 1, null,
  '84050000-0000-4000-8000-000000000003',
  '74050000-0000-4000-8000-000000000001',
  'a4050000-0000-4000-8000-000000000202',
  'b4050000-0000-4000-8000-000000000202'), 6::bigint,
  'Group ownership transfers only to an active same-organization Group');
select throws_ok(
  $$select pg_temp.coordinate_neutral_record_ownership_transfer(
    '24050000-0000-4000-8000-000000000001',
    'e4050000-0000-4000-8000-000000000201', 2, null,
    '84050000-0000-4000-8000-000000000003',
    '74050000-0000-4000-8000-000000000001',
    'a4050000-0000-4000-8000-000000000203',
    'b4050000-0000-4000-8000-000000000203')$$,
  '22023', 'Neutral ownership proposal has the wrong kind',
  'a published account-owned record refuses a Group proposal');
select throws_ok(
  $$select pg_temp.coordinate_neutral_record_ownership_transfer(
    '24050000-0000-4000-8000-000000000001',
    'e4050000-0000-4000-8000-000000000203', 1,
    '74050000-0000-4000-8000-000000000002', null,
    '74050000-0000-4000-8000-000000000001',
    'a4050000-0000-4000-8000-000000000204',
    'b4050000-0000-4000-8000-000000000204')$$,
  '42501', 'Neutral ownership mode has no direct transfer',
  'inherited ownership has no direct transfer');
select is(
  (select current_version || '|' || change_reason
   from vortex_access.organization_access_versions
   where organization_id = '24050000-0000-4000-8000-000000000001'),
  '6|record_ownership_changed',
  'each successful representative ownership transfer changes Access once');

select * from finish();
rollback;
