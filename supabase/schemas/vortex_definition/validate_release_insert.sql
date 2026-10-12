CREATE FUNCTION vortex_definition.validate_release_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  root_kind text;
  root_key text;
  root_created_at timestamptz;
begin
  select root.kind, root.key, root.created_at
  into root_kind, root_key, root_created_at
  from vortex_definition.roots as root
  where root.root_id = new.root_id;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'A definition release requires an existing root';
  end if;

  if new.authored_source ->> 'kind' is distinct from root_kind
    or new.authored_source ->> 'key' is distinct from root_key
    or new.authored_source ->> 'source_contract_version'
      is distinct from new.source_contract_version then
    raise exception using
      errcode = '23514',
      message = 'Definition release source metadata must match its permanent root and source contract';
  end if;

  if new.published_at < root_created_at then
    raise exception using
      errcode = '23514',
      message = 'Definition release publication time cannot precede root creation';
  end if;

  return new;
end
$$;


ALTER FUNCTION vortex_definition.validate_release_insert() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_definition.validate_release_insert() FROM PUBLIC;
