# OAuth Setup — RefugeCloud

This guide covers everything needed to enable Google and Steam login in production. No real secrets are stored here — fill them in the server's `.env` file.

---

## Exact callback / return URLs

These are the values the server actually uses. Use them verbatim in each provider's dashboard.

### Google OAuth 2.0

| Field | Value |
|---|---|
| Authorized JavaScript origin | `https://refugecloud.com` |
| Authorized redirect URI | `https://refugecloud.com/api/auth/google/callback` |

### Steam OpenID

| Field | Value |
|---|---|
| Domain (for API key registration) | `refugecloud.com` |
| OpenID realm | `https://refugecloud.com/` *(trailing slash required)* |
| Return URL (callback route) | `https://refugecloud.com/api/auth/steam/callback` |

---

## Environment variables

Add these to the production `.env` file (never commit it). See `.env.example` for the full template.

```ini
# ─── Google OAuth 2.0 ───
GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-<your-secret>
GOOGLE_CALLBACK_URL=https://refugecloud.com/api/auth/google/callback

# ─── Steam OpenID ───
STEAM_API_KEY=<your-32-char-steam-api-key>
STEAM_RETURN_URL=https://refugecloud.com/api/auth/steam/callback
STEAM_REALM=https://refugecloud.com/
```

After editing `.env`, restart the service and verify:

```bash
sudo systemctl restart refugecloud
sudo systemctl status refugecloud --no-pager
npm run smoke:live
```

---

## Google Cloud Console setup

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. Create a project if you don't have one.
3. Click **Create Credentials → OAuth client ID**.
4. Application type: **Web application**.
5. Name: `RefugeCloud` (or any label).
6. Under **Authorized JavaScript origins**, add:
   ```
   https://refugecloud.com
   ```
7. Under **Authorized redirect URIs**, add:
   ```
   https://refugecloud.com/api/auth/google/callback
   ```
8. Click **Create**. Copy the **Client ID** and **Client Secret**.
9. Enable the **Google People API** (or **Google+ API** if not deprecated) for the project so profile data is accessible.
10. If your app is in "Testing" mode in the OAuth consent screen, add your users to the test users list. Switch to "Production" when ready for all users.

Add to production `.env`:
```ini
GOOGLE_CLIENT_ID=<client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-<secret>
GOOGLE_CALLBACK_URL=https://refugecloud.com/api/auth/google/callback
```

---

## Steam API key and OpenID setup

Steam login uses OpenID 2.0 — no OAuth app registration needed. You only need an API key to fetch player profile data (display name, avatar).

