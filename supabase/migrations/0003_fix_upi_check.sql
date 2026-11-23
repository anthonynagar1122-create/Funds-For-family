-- Postgres regex repetition counts cap at 255, so {2,256} always errors. Same rule, expressed safely.
alter table public.users drop constraint if exists users_upi_id_check;
alter table public.users add constraint users_upi_id_check
  check (upi_id is null or (upi_id ~ '^[A-Za-z0-9._-]{2,}@[A-Za-z]{2,64}$' and char_length(split_part(upi_id, '@', 1)) <= 256));
