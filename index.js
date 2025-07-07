const express = require("express");
const cookieParser = require("cookie-parser");
const { spawn } = require("child_process");
const config = require("./config.json");
const fetch = (...args) => import("node-fetch").then(m => m.default(...args));

const BOT_TOKEN = config.BOT_TOKEN;
const CHANNEL = config.CHANNEL_ID;
const DASH_PASS = config.DASHBOARD_PASSWORD || "secret";

if (!BOT_TOKEN || !CHANNEL) {
  console.error("[Error] BOT_TOKEN or CHANNEL_ID missing");
  process.exit(1);
}

const PORT = 3000;
const app = express();
app.use(express.json());
app.use(cookieParser());

// 🚨 Brute-force login protection
const failedLogins = new Map();

// 🚧 In-memory storage
const pending = new Map();    // waiting jobs
const sessions = new Map();   // active sessions
const lastSeen = new Map();   // last check timestamp

// 🔒 Auth middleware (exempts core API endpoints)
function requireAuth(req, res, next) {
  const open = ["/track", "/check", "/complete", "/send-job", "/status", "/join", "/login", "/login-submit"];
  if (open.some(p => req.path.startsWith(p))) return next();
  if (req.cookies.dash_auth === DASH_PASS) return next();
  return res.redirect("/login");
}
app.use(requireAuth);

// 🔐 GET /login
app.get("/login", (req, res) => {
  res.send(`
<!DOCTYPE html><html><body style="margin:0;padding:0;height:100vh;background:#18181b;color:#eee;display:flex;justify-content:center;align-items:center;font-family:sans-serif;">
  <form method="POST" action="/login-submit" style="display:flex;flex-direction:column;width:260px;">
    <input name="password" type="password" placeholder="Password" required
      style="padding:10px;margin-bottom:12px;border:none;border-radius:4px;background:#2a2a33;color:#eee;"/>
    <button type="submit" style="padding:10px;background:#3b82f6;color:#fff;border:none;border-radius:4px;">Login</button>
  </form>
</body></html>`);
});

// 🛡 POST /login-submit
app.post("/login-submit", express.urlencoded({ extended: false }), (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const rec = failedLogins.get(ip) || { count: 0, last: 0 };
  if (rec.count >= 10 && Date.now() - rec.last < 5 * 60 * 1000) {
    return res.send("⛔ Too many login attempts. Try again later.");
  }
  if (req.body.password === DASH_PASS) {
    res.cookie("dash_auth", DASH_PASS, { httpOnly: true });
    failedLogins.delete(ip);
    return res.redirect("/dashboard");
  }
  failedLogins.set(ip, { count: rec.count + 1, last: Date.now() });
  return res.send("❌ Invalid password. <a href='/login'>Try again</a>");
});

// 🖥 GET /dashboard
app.get("/dashboard", (req, res) => {
  const activeJobs = Array.from(sessions.values())
    .map(s => ({
      username: s.username,
      no_order: s.no_order,
      nama_store: s.nama_store,
      timeLeft: Math.max(0, Math.floor((s.endTime - Date.now()) / 60000)),
      status: s.offline ? "OFFLINE" : "ONLINE"
    }));

  const rows = activeJobs.map(j => `
    <tr style="border-bottom:1px solid #444;">
      <td>${j.username}</td>
      <td>${j.no_order}</td>
      <td>${j.nama_store}</td>
      <td>${j.timeLeft}m</td>
      <td>${j.status}</td>
      <td><button onclick="location.href='/cancel/${j.username}'" style="padding:4px 8px;background:#ef4444;color:#fff;border:none;border-radius:4px;">Cancel</button></td>
    </tr>`).join("");

  res.send(`
<!DOCTYPE html><html><body style="margin:20px;background:#18181b;color:#eee;font-family:sans-serif;">
  <h1 style="text-align:center;">Joki Dashboard</h1>
  <div style="max-width:420px;margin:auto;padding:16px;background:#1f1f25;border:1px solid #333;border-radius:8px;">
    <form id="jobForm" style="display:flex;flex-direction:column;">
      <input name="username" placeholder="Username" required style="padding:10px;margin-bottom:10px;background:#2a2a33;color:#eee;border:none;border-radius:4px;"/>
      <input name="no_order" placeholder="Order ID" required style="padding:10px;margin-bottom:10px;background:#2a2a33;color:#eee;border:none;border-radius:4px;"/>
      <input name="nama_store" placeholder="Store Name" required style="padding:10px;margin-bottom:10px;background:#2a2a33;color:#eee;border:none;border-radius:4px;"/>
      <input name="jam_selesai_joki" type="number" step="any" placeholder="Hours" required style="padding:10px;margin-bottom:14px;background:#2a2a33;color:#eee;border:none;border-radius:4px;"/>
      <button type="submit" style="padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:4px;">Start Job</button>
    </form>
  </div>
  <h2 style="text-align:center;margin-top:28px;">Active Sessions</h2>
  <div style="overflow-x:auto;margin-top:10px;">
    <table style="width:95%;margin:auto;border-collapse:collapse;color:#eee;">
      <tr style="background:#2a2a33;"><th>User</th><th>Order</th><th>Store</th><th>Time Left</th><th>Status</th><th>Action</th></tr>
      ${rows}
    </table>
  </div>
  <script>
    document.getElementById("jobForm").onsubmit = async e => {
      e.preventDefault();
      await fetch("/start-job", {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(e.target)))
      });
      location.reload();
    };
  </script>
</body></html>`);
});

