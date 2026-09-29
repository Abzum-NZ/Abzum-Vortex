create or replace function vortex_connection.enforce_grant_application_root()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  app_record record;
begin
  select root.organization_id, root.kind into app_record
  from vortex_definition.roots as root
  where root.root_id = new.application_root_id;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'Referenced application root does not exist';
  end if;

  if app_record.kind <> 'application' then
    raise exception using
      errcode = '23514',
      message = 'Referenced root must be of kind application';
  end if;

  if app_record.organization_id <> new.organization_id then
    raise exception using
      errcode = '23514',
      message = 'Referenced application root organization does not match grant organization';
  end if;

  return new;
end;
$function$;

revoke all on function vortex_connection.enforce_grant_application_root() from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_connection.enforce_grant_application_root() is null;
