# Fraternal CRM

Email and text messaging plus a contact CRM for Masonic bodies. Built for a statewide body (the Orient) and its subordinate valleys. One Orient per install.

## What it does

- **Contacts and lists.** Per valley. CSV import with column auto-matching, CSV export, search, duplicate matching by email or phone.
- **Email campaigns** with a WYSIWYG editor (headings, bold, lists, links, images by URL, merge fields, live preview). A plain-text version is generated automatically.
- **Text campaigns** with a character and segment counter. "Reply STOP to opt out." is added automatically.
- **Scheduling, batching and delivery tracking** per recipient, with failures and skips explained.
- **Roles.** Statewide admins create valleys and valley admins and see every valley. Valley admins see only their own.
- **API.** Valley-scoped API keys for adding contacts and sending campaigns from other systems.

## Run it

Requires Node 22.13 or newer.

```
npm install
cp .env.example .env     # edit it, then export the variables (or use your process manager)
npm start
```

On first start with an empty database, the statewide admin is created from `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD`. Sign in, add valleys under Admin, then add a valley admin for each one.

Run it behind HTTPS (Caddy or nginx), set `PUBLIC_BASE_URL` to the https address and `TRUST_PROXY=1`.

Tests: `npm test`

By default both providers are `console`, which only logs. Nothing leaves the server until you configure real ones.

## Saving your work and your data

**Autosave.** Campaign drafts save to the server about a second and a half after you stop typing. The screen shows "Saved 3:42 PM". Closing the tab, reloading, or switching devices does not lose the message. Leaving the screen saves first. Open any draft from Campaigns to keep editing. A scheduled campaign must be cancelled back to a draft before it can be edited, so a message cannot change after you scheduled it.

**Where data lives.** Everything (contacts, lists, campaigns, delivery history, sign-in sessions, API key hashes) is in one SQLite file at `DATA_DIR/fraternal-crm.sqlite`. Restarting the app loses nothing. What matters is that `DATA_DIR` is on a disk that survives deploys. On a platform with throwaway disks (most container hosts by default) you must attach a persistent volume there, or every deploy starts empty.

**Backups.** The app takes a consistent copy of the database every `BACKUP_EVERY_HOURS` (default 24) into `BACKUP_DIR` (default `DATA_DIR/backups`) and keeps the newest `BACKUP_KEEP` (default 14). Files are readable by the owner only, because they hold contact data and password hashes. Run one by hand with `npm run backup`. Set `BACKUP_EVERY_HOURS=0` to turn the automatic ones off.

By default backups sit on the same disk as the database, which does not protect you from losing that disk. Point `BACKUP_DIR` at a different volume, or copy the folder off the machine on a schedule.

**Restore.** Stop the app, copy a backup file over `DATA_DIR/fraternal-crm.sqlite`, start the app.

**Upgrades.** Older databases are upgraded automatically on start. A database written by a newer version is refused rather than damaged.

**Docker.** A `Dockerfile` is included. Mount a volume at `/data`: `docker run -v crm-data:/data -p 3000:3000 --env-file .env fraternal-crm`. I have not built or run this image, so treat it as a starting point.

## Texting providers

Set `SMS_PROVIDER` to `twilio` or `telnyx`.

- **Twilio.** Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (a number or a Messaging Service SID starting with `MG`). Point the number's incoming message webhook at `https://YOUR-HOST/webhooks/twilio`. Replies of STOP then update your contacts automatically, in every valley, and requests are signature checked.
- **Telnyx.** Set `TELNYX_API_KEY` and `TELNYX_FROM`. Sending works. Inbound STOP replies are not synced into this app yet, so opt-outs that happen only at the carrier will not appear in your contact list.

I could not test either provider against a live account. The request formats follow each provider's public API and are covered by unit tests with fakes only. Send a test to your own phone first.

Cost: Telnyx and similar providers are often cheaper per message than Twilio, but check current pricing yourself. There is no free way to text arbitrary people. Email-to-text gateways are unreliable and carriers are shutting them down, so I did not build on them.

**US registration is the real hurdle.** Business texting to US numbers requires carrier registration (10DLC brand and campaign registration, or toll-free verification). Unregistered traffic is filtered or blocked. Start this early, because approval takes days. The registration is per sending organization, so decide whether the Orient registers once for all valleys or each valley registers separately.

## Email

Set `EMAIL_PROVIDER=smtp` and `SMTP_URL`. Any SMTP service works (Amazon SES, Postmark, Mailgun, Brevo and others). Set up SPF, DKIM and DMARC on the sending domain or large mailbox providers will route you to spam. Every email carries an unsubscribe link and one-click unsubscribe headers.

## Consent rules built in

- Nobody is messaged unless marked as having agreed to that channel. Imports and the API default to no consent. Ticking consent is an attestation by the admin and is logged.
- STOP, START and unsubscribe are honored. Consent is rechecked at the moment of sending, not only when a campaign is created.
- An opted-out person is never re-subscribed by import, API or an admin. Only the person can opt back in (reply START). Admins can record an opt-out.
- A phone number that texts STOP is opted out in every valley.

## API

Create a key under Connect. Use `Authorization: Bearer frc_...`. Keys only work for their valley.

```
POST /api/v1/contacts          create or match a contact (fills blank fields only)
GET  /api/v1/contacts          page through contacts (?limit=&after_id=)
GET  /api/v1/lists             POST /api/v1/lists
POST /api/v1/lists/:id/members add by contact_ids or emails
POST /api/v1/campaigns         create (send_now: true to start immediately)
POST /api/v1/campaigns/:id/send
GET  /api/v1/campaigns/:id     status and counts
```

A campaign with `list_id` omitted or null goes to all contacts in the valley. A bad `list_id` is rejected, never widened.

## Known limits

- Phone numbers without a `+` are read as US or Canada.
- Images in emails must already be hosted online. There is no upload yet.
- A person in two valleys is two contact records.
- Failed messages are not retried. If the server dies between handing a message to the provider and recording it, that message can be sent twice.
- Sending speed is `SMS_PER_TICK` and `EMAIL_PER_TICK` messages every `TICK_MS`. Raise them for large lists, and stay within your provider's rate limits.
- Autosave covers campaign drafts only. Other forms (adding a contact, import) save when you submit them.
- No self-service opt-in form, delivery-status webhooks, open or click tracking, or audit log of admin actions yet.
- Uses Node's built-in SQLite, which Node still labels experimental. Fine for this scale. For many concurrent users, move to Postgres.
