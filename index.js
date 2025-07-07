const express = require("express");
const fetch = require("node-fetch");
const cookieParser = require("cookie-parser");
const { spawn } = require("child_process");
const config = require("./config.json");

const BOT_TOKEN = config.BOT_TOKEN;
const CHANNEL = config.CHANNEL_ID;
const DASH_PASS = config.DASHBOARD_PASSWORD || "secret";

if (!BOT_TOKEN || !CHANNEL) {
  console.error("✅ [Error] Invalid BOT_TOKEN or CHANNEL_ID in config.json");
  process.exit(1);
}

const PORT = 3000;
const app = express();
app.use(express.json());
app.use(cookieParser());

// In-memory storage
const pending = new Map();   // username -> { username, no_order, nama_store, endTime, status }
const sessions = new Map();  // username -> session details
const lastSeen = new Map();  // username -> timestamp of last /check

// ✅ Middleware: Require Auth for Dashboard
function requireAuth(req, res, next) {
  if (
    req.path.startsWith("/status") ||
    req.path === "/join" ||
    req.path === "/login" ||
    req.path === "/login-submit"
  ) return next();

  if (req.cookies?.dash_auth === DASH_PASS) return next();
  res.redirect("/login");
}
app.use(requireAuth);

// 🔐 Login UI
app.get("/login", (req, res) => {
  res.send(`
  <!DOCTYPE html><html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;">
    <form method="POST" action="/login-submit" style="display:flex;flex-direction:column;width:220px;">
      <input name="password" type="password" placeholder="Password" required style="padding:8px;margin-bottom:10px;"/>
      <button type="submit" style="padding:8px;">Login</button>
    </form>
  </body></html>`);
});

app.post("/login-submit", express.urlencoded({ extended: false }), (req, res) => {
  if (req.body.password === DASH_PASS) {
    res.cookie("dash_auth", DASH_PASS, { httpOnly: true });
    return res.redirect("/dashboard");
  }
  res.send("❌ Invalid password. <a href='/login'>Try again</a>");
});

// 🖥️ Dashboard UI
app.get("/dashboard", (req, res) => {
  const rows = Array.from(pending.values())
    .map(j => `
    <tr>
      <td>${j.username}</td>
      <td>${j.no_order}</td>
      <td>${j.nama_store}</td>
      <td>${Math.max(0, Math.floor((j.endTime - Date.now()) / 60000))}m</td>
      <td>${j.status}</td>
      <td><button onclick="location='/cancel/${j.username}'">Cancel</button></td>
    </tr>`).join("");

  res.send(`
  <!DOCTYPE html><html><body style="font-family:sans-serif;margin:20px;">
    <h1 style="text-align:center;">Joki Dashboard</h1>
    <div style="max-width:400px;margin:auto;padding:12px;border:1px solid #666;border-radius:8px;">
      <form id="jobForm" style="display:flex;flex-direction:column;">
        <input name="username" placeholder="Username" required style="padding:8px;margin-bottom:8px;" />
        <input name="no_order" placeholder="Order ID" required style="padding:8px;margin-bottom:8px;" />
        <input name="nama_store" placeholder="Store Name" required style="padding:8px;margin-bottom:8px;" />
        <input name="jam_selesai_joki" type="number" placeholder="Hours" required style="padding:8px;margin-bottom:12px;" />
        <button type="submit" style="padding:10px;">Start Job</button>
      </form>
    </div>
    <h2 style="text-align:center;margin-top:24px;">Active Jobs</h2>
    <div style="overflow-x:auto;"> 
      <table style="width:95%;margin:auto;border-collapse:collapse;border:1px solid #aaa;">
        <tr style="background:#eee;"><th>User</th><th>Order</th><th>Store</th><th>Time Left</th><th>Status</th><th>Action</th></tr>
        ${rows}
      </table>
    </div>
    <script>
      document.getElementById("jobForm").onsubmit = async e => {
        e.preventDefault();
        const form = new FormData(e.target);
        await fetch("/start-job", {
          method: "POST",
          body: JSON.stringify(Object.fromEntries(form)),
          headers: {"Content-Type": "application/json"}
        });
        location.reload();
      };
    </script>
  </body></html>`);
});

// 🧪 Start Job
app.post("/start-job", (req, res) => {
  const { username, no_order, nama_store, jam_selesai_joki } = req.body;
  const endTime = Date.now() + Number(jam_selesai_joki) * 3600000;
  pending.set(username, { username, no_order, nama_store, endTime, status: "waiting" });
  res.json({ ok: true });
});

// ❌ Cancel Job
app.get("/cancel/:username", (req, res) => {
  const u = req.params.username;
  pending.delete(u);
  sessions.delete(u);
  lastSeen.delete(u);
  res.redirect("/dashboard");
});

