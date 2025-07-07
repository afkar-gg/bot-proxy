const express = require("express");
const fetch = require("node-fetch");
const cookieParser = require("cookie-parser");
const { spawn } = require("child_process");
const config = require("./config.json");

const BOT_TOKEN = config.BOT_TOKEN;
const CHANNEL = config.CHANNEL_ID;
const DASH_PASS = config.DASHBOARD_PASSWORD || "secret";

if (!BOT_TOKEN || !CHANNEL) {
  console.error("[Error] BOT_TOKEN or CHANNEL_ID missing in config.json");
  process.exit(1);
}

const PORT = 3000;
const app = express();
app.use(express.json());
app.use(cookieParser());

// Rate-limit protection for login
const failedLogins = new Map();

// In-memory storage for jobs
const pending = new Map();
const sessions = new Map();
const lastSeen = new Map();

// Auth middleware — now excludes key endpoints from auth
function requireAuth(req, res, next) {
  const openPaths = [
    "/status",
    "/track",
    "/check",
    "/complete",
    "/send-job",
    "/join",
    "/login",
    "/login-submit"
  ];

  if (openPaths.some(p => req.path.startsWith(p))) {
    return next();
  }

  if (req.cookies?.dash_auth === DASH_PASS) {
    return next();
  }

  return res.redirect("/login");
}
app.use(requireAuth);

// 🔐 Login (dark mode)
app.get("/login", (req, res) => {
  res.send(`
<!DOCTYPE html><html><body style="background:#18181b;color:#eee;display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;margin:0;">
  <form method="POST" action="/login-submit" style="display:flex;flex-direction:column;width:260px;">
    <input name="password" type="password" placeholder="Password" required
      style="padding:10px;margin-bottom:12px;border:none;border-radius:4px;background:#2a2a33;color:#eee;"/>
    <button type="submit" style="padding:10px;background:#3b82f6;color:#fff;border:none;border-radius:4px;">Login</button>
  </form>
</body></html>`);
});

// 🛡 Login POST with rate limiting
app.post("/login-submit", express.urlencoded({ extended: false }), (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.connection.remoteAddress;
  const record = failedLogins.get(ip) || { count: 0, last: 0 };

  if (record.count >= 10 && Date.now() - record.last < 5 * 60 * 1000) {
    return res.send("⛔ Too many attempts. Try again later.");
  }

  if (req.body.password === DASH_PASS) {
    res.cookie("dash_auth", DASH_PASS, { httpOnly: true });
    failedLogins.delete(ip);
    return res.redirect("/dashboard");
  }

  failedLogins.set(ip, { count: record.count + 1, last: Date.now() });
  return res.send("❌ Invalid password. <a href='/login'>Try again</a>");
});

// 🖥 Dashboard (dark mode)
app.get("/dashboard", (req, res) => {
  const rows = Array.from(pending.values()).map(job => `
    <tr><td>${job.username}</td><td>${job.no_order}</td><td>${job.nama_store}</td>
      <td>${Math.max(0, Math.floor((job.endTime - Date.now()) / 60000))}m</td>
      <td>${job.status}</td>
      <td><button onclick="location.href='/cancel/${job.username}'"
        style="background:#ef4444;color:#fff;border:none;padding:4px 8px;border-radius:3px;">
        Cancel
      </button></td></tr>`).join("");

  res.send(`
<!DOCTYPE html><html><body style="background:#18181b;color:#eee;margin:0;padding:20px;font-family:sans-serif;">
  <h1 style="text-align:center;">Joki Dashboard</h1>
  <div style="max-width:420px;margin:auto;background:#1f1f25;padding:16px;border-radius:8px;border:1px solid #333;">
    <form id="jobForm" style="display:flex;flex-direction:column;">
      <input name="username" placeholder="Username" required style="padding:10px;margin-bottom:10px;background:#2a2a33;border:none;border-radius:4px;color:#eee;"/>
      <input name="no_order" placeholder="Order ID" required style="padding:10px;margin-bottom:10px;background:#2a2a33;border:none;border-radius:4px;color:#eee;"/>
      <input name="nama_store" placeholder="Store Name" required style="padding:10px;margin-bottom:10px;background:#2a2a33;border:none;border-radius:4px;color:#eee;"/>
      <input name="jam_selesai_joki" type="number" placeholder="Hours" required style="padding:10px;margin-bottom:14px;background:#2a2a33;border:none;border-radius:4px;color:#eee;"/>
      <button type="submit" style="padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:4px;">Start Job</button>
    </form>
  </div>
  <h2 style="text-align:center;margin-top:24px;">Active Jobs</h2>
  <table style="width:95%;margin:auto;border-collapse:collapse;border:1px solid #444;">
    <tr style="background:#2a2a33;"><th>User</th><th>Order</th><th>Store</th><th>Time Left</th><th>Status</th><th>Action</th></tr>
    ${rows}
  </table>
  <script>
    document.getElementById("jobForm").onsubmit = async e => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target));
      await fetch("/start-job",{ method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(d) });
      location.reload();
    };
  </script>
</body></html>`);
});

