create or replace function vortex_file.enforce_file_application_root()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  application_root record;
begin
  if new.application_root_id is null then
    return new;
  end if;

  select root.organization_id, root.kind into application_root
  from vortex_definition.roots as root
  where root.root_id = new.application_root_id;

  if not found then
    raise exception using errcode = '23503',
      message = 'Referenced application root does not exist';
  end if;

  if application_root.kind <> 'application' then
    raise exception using errcode = '23514',
      message = 'Referenced root must be of kind application';
  end if;

  if application_root.organization_id <> new.organization_id then
    raise exception using errcode = '23514',
      message = 'Referenced application root organization does not match file organization';
  end if;

  return new;
end
$function$;

revoke all on function vortex_file.enforce_file_application_root()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_file.enforce_file_application_root() is
  'Keeps a file''s Application scope inside its own organisation and on a root of kind application.';

alter function vortex_file.enforce_file_application_root() owner to postgres;
