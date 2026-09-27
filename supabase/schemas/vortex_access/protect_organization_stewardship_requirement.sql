create or replace function vortex_access.protect_organization_stewardship_requirement()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Organization stewardship requirements cannot be deleted';
  end if;

  if old.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization stewardship requirement revision is exhausted';
  end if;

  if new.organization_id <> old.organization_id
    or new.original_organization_account_id <>
      old.original_organization_account_id
    or new.original_role_id <> old.original_role_id
    or new.original_role_assignment_id <> old.original_role_assignment_id
    or new.original_delegation_authority_id <>
      old.original_delegation_authority_id
    or new.adopted_by <> old.adopted_by
    or new.adopted_at <> old.adopted_at
    or new.adoption_correlation_id <> old.adoption_correlation_id
    or new.revision <> old.revision + 1
    or new.changed_at < old.changed_at
    or new.changed_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or new.changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or new.change_correlation_id =
      '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '23514',
      message = 'Organization stewardship requirement transition is invalid';
  end if;

  return new;
end
$function$;

revoke execute on function vortex_access.protect_organization_stewardship_requirement()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_access.protect_organization_stewardship_requirement() is
  'Protects immutable original stewardship evidence and requires each attributed change to advance its revision.';
