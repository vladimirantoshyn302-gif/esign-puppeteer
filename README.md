# eSign Bot — Railway + N8N

Two-step Puppeteer bot for automating eSign AnyWhere document signing.

## Deploy to Railway

1. Push this folder to GitHub
2. Railway → **New Project** → **Deploy from GitHub repo**
3. Railway auto-detects the Dockerfile — no extra config needed
4. After deploy, copy your Railway URL (e.g. `https://esign-bot.railway.app`)

---

## N8N Workflow

### Node 1 — HTTP Request: Start signing

```
Method: POST
URL:    https://your-app.railway.app/sign
Body:   { "url": "{{ $json.signing_url }}" }
```

Response saved to session:
```json
{ "sessionId": "session_1709123456789", "status": "otp_sent" }
```

---

### Node 2 — Wait / Get OTP
_(your existing SMS/email OTP retrieval logic)_

Save the OTP into a variable, e.g. `{{ $json.otp_code }}`

---

### Node 3 — HTTP Request: Submit OTP

```
Method: POST
URL:    https://your-app.railway.app/otp
Body:   {
          "sessionId": "{{ $('Node 1').json.sessionId }}",
          "otp": "{{ $json.otp_code }}"
        }
```

Response:
```json
{
  "success": true,
  "status": "signed",
  "finalUrl": "https://...",
  "screenshot": "data:image/png;base64,..."
}
```

---

## API Reference

| Endpoint | Method | Body | Description |
|----------|--------|------|-------------|
| `/sign`  | POST   | `{ url }` | Step 1: open page, click buttons, trigger OTP SMS |
| `/otp`   | POST   | `{ sessionId, otp }` | Step 2: enter OTP, sign document |
| `/health`| GET    | — | Check active sessions |

---

## Notes

- Sessions expire after **10 minutes** — call `/sign` again if expired
- `/otp` keeps the session alive on error so N8N can retry
- `screenshot` in the response shows the final page state for verification