1. Go to [https://steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey).
2. Log in with your Steam account.
3. Enter domain: `refugecloud.com`.
4. Accept the Steam Web API Terms of Use.
5. Copy the **API key** (32 hex characters).

Add to production `.env`:
```ini
STEAM_API_KEY=<your-32-char-api-key>
STEAM_RETURN_URL=https://refugecloud.com/api/auth/steam/callback
STEAM_REALM=https://refugecloud.com/
```

> **Note:** `STEAM_REALM` must end with a trailing slash. The realm is the OpenID trust root — Steam verifies the return URL is under this prefix.

---

## How the auth handoff works (no token in URL)

1. User clicks "Continue with Google" → browser navigates to `GET /api/auth/google`.
2. Server redirects to Google's consent page.
3. Google redirects back to `GET /api/auth/google/callback`.
4. Server validates the OAuth code, finds/creates the user, generates a JWT.
5. JWT is stored in the **server-side session** — never placed in the redirect URL.
6. Browser is redirected to `https://refugecloud.com/oauth/callback` (no token in URL).
7. The React `OAuthCallback` page calls `GET /api/auth/oauth-token` with `credentials: 'include'`.
8. Server reads the token from session (one-time use), sets the `refugecloud_auth` **HttpOnly cookie**, deletes the session data, returns `{ ok: true, user }`.
9. Frontend receives the user object, updates app state. Token is never visible to JavaScript.

Cookie properties: `httpOnly`, `secure` (production only), `sameSite=lax`, `path=/`, 7-day expiry.

---

## Verifying configuration

### Check provider status (public endpoint — no auth needed)

```bash
curl -s http://127.0.0.1:3003/api/auth/providers | jq .
# Expected when both configured:
# { "google": true, "steam": true }
# Expected when neither configured:
# { "google": false, "steam": false }
```

### Check admin system health (requires admin session)

`GET /api/admin/system-health` returns:
```json
{
  "googleOAuth": "Configured",
  "googleCallbackUrl": "https://refugecloud.com/api/auth/google/callback",
  "steamOAuth": "Configured",
  "steamReturnUrl": "https://refugecloud.com/api/auth/steam/callback",
  "steamRealm": "https://refugecloud.com/"
}
```

### Check startup logs

```bash
sudo journalctl -u refugecloud -n 30 --no-pager | grep '\[auth\]'
# Configured:
# [auth] Google OAuth: configured
# [auth] Steam OpenID: configured
# Not configured:
# [auth] Google OAuth: not configured (missing: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
# [auth] Steam OpenID: not configured (missing: STEAM_API_KEY, STEAM_RETURN_URL)
```

### Run smoke test

```bash
npm run smoke:live
```

The smoke test checks `GET /api/auth/providers` returns 200 with `google` and `steam` keys. This passes regardless of whether providers are configured — it just confirms the endpoint is reachable.

---

## Manual browser test checklist

After adding real credentials and restarting the service:

### Google
- [ ] Visit `https://refugecloud.com/login` — Google button is visible (not the "not configured" message).
- [ ] Click "Continue with Google" — browser redirects to `accounts.google.com`.
- [ ] Complete Google consent.
- [ ] Redirected back to `https://refugecloud.com/oauth/callback`, then to `/`.
- [ ] You are logged in (your username appears in the nav).
- [ ] No token visible in the URL at any point.
- [ ] In browser DevTools → Application → Cookies → `refugecloud.com`: `refugecloud_auth` cookie is present, marked `HttpOnly`.
- [ ] In DevTools → Application → Local Storage: no token stored.

### Steam
- [ ] Visit `https://refugecloud.com/login` — Steam button is visible.
- [ ] Click "Continue with Steam" — browser redirects to `steamcommunity.com/openid/login`.
- [ ] Complete Steam login.
- [ ] Redirected back to `https://refugecloud.com/oauth/callback`, then to `/`.
- [ ] You are logged in with your Steam display name / username.
- [ ] No token in URL. `refugecloud_auth` HttpOnly cookie set.

### Account linking (Google only)
- [ ] If you already have an account with the same email, Google login links to that existing account rather than creating a new one.

---

## Troubleshooting

### Google button not showing

The login page fetches `/api/auth/providers`. If `google: false`:
- `GOOGLE_CLIENT_ID` is missing, blank, or set to `placeholder` in `.env`.
- `GOOGLE_CLIENT_SECRET` is missing or too short.
- Restart the service after editing `.env`.

Check: `sudo journalctl -u refugecloud -n 20 --no-pager | grep auth`

### Steam button not showing

If `steam: false`:
- `STEAM_API_KEY` is missing, blank, or set to `placeholder`.
- `STEAM_RETURN_URL` is missing or doesn't start with `http`.
- Both must be set for Steam to show as configured.

### Callback URL mismatch (Google)

> Error: `redirect_uri_mismatch`

The `GOOGLE_CALLBACK_URL` in `.env` does not exactly match what's registered in Google Cloud Console. Common causes:
- Trailing slash difference (`/callback` vs `/callback/`)
- HTTP vs HTTPS
- Wrong domain or port

Fix: copy the URL exactly from `.env.example`'s production comment into the Google Console.

### Callback URL mismatch (Steam)

> Error: `Invalid openid.return_to`

- `STEAM_RETURN_URL` must exactly match what Steam received during the initial redirect.
- `STEAM_REALM` must be a prefix of `STEAM_RETURN_URL`.
- Both must use `https://` in production.

Fix: ensure `STEAM_REALM=https://refugecloud.com/` (trailing slash) and `STEAM_RETURN_URL=https://refugecloud.com/api/auth/steam/callback`.

### Cookie not set after OAuth

> `/api/auth/me` returns 401 after OAuth callback

1. Open DevTools → Network → filter for `oauth-token`.
2. Check the response: should be 200 with `{ ok: true, user: {...} }`.
3. Check Set-Cookie header on that response: should set `refugecloud_auth`.
4. If response is 401: "No OAuth session found" — the session was lost between the OAuth redirect and the token claim. This happens if:
   - `SESSION_SECRET` changed between the OAuth start and the callback (restart invalidates all sessions).
   - The browser is blocking the session cookie (check DevTools → Cookies for the connect.sid session cookie).
   - The `sameSite: lax` session cookie is being blocked — ensure you're on HTTPS in production.

### `/api/auth/me` returns 401 before login

This is **expected and normal**. The app calls `/api/auth/me` on page load to restore session. If no cookie is present, it returns 401. The frontend handles this silently and shows the logged-out state.

### Cloudflare / reverse proxy HTTPS notes

If the service is behind Nginx Proxy Manager or Cloudflare:
- Set `TRUST_PROXY=1` in `.env` so Express trusts the `X-Forwarded-Proto` header.
- The `secure: true` cookie flag requires HTTPS. Without `TRUST_PROXY=1`, Express sees the connection as HTTP (from the proxy), and may not set the `secure` cookie.
- In Google Cloud Console, always register the public `https://` URL, not the internal `http://127.0.0.1:3003` address.
- In Steam, register the public `https://` return URL. Steam will refuse to redirect to HTTP in production.

### OAuth "failed" error on login page

The URL parameter `?error=google_failed` or `?error=steam_failed` means the provider's Passport strategy called `done(false)` or threw — typically a banned account, DB error, or profile fetch failure. Check `sudo journalctl -u refugecloud -n 50 --no-pager` for `[server] Unhandled error:` or `[auth]` lines around the time of the failure.
