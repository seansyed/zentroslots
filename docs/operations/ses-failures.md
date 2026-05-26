# Runbook — AWS SES failures (bounces, suppression, hard errors)

## When to use this

- `/api/health` shows `reminder_delivery: BROKEN: N failed / 0 sent`.
- `/api/health` shows `smtp_transport: false`.
- Customers report not receiving booking confirmations or reminders.
- `communication_logs` shows recent rows with `status='failed'`.

## Triage steps

### 1. Pinpoint the failure category

```sql
SELECT status, failure_reason, COUNT(*), MAX(created_at)
FROM communication_logs
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY 1, 2
ORDER BY 3 DESC;
```

Common reasons:
- `address_rejected` — SES sandbox mode. Sender or recipient not verified.
- `Address blacklisted` / `Permanent failure` — recipient in suppression list.
- `Connection timeout` — SES regional outage or SMTP credentials wrong.
- `Authentication failed` — SMTP user/pass in `.env` is wrong.

### 2. Confirm SES account state

AWS Console → SES → Account dashboard:
- Sending statistics: bounces > 5% or complaints > 0.1% → account
  is at risk of pause.
- Sandbox state: if "Sandbox", you can only send to verified recipients.

### 3. Confirm SMTP transport

```bash
ssh -i ~/.ssh/AATSKeyPair.pem ubuntu@35.83.95.42
cd /var/www/scheduling-saas
npm run email:smoke
```

This calls `lib/email.ts` `verifySmtpTransport()` and sends a probe
message to ADMIN_EMAIL. The output tells you whether the issue is
transport (creds, network) or sender identity.

## Recovery

### Sender / domain not verified (sandbox)

1. AWS SES → Verified Identities → "Verify a new domain" → enter
   `zentromeet.com`.
2. AWS gives you 3 CNAME records to publish at the DNS provider.
3. After verification (usually <5 min), every `*@zentromeet.com`
   sender works automatically.
4. As a quick stopgap (without DNS), verify a single email identity
   `no-reply@zentromeet.com` — AWS sends a confirmation link.

### Account in sandbox (cannot send to arbitrary recipients)

AWS SES → Account dashboard → "Request production access."
- Use case: "Transactional email for our SaaS scheduling product —
  booking confirmations, reminders, password resets to verified end
  users."
- Daily volume: estimate from `communication_logs` 30d.
- Bounce + complaint handling: point at our `email_suppressions` table.
- Approval usually <24h.

### Bounce / complaint spike

```sql
-- Recent additions to suppression list
SELECT email_lower, kind, bounce_subtype, first_seen_at, last_seen_at, event_count
FROM email_suppressions
ORDER BY last_seen_at DESC
LIMIT 20;
```

If a single recipient is bouncing repeatedly:
- It's already in `email_suppressions` (the SES webhook handles
  this automatically).
- `lib/email-suppression.ts` skips before send.
- No operator action needed unless a legitimate address is wrongly
  suppressed → delete the row:
  ```sql
  DELETE FROM email_suppressions WHERE email_lower = 'foo@example.com' AND kind = 'bounce';
  ```

### Wrong SMTP credentials

1. Rotate via AWS SES → SMTP settings → "Create SMTP credentials."
2. Update `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` in `.env`.
3. `pm2 restart scheduling-saas --update-env`.
4. Verify: `npm run email:smoke`.

### Hot-fallback to Resend / Postmark

`lib/email.ts` accepts `EMAIL_PROVIDER=resend` or `postmark` as an
override. If SES is broken and we need to ship today:

1. Sign up for the fallback provider (≤ 15 min).
2. Add `RESEND_API_KEY` (or `POSTMARK_SERVER_TOKEN`) to `.env`.
3. Set `EMAIL_PROVIDER=resend` in `.env`.
4. `pm2 restart scheduling-saas --update-env`.
5. The existing `sendEmail()` calls route through the new transport.

## Verification

```bash
# Trigger a real reminder send
curl -X POST -s -o /dev/null -w "%{http_code}\n" https://app.zentromeet.com/api/internal/test-reminder \
  -H "Authorization: Bearer $INTERNAL_TOKEN"

# Or via cron worker (replays the next scheduled reminder)
cd /var/www/scheduling-saas && npm run reminders:send

# Confirm communication_logs
psql "$DATABASE_URL" -c "SELECT created_at, event_type, status, failure_reason FROM communication_logs ORDER BY 1 DESC LIMIT 10;"

# /api/health should flip green
curl -s https://app.zentromeet.com/api/health | jq '.checks.reminder_delivery'
```

## After-action

- Affected customers (no_show risk): backfill the missed reminder
  by triggering it manually. Don't double-send if the booking is
  already past — the customer no-showed already.
- Document the resolution in `docs/operations/incidents/`.
- Update the audit log:
  ```sql
  INSERT INTO audit_logs (action, actor_label, metadata) VALUES
   ('ops.incident_resolved', 'operator:YOUR_NAME',
    '{"incident": "ses_failure", "root_cause": "...", "duration_min": N}');
  ```