// 🔄 POST /start-job
app.post("/start-job", (req, res) => {
  const { username, no_order, nama_store, jam_selesai_joki } = req.body;
  const endTime = Date.now() + Number(jam_selesai_joki) * 3600000;
  pending.set(username, { username, no_order, nama_store, endTime, status: "waiting" });
  res.json({ ok: true });
});

// ❌ GET /cancel/:username
app.get("/cancel/:username", (req, res) => {
  const u = req.params.username;
  pending.delete(u);
  sessions.delete(u);
  lastSeen.delete(u);
  res.redirect("/dashboard");
});

// 📡 POST /track
app.post("/track", (req, res) => {
  const { username } = req.body;

  // ✅ Resume if already active
  const existing = sessions.get(username);
  if (existing) {
    lastSeen.set(username, Date.now());
    return res.json({ ok: true, endTime: existing.endTime });
  }

  // 🔄 New job must be in pending
  if (!pending.has(username)) {
    return res.status(404).json({ error: "No pending job" });
  }

  const job = pending.get(username);
  pending.delete(username);

  const session = {
    ...job,
    startTime: Date.now(),
    messageId: null,
    channel: CHANNEL,
    warned: false,
    offline: false,
    endTime: job.endTime
  };

  sessions.set(username, session);
  lastSeen.set(username, Date.now());

  const now = Math.floor(session.startTime / 1000);
  const end = Math.floor(session.endTime / 1000);
  const clean = job.no_order.replace(/^OD000000/, "");

  const embed = {
    embeds: [{
      title: "🎮 **JOKI STARTED**",
      description:
        `**Username:** ${username}\n**Order ID:** ${job.no_order}\n` +
        `[🔗 View Order](https://tokoku.itemku.com/riwayat-pesanan/rincian/${clean})\n\n` +
        `**Start:** <t:${now}:f>\n**End:** <t:${end}:f>`,
      footer: { text: `- ${job.nama_store}` }
    }]
  };

  fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
    body: JSON.stringify(embed)
  })
    .then(r => r.json())
    .then(data => { session.messageId = data.id; })
    .catch(console.error);

  res.json({ ok: true, endTime: session.endTime });
});

// ✅ POST /check
app.post("/check", (req, res) => {
  const { username } = req.body;
  const s = sessions.get(username);
  if (!s) return res.status(404).json({ error: "No active session" });

  lastSeen.set(username, Date.now());

  fetch(`https://discord.com/api/v10/channels/${s.channel}/messages/${s.messageId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
    body: JSON.stringify({ content: `🟢 Online — Last Checked: <t:${Math.floor(Date.now()/1000)}:R>` })
  }).catch(console.error);

  res.json({ ok: true });
});

// 🏁 POST /complete
app.post("/complete", (req, res) => {
  const { username } = req.body;
  const s = sessions.get(username);
  if (!s) return res.status(404).json({ error: "No session" });

  const now = Math.floor(Date.now() / 1000);
  const clean = s.no_order.replace(/^OD000000/, "");
  const embed = {
    embeds: [{
      title: "✅ **JOKI COMPLETED**",
      description:
        `**Username:** ${username}\n**Order ID:** ${s.no_order}\n` +
        `[🔗 View Order](https://tokoku.itemku.com/riwayat-pesanan/rincian/${clean})\n\n` +
        `⏰ Completed at: <t:${now}:f>`,
      footer: { text: `- ${s.nama_store}` }
    }]
  };

  fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
    body: JSON.stringify(embed)
  }).catch(console.error);

  sessions.delete(username);
  lastSeen.delete(username);
  res.json({ ok: true });
});

