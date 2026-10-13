CREATE FUNCTION vortex_definition.protect_root_identity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.root_id is distinct from old.root_id
    or new.organization_id is distinct from old.organization_id
    or new.kind is distinct from old.kind
    or new.key is distinct from old.key
    or new.created_at is distinct from old.created_at
    or new.created_by is distinct from old.created_by then
    raise exception using
      errcode = '23514',
      message = 'Definition root identity, ownership, kind, key and creation evidence are permanent';
  end if;

  return new;
end
$$;

ALTER FUNCTION vortex_definition.protect_root_identity() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_definition.protect_root_identity() FROM PUBLIC;
