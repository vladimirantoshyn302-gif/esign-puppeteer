const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// In-memory session store: sessionId -> { browser, page, createdAt }
const sessions = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Open URL and click through to OTP send
// N8N calls this first with the signing URL
//
// POST /sign
// Body: { "url": "https://saas.esignanywhere.net/..." }
// Returns: { "sessionId": "...", "status": "otp_sent" }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/sign', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const sessionId = `session_${Date.now()}`;
  console.log(`[${sessionId}] STEP 1 — Opening URL: ${url}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // 1. Load the signing page
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    console.log(`[${sessionId}] Page loaded`);

    // 2. Click "Click să semnezi"
    await waitAndClickByText(page, ['Click să semnezi', 'Semnează'], 15000);
    console.log(`[${sessionId}] Clicked: Click să semnezi`);
    await page.waitForTimeout(1500);

    // 3. Click "URMĂTORUL" (signature method dialog)
    await waitAndClickByText(page, ['URMĂTORUL', 'Următorul', 'URMATORUL'], 10000);
    console.log(`[${sessionId}] Clicked: URMĂTORUL`);
    await page.waitForTimeout(1500);

    // 4. Click "TRIMITE" (send OTP via SMS)
    await waitAndClickByText(page, ['TRIMITE', 'Trimite'], 10000);
    console.log(`[${sessionId}] Clicked: TRIMITE — OTP sent to phone`);
    await page.waitForTimeout(1000);

    // Save session — browser stays open waiting for OTP
    sessions.set(sessionId, { browser, page, createdAt: Date.now() });

    res.json({
      success: true,
      sessionId,
      status: 'otp_sent',
      message: 'OTP sent. Now call POST /otp with sessionId and otp code.',
    });

  } catch (err) {
    console.error(`[${sessionId}] STEP 1 ERROR:`, err.message);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message, step: 'sign' });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: Receive OTP from N8N and complete signing
// N8N calls this after receiving the OTP code
//
// POST /otp
// Body: { "sessionId": "session_...", "otp": "123456" }
// Returns: { "success": true, "finalUrl": "...", "screenshot": "base64..." }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/otp', async (req, res) => {
  const { sessionId, otp } = req.body;

  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  if (!otp)       return res.status(400).json({ error: 'otp is required' });

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({
      error: 'Session not found or expired',
      hint: 'Sessions expire after 10 minutes. Call /sign again.',
    });
  }

  console.log(`[${sessionId}] STEP 2 — Submitting OTP: ${otp}`);
  const { browser, page } = session;

  try {
    // 5. Wait for OTP input field to appear
    await page.waitForSelector('input', { timeout: 15000 });
    await page.waitForTimeout(500);

    // 6. Find visible OTP input and type the code
    const inputs = await page.$$('input');
    let otpEntered = false;

    for (const input of inputs) {
      const isVisible = await input.isIntersectingViewport().catch(() => false);
      if (isVisible) {
        await input.click({ clickCount: 3 }); // select all existing text
        await input.type(String(otp));
        otpEntered = true;
        console.log(`[${sessionId}] OTP entered`);
        break;
      }
    }

    if (!otpEntered) throw new Error('Could not find OTP input field on page');

    await page.waitForTimeout(500);

    // 7. Click "SEMNARE PACHET" to finalize
    await waitAndClickByText(page, ['SEMNARE PACHET', 'Semnare pachet'], 10000);
    console.log(`[${sessionId}] Clicked: SEMNARE PACHET`);

    // 8. Wait for completion
    await page.waitForTimeout(4000);

    const finalUrl = page.url();
    const screenshot = await page.screenshot({ encoding: 'base64' });

    console.log(`[${sessionId}] DONE — Final URL: ${finalUrl}`);

    // Cleanup session
    sessions.delete(sessionId);
    await browser.close();

    res.json({
      success: true,
      status: 'signed',
      message: 'Document signed successfully',
      sessionId,
      finalUrl,
      screenshot: `data:image/png;base64,${screenshot}`,
    });

  } catch (err) {
    console.error(`[${sessionId}] STEP 2 ERROR:`, err.message);
    // Keep session alive so N8N can retry
    res.status(500).json({ error: err.message, step: 'otp', sessionId });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// Health check
// GET /health
// ─────────────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const sessionList = [...sessions.entries()].map(([id, s]) => ({
    id,
    ageSeconds: Math.round((Date.now() - s.createdAt) / 1000),
  }));
  res.json({ status: 'ok', activeSessions: sessions.size, sessions: sessionList });
});


// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Poll for element by text and click it
// ─────────────────────────────────────────────────────────────────────────────
async function waitAndClickByText(page, texts, timeout = 10000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const text of texts) {
      try {
        const elements = await page.$x(`//*[contains(text(), '${text}')]`);
        for (const el of elements) {
          const isVisible = await el.isIntersectingViewport().catch(() => false);
          if (isVisible) {
            await el.click();
            return true;
          }
        }
      } catch (_) {}
    }
    await page.waitForTimeout(500);
  }

  throw new Error(`Timeout: button not found — tried: ${texts.join(' / ')}`);
}


// ─────────────────────────────────────────────────────────────────────────────
// Auto-cleanup stale sessions (expire after 10 min)
// ─────────────────────────────────────────────────────────────────────────────
setInterval(async () => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.createdAt > 10 * 60 * 1000) {
      console.log(`[cleanup] Closing stale session: ${id}`);
      await session.browser.close().catch(() => {});
      sessions.delete(id);
    }
  }
}, 60 * 1000);


app.listen(PORT, () => {
  console.log(`eSign bot running on port ${PORT}`);
  console.log(`  POST /sign   — Step 1: open URL, click buttons, send OTP`);
  console.log(`  POST /otp    — Step 2: enter OTP, finalize signing`);
  console.log(`  GET  /health — status`);
});