// 🧩 POST /send-job
app.post("/send-job", (req, res) => {
  const { username, placeId, jobId, join_url } = req.body;
  const s = sessions.get(username);
  if (!s) return res.status(404).json({ error: "No session" });

  const embed = {
    embeds: [{
      title: `🧩 Job ID for ${username}`,
      description: `**Place ID:** \`${placeId}\`\n**Job ID:** \`${jobId}\``,
      color: 0x3498db,
      fields: [{ name: "Join Link", value: `[Click to Join](${join_url})` }]
    }]
  };

  fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
    body: JSON.stringify(embed)
  }).catch(console.error);

  res.json({ ok: true });
});

// 🌐 GET /status (page)
app.get("/status", (req, res) => {
  res.send(`
<!DOCTYPE html><html><body style="margin:0;padding:20px;background:#18181b;color:#eee;font-family:sans-serif;">
  <h1 style="text-align:center;">Check Joki Status</h1>
  <div style="display:flex;justify-content:center;margin-top:20px;">
    <input id="u" placeholder="Username" style="padding:10px;background:#2a2a33;color:#eee;border:none;border-radius:4px;width:200px;"/>
    <button onclick="check()" style="margin-left:10px;padding:10px;background:#3b82f6;color:#fff;border:none;border-radius:4px;">Check</button>
  </div>
  <div id="r" style="text-align:center;margin-top:30px;font-size:18px;"></div>
  <script>
    async function check() {
      const u = document.getElementById("u").value.trim(); if (!u) return;
      const d = await fetch("/status/" + u).then(r => r.json());
      const out = document.getElementById("r");
      if (d.error) return out.innerHTML = '<span style="color:red;">❌ ' + d.error + '</span>';
      if (d.lastSeen === "offline") {
        out.innerHTML = \`🧍 <b>\${d.username}</b> is <span style="color:red;">OFFLINE</span><br>👁️ Last Checked: ∞\`;
      } else {
        const rem = ((d.endTime - Date.now())/1000|0), m = rem/60|0, s = rem%60|0;
        const ago = Math.floor((Date.now() - d.lastSeen)/60000);
        out.innerHTML = \`🧍 <b>\${d.username}</b> is <span style="color:lime;">ONLINE</span><br>🕒 Time left: \${m}m \${s}s<br>👁️ Last Checked: \${ago} min ago\`;
      }
    }
  </script>
</body></html>`);
});

// ✅ GET /status/:username
app.get("/status/:username", (req, res) => {
  const u = req.params.username;
  const s = sessions.get(u);
  const seen = lastSeen.get(u);
  if (!s) return res.status(404).json({ error: `No session for ${u}` });
  const offline = !seen || Date.now() - seen > 3 * 60 * 1000;
  res.json({ username: u, endTime: s.endTime, lastSeen: offline ? "offline" : seen });
});

// 🔗 GET /join
app.get("/join", (req, res) => {
  const { place, job } = req.query;
  if (!place || !job) return res.status(400).send("Missing place/job");
  const uri = `roblox://experiences/start?placeId=${place}&gameId=${job}`;
  res.send(`
<!DOCTYPE html><html><body style="margin:0;padding:0;height:100vh;background:#18181b;color:#eee;display:flex;justify-content:center;align-items:center;font-family:sans-serif;">
  <div style="text-align:center;">
    <h1>🔗 Redirecting to Roblox...</h1>
    <a href="${uri}" style="color:#3b82f6;">Tap here if not redirected</a>
  </div>
</body></html>`);
});

// ⏱ Watchdog every minute
setInterval(() => {
  const now = Date.now();
  sessions.forEach((s, u) => {
    const seen = lastSeen.get(u) || 0;
    if (!s.warned && now > s.endTime) {
      fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
        body: JSON.stringify({ content: `⏳ ${u}'s joki ended.` })
      }).catch(console.error);
      s.warned = true;
    }
    if (!s.offline && now - seen > 3 * 60 * 1000) {
      fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
        body: JSON.stringify({ content: `🔴 @everyone – **${u} is OFFLINE.** No heartbeat in 3 minutes.` })
      }).catch(console.error);
      s.offline = true;
    }
  });
}, 60 * 1000);

// 🚀 Start server + spawn tunnel
app.listen(PORT, () => {
  console.log(`✅ Proxy listening on port ${PORT}`);
  const tun = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${PORT}`, "--loglevel", "info"]);
  const reader = msg => {
    const t = msg.toString();
    if (t.includes("trycloudflare.com") || t.includes("cfargotunnel.com")) {
      console.log("🌐 Tunnel URL:", t.trim());
    }
  };
  tun.stdout.on("data", reader);
  tun.stderr.on("data", reader);
});