// 🧪 POST /start-job
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
  if (!pending.has(username)) return res.status(404).json({ error: "No job pending" });

  const job = pending.get(username);
  pending.delete(username);

  const session = { ...job, startTime: Date.now(), messageId: null, channel: CHANNEL, warned: false, offline: false };
  session.endTime = job.endTime;
  sessions.set(username, session);
  lastSeen.set(username, Date.now());

  const nowS = Math.floor(session.startTime / 1000),
        endS = Math.floor(session.endTime / 1000),
        clean = job.no_order.replace(/^OD000000/, "");
  const embed = {
    embeds: [{
      title: "🎮 **JOKI STARTED**",
      description:
        `**Username:** ${username}\n**Order ID:** ${job.no_order}\n[🔗 View Order](https://tokoku.itemku.com/riwayat-pesanan/rincian/${clean})\n\n**Start:** <t:${nowS}:f>\n**End:** <t:${endS}:f>`,
      footer: { text: `- ${job.nama_store}` }
    }]
  };

  fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
    method: "POST",
    headers: { "Content-Type":"application/json", Authorization:`Bot ${BOT_TOKEN}` },
    body: JSON.stringify(embed)
  })
    .then(r => r.json()).then(j => session.messageId = j.id).catch(console.error);

  res.json({ ok: true, endTime: session.endTime });
});

// ✅ POST /check
app.post("/check", (req, res) => {
  const { username } = req.body;
  const s = sessions.get(username);
  if (!s) return res.status(404).json({ error: "No session active" });

  lastSeen.set(username, Date.now());

  fetch(`https://discord.com/api/v10/channels/${s.channel}/messages/${s.messageId}`, {
    method: "PATCH",
    headers: { "Content-Type":"application/json", Authorization:`Bot ${BOT_TOKEN}` },
    body: JSON.stringify({ content: `🟢 Online — Last Checked: <t:${Math.floor(Date.now()/1000)}:R>` })
  }).catch(console.error);

  res.json({ ok: true });
});

// 🏁 POST /complete
app.post("/complete", (req, res) => {
  const { username } = req.body;
  const s = sessions.get(username);
  if (!s) return res.status(404).json({ error: "No session active" });

  const nowS = Math.floor(Date.now() / 1000),
        clean = s.no_order.replace(/^OD000000/, "");
  const embed = {
    embeds: [{
      title: "✅ **JOKI COMPLETED**",
      description:
        `**Username:** ${username}\n**Order ID:** ${s.no_order}\n[🔗 View Order](https://tokoku.itemku.com/riwayat-pesanan/rincian/${clean})\n\n⏰ Completed at: <t:${nowS}:f>`,
      footer: { text: `- ${s.nama_store}` }
    }]
  };

  fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
    method: "POST",
    headers: { "Content-Type":"application/json", Authorization:`Bot ${BOT_TOKEN}` },
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
  if (!s) return res.status(404).json({ error: "No session active" });

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
    headers: { "Content-Type":"application/json", Authorization:`Bot ${BOT_TOKEN}` },
    body: JSON.stringify(embed)
  }).catch(console.error);

  res.json({ ok: true });
});

// 🌐 GET /status (public page)
app.get("/status", (req, res) => {
  res.send(`
<!DOCTYPE html><html><body style="margin:0;padding:20px;background:#18181b;color:#eee;font-family:sans-serif;">
  <h1 style="text-align:center;">Check Joki Status</h1>
  <div style="display:flex;justify-content:center;margin-top:20px;">
    <input id="u" placeholder="Username" style="padding:10px;border:none;border-radius:4px;background:#2a2a33;color:#eee;width:200px;"/>
    <button onclick="check()" style="margin-left:10px;padding:10px;background:#3b82f6;color:#fff;border:none;border-radius:4px;">Check</button>
  </div>
  <div id="r" style="text-align:center;margin-top:30px;font-size:18px;"></div>
  <script>
    async function check() {
      const u = document.getElementById("u").value.trim();
      if (!u) return;
      const d = await fetch("/status/" + u).then(r => r.json());
      const o = document.getElementById("r");
      if (d.error) o.innerHTML = '<span style="color:#f87171;">❌ '+d.error+'</span>';
      else if (d.lastSeen === "offline") {
        o.innerHTML = \`🧍 <strong>\${u}</strong> is <span style="color:#f87171;">OFFLINE</span><br>👁️ Last Checked: ∞\`;
      } else {
        const rem = ((d.endTime-Date.now())/1000|0), m = rem/60|0, s = rem%60|0, ago = Math.floor((Date.now()-d.lastSeen)/60000);
        o.innerHTML = \`🧍 <strong>\${u}</strong> is <span style="color:#34d399;">ONLINE</span><br>🕒 Time left: \${m}m \${s}s<br>👁️ Last Checked: \${ago} min ago\`;
      }
    }
  </script>
</body></html>`);
});

// 📊 GET /status/:username (API)
app.get("/status/:username", (req, res) => {
  const u = req.params.username;
  const s = sessions.get(u);
  const seen = lastSeen.get(u);
  if (!s) return res.status(404).json({ error: `No session for ${u}` });

  const offline = !seen || Date.now() - seen > 180000;
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
    <a href="${uri}" style="color:#3 […]