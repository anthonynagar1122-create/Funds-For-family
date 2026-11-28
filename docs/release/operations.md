# Operations: backups, incidents and owner-only switches

For the person running the pilot. Nothing here is done automatically. Every step that touches a live service (Supabase, Vercel, Clerk, Resend) is an owner action: the build and test tooling never changes a deployed service.

## 1. Backups

Data lives in one Supabase Postgres project. Clerk holds sign-in accounts only.

**Confirm daily backups exist (owner, once before launch and monthly after)**
1. Supabase dashboard, the production project, Database, Backups.
2. Confirm a backup is listed for each of the last 7 days (daily backups are included on paid plans; the free plan has none, so on the free plan take a manual dump, see below).
3. Write down the plan, the retention (days) and whether point-in-time recovery is on. Record it in the launch notes.

**Manual dump (any plan, before every migration)**
`pg_dump "<connection string from Database settings>" --format=custom --file=ffp-$(date +%F).dump`
Store the file somewhere private. It contains personal data (names, emails, UPI IDs): do not email it or commit it.

**Restore drill (once before launch, then after any change of plan)**
Never restore into production for a drill.
1. Create a scratch Supabase project (any name containing `scratch`; free plan is enough).
2. From the production backup page, restore the latest backup to the scratch project, or run `pg_restore --no-owner --dbname "<scratch connection string>" ffp-<date>.dump`.
3. Check: row counts of `users`, `requests`, `contributions`, `repayments` match production within the age of the backup; sign in is not tested (Clerk is separate).
4. Point a local copy at the scratch project only (`SUPABASE_URL` / `SUPABASE_SECRET_KEY` in a local `.env`) and run `npm run test:integration` against it only if it is clearly a scratch project (the suite refuses production URLs).
5. Delete the scratch project. Note the date, the backup used, how long the restore took and any problem.

If the drill has not been done, backups are unproven. Treat that as a launch blocker.

## 2. Incident handling

**Who:** the owner is the single decision maker and holds the keys. Name a second person who can reach the dashboards if the owner is unavailable, and write their contact in the launch notes.

**First five minutes (any incident)**
1. Write the time and what was seen. Do not delete evidence (logs, rows).
2. If members may be harmed or money records look wrong, pause first (steps below), investigate second.
3. Tell affected members in plain words through the channel they already use with the owner (WhatsApp or the in-app help message). Do not promise things that are not built.

**Switch email off (EMAIL_ENABLED)**
1. Vercel, the project, Settings, Environment Variables: set `EMAIL_ENABLED` to `false` (or delete it; the default is off) for Production.
2. Redeploy (env changes apply to new deployments only). With it off, no email is sent by any path, even with `RESEND_API_KEY` set. The log shows "email skipped: EMAIL_ENABLED is off".
3. If mail was sent in error, also revoke the Resend API key (rotation below).

**Pause sign-ups**
Joining is by invitation only, so pausing means stopping invitations:
1. In the admin workspace, open Invites and revoke every pending invite (admin API: `DELETE /admin/invites/:id`).
2. Set each member's invite limit to 0 (admin API: `POST /admin/members/:id/invite-limit`).
3. Optional extra lock in Clerk dashboard, Configure, Restrictions: turn off sign-up or switch to restricted mode so no new Clerk account can be created. The owner can still sign in (`OWNER_EMAIL`).
4. To resume, reverse the same steps and raise the invite limits again.

**Pause the whole app**
Vercel dashboard, the project, Settings, Advanced, Pause Project (or promote the last good deployment via Deployments, Instant Rollback). Pausing makes the site unavailable to everyone; data is untouched.

**Rotate keys** (do after any suspected leak, and when someone with access leaves). Always: create the new key, update Vercel Production env, redeploy, check sign-in works, then revoke the old key.
- Clerk secret key: Clerk dashboard, API Keys, roll the secret key. Update `CLERK_SECRET_KEY`.
- Supabase secret key: Supabase dashboard, Project Settings, API Keys, create a new secret key. Update `SUPABASE_SECRET_KEY`, then delete the old one (the legacy `SUPABASE_SERVICE_ROLE_KEY` too, if it was ever set).
- Resend API key: Resend dashboard, API Keys, create new, update `RESEND_API_KEY`, delete the old one.
- `CRON_SECRET`: generate a new long random value, update it in Vercel; the daily job reads it on the next run.
- Vercel and GitHub access tokens: revoke in each account's settings and remove departed people from the team.

**After the incident:** record cause, impact, what was changed and what stops a repeat. Fix with a test first.

## 3. Owner-only switches

These are changed by the owner, never by the build tooling, and each change is logged in the launch notes with date and reason.

| Switch | Where | Default | Notes |
|---|---|---|---|
| `EMAIL_ENABLED` | Vercel env | off | Master switch for all email. Turn on only after the sending domain is verified in Resend and a staging test has passed. |
| `RESEND_API_KEY` / `EMAIL_FROM` | Vercel env | unset | Needed in addition to `EMAIL_ENABLED=true`. |
| `OWNER_EMAIL` | Vercel env | unset | Whoever signs in with this verified email becomes admin and verifier. Change with care. |
| `CRON_SECRET` | Vercel env | unset | Guards the daily job. |
| Web Analytics | Vercel dashboard | off | Leave off for the pilot (P-43). |
| Sign-up restrictions, verified-email requirement | Clerk dashboard | n/a | See section 6 of the Phase A checklist. |
| Applying database migrations | Supabase | manual | Staging first. Take a dump first (section 1). |
| Deploying to production | Vercel | manual | Nothing deploys to production without the owner's approval (P-4). |
