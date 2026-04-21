const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-session-id']
}));
app.use(express.json({ limit: '10mb' }));

// Session store: sessionId -> { browser, page, createdAt }
const sessions = new Map();
const SESSION_TTL = 10 * 60 * 1000; // 10 minutes

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-extensions',
    ],
    defaultViewport: { width: 1280, height: 800 }
  });
}

async function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    const browser = await launchBrowser();
    const page = await browser.newPage();

    // Realistic browser headers
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    });

    sessions.set(sessionId, { browser, page, createdAt: Date.now(), history: [], historyPos: -1 });
  }
  const session = sessions.get(sessionId);
  session.lastUsed = Date.now();
  return session;
}

// Clean up idle sessions
setInterval(async () => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - (session.lastUsed || session.createdAt) > SESSION_TTL) {
      try { await session.browser.close(); } catch (_) {}
      sessions.delete(id);
      console.log(`Session ${id} cleaned up`);
    }
  }
}, 60 * 1000);

// ── Screenshot (main browse endpoint) ──────────────────────────────────────
app.post('/api/navigate', async (req, res) => {
  const { url, sessionId } = req.body;
  if (!url || !sessionId) return res.status(400).json({ error: 'url and sessionId required' });

  try {
    let nav = url.trim();
    if (!/^https?:\/\//i.test(nav)) {
      if (/^[\w.-]+\.\w{2,}/.test(nav) && !nav.includes(' ')) {
        nav = 'https://' + nav;
      } else {
        nav = 'https://www.google.com/search?q=' + encodeURIComponent(nav);
      }
    }

    const session = await getSession(sessionId);
    const { page } = session;

    await page.goto(nav, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 800)); // let JS settle

    const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 85 });
    const title = await page.title();
    const currentUrl = page.url();

    // Update history
    session.history = session.history.slice(0, session.historyPos + 1);
    session.history.push(currentUrl);
    session.historyPos = session.history.length - 1;

    res.json({
      screenshot,
      title,
      url: currentUrl,
      canGoBack: session.historyPos > 0,
      canGoForward: session.historyPos < session.history.length - 1
    });
  } catch (err) {
    console.error('navigate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Click ───────────────────────────────────────────────────────────────────
app.post('/api/click', async (req, res) => {
  const { x, y, sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  try {
    const { page, history, historyPos } = await getSession(sessionId);
    const session = await getSession(sessionId);

    await page.mouse.click(x, y);
    await new Promise(r => setTimeout(r, 1200));

    const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 85 });
    const title = await page.title();
    const currentUrl = page.url();

    // If URL changed, update history
    const prevUrl = session.history[session.historyPos];
    if (currentUrl !== prevUrl) {
      session.history = session.history.slice(0, session.historyPos + 1);
      session.history.push(currentUrl);
      session.historyPos = session.history.length - 1;
    }

    res.json({
      screenshot, title, url: currentUrl,
      canGoBack: session.historyPos > 0,
      canGoForward: session.historyPos < session.history.length - 1
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Type ────────────────────────────────────────────────────────────────────
app.post('/api/type', async (req, res) => {
  const { text, sessionId, key } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  try {
    const session = await getSession(sessionId);
    const { page } = session;

    if (key) {
      await page.keyboard.press(key);
    } else if (text) {
      await page.keyboard.type(text, { delay: 30 });
    }

    await new Promise(r => setTimeout(r, 800));
    const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 85 });
    const title = await page.title();
    const currentUrl = page.url();

    // URL change check
    const prevUrl = session.history[session.historyPos];
    if (currentUrl !== prevUrl) {
      session.history = session.history.slice(0, session.historyPos + 1);
      session.history.push(currentUrl);
      session.historyPos = session.history.length - 1;
    }

    res.json({
      screenshot, title, url: currentUrl,
      canGoBack: session.historyPos > 0,
      canGoForward: session.historyPos < session.history.length - 1
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Scroll ───────────────────────────────────────────────────────────────────
app.post('/api/scroll', async (req, res) => {
  const { deltaY, sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  try {
    const session = await getSession(sessionId);
    const { page } = session;

    await page.evaluate((dy) => window.scrollBy(0, dy), deltaY);
    await new Promise(r => setTimeout(r, 300));

    const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 85 });
    res.json({ screenshot, url: page.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Back / Forward ───────────────────────────────────────────────────────────
app.post('/api/back', async (req, res) => {
  const { sessionId } = req.body;
  try {
    const session = await getSession(sessionId);
    const { page } = session;

    if (session.historyPos > 0) {
      session.historyPos--;
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
      await new Promise(r => setTimeout(r, 600));
    }

    const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 85 });
    res.json({
      screenshot, title: await page.title(), url: page.url(),
      canGoBack: session.historyPos > 0,
      canGoForward: session.historyPos < session.history.length - 1
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/forward', async (req, res) => {
  const { sessionId } = req.body;
  try {
    const session = await getSession(sessionId);
    const { page } = session;

    if (session.historyPos < session.history.length - 1) {
      session.historyPos++;
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 });
      await new Promise(r => setTimeout(r, 600));
    }

    const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 85 });
    res.json({
      screenshot, title: await page.title(), url: page.url(),
      canGoBack: session.historyPos > 0,
      canGoForward: session.historyPos < session.history.length - 1
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Refresh ──────────────────────────────────────────────────────────────────
app.post('/api/refresh', async (req, res) => {
  const { sessionId } = req.body;
  try {
    const session = await getSession(sessionId);
    const { page } = session;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(r => setTimeout(r, 600));
    const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 85 });
    res.json({ screenshot, title: await page.title(), url: page.url() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Screenshot only (no nav) ─────────────────────────────────────────────────
app.post('/api/screenshot', async (req, res) => {
  const { sessionId } = req.body;
  try {
    const session = await getSession(sessionId);
    const screenshot = await session.page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 85 });
    res.json({ screenshot, url: session.page.url(), title: await session.page.title() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', sessions: sessions.size }));

app.listen(PORT, () => console.log(`Aura backend running on port ${PORT}`));
