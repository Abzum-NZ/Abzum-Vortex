-- Private current Group, membership, assignment, activation and delegation facts.
-- These rows are protected evidence only. They expose no writer or access decision.

create table vortex_access.organization_groups (
  organization_id uuid not null,
  group_id uuid not null,
  group_key text not null,
  label text not null,
  state text not null,
  revision bigint not null,
  created_by uuid not null,
  created_at timestamptz not null,
  changed_by uuid not null,
  changed_at timestamptz not null,
  change_correlation_id uuid not null,
  constraint organization_groups_pk primary key (organization_id, group_id),
  constraint organization_groups_key_unique unique (organization_id, group_key),
  constraint organization_groups_ids_non_nil check (
    organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and group_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and created_by <> '00000000-0000-0000-0000-000000000000'::uuid
    and changed_by <> '00000000-0000-0000-0000-000000000000'::uuid
    and change_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organization_groups_key_format check (
    pg_catalog.char_length(group_key) between 1 and 40
    and group_key ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
  ),
  constraint organization_groups_label_valid check (
    label = pg_catalog.btrim(label)
    and pg_catalog.char_length(label) between 1 and 60
  ),
  constraint organization_groups_state_valid check (state in ('active', 'retired')),
  constraint organization_groups_revision_range check (
    revision between 1 and 9007199254740991
  ),
  constraint organization_groups_time_valid check (
    created_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and changed_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and changed_at >= created_at
  ),
  constraint organization_groups_organization_fk foreign key (organization_id)
    references vortex_identity.organizations (organization_id)
);

create table vortex_access.organization_group_memberships (
  organization_id uuid not null,
  membership_id uuid not null,
  group_id uuid not null,
  organization_account_id uuid not null,
  revision bigint not null,
  starts_at timestamptz not null,
  expires_at timestamptz,
  state text not null,
  granted_by uuid not null,
  granted_at timestamptz not null,
  grant_correlation_id uuid not null,
  changed_by uuid not null,
  changed_at timestamptz not null,
  change_correlation_id uuid not null,
  revoked_by uuid,
  revoked_at timestamptz,
  revocation_correlation_id uuid,
  constraint organization_group_memberships_pk primary key (
    organization_id, membership_id
  ),
  constraint organization_group_memberships_ids_non_nil check (
    organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and membership_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and group_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and organization_account_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and granted_by <> '00000000-0000-0000-0000-000000000000'::uuid
    and grant_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and changed_by <> '00000000-0000-0000-0000-000000000000'::uuid
    and change_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and (revoked_by is null
      or revoked_by <> '00000000-0000-0000-0000-000000000000'::uuid)
    and (revocation_correlation_id is null
      or revocation_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid)
  ),
  constraint organization_group_memberships_revision_range check (
    revision between 1 and 9007199254740991
  ),
  constraint organization_group_memberships_state_valid check (state in ('live', 'revoked')),
  constraint organization_group_memberships_revocation_shape check (
    (
      state = 'live'
      and revoked_by is null
      and revoked_at is null
      and revocation_correlation_id is null
    ) or (
      state = 'revoked'
      and revoked_by is not null
      and revoked_at is not null
      and revocation_correlation_id is not null
    )
  ),
  constraint organization_group_memberships_time_valid check (
    starts_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and (expires_at is null
      or expires_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    and granted_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and changed_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and (revoked_at is null
      or revoked_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    and (expires_at is null or expires_at > starts_at)
    and changed_at >= granted_at
    and (revoked_at is null or revoked_at >= granted_at)
    and (revoked_at is null or changed_at >= revoked_at)
  ),
  constraint organization_group_memberships_group_fk foreign key (
    organization_id, group_id
  ) references vortex_access.organization_groups (organization_id, group_id),
  constraint organization_group_memberships_account_fk foreign key (
    organization_id, organization_account_id
  ) references vortex_identity.organization_accounts (
    organization_id, organization_account_id
  )
);

create unique index organization_group_memberships_one_live_pair
  on vortex_access.organization_group_memberships (
    organization_id, group_id, organization_account_id
  ) where state = 'live';

comment on index vortex_access.organization_group_memberships_one_live_pair is
  'The live-pair index also serves current Group traversal; historical membership reads use the exact-ID primary key.';

create index organization_group_memberships_account_idx
  on vortex_access.organization_group_memberships (
    organization_id, organization_account_id, state, starts_at, expires_at
  );

create table vortex_access.organization_role_assignments (
  organization_id uuid not null,
  role_assignment_id uuid not null,
  role_id uuid not null,
  assignee_kind text not null,
  organization_account_id uuid,
  group_id uuid,
  assignment_kind text not null,
  revision bigint not null,
  starts_at timestamptz not null,
  expires_at timestamptz,
  state text not null,
  granted_by uuid not null,
  granted_at timestamptz not null,
  grant_correlation_id uuid not null,
  changed_by uuid not null,
  changed_at timestamptz not null,
  change_correlation_id uuid not null,
  revoked_by uuid,
  revoked_at timestamptz,
  revocation_correlation_id uuid,
  constraint organization_role_assignments_pk primary key (
    organization_id, role_assignment_id
  ),
  constraint organization_role_assignments_kind_valid check (
    assignee_kind in ('organization_account', 'group')
    and assignment_kind in ('standing', 'eligible')
  ),
  constraint organization_role_assignments_assignee_shape check (
    (
      assignee_kind = 'organization_account'
      and organization_account_id is not null
      and group_id is null
    ) or (
      assignee_kind = 'group'
      and organization_account_id is null
      and group_id is not null
    )
  ),
  constraint organization_role_assignments_ids_non_nil check (
    organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and role_assignment_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and role_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and (organization_account_id is null
      or organization_account_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    and (group_id is null
      or group_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    and granted_by <> '00000000-0000-0000-0000-000000000000'::uuid
    and grant_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and changed_by <> '00000000-0000-0000-0000-000000000000'::uuid
    and change_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and (revoked_by is null
      or revoked_by <> '00000000-0000-0000-0000-000000000000'::uuid)
    and (revocation_correlation_id is null
      or revocation_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid)
  ),
  constraint organization_role_assignments_revision_range check (
    revision between 1 and 9007199254740991
  ),
  constraint organization_role_assignments_state_valid check (state in ('live', 'revoked')),
  constraint organization_role_assignments_revocation_shape check (
    (
      state = 'live'
      and revoked_by is null
      and revoked_at is null
      and revocation_correlation_id is null
    ) or (
      state = 'revoked'
      and revoked_by is not null
      and revoked_at is not null
      and revocation_correlation_id is not null
    )
  ),
  constraint organization_role_assignments_time_valid check (
    starts_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and (expires_at is null
      or expires_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    and granted_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and changed_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and (revoked_at is null
      or revoked_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    and (expires_at is null or expires_at > starts_at)
    and changed_at >= granted_at
    and (revoked_at is null or revoked_at >= granted_at)
    and (revoked_at is null or changed_at >= revoked_at)
  ),
  constraint organization_role_assignments_role_fk foreign key (
    organization_id, role_id
  ) references vortex_access.organization_roles (organization_id, role_id),
  constraint organization_role_assignments_account_fk foreign key (
    organization_id, organization_account_id
  ) references vortex_identity.organization_accounts (
    organization_id, organization_account_id
  ),
  constraint organization_role_assignments_group_fk foreign key (
    organization_id, group_id
  ) references vortex_access.organization_groups (organization_id, group_id)
);

create index organization_role_assignments_role_idx
  on vortex_access.organization_role_assignments (
    organization_id, role_id, state, starts_at, expires_at
  );

create index organization_role_assignments_account_idx
  on vortex_access.organization_role_assignments (
    organization_id, organization_account_id, state, starts_at, expires_at
  ) where organization_account_id is not null;

create index organization_role_assignments_group_idx
  on vortex_access.organization_role_assignments (
    organization_id, group_id, state, starts_at, expires_at
  ) where group_id is not null;

create table vortex_access.organization_role_activations (
  organization_id uuid not null,
  role_activation_id uuid not null,
  organization_account_id uuid not null,
  role_id uuid not null,
  revision bigint not null,
  historical_role_revision bigint not null,
  authority_continuity_revision bigint not null,
  policy_continuity_revision bigint not null,
  activation_policy_id uuid not null,
  activation_policy_revision bigint not null,
  activation_policy_fingerprint text not null,
  eligibility_source_kind text not null,
  role_assignment_id uuid not null,
  role_assignment_revision bigint not null,
  membership_id uuid,
  membership_revision bigint,
  state text not null,
  activated_by uuid not null,
  activated_at timestamptz not null,
  expires_at timestamptz not null,
  activation_correlation_id uuid not null,
  changed_by uuid not null,
  changed_at timestamptz not null,
  change_correlation_id uuid not null,
  revoked_by uuid,
  revoked_at timestamptz,
  revocation_correlation_id uuid,
  constraint organization_role_activations_pk primary key (
    organization_id, role_activation_id
  ),
  constraint organization_role_activations_ids_non_nil check (
    organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and role_activation_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and organization_account_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and role_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and activation_policy_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and role_assignment_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and (membership_id is null
      or membership_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    and activated_by <> '00000000-0000-0000-0000-000000000000'::uuid
    and activation_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and changed_by <> '00000000-0000-0000-0000-000000000000'::uuid
    and change_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and (revoked_by is null
      or revoked_by <> '00000000-0000-0000-0000-000000000000'::uuid)
    and (revocation_correlation_id is null
      or revocation_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid)
  ),
  constraint organization_role_activations_revision_range check (
    revision between 1 and 9007199254740991
    and historical_role_revision between 1 and 9007199254740991
    and authority_continuity_revision between 1 and 9007199254740991
    and policy_continuity_revision between 1 and 9007199254740991
    and activation_policy_revision between 1 and 9007199254740991
    and role_assignment_revision between 1 and 9007199254740991
    and (membership_revision is null
      or membership_revision between 1 and 9007199254740991)
  ),
  constraint organization_role_activations_policy_fingerprint_valid check (
    activation_policy_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint organization_role_activations_source_shape check (
    (
      eligibility_source_kind = 'direct'
      and membership_id is null
      and membership_revision is null
    ) or (
      eligibility_source_kind = 'group'
      and membership_id is not null
      and membership_revision is not null
    )
  ),
  constraint organization_role_activations_state_valid check (state in ('live', 'revoked')),
  constraint organization_role_activations_revocation_shape check (
    (
      state = 'live'
      and revoked_by is null
      and revoked_at is null
      and revocation_correlation_id is null
    ) or (
      state = 'revoked'
      and revoked_by is not null
      and revoked_at is not null
      and revocation_correlation_id is not null
    )
  ),
  constraint organization_role_activations_time_valid check (
    activated_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and expires_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and changed_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and (revoked_at is null
      or revoked_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    and expires_at > activated_at
    and changed_at >= activated_at
    and (revoked_at is null or revoked_at >= activated_at)
    and (revoked_at is null or changed_at >= revoked_at)
  ),
  constraint organization_role_activations_account_fk foreign key (
    organization_id, organization_account_id
  ) references vortex_identity.organization_accounts (
    organization_id, organization_account_id
  ),
  constraint organization_role_activations_role_fk foreign key (
    organization_id, role_id
  ) references vortex_access.organization_roles (organization_id, role_id),
  constraint organization_role_activations_role_revision_fk foreign key (
    organization_id, role_id, historical_role_revision
  ) references vortex_access.organization_role_revisions (
    organization_id, role_id, revision
  ),
  constraint organization_role_activations_activation_policy_fk foreign key (
    organization_id, role_id, activation_policy_id,
    activation_policy_revision, activation_policy_fingerprint
  ) references vortex_access.organization_role_activation_policy_revisions (
    organization_id, role_id, activation_policy_id, revision, policy_fingerprint
  ),
  constraint organization_role_activations_assignment_fk foreign key (
    organization_id, role_assignment_id
  ) references vortex_access.organization_role_assignments (
    organization_id, role_assignment_id
  ),
  constraint organization_role_activations_membership_fk foreign key (
    organization_id, membership_id
  ) references vortex_access.organization_group_memberships (
    organization_id, membership_id
  )
);

create index organization_role_activations_account_role_idx
  on vortex_access.organization_role_activations (
    organization_id, organization_account_id, role_id, state, expires_at
  );

create index organization_role_activations_role_revision_idx
  on vortex_access.organization_role_activations (
    organization_id, role_id, historical_role_revision
  );

create index organization_role_activations_policy_idx
  on vortex_access.organization_role_activations (
    organization_id, role_id, activation_policy_id,
    activation_policy_revision, activation_policy_fingerprint
  );

create index organization_role_activations_assignment_idx
  on vortex_access.organization_role_activations (
    organization_id, role_assignment_id
  );

create index organization_role_activations_membership_idx
  on vortex_access.organization_role_activations (
    organization_id, membership_id
  ) where membership_id is not null;

create table vortex_access.organization_delegation_authorities (
  organization_id uuid not null,
  delegation_authority_id uuid not null,
  holder_kind text not null,
  organization_account_id uuid,
  group_id uuid,
  scope_kind text not null,
  bounded_permissions jsonb,
  scope_fingerprint text,
  revision bigint not null,
  starts_at timestamptz not null,
  expires_at timestamptz,
  state text not null,
  granted_by uuid not null,
  granted_at timestamptz not null,
  grant_correlation_id uuid not null,
  changed_by uuid not null,
  changed_at timestamptz not null,
  change_correlation_id uuid not null,
  revoked_by uuid,
  revoked_at timestamptz,
  revocation_correlation_id uuid,
  constraint organization_delegation_authorities_pk primary key (
    organization_id, delegation_authority_id
  ),
  constraint organization_delegation_authorities_holder_kind_valid check (
    holder_kind in ('organization_account', 'group')
  ),
  constraint organization_delegation_authorities_holder_shape check (
    (
      holder_kind = 'organization_account'
      and organization_account_id is not null
      and group_id is null
    ) or (
      holder_kind = 'group'
      and organization_account_id is null
      and group_id is not null
    )
  ),
  constraint organization_delegation_authorities_scope_shape check (
    (
      scope_kind = 'organization_catalogue'
      and bounded_permissions is null
      and scope_fingerprint is null
    ) or (
      scope_kind = 'bounded'
      and bounded_permissions is not null
      and scope_fingerprint is not null
      and case
        when pg_catalog.jsonb_typeof(bounded_permissions) = 'array'
          then pg_catalog.jsonb_array_length(bounded_permissions) > 0
        else false
      end
      and scope_fingerprint ~ '^sha256:[a-f0-9]{64}$'
    )
  ),
  constraint organization_delegation_authorities_ids_non_nil check (
    organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and delegation_authority_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and (organization_account_id is null
      or organization_account_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    and (group_id is null
      or group_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    and granted_by <> '00000000-0000-0000-0000-000000000000'::uuid
    and grant_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and changed_by <> '00000000-0000-0000-0000-000000000000'::uuid
    and change_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and (revoked_by is null
      or revoked_by <> '00000000-0000-0000-0000-000000000000'::uuid)
    and (revocation_correlation_id is null
      or revocation_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid)
  ),
  constraint organization_delegation_authorities_revision_range check (
    revision between 1 and 9007199254740991
  ),
  constraint organization_delegation_authorities_state_valid check (
    state in ('live', 'revoked')
  ),
  constraint organization_delegation_authorities_revocation_shape check (
    (
      state = 'live'
      and revoked_by is null
      and revoked_at is null
      and revocation_correlation_id is null
    ) or (
      state = 'revoked'
      and revoked_by is not null
      and revoked_at is not null
      and revocation_correlation_id is not null
    )
  ),
  constraint organization_delegation_authorities_time_valid check (
    starts_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and (expires_at is null
      or expires_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    and granted_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and changed_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and (revoked_at is null
      or revoked_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    and (expires_at is null or expires_at > starts_at)
    and changed_at >= granted_at
    and (revoked_at is null or revoked_at >= granted_at)
    and (revoked_at is null or changed_at >= revoked_at)
  ),
  constraint organization_delegation_authorities_account_fk foreign key (
    organization_id, organization_account_id
  ) references vortex_identity.organization_accounts (
    organization_id, organization_account_id
  ),
  constraint organization_delegation_authorities_group_fk foreign key (
    organization_id, group_id
  ) references vortex_access.organization_groups (organization_id, group_id)
);

create index organization_delegation_authorities_account_idx
  on vortex_access.organization_delegation_authorities (
    organization_id, organization_account_id, state, starts_at, expires_at
  ) where organization_account_id is not null;

create index organization_delegation_authorities_group_idx
  on vortex_access.organization_delegation_authorities (
    organization_id, group_id, state, starts_at, expires_at
  ) where group_id is not null;

alter table vortex_access.organization_groups enable row level security;
alter table vortex_access.organization_groups force row level security;
alter table vortex_access.organization_group_memberships enable row level security;
alter table vortex_access.organization_group_memberships force row level security;
alter table vortex_access.organization_role_assignments enable row level security;
alter table vortex_access.organization_role_assignments force row level security;
alter table vortex_access.organization_role_activations enable row level security;
alter table vortex_access.organization_role_activations force row level security;
alter table vortex_access.organization_delegation_authorities enable row level security;
alter table vortex_access.organization_delegation_authorities force row level security;

create function vortex_access.protect_organization_group()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.revision <> 1 or new.state <> 'active' then
      raise exception using errcode = '23514',
        message = 'An organization Group must begin active at revision one';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Organization Groups cannot be deleted';
  end if;

  if old.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization Group revision is exhausted';
  end if;

  if old.state = 'retired'
    or new.organization_id is distinct from old.organization_id
    or new.group_id is distinct from old.group_id
    or new.group_key is distinct from old.group_key
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
    or new.revision <> old.revision + 1
    or new.changed_at < old.changed_at
    or (new.changed_by, new.changed_at, new.change_correlation_id)
      is not distinct from
      (old.changed_by, old.changed_at, old.change_correlation_id)
    or (old.state = 'active' and new.state not in ('active', 'retired')) then
    raise exception using errcode = '23514',
      message = 'Organization Group transition is invalid';
  end if;

  return new;
end
$function$;

create trigger organization_groups_protect_change
before insert or update or delete on vortex_access.organization_groups
for each row execute function vortex_access.protect_organization_group();

create function vortex_access.validate_organization_group_membership_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.revision <> 1
    or new.state <> 'live'
    or (new.expires_at is not null
      and new.expires_at <= pg_catalog.statement_timestamp()) then
    raise exception using errcode = '23514',
      message = 'A new Group membership requires a current live revision-one window';
  end if;

  if not exists (
    select 1
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = new.organization_id
      and organization_group.group_id = new.group_id
      and organization_group.state = 'active'
  ) or not exists (
    select 1
    from vortex_identity.organization_accounts as account
    where account.organization_id = new.organization_id
      and account.organization_account_id = new.organization_account_id
      and account.state = 'active'
  ) then
    raise exception using errcode = '23514',
      message = 'A new Group membership requires active same-organization sources';
  end if;

  return new;
end
$function$;

create trigger organization_group_memberships_validate_insert
before insert on vortex_access.organization_group_memberships
for each row execute function
  vortex_access.validate_organization_group_membership_insert();

create function vortex_access.protect_organization_group_membership()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Organization Group memberships cannot be deleted';
  end if;

  if old.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization Group membership revision is exhausted';
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.membership_id is distinct from old.membership_id
    or new.group_id is distinct from old.group_id
    or new.organization_account_id is distinct from old.organization_account_id
    or new.starts_at is distinct from old.starts_at
    or new.expires_at is distinct from old.expires_at
    or new.granted_by is distinct from old.granted_by
    or new.granted_at is distinct from old.granted_at
    or new.grant_correlation_id is distinct from old.grant_correlation_id
    or new.revision <> old.revision + 1
    or new.changed_at < old.changed_at
    or (new.changed_by, new.changed_at, new.change_correlation_id)
      is not distinct from
      (old.changed_by, old.changed_at, old.change_correlation_id) then
    raise exception using errcode = '23514',
      message = 'Organization Group membership identity or evidence is immutable';
  end if;

  if old.state = 'live' and new.state = 'revoked' then
    if new.revoked_at is null or new.revoked_at < old.changed_at then
      raise exception using errcode = '23514',
        message = 'Group membership revocation cannot predate current evidence';
    end if;
    return new;
  end if;

  if old.state = 'revoked' and new.state = 'live' then
    if new.expires_at is not null
      and new.expires_at <= pg_catalog.statement_timestamp() then
      raise exception using errcode = '23514',
        message = 'An expired Group membership requires a new identity';
    end if;

    if not exists (
      select 1
      from vortex_access.organization_groups as organization_group
      where organization_group.organization_id = new.organization_id
        and organization_group.group_id = new.group_id
        and organization_group.state = 'active'
    ) or not exists (
      select 1
      from vortex_identity.organization_accounts as account
      where account.organization_id = new.organization_id
        and account.organization_account_id = new.organization_account_id
        and account.state = 'active'
    ) then
      raise exception using errcode = '23514',
        message = 'Group membership restoration requires active same-organization sources';
    end if;

    return new;
  end if;

  raise exception using errcode = '23514',
    message = 'Organization Group membership transition is invalid';
end
$function$;

create trigger organization_group_memberships_protect_change
before update or delete on vortex_access.organization_group_memberships
for each row execute function vortex_access.protect_organization_group_membership();

create function vortex_access.validate_organization_role_assignment_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.revision <> 1
    or new.state <> 'live'
    or (new.expires_at is not null
      and new.expires_at <= pg_catalog.statement_timestamp()) then
    raise exception using errcode = '23514',
      message = 'A new role assignment requires a current live revision-one window';
  end if;

  if not exists (
    select 1
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = new.organization_id
      and role.role_id = new.role_id
      and revision.lifecycle = 'active'
      and (
        (new.assignment_kind = 'standing' and revision.assignment_policy = 'standing')
        or (
          new.assignment_kind = 'eligible'
          and revision.assignment_policy = 'activation_required'
        )
      )
  ) then
    raise exception using errcode = '23514',
      message = 'A new role assignment requires a compatible active role';
  end if;

  if new.assignee_kind = 'organization_account' then
    if not exists (
      select 1
      from vortex_identity.organization_accounts as account
      where account.organization_id = new.organization_id
        and account.organization_account_id = new.organization_account_id
        and account.state = 'active'
    ) then
      raise exception using errcode = '23514',
        message = 'A new role assignment requires an active same-organization account';
    end if;
  elsif new.assignee_kind = 'group' then
    if not exists (
      select 1
      from vortex_access.organization_groups as organization_group
      where organization_group.organization_id = new.organization_id
        and organization_group.group_id = new.group_id
        and organization_group.state = 'active'
    ) then
      raise exception using errcode = '23514',
        message = 'A new role assignment requires an active same-organization Group';
    end if;
  end if;

  return new;
end
$function$;

create trigger organization_role_assignments_validate_insert
before insert on vortex_access.organization_role_assignments
for each row execute function vortex_access.validate_organization_role_assignment_insert();

create function vortex_access.protect_organization_role_assignment()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Organization role assignments cannot be deleted';
  end if;

  if old.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization role assignment revision is exhausted';
  end if;

  if old.state = 'revoked'
    or new.state <> 'revoked'
    or new.revoked_at is null
    or new.revoked_at < old.changed_at
    or new.organization_id is distinct from old.organization_id
    or new.role_assignment_id is distinct from old.role_assignment_id
    or new.role_id is distinct from old.role_id
    or new.assignee_kind is distinct from old.assignee_kind
    or new.organization_account_id is distinct from old.organization_account_id
    or new.group_id is distinct from old.group_id
    or new.assignment_kind is distinct from old.assignment_kind
    or new.starts_at is distinct from old.starts_at
    or new.expires_at is distinct from old.expires_at
    or new.granted_by is distinct from old.granted_by
    or new.granted_at is distinct from old.granted_at
    or new.grant_correlation_id is distinct from old.grant_correlation_id
    or new.revision <> old.revision + 1
    or new.changed_at < old.changed_at
    or (new.changed_by, new.changed_at, new.change_correlation_id)
      is not distinct from
      (old.changed_by, old.changed_at, old.change_correlation_id) then
    raise exception using errcode = '23514',
      message = 'Organization role assignment transition is invalid';
  end if;

  return new;
end
$function$;

create trigger organization_role_assignments_protect_change
before update or delete on vortex_access.organization_role_assignments
for each row execute function vortex_access.protect_organization_role_assignment();

create function vortex_access.validate_organization_role_activation_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  validation_time timestamptz := pg_catalog.statement_timestamp();
  role_fact record;
  current_assignment record;
  current_membership record;
begin
  if new.revision <> 1
    or new.state <> 'live'
    or new.activated_at <> validation_time
    or new.expires_at <= validation_time then
    raise exception using errcode = '23514',
      message = 'A new role activation requires a current live revision-one window';
  end if;

  if not exists (
    select 1
    from vortex_identity.organization_accounts as account
    where account.organization_id = new.organization_id
      and account.organization_account_id = new.organization_account_id
      and account.state = 'active'
  ) then
    raise exception using errcode = '23514',
      message = 'A role activation requires an active same-organization account';
  end if;

  select role.live_revision, revision.lifecycle, revision.assignment_policy,
    revision.authority_continuity_revision,
    revision.policy_continuity_revision, revision.activation_policy_id,
    revision.activation_policy_revision, revision.activation_policy_fingerprint,
    policy.maximum_activation_duration_seconds
  into role_fact
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  join vortex_access.organization_role_activation_policy_revisions as policy
    on policy.organization_id = revision.organization_id
    and policy.role_id = revision.role_id
    and policy.activation_policy_id = revision.activation_policy_id
    and policy.revision = revision.activation_policy_revision
    and policy.policy_fingerprint = revision.activation_policy_fingerprint
  where role.organization_id = new.organization_id
    and role.role_id = new.role_id;

  if not found
    or role_fact.live_revision <> new.historical_role_revision
    or role_fact.lifecycle not in ('active', 'acceptance_required')
    or role_fact.assignment_policy <> 'activation_required'
    or role_fact.authority_continuity_revision <>
      new.authority_continuity_revision
    or role_fact.policy_continuity_revision <> new.policy_continuity_revision
    or role_fact.activation_policy_id <> new.activation_policy_id
    or role_fact.activation_policy_revision <> new.activation_policy_revision
    or role_fact.activation_policy_fingerprint <>
      new.activation_policy_fingerprint
    or extract(epoch from (new.expires_at - new.activated_at)) >
      role_fact.maximum_activation_duration_seconds then
    raise exception using errcode = '23514',
      message = 'A role activation requires exact current role and policy evidence';
  end if;

  if not exists (
    select 1
    from vortex_access.organization_role_permission_entries as permission
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = permission.organization_id
      and continuity.application_root_id is not distinct from permission.application_root_id
      and continuity.owner_kind = permission.owner_kind
      and continuity.owner_id = permission.owner_id
      and continuity.permission_id = permission.permission_id
      and continuity.state = 'available'
      and continuity.continuity_revision = permission.continuity_revision
      and continuity.meaning_fingerprint = permission.meaning_fingerprint
    where permission.organization_id = new.organization_id
      and permission.role_id = new.role_id
      and permission.role_revision = new.historical_role_revision
  ) then
    raise exception using errcode = '23514',
      message = 'A role activation requires nonempty current retained authority';
  end if;

  select assignment.role_id, assignment.assignee_kind,
    assignment.organization_account_id, assignment.group_id,
    assignment.assignment_kind, assignment.revision, assignment.starts_at,
    assignment.expires_at, assignment.state
  into current_assignment
  from vortex_access.organization_role_assignments as assignment
  where assignment.organization_id = new.organization_id
    and assignment.role_assignment_id = new.role_assignment_id;

  if not found
    or current_assignment.role_id <> new.role_id
    or current_assignment.assignment_kind <> 'eligible'
    or current_assignment.revision <> new.role_assignment_revision
    or current_assignment.state <> 'live'
    or current_assignment.starts_at > validation_time
    or (
      current_assignment.expires_at is not null
      and current_assignment.expires_at <= validation_time
    )
    or (
      current_assignment.expires_at is not null
      and new.expires_at > current_assignment.expires_at
    ) then
    raise exception using errcode = '23514',
      message = 'A role activation requires exact current eligible assignment evidence';
  end if;

  if new.eligibility_source_kind = 'direct' then
    if current_assignment.assignee_kind <> 'organization_account'
      or current_assignment.organization_account_id <>
        new.organization_account_id then
      raise exception using errcode = '23514',
        message = 'A direct activation requires matching account eligibility';
    end if;
  elsif new.eligibility_source_kind = 'group' then
    if current_assignment.assignee_kind <> 'group' then
      raise exception using errcode = '23514',
        message = 'A Group activation requires Group eligibility';
    end if;

    select membership.group_id, membership.organization_account_id,
      membership.revision, membership.starts_at, membership.expires_at,
      membership.state
    into current_membership
    from vortex_access.organization_group_memberships as membership
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = membership.organization_id
      and organization_group.group_id = membership.group_id
      and organization_group.state = 'active'
    where membership.organization_id = new.organization_id
      and membership.membership_id = new.membership_id;

    if not found
      or current_membership.group_id <> current_assignment.group_id
      or current_membership.organization_account_id <>
        new.organization_account_id
      or current_membership.revision <> new.membership_revision
      or current_membership.state <> 'live'
      or current_membership.starts_at > validation_time
      or (
        current_membership.expires_at is not null
        and current_membership.expires_at <= validation_time
      )
      or (
        current_membership.expires_at is not null
        and new.expires_at > current_membership.expires_at
      ) then
      raise exception using errcode = '23514',
        message = 'A Group activation requires exact current membership evidence';
    end if;
  end if;

  return new;
end
$function$;

create trigger organization_role_activations_validate_insert
before insert on vortex_access.organization_role_activations
for each row execute function vortex_access.validate_organization_role_activation_insert();

create function vortex_access.protect_organization_role_activation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Organization role activations cannot be deleted';
  end if;

  if old.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization role activation revision is exhausted';
  end if;

  if old.state = 'revoked'
    or new.state <> 'revoked'
    or new.revoked_at is null
    or new.revoked_at < old.changed_at
    or new.organization_id is distinct from old.organization_id
    or new.role_activation_id is distinct from old.role_activation_id
    or new.organization_account_id is distinct from old.organization_account_id
    or new.role_id is distinct from old.role_id
    or new.historical_role_revision is distinct from old.historical_role_revision
    or new.authority_continuity_revision is distinct from
      old.authority_continuity_revision
    or new.policy_continuity_revision is distinct from
      old.policy_continuity_revision
    or new.activation_policy_id is distinct from old.activation_policy_id
    or new.activation_policy_revision is distinct from old.activation_policy_revision
    or new.activation_policy_fingerprint is distinct from
      old.activation_policy_fingerprint
    or new.eligibility_source_kind is distinct from old.eligibility_source_kind
    or new.role_assignment_id is distinct from old.role_assignment_id
    or new.role_assignment_revision is distinct from old.role_assignment_revision
    or new.membership_id is distinct from old.membership_id
    or new.membership_revision is distinct from old.membership_revision
    or new.activated_by is distinct from old.activated_by
    or new.activated_at is distinct from old.activated_at
    or new.expires_at is distinct from old.expires_at
    or new.activation_correlation_id is distinct from old.activation_correlation_id
    or new.revision <> old.revision + 1
    or new.changed_at < old.changed_at
    or (new.changed_by, new.changed_at, new.change_correlation_id)
      is not distinct from
      (old.changed_by, old.changed_at, old.change_correlation_id) then
    raise exception using errcode = '23514',
      message = 'Organization role activation transition is invalid';
  end if;

  return new;
end
$function$;

create trigger organization_role_activations_protect_change
before update or delete on vortex_access.organization_role_activations
for each row execute function vortex_access.protect_organization_role_activation();

create function vortex_access.validate_organization_delegation_bounded_permissions(
  p_organization_id uuid,
  p_permissions jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  canonical_permissions jsonb;
begin
  if p_permissions is null
    or pg_catalog.jsonb_typeof(p_permissions) <> 'array'
    or pg_catalog.jsonb_array_length(p_permissions) = 0 then
    raise exception using errcode = '23514',
      message = 'Bounded delegation permissions must be a nonempty array';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_permissions) as candidate(value)
    where pg_catalog.jsonb_typeof(candidate.value) <> 'object'
  ) then
    raise exception using errcode = '23514',
      message = 'Every bounded delegation permission must be an object';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_permissions) as candidate(value)
    where (
      (
        candidate.value ->> 'ownerKind' = 'platform'
        and candidate.value ?& array[
          'acceptedRegistrationRevision', 'catalogueFingerprint',
          'continuityRevision', 'kind', 'meaningFingerprint', 'ownerId',
          'ownerKind', 'permissionId'
        ]
        and candidate.value - array[
          'acceptedRegistrationRevision', 'catalogueFingerprint',
          'continuityRevision', 'kind', 'meaningFingerprint', 'ownerId',
          'ownerKind', 'permissionId'
        ] = '{}'::jsonb
      ) or (
        candidate.value ->> 'ownerKind' in ('application', 'module')
        and candidate.value ?& array[
          'acceptedRegistrationRevision', 'applicationRootId',
          'catalogueFingerprint', 'continuityRevision', 'kind',
          'meaningFingerprint', 'ownerId', 'ownerKind', 'permissionId'
        ]
        and candidate.value - array[
          'acceptedRegistrationRevision', 'applicationRootId',
          'catalogueFingerprint', 'continuityRevision', 'kind',
          'meaningFingerprint', 'ownerId', 'ownerKind', 'permissionId'
        ] = '{}'::jsonb
      )
    ) is not true
  ) then
    raise exception using errcode = '23514',
      message = 'A bounded delegation permission has missing or unknown keys';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_permissions) as candidate(value)
    where (
      pg_catalog.jsonb_typeof(candidate.value -> 'kind') = 'string'
      and candidate.value ->> 'kind' = 'exact'
      and pg_catalog.jsonb_typeof(candidate.value -> 'ownerKind') = 'string'
      and candidate.value ->> 'ownerKind' in ('platform', 'application', 'module')
      and case
        when pg_catalog.jsonb_typeof(candidate.value -> 'ownerId') = 'string'
          and candidate.value ->> 'ownerId' ~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then pg_catalog.lower(candidate.value ->> 'ownerId') <>
            '00000000-0000-0000-0000-000000000000'
        else false
      end
      and case
        when pg_catalog.jsonb_typeof(candidate.value -> 'permissionId') =
          'string'
          and candidate.value ->> 'permissionId' ~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then pg_catalog.lower(candidate.value ->> 'permissionId') <>
            '00000000-0000-0000-0000-000000000000'
        else false
      end
      and case
        when pg_catalog.jsonb_typeof(
          candidate.value -> 'acceptedRegistrationRevision'
        ) = 'number' then
          (candidate.value ->> 'acceptedRegistrationRevision')::numeric
            between 1 and 9007199254740991
          and (candidate.value ->> 'acceptedRegistrationRevision')::numeric =
            pg_catalog.trunc(
              (candidate.value ->> 'acceptedRegistrationRevision')::numeric
            )
        else false
      end
      and case
        when pg_catalog.jsonb_typeof(candidate.value -> 'continuityRevision') =
          'number' then
          (candidate.value ->> 'continuityRevision')::numeric
            between 1 and 9007199254740991
          and (candidate.value ->> 'continuityRevision')::numeric =
            pg_catalog.trunc(
              (candidate.value ->> 'continuityRevision')::numeric
            )
        else false
      end
      and pg_catalog.jsonb_typeof(candidate.value -> 'catalogueFingerprint') =
        'string'
      and candidate.value ->> 'catalogueFingerprint' ~
        '^sha256:[a-f0-9]{64}$'
      and pg_catalog.jsonb_typeof(candidate.value -> 'meaningFingerprint') =
        'string'
      and candidate.value ->> 'meaningFingerprint' ~ '^sha256:[a-f0-9]{64}$'
      and (
        (
          candidate.value ->> 'ownerKind' = 'platform'
          and not candidate.value ? 'applicationRootId'
        ) or (
          candidate.value ->> 'ownerKind' in ('application', 'module')
          and case
            when pg_catalog.jsonb_typeof(
              candidate.value -> 'applicationRootId'
            ) = 'string'
              and candidate.value ->> 'applicationRootId' ~*
                '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then pg_catalog.lower(candidate.value ->> 'applicationRootId') <>
                '00000000-0000-0000-0000-000000000000'
            else false
          end
          and (
            candidate.value ->> 'ownerKind' <> 'application'
            or pg_catalog.lower(candidate.value ->> 'ownerId') =
              pg_catalog.lower(candidate.value ->> 'applicationRootId')
          )
        )
      )
    ) is not true
  ) then
    raise exception using errcode = '23514',
      message = 'A bounded delegation permission has invalid values';
  end if;

  if exists (
    with parsed as (
      select
        case
          when candidate.value ->> 'ownerKind' = 'platform' then null::uuid
          else (candidate.value ->> 'applicationRootId')::uuid
        end as application_root_id,
        candidate.value ->> 'ownerKind' as owner_kind,
        (candidate.value ->> 'ownerId')::uuid as owner_id,
        (candidate.value ->> 'permissionId')::uuid as permission_id
      from pg_catalog.jsonb_array_elements(p_permissions) as candidate(value)
    )
    select 1
    from parsed
    group by application_root_id, owner_kind, owner_id, permission_id
    having pg_catalog.count(*) > 1
  ) then
    raise exception using errcode = '23514',
      message = 'A bounded delegation permission identity may appear only once';
  end if;

  with parsed as (
    select candidate.value,
      case
        when candidate.value ->> 'ownerKind' = 'platform' then null::uuid
        else (candidate.value ->> 'applicationRootId')::uuid
      end as application_root_id,
      candidate.value ->> 'ownerKind' as owner_kind,
      (candidate.value ->> 'ownerId')::uuid as owner_id,
      (candidate.value ->> 'permissionId')::uuid as permission_id
    from pg_catalog.jsonb_array_elements(p_permissions) as candidate(value)
  )
  select pg_catalog.jsonb_agg(
    parsed.value order by parsed.application_root_id asc nulls last,
      parsed.owner_kind collate "C", parsed.owner_id, parsed.permission_id
  )
  into canonical_permissions
  from parsed;

  if canonical_permissions is distinct from p_permissions then
    raise exception using errcode = '23514',
      message = 'Bounded delegation permissions must use canonical order';
  end if;

  if exists (
    with parsed as (
      select
        case
          when candidate.value ->> 'ownerKind' = 'platform' then null::uuid
          else (candidate.value ->> 'applicationRootId')::uuid
        end as application_root_id,
        candidate.value ->> 'ownerKind' as owner_kind,
        (candidate.value ->> 'ownerId')::uuid as owner_id,
        (candidate.value ->> 'permissionId')::uuid as permission_id,
        (candidate.value ->> 'acceptedRegistrationRevision')::numeric::bigint as
          accepted_registration_revision,
        candidate.value ->> 'catalogueFingerprint' as catalogue_fingerprint,
        (candidate.value ->> 'continuityRevision')::numeric::bigint as
          continuity_revision,
        candidate.value ->> 'meaningFingerprint' as meaning_fingerprint
      from pg_catalog.jsonb_array_elements(p_permissions) as candidate(value)
    )
    select 1
    from parsed
    where not exists (
      select 1
      from vortex_access.permission_catalogue_entries as entry
      join vortex_access.permission_registration_revisions as registration
        on registration.organization_id = entry.organization_id
        and registration.registration_kind = entry.registration_kind
        and registration.registration_owner_id = entry.registration_owner_id
        and registration.revision = entry.registration_revision
        and registration.state = 'active'
        and registration.permission_catalogue_fingerprint =
          parsed.catalogue_fingerprint
      join vortex_access.permission_continuities as continuity
        on continuity.organization_id = entry.organization_id
        and continuity.application_root_id is not distinct from
          entry.application_root_id
        and continuity.owner_kind = entry.owner_kind
        and continuity.owner_id = entry.owner_id
        and continuity.permission_id = entry.permission_id
        and continuity.state = 'available'
        and continuity.continuity_revision = parsed.continuity_revision
        and continuity.meaning_fingerprint = parsed.meaning_fingerprint
      where entry.organization_id = p_organization_id
        and entry.application_root_id is not distinct from
          parsed.application_root_id
        and entry.owner_kind = parsed.owner_kind
        and entry.owner_id = parsed.owner_id
        and entry.permission_id = parsed.permission_id
        and entry.registration_revision =
          parsed.accepted_registration_revision
        and entry.meaning_fingerprint = parsed.meaning_fingerprint
    )
  ) then
    raise exception using errcode = '23514',
      message = 'Bounded delegation permissions require exact current catalogue evidence';
  end if;
end
$function$;

create function vortex_access.validate_organization_delegation_authority()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' and (
    new.revision <> 1
    or new.state <> 'live'
    or (new.expires_at is not null
      and new.expires_at <= pg_catalog.statement_timestamp())
  ) then
    raise exception using errcode = '23514',
      message = 'A new delegation requires a current live revision-one window';
  end if;

  if tg_op = 'UPDATE' and new.state = 'revoked' then
    return new;
  end if;

  if new.expires_at is not null
    and new.expires_at <= pg_catalog.statement_timestamp() then
    raise exception using errcode = '23514',
      message = 'An expired delegation cannot receive replacement scope';
  end if;

  if new.holder_kind = 'organization_account' then
    if not exists (
      select 1
      from vortex_identity.organization_accounts as account
      where account.organization_id = new.organization_id
        and account.organization_account_id = new.organization_account_id
        and account.state = 'active'
    ) then
      raise exception using errcode = '23514',
        message = 'A delegation requires an active same-organization account';
    end if;
  elsif new.holder_kind = 'group' then
    if not exists (
      select 1
      from vortex_access.organization_groups as organization_group
      where organization_group.organization_id = new.organization_id
        and organization_group.group_id = new.group_id
        and organization_group.state = 'active'
    ) then
      raise exception using errcode = '23514',
        message = 'A delegation requires an active same-organization Group';
    end if;
  end if;

  if new.scope_kind = 'bounded' then
    perform vortex_access.validate_organization_delegation_bounded_permissions(
      new.organization_id,
      new.bounded_permissions
    );
  end if;

  return new;
end
$function$;

create trigger organization_delegation_authorities_validate_scope
before insert or update on vortex_access.organization_delegation_authorities
for each row execute function
  vortex_access.validate_organization_delegation_authority();

create function vortex_access.protect_organization_delegation_authority()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  permissions_changed boolean;
  fingerprint_changed boolean;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Organization delegation authorities cannot be deleted';
  end if;

  if old.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization delegation authority revision is exhausted';
  end if;

  if old.state = 'revoked'
    or new.organization_id is distinct from old.organization_id
    or new.delegation_authority_id is distinct from
      old.delegation_authority_id
    or new.holder_kind is distinct from old.holder_kind
    or new.organization_account_id is distinct from old.organization_account_id
    or new.group_id is distinct from old.group_id
    or new.starts_at is distinct from old.starts_at
    or new.expires_at is distinct from old.expires_at
    or new.granted_by is distinct from old.granted_by
    or new.granted_at is distinct from old.granted_at
    or new.grant_correlation_id is distinct from old.grant_correlation_id
    or new.revision <> old.revision + 1
    or new.changed_at < old.changed_at
    or (new.changed_by, new.changed_at, new.change_correlation_id)
      is not distinct from
      (old.changed_by, old.changed_at, old.change_correlation_id) then
    raise exception using errcode = '23514',
      message = 'Organization delegation authority identity or evidence is immutable';
  end if;

  permissions_changed := new.bounded_permissions is distinct from
    old.bounded_permissions;
  fingerprint_changed := new.scope_fingerprint is distinct from
    old.scope_fingerprint;

  if new.state = 'revoked' then
    if new.revoked_at is null
      or new.revoked_at < old.changed_at
      or new.scope_kind is distinct from old.scope_kind
      or permissions_changed
      or fingerprint_changed then
      raise exception using errcode = '23514',
        message = 'Delegation revocation cannot alter scope or predate current evidence';
    end if;
    return new;
  end if;

  if new.state <> 'live'
    or (
      new.scope_kind is not distinct from old.scope_kind
      and not permissions_changed
      and not fingerprint_changed
    )
    or (
      new.scope_kind = 'bounded'
      and old.scope_kind = 'bounded'
      and permissions_changed <> fingerprint_changed
    ) then
    raise exception using errcode = '23514',
      message = 'Delegation scope replacement must replace one exact whole scope';
  end if;

  return new;
end
$function$;

create trigger organization_delegation_authorities_protect_change
before update or delete on vortex_access.organization_delegation_authorities
for each row execute function
  vortex_access.protect_organization_delegation_authority();

create function vortex_access.read_organization_group(
  p_organization_id uuid,
  p_group_id uuid
)
returns table (
  organization_id uuid,
  group_id uuid,
  group_key text,
  label text,
  state text,
  revision bigint,
  created_by_actor_id uuid,
  created_at timestamptz,
  changed_by_actor_id uuid,
  changed_at timestamptz,
  change_correlation_id uuid
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select organization_group.organization_id, organization_group.group_id,
    organization_group.group_key, organization_group.label,
    organization_group.state, organization_group.revision,
    organization_group.created_by, organization_group.created_at,
    organization_group.changed_by, organization_group.changed_at,
    organization_group.change_correlation_id
  from vortex_access.organization_groups as organization_group
  where organization_group.organization_id = p_organization_id
    and organization_group.group_id = p_group_id
$function$;

create function vortex_access.read_organization_group_membership(
  p_organization_id uuid,
  p_membership_id uuid
)
returns table (
  organization_id uuid,
  membership_id uuid,
  group_id uuid,
  organization_account_id uuid,
  revision bigint,
  starts_at timestamptz,
  expires_at timestamptz,
  state text,
  granted_by_actor_id uuid,
  granted_at timestamptz,
  grant_correlation_id uuid,
  changed_by_actor_id uuid,
  changed_at timestamptz,
  change_correlation_id uuid,
  revoked_by_actor_id uuid,
  revoked_at timestamptz,
  revocation_correlation_id uuid,
  effective_state text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select membership.organization_id, membership.membership_id,
    membership.group_id, membership.organization_account_id,
    membership.revision, membership.starts_at, membership.expires_at,
    membership.state, membership.granted_by, membership.granted_at,
    membership.grant_correlation_id, membership.changed_by,
    membership.changed_at, membership.change_correlation_id,
    membership.revoked_by, membership.revoked_at,
    membership.revocation_correlation_id,
    case
      when membership.state = 'revoked' then 'revoked'
      when membership.starts_at > clock.checked_at then 'scheduled'
      when membership.expires_at is not null
        and membership.expires_at <= clock.checked_at then 'expired'
      else 'active'
    end
  from vortex_access.organization_group_memberships as membership
  cross join (
    select pg_catalog.statement_timestamp() as checked_at
  ) as clock
  where membership.organization_id = p_organization_id
    and membership.membership_id = p_membership_id
$function$;

create function vortex_access.read_organization_role_assignment(
  p_organization_id uuid,
  p_role_assignment_id uuid
)
returns table (
  organization_id uuid,
  role_assignment_id uuid,
  role_id uuid,
  assignee_kind text,
  organization_account_id uuid,
  group_id uuid,
  assignment_kind text,
  revision bigint,
  starts_at timestamptz,
  expires_at timestamptz,
  state text,
  granted_by_actor_id uuid,
  granted_at timestamptz,
  grant_correlation_id uuid,
  changed_by_actor_id uuid,
  changed_at timestamptz,
  change_correlation_id uuid,
  revoked_by_actor_id uuid,
  revoked_at timestamptz,
  revocation_correlation_id uuid,
  effective_state text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select assignment.organization_id, assignment.role_assignment_id,
    assignment.role_id, assignment.assignee_kind,
    assignment.organization_account_id, assignment.group_id,
    assignment.assignment_kind, assignment.revision, assignment.starts_at,
    assignment.expires_at, assignment.state, assignment.granted_by,
    assignment.granted_at, assignment.grant_correlation_id,
    assignment.changed_by, assignment.changed_at,
    assignment.change_correlation_id, assignment.revoked_by,
    assignment.revoked_at, assignment.revocation_correlation_id,
    case
      when assignment.state = 'revoked' then 'revoked'
      when assignment.starts_at > clock.checked_at then 'scheduled'
      when assignment.expires_at is not null
        and assignment.expires_at <= clock.checked_at then 'expired'
      else 'active'
    end
  from vortex_access.organization_role_assignments as assignment
  cross join (
    select pg_catalog.statement_timestamp() as checked_at
  ) as clock
  where assignment.organization_id = p_organization_id
    and assignment.role_assignment_id = p_role_assignment_id
$function$;

create function vortex_access.read_organization_role_activation(
  p_organization_id uuid,
  p_role_activation_id uuid
)
returns table (
  organization_id uuid,
  role_activation_id uuid,
  organization_account_id uuid,
  role_id uuid,
  revision bigint,
  historical_role_revision bigint,
  authority_continuity_revision bigint,
  policy_continuity_revision bigint,
  activation_policy_id uuid,
  activation_policy_revision bigint,
  activation_policy_fingerprint text,
  eligibility_source_kind text,
  role_assignment_id uuid,
  role_assignment_revision bigint,
  membership_id uuid,
  membership_revision bigint,
  state text,
  activated_by_actor_id uuid,
  activated_at timestamptz,
  expires_at timestamptz,
  activation_correlation_id uuid,
  changed_by_actor_id uuid,
  changed_at timestamptz,
  change_correlation_id uuid,
  revoked_by_actor_id uuid,
  revoked_at timestamptz,
  revocation_correlation_id uuid,
  temporal_state text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select activation.organization_id, activation.role_activation_id,
    activation.organization_account_id, activation.role_id,
    activation.revision, activation.historical_role_revision,
    activation.authority_continuity_revision,
    activation.policy_continuity_revision, activation.activation_policy_id,
    activation.activation_policy_revision,
    activation.activation_policy_fingerprint,
    activation.eligibility_source_kind, activation.role_assignment_id,
    activation.role_assignment_revision, activation.membership_id,
    activation.membership_revision, activation.state,
    activation.activated_by, activation.activated_at, activation.expires_at,
    activation.activation_correlation_id, activation.changed_by,
    activation.changed_at, activation.change_correlation_id,
    activation.revoked_by, activation.revoked_at,
    activation.revocation_correlation_id,
    case
      when activation.state = 'revoked' then 'revoked'
      when activation.expires_at <= clock.checked_at then 'expired'
      else 'active'
    end
  from vortex_access.organization_role_activations as activation
  cross join (
    select pg_catalog.statement_timestamp() as checked_at
  ) as clock
  where activation.organization_id = p_organization_id
    and activation.role_activation_id = p_role_activation_id
$function$;

create function vortex_access.read_organization_delegation_authority(
  p_organization_id uuid,
  p_delegation_authority_id uuid
)
returns table (
  organization_id uuid,
  delegation_authority_id uuid,
  holder_kind text,
  organization_account_id uuid,
  group_id uuid,
  scope jsonb,
  revision bigint,
  starts_at timestamptz,
  expires_at timestamptz,
  state text,
  granted_by_actor_id uuid,
  granted_at timestamptz,
  grant_correlation_id uuid,
  changed_by_actor_id uuid,
  changed_at timestamptz,
  change_correlation_id uuid,
  revoked_by_actor_id uuid,
  revoked_at timestamptz,
  revocation_correlation_id uuid,
  effective_state text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select delegation.organization_id, delegation.delegation_authority_id,
    delegation.holder_kind, delegation.organization_account_id,
    delegation.group_id,
    case delegation.scope_kind
      when 'organization_catalogue' then
        pg_catalog.jsonb_build_object('kind', 'organization_catalogue')
      when 'bounded' then pg_catalog.jsonb_build_object(
        'kind', 'bounded',
        'permissions', delegation.bounded_permissions,
        'scopeFingerprint', delegation.scope_fingerprint
      )
    end,
    delegation.revision, delegation.starts_at, delegation.expires_at,
    delegation.state, delegation.granted_by, delegation.granted_at,
    delegation.grant_correlation_id, delegation.changed_by,
    delegation.changed_at, delegation.change_correlation_id,
    delegation.revoked_by, delegation.revoked_at,
    delegation.revocation_correlation_id,
    case
      when delegation.state = 'revoked' then 'revoked'
      when delegation.starts_at > clock.checked_at then 'scheduled'
      when delegation.expires_at is not null
        and delegation.expires_at <= clock.checked_at then 'expired'
      else 'active'
    end
  from vortex_access.organization_delegation_authorities as delegation
  cross join (
    select pg_catalog.statement_timestamp() as checked_at
  ) as clock
  where delegation.organization_id = p_organization_id
    and delegation.delegation_authority_id = p_delegation_authority_id
$function$;

comment on table vortex_access.organization_groups is
  'Private current Group facts. Retirement is terminal; this table grants no permission.';
comment on table vortex_access.organization_group_memberships is
  'Private current membership facts. A live temporal state does not itself grant role permission.';
comment on table vortex_access.organization_role_assignments is
  'Private current standing or eligible assignment facts. Eligibility never grants permission.';
comment on table vortex_access.organization_role_activations is
  'Private account-specific activation facts with exact role, policy and eligibility provenance.';
comment on column vortex_access.organization_role_activations.role_assignment_revision is
  'Historical source evidence intentionally remains scalar so current assignment changes are not FK-blocked.';
comment on column vortex_access.organization_role_activations.membership_revision is
  'Historical source evidence intentionally remains scalar so membership restoration is not FK-blocked.';
comment on table vortex_access.organization_delegation_authorities is
  'Private current delegation facts; bounded permissions are one exact ordered atomic set.';
comment on column vortex_access.organization_delegation_authorities.scope_fingerprint is
  'Preparation provenance only. Authority remains the validated exact permission tuples.';
comment on function vortex_access.read_organization_group(uuid, uuid) is
  'Owner-only exact Group fact read; foreign and unknown identities both return no row.';
comment on function vortex_access.read_organization_group_membership(uuid, uuid) is
  'Owner-only exact membership fact read with database-time temporal status.';
comment on function vortex_access.read_organization_role_assignment(uuid, uuid) is
  'Owner-only exact assignment fact read with database-time temporal status, not an access decision.';
comment on function vortex_access.read_organization_role_activation(uuid, uuid) is
  'Owner-only exact activation fact read with database-time temporal status, not an access decision.';
comment on function vortex_access.read_organization_delegation_authority(uuid, uuid) is
  'Owner-only exact delegation fact read with database-time temporal status, not an access decision.';

revoke all on table vortex_access.organization_groups,
  vortex_access.organization_group_memberships,
  vortex_access.organization_role_assignments,
  vortex_access.organization_role_activations,
  vortex_access.organization_delegation_authorities
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

revoke execute on function vortex_access.protect_organization_group()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.validate_organization_group_membership_insert()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_access.protect_organization_group_membership()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.validate_organization_role_assignment_insert()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_access.protect_organization_role_assignment()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.validate_organization_role_activation_insert()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_access.protect_organization_role_activation()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.validate_organization_delegation_bounded_permissions(uuid, jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.validate_organization_delegation_authority()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.protect_organization_delegation_authority()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_access.read_organization_group(uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.read_organization_group_membership(uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.read_organization_role_assignment(uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.read_organization_role_activation(uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.read_organization_delegation_authority(uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
