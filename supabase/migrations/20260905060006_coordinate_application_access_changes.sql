-- Coordinate application registration, continuity and automatic role narrowing.
-- This remains an owner-only storage composition and grants no user authority.

alter function vortex_access.apply_application_permission_registration(
  text, bigint, jsonb, uuid, uuid
) rename to apply_application_permission_registration_v1_internal;

alter function vortex_access.withdraw_application_permission_registration(
  uuid, uuid, bigint, uuid, uuid
) rename to withdraw_application_permission_registration_v1_internal;

alter table vortex_access.organization_role_permission_entries
  drop constraint organization_role_permission_entries_role_revision_fk,
  add constraint organization_role_permission_entries_role_revision_fk foreign key (
    organization_id, role_id, role_revision, role_kind, role_application_scope_id
  ) references vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, application_scope_id
  ) deferrable initially deferred;

drop trigger organization_role_permission_entries_evidence
  on vortex_access.organization_role_permission_entries;

create function vortex_access.lock_role_and_refuse_sealed_permission_append()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  perform 1
  from vortex_access.organization_roles as role
  where role.organization_id = new.organization_id
    and role.role_id = new.role_id
  for update;
  if not found then
    raise exception using errcode = '23503',
      message = 'Organization role permission entries require a permanent role';
  end if;

  if exists (
    select 1
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = new.organization_id
      and revision.role_id = new.role_id
      and revision.revision = new.role_revision
  ) then
    raise exception using errcode = '23514',
      message = 'Organization role permission set is already sealed';
  end if;

  return new;
end
$function$;

create function vortex_access.lock_role_before_revision_seal()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  perform 1
  from vortex_access.organization_roles as role
  where role.organization_id = new.organization_id
    and role.role_id = new.role_id
  for update;
  if not found then
    raise exception using errcode = '23503',
      message = 'Organization role revisions require a permanent role';
  end if;
  return new;
end
$function$;

create trigger organization_role_permission_entries_refuse_sealed_append
before insert on vortex_access.organization_role_permission_entries
for each row execute function
  vortex_access.lock_role_and_refuse_sealed_permission_append();

create trigger organization_role_revisions_lock_before_seal
before insert on vortex_access.organization_role_revisions
for each row execute function vortex_access.lock_role_before_revision_seal();

alter table vortex_access.organization_role_revisions
  add column authority_continuity_revision bigint;

do $migration$
declare
  role_identity record;
  role_revision record;
  previous_revision bigint;
  previous_lifecycle text;
  resulting_continuity bigint;
  authority_broadened boolean;
begin
  if exists (
    select 1
    from (
      select revision.organization_id, revision.role_id, revision.revision,
        pg_catalog.row_number() over (
          partition by revision.organization_id, revision.role_id
          order by revision.revision
        ) as expected_revision
      from vortex_access.organization_role_revisions as revision
    ) as history
    where history.revision <> history.expected_revision
  ) or exists (
    select 1
    from vortex_access.organization_role_revisions as revision
    where (revision.role_kind = 'custom' or revision.lifecycle = 'active')
      and not exists (
        select 1
        from vortex_access.organization_role_permission_entries as permission
        where permission.organization_id = revision.organization_id
          and permission.role_id = revision.role_id
          and permission.role_revision = revision.revision
      )
  ) or exists (
    select 1
    from vortex_access.organization_role_revisions as revision
    where not exists (
      select 1
      from vortex_access.organization_roles as role
      where role.organization_id = revision.organization_id
        and role.role_id = revision.role_id
        and role.role_kind = revision.role_kind
        and role.application_scope_id = revision.application_scope_id
    )
  ) or exists (
    select 1
    from vortex_access.organization_role_permission_entries as permission
    where not exists (
      select 1
      from vortex_access.organization_role_revisions as revision
      where revision.organization_id = permission.organization_id
        and revision.role_id = permission.role_id
        and revision.revision = permission.role_revision
        and revision.role_kind = permission.role_kind
        and revision.application_scope_id = permission.role_application_scope_id
    )
  ) or exists (
    select 1
    from vortex_access.organization_role_permission_entries as permission
    join vortex_access.permission_registration_revisions as registration
      on registration.organization_id = permission.organization_id
      and registration.registration_kind = permission.registration_kind
      and registration.registration_owner_id = permission.registration_owner_id
      and registration.revision = permission.accepted_registration_revision
    join vortex_access.permission_catalogue_entries as catalogue
      on catalogue.organization_id = permission.organization_id
      and catalogue.registration_kind = permission.registration_kind
      and catalogue.registration_owner_id = permission.registration_owner_id
      and catalogue.registration_revision = permission.accepted_registration_revision
      and catalogue.owner_kind = permission.owner_kind
      and catalogue.owner_id = permission.owner_id
      and catalogue.permission_id = permission.permission_id
    where permission.catalogue_fingerprint <>
        registration.permission_catalogue_fingerprint
      or permission.meaning_fingerprint <> catalogue.meaning_fingerprint
  ) or exists (
    select 1
    from vortex_access.organization_role_revisions as revision
    join vortex_access.organization_role_permission_entries as permission
      on permission.organization_id = revision.organization_id
      and permission.role_id = revision.role_id
      and permission.role_revision = revision.revision
    join vortex_access.permission_catalogue_entries as catalogue
      on catalogue.organization_id = permission.organization_id
      and catalogue.registration_kind = permission.registration_kind
      and catalogue.registration_owner_id = permission.registration_owner_id
      and catalogue.registration_revision = permission.accepted_registration_revision
      and catalogue.owner_kind = permission.owner_kind
      and catalogue.owner_id = permission.owner_id
      and catalogue.permission_id = permission.permission_id
    where revision.privilege_classification = 'standard'
      and catalogue.administrative
  ) or exists (
    select 1
    from vortex_access.organization_role_revisions as revision
    join vortex_access.permission_registration_revisions as registration
      on registration.organization_id = revision.organization_id
      and registration.registration_kind = revision.source_registration_kind
      and registration.registration_owner_id = revision.application_root_id
      and registration.revision = revision.accepted_registration_revision
    where revision.role_kind = 'application'
      and (
        revision.source_definition_key <> registration.source_definition_key
        or revision.source_release_revision <> registration.source_revision
        or revision.source_release_version <> registration.source_version
        or revision.source_validation_contract_version <>
          registration.validation_contract_version
        or revision.source_content_fingerprint <> registration.source_content_fingerprint
        or revision.source_resolution_fingerprint <>
          registration.source_resolution_fingerprint
        or revision.source_catalogue_fingerprint <>
          registration.permission_catalogue_fingerprint
      )
  ) or exists (
    select 1
    from vortex_access.organization_role_revisions as revision
    join vortex_access.organization_role_permission_entries as permission
      on permission.organization_id = revision.organization_id
      and permission.role_id = revision.role_id
      and permission.role_revision = revision.revision
    where revision.role_kind = 'application'
      and (
        permission.application_root_id is distinct from revision.application_root_id
        or permission.accepted_registration_revision <>
          revision.accepted_registration_revision
        or permission.catalogue_fingerprint <>
          revision.source_catalogue_fingerprint
      )
  ) then
    raise exception using errcode = '23514',
      message = 'Existing organization role history is incomplete';
  end if;

  execute 'alter table vortex_access.organization_role_revisions disable trigger organization_role_revisions_immutable';
  begin
    for role_identity in
      select distinct revision.organization_id, revision.role_id
      from vortex_access.organization_role_revisions as revision
      order by revision.organization_id, revision.role_id
    loop
      previous_revision := null;
      previous_lifecycle := null;
      resulting_continuity := 1;

      for role_revision in
        select revision.revision, revision.lifecycle
        from vortex_access.organization_role_revisions as revision
        where revision.organization_id = role_identity.organization_id
          and revision.role_id = role_identity.role_id
        order by revision.revision
      loop
        if previous_revision is not null then
          select exists (
            select 1
            from vortex_access.organization_role_permission_entries as current_permission
            where current_permission.organization_id = role_identity.organization_id
              and current_permission.role_id = role_identity.role_id
              and current_permission.role_revision = role_revision.revision
              and not exists (
                select 1
                from vortex_access.organization_role_permission_entries as previous_permission
                where previous_permission.organization_id =
                    current_permission.organization_id
                  and previous_permission.role_id = current_permission.role_id
                  and previous_permission.role_revision = previous_revision
                  and previous_permission.application_root_id is not distinct
                    from current_permission.application_root_id
                  and previous_permission.owner_kind = current_permission.owner_kind
                  and previous_permission.owner_id = current_permission.owner_id
                  and previous_permission.permission_id = current_permission.permission_id
                  and previous_permission.continuity_revision =
                    current_permission.continuity_revision
                  and previous_permission.meaning_fingerprint =
                    current_permission.meaning_fingerprint
              )
          ) into authority_broadened;

          if authority_broadened
            or (
              previous_lifecycle in ('unavailable', 'retired')
              and role_revision.lifecycle in ('active', 'acceptance_required')
            ) then
            if resulting_continuity = 9007199254740991 then
              raise exception using errcode = '22003',
                message = 'Organization role authority continuity is exhausted';
            end if;
            resulting_continuity := resulting_continuity + 1;
          end if;
        end if;

        update vortex_access.organization_role_revisions as revision
        set authority_continuity_revision = resulting_continuity
        where revision.organization_id = role_identity.organization_id
          and revision.role_id = role_identity.role_id
          and revision.revision = role_revision.revision;

        previous_revision := role_revision.revision;
        previous_lifecycle := role_revision.lifecycle;
      end loop;
    end loop;

    -- Updating stored generated scope columns can queue deferred FK checks.
    -- Validate this role history before changing its immutable trigger again.
    set constraints
      vortex_access.organization_roles_current_revision_fk,
      vortex_access.organization_role_revisions_role_fk,
      vortex_access.organization_role_revisions_activation_policy_fk,
      vortex_access.organization_role_permission_entries_role_revision_fk
      immediate;
  exception
    when others then
      execute 'alter table vortex_access.organization_role_revisions enable trigger organization_role_revisions_immutable';
      raise;
  end;
  execute 'alter table vortex_access.organization_role_revisions enable trigger organization_role_revisions_immutable';
  set constraints
    vortex_access.organization_roles_current_revision_fk,
    vortex_access.organization_role_revisions_role_fk,
    vortex_access.organization_role_revisions_activation_policy_fk,
    vortex_access.organization_role_permission_entries_role_revision_fk
    deferred;
