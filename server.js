const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'x-session-id'] }));
app.use(express.json({ limit: '10mb' }));

const sessions = new Map();
const SESSION_TTL = 15 * 60 * 1000;

const BLOCKED_DOMAINS = [
  'doubleclick.net','googlesyndication.com','googletagmanager.com','googletagservices.com',
  'adservice.google.com','amazon-adsystem.com','ads.yahoo.com',
  'connect.facebook.net','scorecardresearch.com','quantserve.com','chartbeat.com',
  'hotjar.com','fullstory.com','mouseflow.com','crazyegg.com','newrelic.com',
  'nr-data.net','optimizely.com','segment.com','mixpanel.com','amplitude.com',
  'analytics.tiktok.com','bat.bing.com','static.ads-twitter.com','ads.pinterest.com',
];

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas','--no-first-run','--no-zygote',
      '--disable-gpu','--disable-background-networking','--disable-extensions',
      '--disable-hang-monitor','--disable-prompt-on-repost','--disable-sync',
      '--metrics-recording-only','--mute-audio','--no-default-browser-check',
      '--safebrowsing-disable-auto-update','--password-store=basic','--use-mock-keychain',
    ],
    defaultViewport: { width: 1440, height: 900 }
  });
}

async function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    const browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Site': 'none',
      'Upgrade-Insecure-Requests': '1',
    });
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url(), type = req.resourceType();
      if (BLOCKED_DOMAINS.some(d => url.includes(d))) return req.abort();
      if (type === 'media') return req.abort();
      req.continue();
    });
    sessions.set(sessionId, { browser, page, createdAt: Date.now(), history: [], historyPos: -1 });
  }
  const session = sessions.get(sessionId);
  session.lastUsed = Date.now();
  return session;
}

setInterval(async () => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - (session.lastUsed || session.createdAt) > SESSION_TTL) {
      try { await session.browser.close(); } catch (_) {}
      sessions.delete(id);
    }
  }
}, 60 * 1000);

// Full quality for navigations, fast lower-quality for interactive (scroll/type/click)
const shot = (page, q = 82) => page.screenshot({ encoding: 'base64', type: 'jpeg', quality: q });
const fastShot = (page) => page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 70 });

async function smartWait(page, ms = 800) {
  await Promise.race([
    page.waitForNetworkIdle({ idleTime: 250, timeout: ms }).catch(() => {}),
    new Promise(r => setTimeout(r, ms))
  ]);
}