// 📡 Track (Roblox Trigger)
app.post("/track", (req, res) => {
  const { username } = req.body;
  if (!pending.has(username)) return res.status(404).json({ error: "No pending job" });

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
  const clean = session.no_order.replace(/^OD000000/, "");

  const embed = {
    embeds: [{
      title: "🎮 **JOKI STARTED**",
      description:
        `**Username:** ${username}\n` +
        `**Order ID:** ${session.no_order}\n` +
        `[🔗 View Order](https://tokoku.itemku.com/riwayat-pesanan/rincian/${clean})\n\n` +
        `**Start:** <t:${now}:f>\n**End:** <t:${end}:f>`,
      footer: { text: `- ${session.nama_store}` }
    }]
  };

  fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bot ${BOT_TOKEN}` },
    body: JSON.stringify(embed)
  })
    .then(r => r.json())
    .then(data => { session.messageId = data.id; })
    .catch(console.error);

  res.json({ ok: true, endTime: session.endTime });
});

// ✅ Checkpoint
app.post("/check", (req, res) => {
  const { username } = req.body;
  const s = sessions.get(username);
  if (!s) return res.status(404).json({ error: "No active session" });

  lastSeen.set(username, Date.now());

  fetch(`https://discord.com/api/v10/channels/${s.channel}/messages/${s.messageId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Authorization": `Bot ${BOT_TOKEN}` },
    body: JSON.stringify({
      content: `🟢 Online — Last Checked: <t:${Math.floor(Date.now() / 1000)}:R>`
    })
  }).catch(console.error);

  res.json({ ok: true });
});

// 🏁 Complete
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
    headers: { "Content-Type": "application/json", "Authorization": `Bot ${BOT_TOKEN}` },
    body: JSON.stringify(embed)
  }).catch(console.error);

  sessions.delete(username);
  lastSeen.delete(username);
  res.json({ ok: true });
});

// 🧩 Send Job ID
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

  fetch(`https://discord.com/api/v10/channels/${s.channel}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bot ${BOT_TOKEN}` },
    body: JSON.stringify(embed)
  }).catch(console.error);

  res.json({ ok: true });
});

// 🌐 Status UI
app.get("/status", (req, res) => {
  res.send(`
  <!DOCTYPE html><html><body style="display:flex;flex-direction:column;align-items:center;font-family:sans-serif;padding:20px;">
    <h1>Check Joki Status</h1>
    <input id="u" placeholder="Username" style="padding:8px;font-size:16px;"/>
    <button onclick="check()" style="margin:8px;padding:8px;">Check</button>
    <div id="r" style="margin-top:20px;font-size:18px;"></div>
    <script>
      async function check() {
        const u = document.getElementById("u").value.trim();
        if (!u) return;
        const d = await fetch("/status/" + u).then(r => r.json());
        const a = document.getElementById("r");
        if (d.error) a.innerText = "❌ " + d.error;
        else if (d.lastSeen === "offline")
          a.innerHTML = \`🧍 <b>\${u}</b> is <span style="color:red;">OFFLINE</span><br/>👁️ Last Checked: ∞\`;
        else {
          const left = ((d.endTime - Date.now()) / 1000 | 0);
          const m = (left / 60 | 0), s = (left % 60 | 0);
          const ago = Math.floor((Date.now() - d.lastSeen) / 60000);
          a.innerHTML = \`🧍 <b>\${u}</b> is <span style="color:lime;">ONLINE</span><br/>🕒 Time left: \${m}m \${s}s<br/>👁️ Last Checked: \${ago} min ago\`;
        }
      }
    </script>
  </body></html>`);
});

// 📊 API Status
app.get("/status/:username", (req, res) => {
  const u = req.params.username;
  const s = sessions.get(u);
  const seen = lastSeen.get(u);
  if (!s) return res.status(404).json({ error: `No session for ${u}` });

  const now = Date.now();
  const offline = !seen || now - seen > 180000;

  res.json({
    username: u,
    endTime: s.endTime,
    lastSeen: offline ? "offline" : seen
  });
});

// 🔗 Join Redirect (Mobile)
app.get("/join", (req, res) => {
  const { place, job } = req.query;
  if (!place || !job) return res.status(400).send("Missing place/job");
  const uri = `roblox://experiences/start?placeId=${place}&gameId=${job}`;
  res.send(`
  <!DOCTYPE html><html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111;color:#fff;font-family:sans-serif;">
    <div style="text-align:center;">
      <h1>🔗 Redirecting to Roblox...</h1>
      <a href="${uri}" style="color:#4fa9ff;">Click if not redirected</a>
    </div>
  </body></html>`);
});

// ⏱️ Watchdog (3 min interval)
setInterval(() => {
  const now = Date.now();
  sessions.forEach((s, u) => {
    const seen = lastSeen.get(u) || 0;

    if (!s.warned && now > s.endTime) {
      fetch(`https://discord.com/api/v10/channels/${s.channel}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bot ${BOT_TOKEN}` },
        body: JSON.stringify({ content: `�(COMMAND) ${u}'s joki ended.` })
      });
      s.warned = true;
    }

    if (!s.offline && now - seen > 180000) {
      fetch(`https://discord.com/api/v10/channels/${s.channel}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bot ${BOT_TOKEN}` },
        body: JSON.stringify({ content: `🔴 @everyone — **${u} is OFFLINE.** No activity for 3 minutes.` })
      });
      s.offline = true;
    }
  });
}, 60000);

// 🚀 Start server + Cloudflare tunnel
app.listen(PORT, () => {
  console.log(`✅ Proxy running on port ${PORT}`);
  const tun = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${PORT}`, "--loglevel", "info"]);
  const parser = msg => {
    const text = msg.toString();
    if (text.includes("trycloudflare.com")) console.log("🌐 Tunnel URL:", text.trim());
  };
  tun.stdout.on("data", parser);
  tun.stderr.on("data", parser);
});