end
$migration$;

alter table vortex_access.organization_role_revisions
  alter column authority_continuity_revision set not null,
  add constraint organization_role_revisions_authority_continuity_range check (
    authority_continuity_revision between 1 and 9007199254740991
  );

create or replace function vortex_access.validate_organization_role_revision_evidence()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  target_organization_id uuid;
  target_role_id uuid;
  target_role_revision bigint;
  target_role_kind text;
  target_lifecycle text;
  target_privilege_classification text;
  target_assignment_policy text;
  target_policy_continuity_revision bigint;
  target_authority_continuity_revision bigint;
  target_activation_policy_id uuid;
  target_activation_policy_revision bigint;
  target_activation_policy_fingerprint text;
  target_application_root_id uuid;
  target_catalogue_fingerprint text;
  target_registration_revision bigint;
  previous_lifecycle text;
  previous_assignment_policy text;
  previous_policy_continuity_revision bigint;
  previous_authority_continuity_revision bigint;
  previous_activation_policy_id uuid;
  previous_activation_policy_revision bigint;
  previous_activation_policy_fingerprint text;
  policy_unchanged boolean;
  authority_broadened boolean;
  permission_count bigint;
  administrative_permission_count bigint;
  inconsistent_permission_count bigint;
  inconsistent_source_count bigint;
