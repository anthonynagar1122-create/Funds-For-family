-- Lenders carry the risk, so they call or WhatsApp the borrower before contributing.
-- A member's phone is shown only to people who can see one of their requests (enforced by the API).
alter table public.users add column if not exists phone text
  check (phone is null or phone ~ '^\+[0-9]{8,15}$');