// ── Navigate ──────────────────────────────────────────────────────────────────
app.post('/api/navigate', async (req, res) => {
  const { url, sessionId } = req.body;
  if (!url || !sessionId) return res.status(400).json({ error: 'url and sessionId required' });
  try {
    let nav = url.trim();
    if (!/^https?:\/\//i.test(nav)) {
      nav = /^[\w.-]+\.\w{2,}/.test(nav) && !nav.includes(' ')
        ? 'https://' + nav
        : 'https://www.google.com/search?q=' + encodeURIComponent(nav);
    }
    const session = await getSession(sessionId);
    const { page } = session;
    await page.goto(nav, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await smartWait(page, 1000);
    const [screenshot, title] = await Promise.all([shot(page, 82), page.title()]);
    const currentUrl = page.url();
    session.history = session.history.slice(0, session.historyPos + 1);
    session.history.push(currentUrl);
    session.historyPos = session.history.length - 1;
    res.json({ screenshot, title, url: currentUrl, canGoBack: session.historyPos > 0, canGoForward: session.historyPos < session.history.length - 1 });
  } catch (err) {
    console.error('navigate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Click ─────────────────────────────────────────────────────────────────────
app.post('/api/click', async (req, res) => {
  const { x, y, sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  try {
    const session = await getSession(sessionId);
    const { page } = session;
    const urlBefore = page.url();
    await page.mouse.click(x, y);
    // Fast race: 150ms to detect navigation start, else snap fast shot
    const navP = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => null);
    const nav = await Promise.race([navP, new Promise(r => setTimeout(r, 150, 'timeout'))]);
    let navigated = false;
    if (nav !== null && nav !== 'timeout') {
      await smartWait(page, 500);
      navigated = true;
    } else {
      // Brief settle for DOM mutations (dropdowns, modals, input focus)
      await new Promise(r => setTimeout(r, 50));
    }
    const currentUrl = page.url();
    const urlChanged = currentUrl !== urlBefore;
    const [screenshot, title] = await Promise.all([urlChanged ? shot(page, 82) : fastShot(page), page.title()]);
    if (urlChanged) {
      session.history = session.history.slice(0, session.historyPos + 1);
      session.history.push(currentUrl);
      session.historyPos = session.history.length - 1;
    }
    res.json({ screenshot, title, url: currentUrl, canGoBack: session.historyPos > 0, canGoForward: session.historyPos < session.history.length - 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Type (single key/char — backward compat) ──────────────────────────────────
app.post('/api/type', async (req, res) => {
  const { text, sessionId, key } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  try {
    const session = await getSession(sessionId);
    const { page } = session;
    const urlBefore = page.url();
    if (key) await page.keyboard.press(key);
    else if (text) await page.keyboard.type(text, { delay: 0 });
    let navigated = false;
    if (key === 'Enter') {
      const navP = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => null);
      const nav = await Promise.race([navP, new Promise(r => setTimeout(r, 400))]);
      if (nav !== null) { await smartWait(page, 600); navigated = true; }
    }
    if (!navigated) await new Promise(r => setTimeout(r, 40));
    const currentUrl = page.url();
    const urlChanged = currentUrl !== urlBefore;
    const [screenshot, title] = await Promise.all([urlChanged ? shot(page, 82) : fastShot(page), page.title()]);
    if (urlChanged) {
      session.history = session.history.slice(0, session.historyPos + 1);
      session.history.push(currentUrl);
      session.historyPos = session.history.length - 1;
    }
    res.json({ screenshot, title, url: currentUrl, canGoBack: session.historyPos > 0, canGoForward: session.historyPos < session.history.length - 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Type Batch — FAST PATH: entire accumulated string + optional special keys ──
// Client accumulates all printable chars + special keys, sends in ONE request.
// Far fewer round trips = drastically less typing lag.
app.post('/api/type-batch', async (req, res) => {
  const { text, keys, sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  try {
    const session = await getSession(sessionId);
    const { page } = session;
    const urlBefore = page.url();

    if (text && text.length > 0) {
      await page.keyboard.type(text, { delay: 0 });
    }

    let navigated = false;
    if (keys && keys.length > 0) {
      for (const k of keys) {
        await page.keyboard.press(k);
        if (k === 'Enter') {
          const navP = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => null);
          const nav = await Promise.race([navP, new Promise(r => setTimeout(r, 400))]);
          if (nav !== null) { await smartWait(page, 600); navigated = true; break; }
        }
      }
    }

    if (!navigated) await new Promise(r => setTimeout(r, 40));

    const currentUrl = page.url();
    const urlChanged = currentUrl !== urlBefore;
    const [screenshot, title] = await Promise.all([urlChanged ? shot(page, 82) : fastShot(page), page.title()]);

    if (urlChanged) {
      session.history = session.history.slice(0, session.historyPos + 1);
      session.history.push(currentUrl);
      session.historyPos = session.history.length - 1;
    }

    res.json({ screenshot, title, url: currentUrl, canGoBack: session.historyPos > 0, canGoForward: session.historyPos < session.history.length - 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Scroll ────────────────────────────────────────────────────────────────────
app.post('/api/scroll', async (req, res) => {
  const { deltaY, sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  try {
    const session = await getSession(sessionId);
    const { page } = session;
    await page.evaluate((dy) => window.scrollBy({ top: dy, behavior: 'instant' }), deltaY);
    // Minimal settle — 30ms is enough for paint to flush in headless
    await new Promise(r => setTimeout(r, 30));
    const screenshot = await fastShot(page);
    res.json({ screenshot, url: page.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Back ──────────────────────────────────────────────────────────────────────
app.post('/api/back', async (req, res) => {
  const { sessionId } = req.body;
  try {
    const session = await getSession(sessionId);
    const { page } = session;
    if (session.historyPos > 0) {
      session.historyPos--;
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
      await smartWait(page, 600);
    }
    const [screenshot, title] = await Promise.all([shot(page, 82), page.title()]);
    res.json({ screenshot, title, url: page.url(), canGoBack: session.historyPos > 0, canGoForward: session.historyPos < session.history.length - 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Forward ───────────────────────────────────────────────────────────────────
app.post('/api/forward', async (req, res) => {
  const { sessionId } = req.body;
  try {
    const session = await getSession(sessionId);
    const { page } = session;
    if (session.historyPos < session.history.length - 1) {
      session.historyPos++;
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 });
      await smartWait(page, 600);
    }
    const [screenshot, title] = await Promise.all([shot(page, 82), page.title()]);
    res.json({ screenshot, title, url: page.url(), canGoBack: session.historyPos > 0, canGoForward: session.historyPos < session.history.length - 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Refresh ───────────────────────────────────────────────────────────────────
app.post('/api/refresh', async (req, res) => {
  const { sessionId } = req.body;
  try {
    const session = await getSession(sessionId);
    const { page } = session;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
    await smartWait(page, 800);
    const [screenshot, title] = await Promise.all([shot(page, 82), page.title()]);
    res.json({ screenshot, title, url: page.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Screenshot only ───────────────────────────────────────────────────────────
app.post('/api/screenshot', async (req, res) => {
  const { sessionId } = req.body;
  try {
    const session = await getSession(sessionId);
    const [screenshot, title] = await Promise.all([shot(session.page, 88), session.page.title()]);
    res.json({ screenshot, url: session.page.url(), title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Hover ─────────────────────────────────────────────────────────────────────
app.post('/api/hover', async (req, res) => {
  const { x, y, sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  try {
    const session = await getSession(sessionId);
    const { page } = session;
    await page.mouse.move(x, y);
    await new Promise(r => setTimeout(r, 120));
    const screenshot = await fastShot(page);
    res.json({ screenshot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', sessions: sessions.size }));

app.listen(PORT, () => console.log(`Dave Browser backend running on port ${PORT}`));