begin
  target_organization_id := new.organization_id;
  target_role_id := new.role_id;
  target_role_revision := new.revision;

  select revision.role_kind, revision.lifecycle, revision.privilege_classification,
    revision.assignment_policy, revision.policy_continuity_revision,
    revision.authority_continuity_revision, revision.activation_policy_id,
    revision.activation_policy_revision, revision.activation_policy_fingerprint,
    revision.application_root_id, revision.source_catalogue_fingerprint,
    revision.accepted_registration_revision
  into target_role_kind, target_lifecycle, target_privilege_classification,
    target_assignment_policy, target_policy_continuity_revision,
    target_authority_continuity_revision, target_activation_policy_id,
    target_activation_policy_revision, target_activation_policy_fingerprint,
    target_application_root_id, target_catalogue_fingerprint,
    target_registration_revision
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = target_organization_id
    and revision.role_id = target_role_id
    and revision.revision = target_role_revision;

  if not found then
    return null;
  end if;

  if target_role_revision = 1 then
    if target_policy_continuity_revision <> 1 then
      raise exception using errcode = '23514',
        message = 'An initial organization role policy continuity revision must be one';
    end if;
    if target_authority_continuity_revision <> 1 then
      raise exception using errcode = '23514',
        message = 'An initial organization role authority continuity revision must be one';
    end if;
  else
    select revision.lifecycle, revision.assignment_policy,
      revision.policy_continuity_revision,
      revision.authority_continuity_revision, revision.activation_policy_id,
      revision.activation_policy_revision, revision.activation_policy_fingerprint
    into previous_lifecycle, previous_assignment_policy,
      previous_policy_continuity_revision,
      previous_authority_continuity_revision, previous_activation_policy_id,
      previous_activation_policy_revision, previous_activation_policy_fingerprint
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = target_organization_id
      and revision.role_id = target_role_id
      and revision.revision = target_role_revision - 1;

    if not found then
      raise exception using errcode = '23514',
        message = 'An organization role revision requires its immediate predecessor';
    end if;

    policy_unchanged :=
      target_assignment_policy = previous_assignment_policy
      and target_activation_policy_id is not distinct from previous_activation_policy_id
      and target_activation_policy_revision is not distinct
        from previous_activation_policy_revision
      and target_activation_policy_fingerprint is not distinct
        from previous_activation_policy_fingerprint;

    if policy_unchanged and
      target_policy_continuity_revision <> previous_policy_continuity_revision then
      raise exception using errcode = '23514',
        message = 'Unchanged role policy must preserve policy continuity';
    end if;

    if not policy_unchanged and (
      previous_policy_continuity_revision = 9007199254740991
      or target_policy_continuity_revision <> previous_policy_continuity_revision + 1
    ) then
      raise exception using errcode = '23514',
        message = 'Changed role policy must advance policy continuity exactly once';
    end if;

    select exists (
      select 1
      from vortex_access.organization_role_permission_entries as current_permission
      where current_permission.organization_id = target_organization_id
        and current_permission.role_id = target_role_id
        and current_permission.role_revision = target_role_revision
        and not exists (
          select 1
          from vortex_access.organization_role_permission_entries as previous_permission
          where previous_permission.organization_id = current_permission.organization_id
            and previous_permission.role_id = current_permission.role_id
            and previous_permission.role_revision = target_role_revision - 1
            and previous_permission.application_root_id is not distinct
              from current_permission.application_root_id
            and previous_permission.owner_kind = current_permission.owner_kind
            and previous_permission.owner_id = current_permission.owner_id
            and previous_permission.permission_id = current_permission.permission_id
            and previous_permission.continuity_revision =
              current_permission.continuity_revision
            and previous_permission.meaning_fingerprint =
              current_permission.meaning_fingerprint
        )
    ) into authority_broadened;

    if authority_broadened
      or (
        previous_lifecycle in ('unavailable', 'retired')
        and target_lifecycle in ('active', 'acceptance_required')
      ) then
      if previous_authority_continuity_revision = 9007199254740991
        or target_authority_continuity_revision <>
          previous_authority_continuity_revision + 1 then
        raise exception using errcode = '23514',
          message = 'Broadened or restored role authority must advance continuity exactly once';
      end if;
    elsif target_authority_continuity_revision <>
      previous_authority_continuity_revision then
      raise exception using errcode = '23514',
        message = 'Preserved or narrowed role authority must preserve continuity';
    end if;
  end if;

  select pg_catalog.count(*) into permission_count
  from vortex_access.organization_role_permission_entries as permission
  where permission.organization_id = target_organization_id
    and permission.role_id = target_role_id
    and permission.role_revision = target_role_revision;

  if (target_role_kind = 'custom' or target_lifecycle = 'active')
    and permission_count = 0 then
    raise exception using errcode = '23514',
      message = 'This organization role lifecycle requires accepted permissions';
  end if;

  select pg_catalog.count(*) into inconsistent_source_count
  from vortex_access.organization_role_permission_entries as permission
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = permission.organization_id
    and registration.registration_kind = permission.registration_kind
    and registration.registration_owner_id = permission.registration_owner_id
    and registration.revision = permission.accepted_registration_revision
  join vortex_access.permission_catalogue_entries as catalogue
    on catalogue.organization_id = permission.organization_id
    and catalogue.registration_kind = permission.registration_kind
    and catalogue.registration_owner_id = permission.registration_owner_id
    and catalogue.registration_revision = permission.accepted_registration_revision
    and catalogue.owner_kind = permission.owner_kind
    and catalogue.owner_id = permission.owner_id
    and catalogue.permission_id = permission.permission_id
  where permission.organization_id = target_organization_id
    and permission.role_id = target_role_id
    and permission.role_revision = target_role_revision
    and (
      permission.catalogue_fingerprint <> registration.permission_catalogue_fingerprint
      or permission.meaning_fingerprint <> catalogue.meaning_fingerprint
    );

  if inconsistent_source_count <> 0 then
    raise exception using errcode = '23514',
      message = 'Role permissions must retain exact catalogue and meaning evidence';
  end if;

  select pg_catalog.count(*) into administrative_permission_count
  from vortex_access.organization_role_permission_entries as permission
  join vortex_access.permission_catalogue_entries as catalogue
    on catalogue.organization_id = permission.organization_id
    and catalogue.registration_kind = permission.registration_kind
    and catalogue.registration_owner_id = permission.registration_owner_id
    and catalogue.registration_revision = permission.accepted_registration_revision
    and catalogue.owner_kind = permission.owner_kind
    and catalogue.owner_id = permission.owner_id
    and catalogue.permission_id = permission.permission_id
  where permission.organization_id = target_organization_id
    and permission.role_id = target_role_id
    and permission.role_revision = target_role_revision
    and catalogue.administrative;

  if target_privilege_classification = 'standard'
    and administrative_permission_count <> 0 then
    raise exception using errcode = '23514',
      message = 'Administrative permissions require privileged role classification';
  end if;

  if target_role_kind = 'application' then
    select pg_catalog.count(*) into inconsistent_source_count
    from vortex_access.organization_role_revisions as revision
    join vortex_access.permission_registration_revisions as registration
      on registration.organization_id = revision.organization_id
      and registration.registration_kind = revision.source_registration_kind
      and registration.registration_owner_id = revision.application_root_id
      and registration.revision = revision.accepted_registration_revision
    where revision.organization_id = target_organization_id
      and revision.role_id = target_role_id
      and revision.revision = target_role_revision
      and (
        revision.source_definition_key <> registration.source_definition_key
        or revision.source_release_revision <> registration.source_revision
        or revision.source_release_version <> registration.source_version
        or revision.source_validation_contract_version <>
          registration.validation_contract_version
        or revision.source_content_fingerprint <> registration.source_content_fingerprint
        or revision.source_resolution_fingerprint <>
          registration.source_resolution_fingerprint
        or revision.source_catalogue_fingerprint <>
          registration.permission_catalogue_fingerprint
      );

    if inconsistent_source_count <> 0 then
      raise exception using errcode = '23514',
        message = 'Application role source must match exact registration evidence';
    end if;

    select pg_catalog.count(*) into inconsistent_permission_count
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = target_organization_id
      and permission.role_id = target_role_id
      and permission.role_revision = target_role_revision
      and (
        permission.application_root_id is distinct from target_application_root_id
        or permission.accepted_registration_revision <> target_registration_revision
        or permission.catalogue_fingerprint <> target_catalogue_fingerprint
      );

    if inconsistent_permission_count <> 0 then
      raise exception using errcode = '23514',
        message = 'Application role permissions must match accepted registration evidence';
    end if;
  end if;

  return null;
end
$function$;

