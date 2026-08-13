import express from "express";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";

// Load environment variables from .env (if present)
dotenv.config();

// Use process.cwd() as a reliable project root in environments
// where `import.meta.url` may not be a file: URL (fixes some tsx issues)
const __dirname = process.cwd();
const db = new Database("msg_classifier.db");

// Initialize Database
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    text TEXT,
    sender TEXT,
    phoneNumber TEXT,
    result TEXT,
    timestamp INTEGER,
    isRead INTEGER
  );

  CREATE TABLE IF NOT EXISTS contacts (
    phone TEXT PRIMARY KEY,
    name TEXT
  );

  CREATE TABLE IF NOT EXISTS profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT,
    phone TEXT
  );

  INSERT OR IGNORE INTO profile (id, name, phone) VALUES (1, 'Me', '+1 (000) 000-0000');
`);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Ensure classificationService is available for server-side classification and seeding
  const { classificationService } = await import('./src/services/classificationService');

  // Seed sample messages if none exist so the UI has data to display
  try {
    const countRow = db.prepare('SELECT COUNT(*) as c FROM messages').get();
    const count = countRow ? (countRow.c as number) : 0;
    if (count === 0) {
      const samples = [
        { sender: '+91 98765 43210', text: 'Your OTP for login is 4589. Do not share it with anyone.' },
        { sender: 'HDFC BANK', text: 'Rs.500 debited from your account XX1234. Available balance is Rs.12,450.' },
        { sender: 'Amazon', text: "Your order for 'Wireless Headphones' will arrive today by 8 PM." },
        { sender: 'Jio', text: 'Your mobile recharge of Rs.299 is successful. Validity: 28 days.' },
        { sender: 'College Admin', text: 'Class starts at 9 AM tomorrow in Room 302. Attendance is mandatory.' },
        { sender: 'HR Team', text: 'You are shortlisted for the interview on Monday. Please confirm your availability.' },
        { sender: 'Airtel', text: 'Flood alert in your area. Please stay safe and follow local guidelines.' },
        { sender: 'Instagram', text: 'You received a new friend request from @johndoe.' },
        { sender: 'Mom', text: 'Hi, where are you? Call me when you see this.' },
        { sender: 'Zomato', text: '50% discount on your next order! Use code HUNGRY50.' },
        { sender: 'WinBig', text: 'Congratulations! You won a lottery of $1,000,000. Click here to claim: bit.ly/spam' },
      ];

      for (const s of samples) {
        try {
          const result = await classificationService.classifyMessage(s.text);
          db.prepare(`INSERT INTO messages (id, text, sender, phoneNumber, result, timestamp, isRead) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(s.sender + '|' + Date.now(), s.text, s.sender, s.sender, JSON.stringify(result), Date.now(), 0);
        } catch (e) {
          console.warn('Failed to seed message', e);
        }
      }
      console.log('Seeded sample messages');
    }
  } catch (e) {
    console.warn('Error checking/seeding messages', e);
  }

  // Re-classify any messages that have unknown/empty results using the current classifier.
  try {
    const rows = db.prepare('SELECT id, text, result FROM messages').all();
    for (const r of rows) {
      let parsed: any = null;
      try { parsed = r.result ? JSON.parse(r.result as string) : null; } catch (e) { parsed = null; }
      if (!parsed || !parsed.type || parsed.type === 'UNKNOWN' || (parsed.confidence && parsed.confidence < 0.6)) {
        try {
          const updated = await classificationService.classifyMessage(r.text);
          db.prepare('UPDATE messages SET result = ? WHERE id = ?').run(JSON.stringify(updated), r.id);
        } catch (e) {
          console.warn('Re-classify failed for', r.id, e);
        }
      }
    }
    console.log('Re-classification pass complete');
  } catch (e) {
    console.warn('Error during re-classification pass', e);
  }

  // API Routes
  app.get("/api/messages", (req, res) => {
    const messages = db.prepare("SELECT * FROM messages ORDER BY timestamp DESC").all();
    res.json(messages.map(m => ({
      ...m,
      result: m.result ? JSON.parse(m.result as string) : null,
      isRead: !!m.isRead
    })));
  });

  // Get messages by category
  app.get("/api/messages/category/:type", (req, res) => {
    const { type } = req.params;
    let query = "SELECT * FROM messages ORDER BY timestamp DESC";
    let params: any[] = [];
    
    if (type === 'UNREAD') {
      query = "SELECT * FROM messages WHERE isRead = 0 ORDER BY timestamp DESC";
    } else if (type !== 'ALL') {
      query = "SELECT * FROM messages WHERE result LIKE ? ORDER BY timestamp DESC";
      params = [`%\"type\":\"${type}\"%`];
    }
    
    const messages = db.prepare(query).all(...params);
    res.json(messages.map(m => ({
      ...m,
      result: m.result ? JSON.parse(m.result as string) : null,
      isRead: !!m.isRead
    })));
  });

  // Mark message as read/unread
  app.patch("/api/messages/:id/read", (req, res) => {
    const { id } = req.params;
    const { isRead } = req.body;
    
    if (typeof isRead !== 'boolean') {
      return res.status(400).json({ error: 'Missing isRead boolean' });
    }
    
    db.prepare('UPDATE messages SET isRead = ? WHERE id = ?').run(isRead ? 1 : 0, id);
    res.json({ status: 'ok', isRead });
  });

  // Mark message as spam
  app.patch("/api/messages/:id/spam", (req, res) => {
    const { id } = req.params;
    const { isSpam } = req.body;
    
    // If marking as spam, update the classification result
    if (isSpam) {
      const message = db.prepare('SELECT result FROM messages WHERE id = ?').get(id) as any;
      if (message) {
        const parsed = message.result ? JSON.parse(message.result) : null;
        if (parsed) {
          parsed.type = 'SPAM';
          parsed.confidence = 1.0;
          parsed.reason = 'Manually marked as spam';
          db.prepare('UPDATE messages SET result = ? WHERE id = ?').run(JSON.stringify(parsed), id);
        }
      }
    }
    res.json({ status: 'ok', isSpam });
  });

  app.post("/api/messages", (req, res) => {
    const { id, text, sender, phoneNumber, result, timestamp, isRead } = req.body;
    db.prepare(`
      INSERT INTO messages (id, text, sender, phoneNumber, result, timestamp, isRead)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, text, sender, phoneNumber, JSON.stringify(result), timestamp, isRead ? 1 : 0);
    res.status(201).json({ status: "ok" });
  });

  app.delete("/api/messages", (req, res) => {
    db.prepare("DELETE FROM messages").run();
    res.json({ status: "ok" });
  });

  app.get("/api/contacts", (req, res) => {
    const contacts = db.prepare("SELECT * FROM contacts").all();
    res.json(contacts);
  });

  app.post("/api/contacts", (req, res) => {
    const { name, phone } = req.body;
    db.prepare("INSERT OR REPLACE INTO contacts (name, phone) VALUES (?, ?)").run(name, phone);
    res.status(201).json({ status: "ok" });
  });

  app.delete("/api/contacts/:phone", (req, res) => {
    db.prepare("DELETE FROM contacts WHERE phone = ?").run(req.params.phone);
    res.json({ status: "ok" });
  });

  app.get("/api/profile", (req, res) => {
    const profile = db.prepare("SELECT * FROM profile WHERE id = 1").get();
    res.json(profile);
  });

  app.post("/api/profile", (req, res) => {
    const { name, phone } = req.body;
    db.prepare("UPDATE profile SET name = ?, phone = ? WHERE id = 1").run(name, phone);
    res.json({ status: "ok" });
  });

  // Vite middleware for development
  // Static serving for production will be added after API routes.

  // Server-side classification endpoint (uses server's GEMINI_API_KEY)
  // Classification endpoints
  app.post('/api/classify', async (req, res) => {
    try {
      const { text } = req.body;
      if (!text) return res.status(400).json({ error: 'Missing text' });
      const result = await classificationService.classifyMessage(text);
      res.json(result);
    } catch (e) {
      console.error('Classification error', e);
      res.status(500).json({ error: 'Classification failed' });
    }
  });

  // Allow simple GET classification for quick browser checks: /api/classify?text=...
  app.get('/api/classify', async (req, res) => {
    try {
      const text = String(req.query.text || '');
      if (!text) return res.json({ ok: true, info: 'POST JSON { text } or GET with ?text=...' });
      const result = await classificationService.classifyMessage(text);
      res.json(result);
    } catch (e) {
      console.error('Classification GET error', e);
      res.status(500).json({ error: 'Classification failed' });
    }
  });

  // Update message result
  app.patch('/api/messages/:id', (req, res) => {
    const { id } = req.params;
    const { result } = req.body;
    if (!id || !result) return res.status(400).json({ error: 'Missing id or result' });
    db.prepare('UPDATE messages SET result = ? WHERE id = ?').run(JSON.stringify(result), id);
    res.json({ status: 'ok' });
  });

  // Vite middleware for development (attach after API routes so APIs are handled first)
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: "spa",
      // Avoid loading external vite.config.ts to prevent resolver issues
      configFile: false,
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  // Try to listen on PORT, if in use try next ports up to PORT+10
  const startPort = Number(process.env.PORT || PORT || 3000);
  const maxPort = startPort + 10;
  let listeningPort = startPort;

  const tryListen = () => new Promise<number>((resolve, reject) => {
    const srv = app.listen(listeningPort, '0.0.0.0', () => {
      console.log(`Server running on http://localhost:${listeningPort}`);
      resolve(listeningPort);
    });
    srv.on('error', (err: any) => {
      if (err && err.code === 'EADDRINUSE') {
        console.warn(`Port ${listeningPort} in use, trying ${listeningPort + 1}`);
        listeningPort += 1;
        if (listeningPort <= maxPort) {
          // slight delay before retry
          setTimeout(() => tryListen().then(resolve).catch(reject), 200);
        } else {
          reject(new Error('No available ports'));
        }
      } else {
        reject(err);
      }
    });
  });

  try {
    await tryListen();
  } catch (e) {
    console.error('Failed to bind server to a port:', e);
    process.exit(1);
  }
}

startServer();

// The development Vite server is attached inside `startServer()` above
// to ensure middleware is registered once (prevents duplicate HMR websocket
// servers trying to bind the same port). The IIFE that previously created
// another Vite instance has been removed.


