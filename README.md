# Bulk Email Sender

One page: import a CSV (e.g. a Zoho Forms export), add people manually, write a subject and message, send to everyone, and watch the results.

## Run it

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run dev                  # http://localhost:3000
```

## Environment variables (`.env.local`)

| Variable | Required | Purpose |
| --- | --- | --- |
| `RESEND_API_KEY` | yes | Your Resend API key. Stays on the server. |
| `EMAIL_FROM` | yes | Sender, e.g. `Name <hello@yourdomain.com>`. The domain must be verified in Resend. |
| `ACCESS_KEY` | yes | Password the page asks for before sending, so strangers can't use your API key. |
| `REPLY_TO` | no | Where replies go. |
| `UNSUBSCRIBE_EMAIL` | no | Shown in the footer and added as a `List-Unsubscribe` header. |
| `FOOTER_ADDRESS` | no | Organisation / postal address line in the footer. |

## CSV format

First row must be headers. Columns are matched loosely: anything containing `email`, `name` or `phone`/`mobile`. Zoho's split `Name (First Name)` / `Name (Last Name)` columns are joined automatically.

## Notes

- Max 500 contacts. Duplicates (by email, case-insensitive) are skipped; invalid emails are flagged and never sent.
- Emails go out in batches of 50 via Resend's batch API; each person gets their own individual email (no one sees other recipients).
- `{{name}}` in the subject or body is replaced per recipient (falls back to "there").
- After a send, failed contacts stay in the table; the button becomes **Retry** and only targets unsent ones.
- Honor unsubscribe requests: remove those people from future CSVs. Contacts are not stored anywhere (no database), they live in the browser until you refresh.
- Deploy on Vercel (or similar) and set the same env vars there.