create function vortex_access.application_access_current_transition_is_complete(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_registration_revision bigint,
  p_registration_state text
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    p_registration_state in ('active', 'withdrawn')
    and not exists (
      select 1
      from vortex_access.permission_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.application_root_id = p_application_root_id
        and continuity.last_processed_registration_revision <>
          p_registration_revision
    )
    and not exists (
      select 1
      from vortex_access.application_role_template_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.application_root_id = p_application_root_id
        and continuity.last_processed_registration_revision <>
          p_registration_revision
    )
    and not exists (
      select 1
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = p_organization_id
        and permission.registration_kind = 'application'
        and permission.registration_owner_id = p_application_root_id
        and not exists (
          select 1
          from vortex_access.permission_continuities as continuity
          where continuity.organization_id = permission.organization_id
            and continuity.application_root_id = permission.application_root_id
            and continuity.owner_kind = permission.owner_kind
            and continuity.owner_id = permission.owner_id
            and continuity.permission_id = permission.permission_id
        )
    )
    and not exists (
      select 1
      from vortex_access.organization_roles as role
      where role.organization_id = p_organization_id
        and role.role_kind = 'application'
        and role.application_root_id = p_application_root_id
        and not exists (
          select 1
          from vortex_access.application_role_template_continuities as continuity
          where continuity.organization_id = role.organization_id
            and continuity.application_root_id = role.application_root_id
            and continuity.source_role_id = role.source_role_id
        )
    )
    and (
      (
        p_registration_state = 'active'
        and not exists (
          select 1
          from vortex_access.permission_catalogue_entries as entry
          where entry.organization_id = p_organization_id
            and entry.registration_kind = 'application'
            and entry.registration_owner_id = p_application_root_id
            and entry.registration_revision = p_registration_revision
            and not exists (
              select 1
              from vortex_access.permission_continuities as continuity
              where continuity.organization_id = entry.organization_id
                and continuity.application_root_id = entry.application_root_id
                and continuity.owner_kind = entry.owner_kind
                and continuity.owner_id = entry.owner_id
                and continuity.permission_id = entry.permission_id
                and continuity.state = 'available'
                and continuity.meaning_fingerprint = entry.meaning_fingerprint
            )
        )
        and not exists (
          select 1
          from vortex_access.permission_continuities as continuity
          where continuity.organization_id = p_organization_id
            and continuity.application_root_id = p_application_root_id
            and continuity.state = 'available'
            and not exists (
              select 1
              from vortex_access.permission_catalogue_entries as entry
              where entry.organization_id = continuity.organization_id
                and entry.registration_kind = 'application'
                and entry.registration_owner_id = p_application_root_id
                and entry.registration_revision = p_registration_revision
                and entry.application_root_id = continuity.application_root_id
                and entry.owner_kind = continuity.owner_kind
                and entry.owner_id = continuity.owner_id
                and entry.permission_id = continuity.permission_id
                and entry.meaning_fingerprint = continuity.meaning_fingerprint
            )
        )
      )
      or (
        p_registration_state = 'withdrawn'
        and not exists (
          select 1
          from vortex_access.permission_continuities as continuity
          where continuity.organization_id = p_organization_id
            and continuity.application_root_id = p_application_root_id
            and continuity.state = 'available'
        )
        and not exists (
          select 1
          from vortex_access.application_role_template_continuities as continuity
          where continuity.organization_id = p_organization_id
            and continuity.application_root_id = p_application_root_id
            and continuity.state = 'available'
        )
      )
    );
$function$;

create function vortex_access.coordinate_application_access_change(
  p_operation text,
  p_expected_revision bigint,
  p_prepared_templates jsonb,
  p_organization_id uuid,
  p_application_root_id uuid,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  application_root_id uuid,
  registration_state text,
  registration_revision bigint,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  current_registration vortex_access.permission_registrations%rowtype;
  raw_result record;
  first_observation boolean := false;
  permission_candidate jsonb;
  template_value jsonb;
  template_role_id uuid;
  role_record record;
  target_template jsonb;
  current_permission_count bigint;
  retained_permission_count bigint;
  target_permission_count bigint;
  target_lifecycle text;
  next_role_revision bigint;
  next_authority_continuity_revision bigint;
  target_template_continuity_revision bigint;
begin
  if p_operation is null
    or p_operation not in ('register', 'update', 'reactivate', 'withdraw')
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'register' and p_expected_revision is not null)
    or (
      p_operation <> 'register'
      and (
        p_expected_revision is null
        or p_expected_revision not between 1 and 9007199254740991
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Coordinated application access input is invalid';
  end if;

  if p_operation = 'withdraw' then
    if p_prepared_templates is not null then
      raise exception using errcode = '22023',
        message = 'Coordinated application access input is invalid';
    end if;
  else
    if p_prepared_templates is null
      or pg_catalog.jsonb_typeof(p_prepared_templates) is distinct from 'object'
      or p_prepared_templates - array[
        'contractVersion', 'preparationBasis', 'permissionRegistration',
        'templates', 'candidateFingerprint'
      ]::text[] <> '{}'::jsonb
      or not (p_prepared_templates ?& array[
        'contractVersion', 'preparationBasis', 'permissionRegistration',
        'templates', 'candidateFingerprint'
      ])
      or p_prepared_templates ->> 'contractVersion' is distinct from '1.0.0'
      or p_prepared_templates -> 'preparationBasis' is distinct from
        '{"kind":"registration_candidate"}'::jsonb
      or pg_catalog.jsonb_typeof(p_prepared_templates -> 'permissionRegistration')
        is distinct from 'object'
      or p_prepared_templates #>> '{permissionRegistration,contractVersion}'
        is distinct from '1.0.0'
      or pg_catalog.jsonb_typeof(p_prepared_templates -> 'templates')
        is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_prepared_templates -> 'templates') = 0
      or p_prepared_templates ->> 'candidateFingerprint' is null
      or p_prepared_templates ->> 'candidateFingerprint' !~ '^sha256:[a-f0-9]{64}$'
      or (p_prepared_templates #>> '{permissionRegistration,organizationId}')::uuid
        is distinct from
        p_organization_id
      or (p_prepared_templates #>> '{permissionRegistration,applicationRootId}')::uuid
        is distinct from
        p_application_root_id then
      raise exception using errcode = '22023',
        message = 'Coordinated application access preparation is invalid';
    end if;

    permission_candidate := p_prepared_templates -> 'permissionRegistration';
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or item.value - array[
          'template', 'sourceTemplateFingerprint', 'sourcePermissions', 'livePermissions'
        ]::text[] <> '{}'::jsonb
        or not (item.value ?& array[
          'template', 'sourceTemplateFingerprint', 'sourcePermissions', 'livePermissions'
        ])
        or pg_catalog.jsonb_typeof(item.value -> 'template') is distinct from 'object'
        or pg_catalog.jsonb_typeof(item.value -> 'sourcePermissions') is distinct from 'array'
        or pg_catalog.jsonb_typeof(item.value -> 'livePermissions') is distinct from 'array'
        or item.value ->> 'sourceTemplateFingerprint' is null
        or item.value ->> 'sourceTemplateFingerprint' !~ '^sha256:[a-f0-9]{64}$'
        or item.value #>> '{template,roleId}' is null
        or (item.value #>> '{template,roleId}')::uuid =
          '00000000-0000-0000-0000-000000000000'::uuid
    ) or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
      group by item.value #>> '{template,roleId}'
      having pg_catalog.count(*) <> 1
    ) or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
      cross join lateral pg_catalog.jsonb_array_elements(
        item.value -> 'livePermissions'
      ) as live(value)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(permission_candidate -> 'entries') as entry(value)
        where entry.value = live.value
      )
    ) then
      raise exception using errcode = '22023',
        message = 'Coordinated application access preparation is invalid';
    end if;
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Coordinated application access scope is unavailable';
  end if;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id
  for update;

  if p_operation = 'register' then
    if found then
      raise exception using errcode = '40001',
        message = 'Application permission registration already exists';
    end if;
  elsif not found
    or current_registration.revision <> p_expected_revision
    or (p_operation in ('update', 'withdraw') and current_registration.state <> 'active')
    or (p_operation = 'reactivate' and current_registration.state <> 'withdrawn') then
    raise exception using errcode = '40001',
      message = 'Application permission registration revision is stale or unavailable';
  end if;

  perform 1
  from vortex_access.permission_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.application_root_id = p_application_root_id
  order by continuity.application_scope_id, continuity.owner_kind collate "C",
    continuity.owner_id, continuity.permission_id
  for update;

  perform 1
  from vortex_access.application_role_template_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.application_root_id = p_application_root_id
  order by continuity.source_role_id
  for update;

  perform 1
  from vortex_access.organization_roles as role
  where role.organization_id = p_organization_id
    and role.role_kind = 'application'
    and role.application_root_id = p_application_root_id
  order by role.role_id
  for update;

  if p_operation <> 'register' then
    first_observation :=
      not exists (
        select 1
        from vortex_access.permission_continuities as continuity
        where continuity.organization_id = p_organization_id
          and continuity.application_root_id = p_application_root_id
      )
      and not exists (
        select 1
        from vortex_access.application_role_template_continuities as continuity
        where continuity.organization_id = p_organization_id
          and continuity.application_root_id = p_application_root_id
      )
      and not exists (
        select 1
        from vortex_access.organization_roles as role
        where role.organization_id = p_organization_id
          and role.role_kind = 'application'
          and role.application_root_id = p_application_root_id
      )
      and not exists (
        select 1
        from vortex_access.organization_role_revisions as revision
        where revision.organization_id = p_organization_id
          and revision.role_kind = 'application'
          and revision.application_root_id = p_application_root_id
      )
      and not exists (
        select 1
        from vortex_access.organization_role_permission_entries as permission
        where permission.organization_id = p_organization_id
          and permission.application_root_id = p_application_root_id
      );

    if p_operation = 'update'
      and vortex_access.application_permission_registration_matches_candidate(
        p_organization_id, p_application_root_id, current_registration.revision,
        permission_candidate
      )
      and not first_observation then
      if not vortex_access.application_access_current_transition_is_complete(
          p_organization_id, p_application_root_id, current_registration.revision,
          current_registration.state
        ) or not vortex_access.application_access_current_state_matches_candidate(
          p_organization_id, p_application_root_id, current_registration.revision,
          p_prepared_templates
      ) then
        raise exception using errcode = '55000',
          message = 'Coordinated application access state is incomplete';
      end if;

      return query
      select 'unchanged'::text, p_operation, p_organization_id, p_application_root_id,
        current_registration.state, current_registration.revision,
        version.current_version, p_correlation_id
      from vortex_access.organization_access_versions as version
      where version.organization_id = p_organization_id;
      return;
    end if;

    if current_registration.revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Application permission registration revision is exhausted';
    end if;

    if not first_observation
      and not vortex_access.application_access_current_transition_is_complete(
        p_organization_id, p_application_root_id, current_registration.revision,
        current_registration.state
      ) then
      raise exception using errcode = '55000',
        message = 'Coordinated application access state is incomplete';
    end if;
  end if;

  -- The organization version row is already locked. Check before invoking the
  -- legacy raw helper, whose input-error handler also catches numeric overflow.
  -- A complete exact no-op returned above does not need a new Access version.
  if exists (
    select 1 from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id
      and version.current_version >= 9007199254740991
  ) then
    raise exception using errcode = '22003',
      message = 'Organization Access version is exhausted';
  end if;

  if first_observation then
    insert into vortex_access.permission_continuities (
      organization_id, application_root_id, owner_kind, owner_id, permission_id,
      registration_kind, registration_owner_id, state, continuity_revision,
      meaning_fingerprint, last_processed_registration_revision, changed_at
    )
    select entry.organization_id, entry.application_root_id, entry.owner_kind,
      entry.owner_id, entry.permission_id, 'application', p_application_root_id,
      case when current_registration.state = 'active' then 'available' else 'unavailable' end,
      1, entry.meaning_fingerprint, current_registration.revision,
      pg_catalog.statement_timestamp()
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = p_organization_id
      and entry.registration_kind = 'application'
      and entry.registration_owner_id = p_application_root_id
      and entry.registration_revision = current_registration.revision;
  end if;

  if not first_observation
    and current_registration.state = 'active'
    and not exists (
      select 1
      from vortex_access.application_role_template_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.application_root_id = p_application_root_id
    ) then
    raise exception using errcode = '55000',
      message = 'Coordinated application access state is incomplete';
  end if;

  if p_operation = 'withdraw' then
    select changed.* into strict raw_result
    from vortex_access.withdraw_application_permission_registration_v1_internal(
      p_organization_id, p_application_root_id, p_expected_revision,
      p_changed_by, p_correlation_id
    ) as changed;
  else
    select changed.* into strict raw_result
    from vortex_access.apply_application_permission_registration_v1_internal(
      p_operation, p_expected_revision, permission_candidate,
      p_changed_by, p_correlation_id
    ) as changed;
  end if;

  if exists (
    with target as (
      select entry.application_root_id, entry.owner_kind, entry.owner_id,
        entry.permission_id, entry.meaning_fingerprint
      from vortex_access.permission_catalogue_entries as entry
      where raw_result.registration_state = 'active'
        and entry.organization_id = p_organization_id
        and entry.registration_kind = 'application'
        and entry.registration_owner_id = p_application_root_id
        and entry.registration_revision = raw_result.registration_revision
    )
    select 1
    from vortex_access.permission_continuities as continuity
    left join target
      on target.application_root_id = continuity.application_root_id
      and target.owner_kind = continuity.owner_kind
      and target.owner_id = continuity.owner_id
      and target.permission_id = continuity.permission_id
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
      and continuity.continuity_revision = 9007199254740991
      and (
        (target.permission_id is null and continuity.state <> 'unavailable')
        or (
          target.permission_id is not null
          and (
            continuity.state <> 'available'
            or continuity.meaning_fingerprint <> target.meaning_fingerprint
          )
        )
      )
  ) then
    raise exception using errcode = '22003',
      message = 'Application permission continuity revision is exhausted';
  end if;

  with target as (
    select entry.application_root_id, entry.owner_kind, entry.owner_id,
      entry.permission_id, entry.meaning_fingerprint
    from vortex_access.permission_catalogue_entries as entry
    where raw_result.registration_state = 'active'
      and entry.organization_id = p_organization_id
      and entry.registration_kind = 'application'
      and entry.registration_owner_id = p_application_root_id
      and entry.registration_revision = raw_result.registration_revision
  ), transition as (
    select continuity.ctid as continuity_row, target.permission_id as target_permission_id,
      target.meaning_fingerprint as target_meaning_fingerprint
    from vortex_access.permission_continuities as continuity
    left join target
      on target.application_root_id = continuity.application_root_id
      and target.owner_kind = continuity.owner_kind
      and target.owner_id = continuity.owner_id
      and target.permission_id = continuity.permission_id
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
  )
  update vortex_access.permission_continuities as continuity
  set state = case
        when transition.target_permission_id is null then 'unavailable'
        else 'available'
      end,
      continuity_revision = case
        when transition.target_permission_id is not null
          and continuity.state = 'available'
          and continuity.meaning_fingerprint = transition.target_meaning_fingerprint
          then continuity.continuity_revision
        when transition.target_permission_id is null
          and continuity.state = 'unavailable'
          then continuity.continuity_revision
        else continuity.continuity_revision + 1
      end,
      meaning_fingerprint = coalesce(
        transition.target_meaning_fingerprint, continuity.meaning_fingerprint
      ),
      last_processed_registration_revision = raw_result.registration_revision,
      changed_at = pg_catalog.statement_timestamp()
  from transition
  where continuity.ctid = transition.continuity_row;

  if raw_result.registration_state = 'active' then
    insert into vortex_access.permission_continuities (
      organization_id, application_root_id, owner_kind, owner_id, permission_id,
      registration_kind, registration_owner_id, state, continuity_revision,
      meaning_fingerprint, last_processed_registration_revision, changed_at
    )
    select entry.organization_id, entry.application_root_id, entry.owner_kind,
      entry.owner_id, entry.permission_id, 'application', p_application_root_id,
      'available', 1, entry.meaning_fingerprint, raw_result.registration_revision,
      pg_catalog.statement_timestamp()
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = p_organization_id
      and entry.registration_kind = 'application'
      and entry.registration_owner_id = p_application_root_id
      and entry.registration_revision = raw_result.registration_revision
      and not exists (
        select 1
        from vortex_access.permission_continuities as continuity
        where continuity.organization_id = entry.organization_id
          and continuity.application_root_id = entry.application_root_id
          and continuity.owner_kind = entry.owner_kind
          and continuity.owner_id = entry.owner_id
          and continuity.permission_id = entry.permission_id
      );
  end if;

  if exists (
    with target as (
      select (item.value #>> '{template,roleId}')::uuid as source_role_id,
        item.value ->> 'sourceTemplateFingerprint' as source_template_fingerprint
      from pg_catalog.jsonb_array_elements(
        case when raw_result.registration_state = 'active'
          then p_prepared_templates -> 'templates'
          else '[]'::jsonb
        end
      ) as item(value)
    )
    select 1
    from vortex_access.application_role_template_continuities as continuity
    left join target on target.source_role_id = continuity.source_role_id
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
      and continuity.continuity_revision = 9007199254740991
      and (
        (target.source_role_id is null and continuity.state <> 'unavailable')
        or (
          target.source_role_id is not null
          and continuity.state <> 'available'
        )
      )
  ) then
    raise exception using errcode = '22003',
      message = 'Application role template continuity revision is exhausted';
  end if;

  with target as (
    select (item.value #>> '{template,roleId}')::uuid as source_role_id,
      item.value ->> 'sourceTemplateFingerprint' as source_template_fingerprint
    from pg_catalog.jsonb_array_elements(
      case when raw_result.registration_state = 'active'
        then p_prepared_templates -> 'templates'
        else '[]'::jsonb
      end
    ) as item(value)
  ), transition as (
    select continuity.ctid as continuity_row, target.source_role_id as target_role_id,
      target.source_template_fingerprint
    from vortex_access.application_role_template_continuities as continuity
    left join target on target.source_role_id = continuity.source_role_id
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
  )
  update vortex_access.application_role_template_continuities as continuity
  set state = case when transition.target_role_id is null
        then 'unavailable' else 'available' end,
      continuity_revision = case
        when transition.target_role_id is not null and continuity.state = 'available'
          then continuity.continuity_revision
        when transition.target_role_id is null and continuity.state = 'unavailable'
          then continuity.continuity_revision
        else continuity.continuity_revision + 1
      end,
      source_template_fingerprint = coalesce(
        transition.source_template_fingerprint, continuity.source_template_fingerprint
      ),
      last_processed_registration_revision = raw_result.registration_revision,
      changed_at = pg_catalog.statement_timestamp()
  from transition
  where continuity.ctid = transition.continuity_row;

  if raw_result.registration_state = 'active' then
    insert into vortex_access.application_role_template_continuities (
      organization_id, application_root_id, source_role_id, state,
      continuity_revision, source_template_fingerprint,
      last_processed_registration_revision, changed_at
    )
    select p_organization_id, p_application_root_id,
      (item.value #>> '{template,roleId}')::uuid, 'available', 1,
      item.value ->> 'sourceTemplateFingerprint', raw_result.registration_revision,
      pg_catalog.statement_timestamp()
    from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
    where not exists (
      select 1
      from vortex_access.application_role_template_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.application_root_id = p_application_root_id
        and continuity.source_role_id = (item.value #>> '{template,roleId}')::uuid
    );
  end if;

  for role_record in
    select role.role_id, role.source_role_id, role.live_revision,
      revision.lifecycle, revision.privilege_classification,
      revision.assignment_policy, revision.policy_continuity_revision,
      revision.authority_continuity_revision,
      revision.activation_policy_id, revision.activation_policy_revision,
      revision.activation_policy_fingerprint, revision.role_key,
      revision.label, revision.description, revision.source_definition_key,
      revision.source_release_revision, revision.source_release_version,
      revision.source_validation_contract_version,
      revision.source_content_fingerprint, revision.source_resolution_fingerprint,
      revision.source_template_fingerprint, revision.source_catalogue_fingerprint,
      revision.accepted_registration_revision,
      revision.template_continuity_revision,
      revision.accepted_grant_fingerprint
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = p_organization_id
      and role.role_kind = 'application'
      and role.application_root_id = p_application_root_id
    order by role.role_id
  loop
    if role_record.lifecycle = 'retired' then
      continue;
    end if;

    target_template := null;
    target_template_continuity_revision := null;
    if raw_result.registration_state = 'active' then
      select item.value, continuity.continuity_revision
      into target_template, target_template_continuity_revision
      from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates')
        as item(value)
      join vortex_access.application_role_template_continuities as continuity
        on continuity.organization_id = p_organization_id
        and continuity.application_root_id = p_application_root_id
        and continuity.source_role_id =
          (item.value #>> '{template,roleId}')::uuid
        and continuity.state = 'available'
      where (item.value #>> '{template,roleId}')::uuid = role_record.source_role_id;
    end if;

    select pg_catalog.count(*) into current_permission_count
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = p_organization_id
      and permission.role_id = role_record.role_id
      and permission.role_revision = role_record.live_revision;

    if target_template is null then
      retained_permission_count := 0;
      target_permission_count := 0;
      target_lifecycle := 'unavailable';
    else
      select pg_catalog.count(*) into retained_permission_count
      from vortex_access.organization_role_permission_entries as permission
      join vortex_access.permission_continuities as continuity
        on continuity.organization_id = permission.organization_id
        and continuity.application_root_id = permission.application_root_id
        and continuity.owner_kind = permission.owner_kind
        and continuity.owner_id = permission.owner_id
        and continuity.permission_id = permission.permission_id
        and continuity.state = 'available'
        and continuity.continuity_revision = permission.continuity_revision
        and continuity.meaning_fingerprint = permission.meaning_fingerprint
      where permission.organization_id = p_organization_id
        and permission.role_id = role_record.role_id
        and permission.role_revision = role_record.live_revision
        and exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            target_template -> 'livePermissions'
          ) as candidate(value)
          where (candidate.value ->> 'applicationRootId')::uuid =
              permission.application_root_id
            and candidate.value ->> 'ownerKind' = permission.owner_kind
            and (candidate.value ->> 'ownerId')::uuid = permission.owner_id
            and (candidate.value #>> '{permission,permissionId}')::uuid =
              permission.permission_id
            and candidate.value ->> 'meaningFingerprint' =
              permission.meaning_fingerprint
        );
      target_permission_count := pg_catalog.jsonb_array_length(
        target_template -> 'livePermissions'
      );
      if role_record.lifecycle = 'active'
        and retained_permission_count > 0
        and retained_permission_count = target_permission_count
        and role_record.template_continuity_revision =
          target_template_continuity_revision then
        target_lifecycle := 'active';
      else
        target_lifecycle := 'acceptance_required';
      end if;
    end if;

    if role_record.lifecycle = target_lifecycle
      and current_permission_count = retained_permission_count then
      continue;
    end if;

    if role_record.live_revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization role revision is exhausted';
    end if;
    next_role_revision := role_record.live_revision + 1;
    next_authority_continuity_revision :=
      role_record.authority_continuity_revision;
    if role_record.lifecycle in ('unavailable', 'retired')
      and target_lifecycle in ('active', 'acceptance_required') then
      if role_record.authority_continuity_revision = 9007199254740991 then
        raise exception using errcode = '22003',
          message = 'Organization role authority continuity is exhausted';
      end if;
      next_authority_continuity_revision :=
        role_record.authority_continuity_revision + 1;
    end if;

    if target_template is not null then
      insert into vortex_access.organization_role_permission_entries (
        organization_id, role_id, role_revision, entry_ordinal, role_kind,
        role_application_root_id, application_root_id, owner_kind, owner_id,
        permission_id, registration_kind, registration_owner_id,
        accepted_registration_revision, catalogue_fingerprint,
        continuity_revision, meaning_fingerprint
      )
      select permission.organization_id, permission.role_id, next_role_revision,
        pg_catalog.row_number() over (
          order by permission.application_root_id, permission.owner_kind collate "C",
            permission.owner_id, permission.permission_id
        ), permission.role_kind, permission.role_application_root_id,
        permission.application_root_id, permission.owner_kind,
        permission.owner_id, permission.permission_id,
        permission.registration_kind, permission.registration_owner_id,
        permission.accepted_registration_revision,
        permission.catalogue_fingerprint, permission.continuity_revision,
        permission.meaning_fingerprint
      from vortex_access.organization_role_permission_entries as permission
      join vortex_access.permission_continuities as continuity
        on continuity.organization_id = permission.organization_id
        and continuity.application_root_id = permission.application_root_id
        and continuity.owner_kind = permission.owner_kind
        and continuity.owner_id = permission.owner_id
        and continuity.permission_id = permission.permission_id
        and continuity.state = 'available'
        and continuity.continuity_revision = permission.continuity_revision
        and continuity.meaning_fingerprint = permission.meaning_fingerprint
      where permission.organization_id = p_organization_id
        and permission.role_id = role_record.role_id
        and permission.role_revision = role_record.live_revision
        and exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            target_template -> 'livePermissions'
          ) as candidate(value)
          where (candidate.value ->> 'applicationRootId')::uuid =
              permission.application_root_id
            and candidate.value ->> 'ownerKind' = permission.owner_kind
            and (candidate.value ->> 'ownerId')::uuid = permission.owner_id
            and (candidate.value #>> '{permission,permissionId}')::uuid =
              permission.permission_id
            and candidate.value ->> 'meaningFingerprint' =
              permission.meaning_fingerprint
        );
    end if;

    insert into vortex_access.organization_role_revisions (
      organization_id, role_id, revision, role_kind, application_root_id,
      lifecycle, privilege_classification, assignment_policy,
      policy_continuity_revision, authority_continuity_revision,
      activation_policy_id,
      activation_policy_revision, activation_policy_fingerprint, role_key,
      label, description, source_definition_key, source_release_revision,
      source_release_version, source_validation_contract_version,
      source_content_fingerprint, source_resolution_fingerprint,
      source_template_fingerprint, source_catalogue_fingerprint,
      accepted_registration_revision, template_continuity_revision,
      accepted_grant_fingerprint, changed_by, changed_at, change_correlation_id
    ) values (
      p_organization_id, role_record.role_id, next_role_revision, 'application',
      p_application_root_id, target_lifecycle,
      role_record.privilege_classification, role_record.assignment_policy,
      role_record.policy_continuity_revision,
      next_authority_continuity_revision, role_record.activation_policy_id,
      role_record.activation_policy_revision,
      role_record.activation_policy_fingerprint, role_record.role_key,
      role_record.label, role_record.description,
      role_record.source_definition_key, role_record.source_release_revision,
      role_record.source_release_version,
      role_record.source_validation_contract_version,
      role_record.source_content_fingerprint,
      role_record.source_resolution_fingerprint,
      role_record.source_template_fingerprint,
      role_record.source_catalogue_fingerprint,
      role_record.accepted_registration_revision,
      role_record.template_continuity_revision,
      role_record.accepted_grant_fingerprint, p_changed_by,
      pg_catalog.statement_timestamp(), p_correlation_id
    );

    update vortex_access.organization_roles as role
    set live_revision = next_role_revision
    where role.organization_id = p_organization_id
      and role.role_id = role_record.role_id
      and role.live_revision = role_record.live_revision;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role revision is stale';
    end if;
  end loop;

  return query select 'changed'::text, raw_result.operation,
    raw_result.organization_id, raw_result.application_root_id,
    raw_result.registration_state, raw_result.registration_revision,
    raw_result.access_version, raw_result.correlation_id;
exception
  when invalid_text_representation then
    raise exception using errcode = '22023',
      message = 'Coordinated application access input is invalid';
end
$function$;

create function vortex_access.application_permission_registration_matches_candidate(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_registration_revision bigint,
  p_candidate jsonb
)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  release_value jsonb;
  actual_entries jsonb;
  actual_application_permission_ids jsonb;
  registration_exact boolean;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_registration_revision is null
    or p_registration_revision not between 1 and 9007199254740991
    or p_candidate is null
    or pg_catalog.jsonb_typeof(p_candidate) is distinct from 'object'
    or p_candidate - array[
      'contractVersion', 'organizationId', 'applicationRootId', 'applicationRelease',
      'applicationCatalogueFingerprint', 'applicationPermissionIds', 'entries',
      'candidateFingerprint'
    ]::text[] <> '{}'::jsonb
    or not (p_candidate ?& array[
      'contractVersion', 'organizationId', 'applicationRootId', 'applicationRelease',
      'applicationCatalogueFingerprint', 'applicationPermissionIds', 'entries',
      'candidateFingerprint'
    ])
    or p_candidate ->> 'contractVersion' is distinct from '1.0.0'
    or (p_candidate ->> 'organizationId')::uuid is distinct from p_organization_id
    or (p_candidate ->> 'applicationRootId')::uuid is distinct from p_application_root_id
    or pg_catalog.jsonb_typeof(p_candidate -> 'applicationRelease') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_candidate -> 'applicationPermissionIds') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_candidate -> 'entries') is distinct from 'array' then
    return false;
  end if;

  release_value := p_candidate -> 'applicationRelease';

  select pg_catalog.count(*) = 1 into registration_exact
  from vortex_access.permission_registrations as registration
  join vortex_access.permission_registration_revisions as history
    on history.organization_id = registration.organization_id
    and history.registration_kind = registration.registration_kind
    and history.registration_owner_id = registration.registration_owner_id
    and history.revision = registration.revision
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id
    and registration.state = 'active'
    and registration.revision = p_registration_revision
    and registration.source_definition_key = release_value ->> 'definitionKey'
    and registration.source_version = release_value ->> 'releaseVersion'
    and registration.source_revision = (release_value ->> 'releaseRevision')::bigint
    and registration.validation_contract_version =
      release_value ->> 'validationContractVersion'
    and registration.source_content_fingerprint = release_value ->> 'contentFingerprint'
    and registration.source_resolution_fingerprint = release_value ->> 'resolutionFingerprint'
    and registration.permission_catalogue_fingerprint =
      p_candidate ->> 'applicationCatalogueFingerprint'
    and registration.candidate_fingerprint = p_candidate ->> 'candidateFingerprint'
    and history.operation in ('register', 'update', 'reactivate')
    and row(
      registration.state, registration.source_definition_key, registration.source_version,
      registration.source_revision, registration.validation_contract_version,
      registration.source_content_fingerprint, registration.source_resolution_fingerprint,
      registration.permission_catalogue_fingerprint, registration.candidate_fingerprint,
      registration.changed_at, registration.changed_by, registration.change_correlation_id
    ) is not distinct from row(
      history.state, history.source_definition_key, history.source_version,
      history.source_revision, history.validation_contract_version,
      history.source_content_fingerprint, history.source_resolution_fingerprint,
      history.permission_catalogue_fingerprint, history.candidate_fingerprint,
      history.changed_at, history.changed_by, history.change_correlation_id
    );

  if not registration_exact then
    return false;
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'applicationRootId', entry.application_root_id,
        'ownerKind', entry.owner_kind,
        'ownerId', entry.owner_id,
        'permission', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'permissionId', entry.permission_id,
          'key', entry.permission_key,
          'label', entry.label,
          'description', entry.description,
          'recordTypeId', entry.record_type_id,
          'actionKind', entry.action_kind,
          'namedAction', entry.named_action,
          'administrative', entry.administrative
        )),
        'sourceRelease', pg_catalog.jsonb_build_object(
          'kind', entry.source_kind,
          'definitionKey', entry.source_definition_key,
          'rootId', entry.source_root_id,
          'releaseRevision', entry.source_revision,
          'releaseVersion', entry.source_version,
          'validationContractVersion', entry.source_validation_contract_version,
          'contentFingerprint', entry.source_content_fingerprint,
          'resolutionFingerprint', entry.source_resolution_fingerprint
        ),
        'meaningFingerprint', entry.meaning_fingerprint
      ) order by
        entry.owner_kind collate "C", entry.owner_id,
        entry.permission_key collate "C", entry.permission_id
    ),
    '[]'::jsonb
  ) into actual_entries
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'application'
    and entry.registration_owner_id = p_application_root_id
    and entry.registration_revision = p_registration_revision;

  select coalesce(
    pg_catalog.jsonb_agg(entry.permission_id order by
      entry.permission_key collate "C", entry.permission_id),
    '[]'::jsonb
  ) into actual_application_permission_ids
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'application'
    and entry.registration_owner_id = p_application_root_id
    and entry.registration_revision = p_registration_revision
    and entry.owner_kind = 'application'
    and not entry.administrative;

  return actual_entries = p_candidate -> 'entries'
    and actual_application_permission_ids = p_candidate -> 'applicationPermissionIds';
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return false;
end
$function$;

