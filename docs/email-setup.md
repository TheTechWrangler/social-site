# Email Setup — RefugeCloud (Resend)

This guide covers everything needed to enable transactional email (email verification and password reset) via [Resend](https://resend.com). No real API keys are stored here.

---

## How email verification works

1. User registers with username/password → account created with `is_verified = 0`.
2. Server generates a 64-char random token, stores only the SHA-256 hash in `email_verification_tokens`.
3. A verification email is sent to the user's address with a link to `https://refugecloud.com/verify-email?token=<raw-token>`.
4. User clicks the link → `VerifyEmailPage` calls `GET /api/auth/verify-email?token=...`.
5. Server hashes the token, finds the record, marks it used, sets `is_verified = 1`.
6. User now has full write access (posts, comments, likes, etc.).

**Unverified users can:**
- Log in and browse the site
- Read all public content

**Unverified users cannot:**
- Create posts
- Comment, like, repost
- Join or create groups
- Post LFG entries
- Block RSS sources

**OAuth users (Google, Steam)** are auto-verified at registration — their identity is pre-verified by the provider.

---

## Resend account setup

1. Go to [https://resend.com](https://resend.com) and create an account.
2. Navigate to **Domains** and click **Add Domain**.
3. Enter `refugecloud.com`.
4. Resend will show DNS records to add (see below).
5. Once domain is verified, go to **API Keys** → **Create API Key**.
   - Name: `refugecloud-prod` (or any label)
   - Permission: **Sending access** (not full access — principle of least privilege)
6. Copy the key (shown once). Add it to production `.env` as `RESEND_API_KEY`.

---

## Domain verification — DNS records

Resend will provide exact values. The record types you'll add to Cloudflare DNS:

| Type | Name | Purpose |
|---|---|---|
| TXT | `@` or `refugecloud.com` | SPF record — authorizes Resend to send on your behalf |
| CNAME | `resend._domainkey` | DKIM — cryptographic email signature |
| TXT | `_dmarc` | DMARC policy — instructs receivers on handling failures |

### Cloudflare DNS notes

- In Cloudflare, set CNAME records for DKIM to **DNS only** (grey cloud, not proxied). DKIM requires the DNS record to be resolved directly.
- SPF TXT records should be at the root domain (`@`). If you already have an SPF record, merge it (don't create a second TXT — that breaks SPF):
  ```
  v=spf1 include:amazonses.com include:_spf.resend.com ~all
  # adjust existing providers; add "include:_spf.resend.com"
  ```
- DMARC example (start permissive, tighten after monitoring):
  ```
  v=DMARC1; p=none; rua=mailto:admin@refugecloud.com
  ```

---

## Environment variables

Add to production `.env`:

```ini
EMAIL_PROVIDER=resend
EMAIL_FROM=RefugeCloud <noreply@refugecloud.com>
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
EMAIL_VERIFICATION_TTL_HOURS=24
```

**Notes:**
- `EMAIL_FROM` must use a verified domain. Resend will reject sends from unverified domains.
- `RESEND_API_KEY` starts with `re_`. Never commit it.
- `EMAIL_VERIFICATION_TTL_HOURS` defaults to 24 if not set.

After editing `.env`, restart the service:

```bash
sudo systemctl restart refugecloud
sudo systemctl status refugecloud --no-pager
npm run smoke:live
```

---

## Verifying configuration at startup

Check the service logs after restart:

```bash
sudo journalctl -u refugecloud -n 30 --no-pager | grep '\[email\]'
# Configured:
# [email] Resend: configured
# Not configured:
# [email] RESEND_API_KEY not set — email verification disabled. ...
```

---

## Manual test checklist

After adding real credentials and restarting:

### Email verification

- [ ] Register a new local account at `https://refugecloud.com/register`.
- [ ] RegisterPage shows "Check your email" state (not the main feed).
- [ ] Check the registered email inbox — verification email arrives within 1–2 minutes.
- [ ] Email subject: "Verify your RefugeCloud email address"
- [ ] Email sender: `RefugeCloud <noreply@refugecloud.com>`
- [ ] Click the "Verify Email Address" button in the email.
- [ ] Browser navigates to `https://refugecloud.com/verify-email?token=...`
- [ ] Page shows "Email verified!" success message.
- [ ] Navigate to home — user can now post/comment/like.
- [ ] In admin → User Detail: user's `is_verified` field is 1.

**Resend verification test:**
- [ ] Log in as an unverified user → "Email not verified" page appears.
- [ ] Click "Resend verification email" → "Verification email sent!"
- [ ] Check inbox — new email arrives.
- [ ] Old verification link (if used before) shows "Invalid or expired" — only the latest link works.

### Password reset (self-serve)

- [ ] Go to `https://refugecloud.com/login`.
- [ ] Click "Forgot your password?" — an email/username input appears.
- [ ] Enter a **registered** email or username. Click "Send reset email".
- [ ] See generic message: "If an account matches, a password reset email has been sent."
- [ ] Enter a **non-existent** email. Click "Send reset email".
- [ ] See the **same** generic message (anti-enumeration).
- [ ] Check inbox — reset email arrives with subject "Reset your RefugeCloud password".
- [ ] Email contains a "Reset Password" button and an expiry note (1 hour).
- [ ] Click the reset link → `https://refugecloud.com/reset-password?token=...`
- [ ] Page shows "Setting new password for @username".
- [ ] Enter new password (8+ chars). Submit.
- [ ] See "Password updated successfully." and redirect to login after 3 seconds.
- [ ] Log in with the **new** password — succeeds.
- [ ] Log in with the **old** password — fails.
- [ ] Any existing auth session (old cookie) is rejected — `password_changed_at` revocation invalidates old JWTs.
- [ ] Click the reset link a second time → "This reset link is invalid or has expired." (one-time use).
- [ ] Check Resend dashboard → Emails — sent event visible with delivery status.

---

## Troubleshooting

### Email sending disabled at startup

```
[email] RESEND_API_KEY not set — email verification disabled.
```

- `RESEND_API_KEY` is missing, blank, or still set to `XXXXXXX`.
- Set it in `.env` and restart.

### Resend API error: 403 / domain not verified

- The `EMAIL_FROM` domain (`refugecloud.com`) hasn't been verified in your Resend dashboard.
- Complete the DNS record setup in Resend → Domains before sending.

### Resend API error: 422 / invalid from address

- `EMAIL_FROM` is missing or malformed.
- Required format: `Display Name <email@domain.com>` or just `email@domain.com`.
- The domain must be verified in Resend.

### Verification link shows "Invalid or expired"

- The token has expired (default: 24 hours after generation).
- The token was already used (one-time use).
- The user already requested a new token (previous tokens are invalidated when a new one is generated).
- **Fix**: log in and click "Resend verification email".

### Password reset link shows "Invalid or has expired"

- The self-serve token expired (default: 1 hour after generation).
- Admin-generated tokens expire after 2 hours.
- The link was already used (one-time use).
- A new reset was requested — only the most recent link is valid.
- **Fix**: go to `/login` → "Forgot your password?" → request a new link.

### Generic response on forgot-password (anti-enumeration by design)

The `POST /api/auth/forgot-password` endpoint always returns:
```json
{ "ok": true, "message": "If an account matches, a password reset email has been sent." }
```
This is intentional — it does not reveal whether an account exists, is banned, or is OAuth-only. Check Resend dashboard → Emails to confirm a send was actually attempted.

### Password reset for OAuth-only accounts

Users who registered exclusively via Google or Steam have no local RefugeCloud password — there is nothing to reset here. The server silently returns the generic response without sending an email (no account existence is revealed).

**What OAuth-only users should do:**
- **Google accounts** — reset the password at [myaccount.google.com](https://myaccount.google.com).
- **Steam accounts** — reset the Steam account password at [help.steampowered.com](https://help.steampowered.com).
- RefugeCloud login will continue to work once the provider password is updated, because the login does not use a local password.

**If an OAuth-only user wants a local RefugeCloud password as well:**
An admin can use "Generate Password Reset Link" in the admin panel. This creates a time-limited link that lets the user set a local password, enabling both OAuth and local login. This is opt-in and not automatic.

The login page already shows this guidance above the forgot-password input field.

### Rate limit hit on forgot-password

```
{ "error": "Too many password reset requests. Please wait before trying again." }
```
The forgot-password endpoint is limited to 5 requests per IP per 15 minutes (configurable via `RATE_LIMIT_FORGOT_PASSWORD_MAX`). This is separate from the general auth limiter.

### Verification email not arriving

1. Check spam/junk folder.
2. Check Resend dashboard → **Emails** — did the send register? What status?
3. If status is "Bounced": the email address doesn't exist or the mailbox is full.
4. If status is "Delivered" but not in inbox: check spam. SPF/DKIM/DMARC records help deliverability.
5. Check service logs for `[email] Resend API error:` entries.

### Cookie not set / stays unverified after clicking link

- The verification API call succeeded (`{ ok: true }`) but the JWT cookie still has `is_verified: 0`.
- **This is expected** — the JWT is issued at login/register and is not re-issued on verification.
- The user needs to **log out and log back in** for the new `is_verified: 1` value to appear in their cookie/session.
- **Alternative**: on the verify success page, call `/api/auth/me` to refresh user state without a full re-login (not currently implemented — requires a page reload after verify).

### Clicking verify link while not logged in

- This is fine. The verify endpoint (`GET /api/auth/verify-email?token=...`) does not require auth.
- After verification, the user clicks "Go to home" and can log in with full access.

### WEB_BASE_URL not set — link points to localhost

- The verification link is built from `WEB_BASE_URL`. If not set, it falls back to `http://localhost:5174`.
- In production `.env`, ensure: `WEB_BASE_URL=https://refugecloud.com`

---

## API reference

| Endpoint | Method | Auth | Rate limit | Description |
|---|---|---|---|---|
| `/api/auth/verify-email?token=...` | GET | None | 10/15min | Validate and consume email verification token |
| `/api/auth/resend-verification` | POST | Required | 10/15min | Generate new verification token and resend email |
| `/api/auth/forgot-password` | POST | None | **5/15min** | Self-serve password reset — send reset email |
| `/api/auth/reset-password` | GET | None | 10/15min | Validate a password reset token |
| `/api/auth/reset-password` | POST | None | 10/15min | Apply new password using a reset token |

---

## Token lifecycle

### Email verification tokens

- **Generated**: at registration and each resend request.
- **Stored**: only the SHA-256 hash (raw token is never stored or logged).
- **Invalidated**: all previous unused tokens for the user are marked `used_at = now()` when a new one is generated.
- **Expires**: after `EMAIL_VERIFICATION_TTL_HOURS` hours (default 24), stored and compared as explicit UTC. Legacy SQLite UTC timestamps remain accepted.
- **Cleaned up**: `runRetentionCleanup()` deletes expired tokens after `EMAIL_VERIFICATION_TOKENS_RETENTION_DAYS` days (default 7).

### Password reset tokens

- **Generated**: on `POST /api/auth/forgot-password` (self-serve, 1-hour TTL) or admin panel (2-hour TTL).
- **Stored**: only the SHA-256 hash. Raw token goes into the email link only, never stored, never logged.
- **Invalidated**: all previous unused tokens for the user are marked used when a new one is generated.
- **Expires**: after `PASSWORD_RESET_TTL_HOURS` hours (default 1 for self-serve; admin tokens always 2 hours), stored and compared as explicit UTC. Legacy SQLite UTC timestamps remain accepted without extending their lifetime.
- **Revocation**: applying a reset also sets `password_changed_at = datetime('now')` on the user, which invalidates all existing JWTs (the `iat < password_changed_at` check in `requireAuth`).
- **Cleaned up**: `runRetentionCleanup()` deletes expired `password_reset_tokens` rows after `PASSWORD_RESET_TOKENS_RETENTION_DAYS` days (default 30).
