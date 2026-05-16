/**
 * Transactional email helper — Resend provider.
 *
 * Uses native fetch (Node 18+). No new npm dependency.
 *
 * If RESEND_API_KEY is missing or a placeholder, email sending is disabled:
 *   - A warning is logged (key name only — never the value).
 *   - All send attempts return { ok: false } instead of throwing.
 *   - The rest of the app continues normally; verification just won't arrive.
 */

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

export interface SendEmailResult {
  ok: boolean;
  /** Safe error description — never contains the API key. */
  error?: string;
}

function isConfigured(): boolean {
  const key = (process.env.RESEND_API_KEY || '').trim();
  return key.length > 10 && key !== 'XXXXXXX' && key !== 'placeholder';
}

export function isEmailConfigured(): boolean {
  return isConfigured();
}

export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  if (!isConfigured()) {
    console.warn(
      '[email] RESEND_API_KEY is not configured — email sending disabled. ' +
      'Set RESEND_API_KEY in .env to enable transactional email.'
    );
    return { ok: false, error: 'Email sending is not configured.' };
  }

  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  const from   = (process.env.EMAIL_FROM || 'RefugeCloud <noreply@refugecloud.com>').trim();

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      // Log the status and message — never log the API key or auth header.
      const msg = String(body?.message || body?.error || `HTTP ${res.status}`);
      console.error(`[email] Resend API error: ${res.status} — ${msg}`);
      return { ok: false, error: msg };
    }

    return { ok: true };
  } catch (err: any) {
    console.error('[email] Send failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// ─── Email templates ───

export function buildPasswordResetEmail(resetUrl: string, ttlHours: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f3f4f6;font-family:sans-serif">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;border:1px solid #e5e7eb">
    <h2 style="margin:0 0 16px;color:#1f2937;font-size:1.25rem">Reset your RefugeCloud password</h2>
    <p style="color:#374151;margin:0 0 24px;line-height:1.6">
      We received a request to reset the password for your account.
      Click the button below to choose a new password.
    </p>
    <p style="margin:0 0 24px">
      <a href="${resetUrl}"
         style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;font-size:15px">
        Reset Password
      </a>
    </p>
    <p style="color:#6b7280;font-size:0.85rem;margin:0 0 16px">
      This link expires in ${ttlHours} hour${ttlHours !== 1 ? 's' : ''} and can only be used once.
      If you did not request a password reset, you can safely ignore this email —
      your password will not be changed.
    </p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
    <p style="color:#9ca3af;font-size:0.78rem;margin:0;word-break:break-all">
      If the button doesn't work, paste this link into your browser:<br>
      <a href="${resetUrl}" style="color:#6366f1">${resetUrl}</a>
    </p>
  </div>
</body>
</html>`;
}

export function buildVerificationEmail(verifyUrl: string, ttlHours: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f3f4f6;font-family:sans-serif">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;border:1px solid #e5e7eb">
    <h2 style="margin:0 0 16px;color:#1f2937;font-size:1.25rem">Verify your RefugeCloud email</h2>
    <p style="color:#374151;margin:0 0 24px;line-height:1.6">
      Thanks for joining! Click the button below to verify your email address and unlock all features.
    </p>
    <p style="margin:0 0 24px">
      <a href="${verifyUrl}"
         style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;font-size:15px">
        Verify Email Address
      </a>
    </p>
    <p style="color:#6b7280;font-size:0.85rem;margin:0 0 16px">
      This link expires in ${ttlHours} hour${ttlHours !== 1 ? 's' : ''}.
      If you didn't create a RefugeCloud account, you can safely ignore this email.
    </p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
    <p style="color:#9ca3af;font-size:0.78rem;margin:0;word-break:break-all">
      If the button doesn't work, paste this link into your browser:<br>
      <a href="${verifyUrl}" style="color:#6366f1">${verifyUrl}</a>
    </p>
  </div>
</body>
</html>`;
}