create function vortex_access.application_access_current_state_matches_candidate(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_registration_revision bigint,
  p_prepared_templates jsonb
)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  role_record record;
  target_template jsonb;
  current_permission_count bigint;
  retained_permission_count bigint;
  target_permission_count bigint;
  target_lifecycle text;
  target_template_continuity_revision bigint;
begin
  if not vortex_access.application_permission_registration_matches_candidate(
    p_organization_id, p_application_root_id, p_registration_revision,
    p_prepared_templates -> 'permissionRegistration'
  ) then
    return false;
  end if;

  if exists (
    select 1
    from vortex_access.application_role_template_continuities as continuity
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
      and continuity.last_processed_registration_revision <> p_registration_revision
  ) or exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
    where not exists (
      select 1
      from vortex_access.application_role_template_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.application_root_id = p_application_root_id
        and continuity.source_role_id = (item.value #>> '{template,roleId}')::uuid
        and continuity.state = 'available'
        and continuity.source_template_fingerprint =
          item.value ->> 'sourceTemplateFingerprint'
        and continuity.last_processed_registration_revision = p_registration_revision
    )
  ) or exists (
    select 1
    from vortex_access.application_role_template_continuities as continuity
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
      and continuity.state = 'available'
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
        where (item.value #>> '{template,roleId}')::uuid = continuity.source_role_id
          and item.value ->> 'sourceTemplateFingerprint' =
            continuity.source_template_fingerprint
      )
  ) then
    return false;
  end if;

  for role_record in
    select role.role_id, role.source_role_id, revision.lifecycle,
      revision.revision as role_revision, revision.source_template_fingerprint,
      revision.template_continuity_revision
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = p_organization_id
      and role.role_kind = 'application'
      and role.application_root_id = p_application_root_id
    order by role.role_id
  loop
    if role_record.lifecycle = 'retired' then
      continue;
    end if;

    target_template := null;
    target_template_continuity_revision := null;
    select item.value, continuity.continuity_revision
    into target_template, target_template_continuity_revision
    from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
    join vortex_access.application_role_template_continuities as continuity
      on continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
      and continuity.source_role_id = (item.value #>> '{template,roleId}')::uuid
      and continuity.state = 'available'
    where (item.value #>> '{template,roleId}')::uuid = role_record.source_role_id;

    select pg_catalog.count(*) into current_permission_count
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = p_organization_id
      and permission.role_id = role_record.role_id
      and permission.role_revision = role_record.role_revision;

    if target_template is null then
      retained_permission_count := 0;
      target_permission_count := 0;
      target_lifecycle := 'unavailable';
    else
      select pg_catalog.count(*) into retained_permission_count
      from vortex_access.organization_role_permission_entries as permission
      join vortex_access.permission_continuities as continuity
        on continuity.organization_id = permission.organization_id
        and continuity.application_root_id = permission.application_root_id
        and continuity.owner_kind = permission.owner_kind
        and continuity.owner_id = permission.owner_id
        and continuity.permission_id = permission.permission_id
        and continuity.state = 'available'
        and continuity.continuity_revision = permission.continuity_revision
        and continuity.meaning_fingerprint = permission.meaning_fingerprint
      where permission.organization_id = p_organization_id
        and permission.role_id = role_record.role_id
        and permission.role_revision = role_record.role_revision
        and exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            target_template -> 'livePermissions'
          ) as candidate(value)
          where (candidate.value ->> 'applicationRootId')::uuid =
              permission.application_root_id
            and candidate.value ->> 'ownerKind' = permission.owner_kind
            and (candidate.value ->> 'ownerId')::uuid = permission.owner_id
            and (candidate.value #>> '{permission,permissionId}')::uuid =
              permission.permission_id
            and candidate.value ->> 'meaningFingerprint' =
              permission.meaning_fingerprint
        );
      target_permission_count := pg_catalog.jsonb_array_length(
        target_template -> 'livePermissions'
      );
      if role_record.lifecycle = 'active'
        and retained_permission_count > 0
        and retained_permission_count = target_permission_count
        and role_record.template_continuity_revision =
          target_template_continuity_revision then
        target_lifecycle := 'active';
      else
        target_lifecycle := 'acceptance_required';
      end if;
    end if;

    if role_record.lifecycle <> target_lifecycle
      or current_permission_count <> retained_permission_count then
      return false;
    end if;
  end loop;

  return true;
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return false;
end
$function$;

revoke execute on function
  vortex_access.apply_application_permission_registration_v1_internal(
    text, bigint, jsonb, uuid, uuid
  ),
  vortex_access.withdraw_application_permission_registration_v1_internal(
    uuid, uuid, bigint, uuid, uuid
  ),
  vortex_access.lock_role_and_refuse_sealed_permission_append(),
  vortex_access.lock_role_before_revision_seal(),
  vortex_access.application_access_current_transition_is_complete(
    uuid, uuid, bigint, text
  ),
  vortex_access.application_permission_registration_matches_candidate(
    uuid, uuid, bigint, jsonb
  ),
  vortex_access.application_access_current_state_matches_candidate(
    uuid, uuid, bigint, jsonb
  ),
  vortex_access.coordinate_application_access_change(
    text, bigint, jsonb, uuid, uuid, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on column
  vortex_access.organization_role_revisions.authority_continuity_revision is
  'Monotonic epoch for the exact effective authority tuple set; narrowing preserves it and additions or restoration advance it.';
comment on function vortex_access.coordinate_application_access_change(
  text, bigint, jsonb, uuid, uuid, uuid, uuid
) is
  'Owner-only atomic registration, continuity and supplied-role narrowing composition. It grants no caller authority.';
comment on function
  vortex_access.apply_application_permission_registration_v1_internal(
    text, bigint, jsonb, uuid, uuid
  ) is
  'Legacy raw registration writer retained privately for the coordinated application-access composition only.';
comment on function
  vortex_access.withdraw_application_permission_registration_v1_internal(
    uuid, uuid, bigint, uuid, uuid
  ) is
  'Legacy raw withdrawal writer retained privately for the coordinated application-access composition only.';
