-- Account deletion in one transaction. A Postgres function body runs atomically, so a failure part way leaves nothing
-- half deleted. The user row stays (anonymised) because ledger rows point at it; ledger rows are never touched.
-- Called by the server with the service role key only.
begin;

create or replace function public.delete_member_account(p_user_id bigint, p_placeholder_email text, p_clerk_placeholder text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.users
     set name = 'Former member',
         email = p_placeholder_email,
         clerk_id = p_clerk_placeholder,
         upi_id = null,
         avatar_url = null,
         deleted_at = now(),
         is_admin = false,
         is_verifier = false
   where id = p_user_id;

  update public.invites set email = p_placeholder_email where accepted_user_id = p_user_id;

  delete from public.follows where follower_id = p_user_id or followee_id = p_user_id;

  delete from public.invites
   where inviter_id = p_user_id and accepted_at is null and revoked_at is null and superseded_at is null;
end;
$$;

revoke execute on function public.delete_member_account(bigint, text, text) from public, anon, authenticated;

commit;
