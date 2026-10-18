-- Synthetic development and test data will be added by the issue that owns
-- each schema. Production delivery never applies this file.

-- The application connects as the same restricted runtime login in Local as it does when hosted.
-- This credential is intentionally fixed and Local-only; it is never valid outside the disposable
-- Supabase CLI database on exact loopback.
alter role vortex_runtime password 'vortex-runtime-local-only';

-- The exact-object Storage policies compare signed tokens with this destination identity.
-- This seed runs only on disposable Local Supabase; hosted projects provision their own ref.
alter database postgres set vortex.destination_project = 'local';

-- Local development delivers committed events in process (there is no public webhook endpoint). The
-- dispatcher resolves its system actor from exactly one active platform-wide grant; hosted
-- environments provision that grant as an operations step, never from this file.
insert into vortex_access.system_actor_grants (
  system_actor_grant_id, system_actor_id, operation_key
) values (
  '0b5f3a1e-6c2d-4e8a-9f47-1d3c5a7b9e20',
  '7c4e9a2b-1d3f-4a6c-8b5e-2f9d0c1a3e47',
  'dispatch_event_occurrences'
);
