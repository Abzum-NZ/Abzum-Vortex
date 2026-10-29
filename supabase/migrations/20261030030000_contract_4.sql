-- Contract 4 (Epic 1 #3660, SF-C #3743): one definition contract version, 4.0.0, for applications,
-- modules and record types. Stored drafts are converted in place below; active installations move
-- to a contract-4 release through the setup refresh (publication and the installation coordinator);
-- old releases stay as sealed history. Privileges are unchanged.
set local role vortex_owner;

create or replace function vortex_definition.accepted_contract_version(
  p_kind text
)
returns text[]
language plpgsql
immutable
set search_path = ''
as $function$
begin
  case p_kind
    when 'application' then
      return array['4.0.0'];
    when 'module' then
      return array['4.0.0'];
    when 'record_type' then
      return array['4.0.0'];
    else
      raise exception using errcode = '22023',
        message = 'Accepted contract version kind is unknown';
  end case;
end
$function$;

reset role;
