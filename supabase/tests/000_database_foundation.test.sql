begin;

select plan(4);

select has_extension(
  'pgtap',
  'pgTAP is available to every committed database test'
);

select is(
  (
    select extnamespace::regnamespace::text
    from pg_extension
    where extname = 'pgtap'
  ),
  'extensions',
  'pgTAP remains outside an exposed application schema'
);

select ok(
  exists (
    select 1
    from supabase_migrations.schema_migrations
    where version = '20260903022300'
  ),
  'the database foundation migration is recorded by Supabase migration history'
);

select fail('controlled Testing delivery acceptance failure');

select * from finish();

rollback;
