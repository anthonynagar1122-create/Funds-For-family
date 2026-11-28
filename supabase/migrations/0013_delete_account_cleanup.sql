-- 0013 (06-merge-review-fixes): account deletion also clears help-message assignments.
-- 0006 lets an admin assign a support message to an admin or verifier (help_messages.assigned_to). When that member
-- deletes their account, 0010's delete_member_account left the assignment pointing at an anonymised, role-less row,
-- so the message looked handled by nobody who could act. This replaces the function (same signature, same body as
-- 0010) and adds: help_messages.assigned_to = null where it points at the deleted member. assigned_by and the support
-- audit trail are history and stay. Apply after 0012. Re-runnable (create or replace).
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

  update public.help_messages set assigned_to = null where assigned_to = p_user_id;
end;
$$;

revoke execute on function public.delete_member_account(bigint, text, text) from public, anon, authenticated;

commit;
