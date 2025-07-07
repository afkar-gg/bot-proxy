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

// Brute‑force protection store
const failedLogins = new Map();

// In‑memory job/session storage
const pending = new Map();
const sessions = new Map();
const lastSeen = new Map();

// Auth middleware
function requireAuth(req, res, next) {
  if (
    req.path.startsWith("/status") ||
    req.path === "/join" ||
    req.path === "/login" ||
    req.path === "/login-submit"
  ) return next();

  if (req.cookies?.dash_auth === DASH_PASS) return next();
  return res.redirect("/login");
}
app.use(requireAuth);

// 🔐 GET /login (dark mode)
app.get("/login", (req, res) => {
  res.send(`
<!DOCTYPE html><html><body style="margin:0;padding:0;height:100vh;background:#18181b;color:#eee;display:flex;justify-content:center;align-items:center;font-family:sans-serif;">
  <form method="POST" action="/login-submit" style="display:flex;flex-direction:column;width:260px;">
    <input name="password" type="password" placeholder="Password" required
      style="padding:10px;margin-bottom:12px;border:none;border-radius:4px;background:#2a2a33;color:#eee;"/>
    <button type="submit"
      style="padding:10px;background:#3b82f6;color:#fff;border:none;border-radius:4px;">
      Login
    </button>
  </form>
</body></html>`);
});

// 🔐 POST /login‑submit (with rate limit)
app.post("/login-submit", express.urlencoded({ extended: false }), (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.connection.remoteAddress;
  const record = failedLogins.get(ip) || { count: 0, lastFail: 0 };

  if (record.count >= 10 && Date.now() - record.lastFail < 5 * 60 * 1000) {
    return res.send("⛔ Too many failed attempts. Try again in 5 minutes.");
  }

  if (req.body.password === DASH_PASS) {
    res.cookie("dash_auth", DASH_PASS, { httpOnly: true });
    failedLogins.delete(ip);
    return res.redirect("/dashboard");
  }

  failedLogins.set(ip, { count: record.count + 1, lastFail: Date.now() });
  return res.send("❌ Invalid password. <a href='/login'>Try again</a>");
});

// 🖥️ GET /dashboard (dark mode)
app.get("/dashboard", (req, res) => {
  const rows = Array.from(pending.values()).map(job => `
    <tr>
      <td>${job.username}</td>
      <td>${job.no_order}</td>
      <td>${job.nama_store}</td>
      <td>${Math.max(0, Math.floor((job.endTime - Date.now()) / 60000))}m</td>
      <td>${job.status}</td>
      <td>
        <button onclick="location.href='/cancel/${job.username}'"
          style="padding:4px 8px;border:none;border-radius:3px;background:#ef4444;color:#fff;">
          Cancel
        </button>
      </td>
    </tr>`).join("");

  res.send(`
<!DOCTYPE html><html><body style="margin:20px;background:#18181b;color:#eee;font-family:sans-serif;">
  <h1 style="text-align:center;margin-bottom:16px;">Joki Dashboard</h1>
  <div style="max-width:420px;margin:auto;padding:16px;background:#1f1f25;border:1px solid #333;border-radius:8px;">
    <form id="jobForm" style="display:flex;flex-direction:column;">
      <input name="username" placeholder="Username" required style="padding:10px;margin-bottom:10px;border:none;border-radius:4px;background:#2a2a33;color:#eee;"/>
      <input name="no_order" placeholder="Order ID" required style="padding:10px;margin-bottom:10px;border:none;border-radius:4px;background:#2a2a33;color:#eee;"/>
      <input name="nama_store" placeholder="Store Name" required style="padding:10px;margin-bottom:10px;border:none;border-radius:4px;background:#2a2a33;color:#eee;"/>
      <input name="jam_selesai_joki" type="number" placeholder="Hours" required style="padding:10px;margin-bottom:14px;border:none;border-radius:4px;background:#2a2a33;color:#eee;"/>
      <button type="submit" style="padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:4px;">
        Start Job
      </button>
    </form>
  </div>
  <h2 style="text-align:center;margin-top:28px;">Active Jobs</h2>
  <div style="overflow-x:auto;margin-top:10px;">
    <table style="width:95%;margin:auto;border-collapse:collapse;border:1px solid #444;">
      <tr style="background:#2a2a33;color:#eee;"><th>User</th><th>Order</th><th>Store</th><th>Time Left</th><th>Status</th><th>Action</th></tr>
      ${rows}
    </table>
  </div>
  <script>
    document.getElementById("jobForm").onsubmit = async e => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target));
      await fetch("/start-job", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify(data)
      });
      location.reload();
    };
  </script>
</body></html>`);
});

// 🧪 POST /start-job
app.post("/start-job", (req, res) => {
  const { username, no_order, nama_store, jam_selesai_joki } = req.body;
  const endTime = Date.now() + Number(jam_selesai_joki) * 60 * 60 * 1000;
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
        `**Username:** ${username}\n` +
        `**Order ID:** ${job.no_order}\n` +
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
        `**Username:** ${username}\n` +
        `**Order ID:** ${s.no_order}\n` +
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
  <div style="display:flex;justify-content:center;align-items:center;margin-top:20px;">
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
      if (d.error) o.innerHTML = '<span style="color:#f87171;">❌ ' + d.error + '</span>';
      else if (d.lastSeen === "offline") {
        o.innerHTML = \`🧍 <strong>\${u}</strong> is <span style="color:#f87171;">OFFLINE</span><br>👁️ Last Checked: ∞\`;
      } else {
        const rem = ((d.endTime - Date.now()) / 1000 | 0), m = rem/60|0, s = rem%60|0;
        const ago = Math.floor((Date.now() - d.lastSeen)/60000);
        o.innerHTML = \`🧍 <strong>\${u}</strong> is <span style="color:#34d399;">ONLINE</span><br>🕒 Time left: \${m}m \${s}s<br>👁️ Last Checked: \${ago} min ago\`;
      }
    }
  </script>
</body></html>`);
});

// 🌐 GET /status/:username (api)
app.get("/status/:username", (req, res) => {
  const u = req.params.username;
  const s = sessions.get(u);
  const seen = lastSeen.get(u);
  if (!s) return res.status(404).json({ error: `No session for ${u}` });

  const isOffline = !seen || Date.now() - seen > 180000;
  res.json({
    username: u,
    endTime: s.endTime,
    lastSeen: isOffline ? "offline" : seen
  });
});

// 🔗 GET /join (mobile redirect)
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

// ⏱️ Watchdog interval (check every minute)
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
        body: JSON.stringify({ content: `🔴 @everyone — **${u} is OFFLINE.** No heartbeat for 3 minutes.` })
      }).catch(console.error);
      s.offline = true;
    }
  });
}, 60 * 1000);

// 🚀 Start server and tunnel
app.listen(PORT, () => {
  console.log(`✅ Proxy running on port ${PORT}`);
  const tunnel = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${PORT}`, "--loglevel", "info"]);
  const reader = msg => {
    const txt = msg.toString();
    if (txt.includes("trycloudflare.com") || txt.includes("cfargotunnel.com")) {
      console.log("🌐 Tunnel URL:", txt.trim());
    }
  };
  tunnel.stdout.on("data", reader);
  tunnel.stderr.on("data", reader);
});