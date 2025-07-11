const express = require("express");
const cookieParser = require("cookie-parser");
const fs = require("fs");
const { spawn } = require("child_process");
const config = require("./config.json");

const BOT_TOKEN = config.BOT_TOKEN;
const CHANNEL = config.CHANNEL_ID;
const JOB_CHANNEL = config.JOB_CHANNEL || CHANNEL;
const DASH_PASS = config.DASHBOARD_PASSWORD || "secret";
const PORT = config.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

const STORAGE_FILE = "./storage.json";

const pending = new Map();
const sessions = new Map();
const lastSeen = new Map();
const completed = new Map();

if (!BOT_TOKEN || !CHANNEL) {
  console.error("❌ Missing BOT_TOKEN or CHANNEL_ID in config.json");
  process.exit(1);
}

// === Load saved data from storage.json ===
if (fs.existsSync(STORAGE_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(STORAGE_FILE));
    for (const item of data.completed || []) {
      completed.set(item.username.toLowerCase(), item);
    }
  } catch (e) {
    console.error("❌ Failed to load storage.json:", e);
  }
}

function saveStorage() {
  const data = {
    completed: Array.from(completed.values())
  };
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2));
}

// === Auth Middleware ===
function requireAuth(req, res, next) {
  const open = [
    "/status", "/status/", "/status/",
    "/login", "/login-submit",
    "/track", "/check", "/complete", "/bond", "/join", "/send-job", "/start-job"
  ];
  if (open.some(p => req.path.startsWith(p))) return next();
  if (req.cookies?.dash_auth === DASH_PASS) return next();
  return res.redirect("/login");
}
app.use(requireAuth);

// === Login Page ===
app.get("/login", (req, res) => {
  res.send(`
  <!DOCTYPE html><html><body style="margin:0;height:100vh;background:#18181b;color:#eee;display:flex;justify-content:center;align-items:center;font-family:sans-serif;">
    <form method="POST" action="/login-submit" style="display:flex;flex-direction:column;width:260px;">
      <input type="password" name="password" placeholder="Password" required
      style="padding:10px;margin:6px 0;border:none;border-radius:4px;background:#2a2a33;color:#eee;" />
      <button type="submit" style="padding:10px;background:#3b82f6;color:#fff;border:none;border-radius:4px;">Login</button>
    </form>
  </body></html>
  `);
});

app.post("/login-submit", (req, res) => {
  const pass = req.body.password;
  if (pass === DASH_PASS) {
    res.cookie("dash_auth", DASH_PASS, { httpOnly: true });
    return res.redirect("/dashboard");
  }
  res.send("❌ Wrong password. <a href='/login'>Try again</a>");
});

// === Dashboard ===
app.get("/dashboard", (req, res) => {
  const now = Date.now();

  const formatAmount = s => {
    if (s.type === "bonds") return `${s.currentBond || 0} bonds`;
    if (s.startTime && s.endTime) {
      const minutes = Math.round((s.endTime - s.startTime) / 60000);
      return `${minutes} min`;
    }
    return "-";
  };

  const renderRows = (items, type) => {
    if (items.length === 0) {
      return `<tr><td colspan="6" style="color:#aaa;text-align:center;">No ${type} sessions</td></tr>`;
    }

    return items.map(s => `
      <tr>
        <td>${s.username}</td>
        <td>${s.no_order || "-"}</td>
        <td>${s.nama_store || "-"}</td>
        <td>${s.type || "afk"}</td>
        <td>${formatAmount(s)}</td>
        <td>
          ${type === "active" ? `
            <form method="POST" action="/cancel-job">
              <input type="hidden" name="username" value="${s.username}" />
              <button style="padding:4px 8px;background:#ef4444;color:#fff;border:none;border-radius:4px;">✖</button>
            </form>
          ` : "–"}
        </td>
      </tr>
    `).join("");
  };

  const pendList = Array.from(pending.values());
  const activeList = Array.from(sessions.values());
  const completedList = Array.from(completed.values());

  res.send(`
<!DOCTYPE html><html><body style="margin:0;padding:20px;background:#18181b;color:#eee;font-family:sans-serif;">
<h1 style="text-align:center;">Joki Dashboard</h1>

<div style="max-width:500px;margin:20px auto;background:#1f1f25;padding:16px;border:1px solid #333;border-radius:8px;">
  <form id="jobForm" method="POST" action="/start-job" style="display:flex;flex-direction:column;">
    <input name="username" placeholder="Username" required style="padding:10px;margin:6px 0;background:#2a2a33;color:#eee;border:none;border-radius:4px;" />
    <input name="no_order" placeholder="Order ID" style="padding:10px;margin:6px 0;background:#2a2a33;color:#eee;border:none;border-radius:4px;" />
    <input name="nama_store" placeholder="Store Name" style="padding:10px;margin:6px 0;background:#2a2a33;color:#eee;border:none;border-radius:4px;" />
    <input name="jam_selesai_joki" type="number" step="any" placeholder="Hours (AFK only)" style="padding:10px;margin:6px 0;background:#2a2a33;color:#eee;border:none;border-radius:4px;" />
    <input name="target_bond" type="number" placeholder="Target Bonds (Bonds only)" style="padding:10px;margin:6px 0;background:#2a2a33;color:#eee;border:none;border-radius:4px;" />
    <select name="type" required style="padding:10px;margin:6px 0;background:#2a2a33;color:#eee;border:none;border-radius:4px;">
      <option value="afk">AFK</option>
      <option value="bonds">Bonds</option>
    </select>
    <button type="submit" style="padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:4px;">Start Job</button>
  </form>
</div>

<h2 style="text-align:center;">Pending Sessions</h2>
<table style="width:100%;max-width:900px;margin:auto;border-collapse:collapse;margin-bottom:40px;">
  <tr style="background:#2a2a33;">
    <th>Username</th><th>Order</th><th>Store</th><th>Type</th><th>Amount</th><th>Action</th>
  </tr>
  ${renderRows(pendList, "pending")}
</table>

<h2 style="text-align:center;">Active Sessions</h2>
<table style="width:100%;max-width:900px;margin:auto;border-collapse:collapse;margin-bottom:40px;">
  <tr style="background:#2a2a33;">
    <th>Username</th><th>Order</th><th>Store</th><th>Type</th><th>Amount</th><th>Action</th>
  </tr>
  ${renderRows(activeList, "active")}
</table>

<h2 style="text-align:center;">Completed Sessions</h2>
<table style="width:100%;max-width:900px;margin:auto;border-collapse:collapse;">
  <tr style="background:#2a2a33;">
    <th>Username</th><th>Order</th><th>Store</th><th>Type</th><th>Amount</th><th>Action</th>
  </tr>
  ${renderRows(completedList, "completed")}
</table>
</body></html>
  `);
});

// === Cancel Job ===
app.post("/cancel-job", (req, res) => {
  const u = req.body.username?.toLowerCase();
  if (!u) return res.redirect("/dashboard");
  pending.delete(u);
  sessions.delete(u);
  lastSeen.delete(u);
  res.redirect("/dashboard");
});

// === Track ===
app.post("/track", (req, res) => {
  const { username } = req.body;
  const user = username?.toLowerCase();
  if (!user) return res.status(400).json({ error: "Missing username" });

  if (sessions.has(user)) {
    lastSeen.set(user, Date.now());
    return res.json({ ok: true, resumed: true });
  }

  if (!pending.has(user)) return res.status(404).json({ error: "No pending job" });

  const job = pending.get(user);
  pending.delete(user);

  const session = {
    ...job,
    startTime: Date.now(),
    endTime: job.type === "afk"
      ? Date.now() + ((parseFloat(job.jam_selesai_joki) || 1) * 3600000)
      : undefined,
    messageId: null,
    currentBond: 0
  };

  sessions.set(user, session);
  lastSeen.set(user, Date.now());

  res.json({ ok: true, started: true, type: session.type });
});

// === Complete (AFK-type)
app.post("/complete", (req, res) => {
  const { username } = req.body;
  const user = username?.toLowerCase();
  const session = sessions.get(user);
  if (!session) return res.status(404).json({ error: "No session" });

  session.endTime = Date.now();
  completed.set(user, session);
  sessions.delete(user);
  lastSeen.delete(user);
  saveStorage();

  // Send webhook to Discord
  const clean = (session.no_order || "").replace(/^OD000000/, "");
  const embed = {
    embeds: [{
      title: "✅ **JOKI COMPLETED**",
      description:
        `**Username:** ${username}\n` +
        `**Order ID:** ${session.no_order || "-"}\n` +
        `[🔗 View Order](https://tokoku.itemku.com/riwayat-pesanan/rincian/${clean})\n\n` +
        `⏰ Completed at: <t:${Math.floor(Date.now() / 1000)}:f>`,
      footer: { text: `- ${session.nama_store || "Unknown Store"}` }
    }]
  };

  fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
    body: JSON.stringify(embed)
  }).catch(console.error);

  res.json({ ok: true });
});

// === Bond Endpoint
app.post("/bond", (req, res) => {
  const { username, bonds, placeId, alert } = req.body;
  const user = username?.toLowerCase();
  if (!user) return res.status(400).json({ error: "Missing username" });

  const session = sessions.get(user);
  if (!session) return res.status(404).json({ error: "No session for bond tracking" });

  session.currentBond = bonds;
  lastSeen.set(user, Date.now());

  if (alert === "lobby_idle") {
    fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
      body: JSON.stringify({
        content: `🔴 @everyone – **${username} has been idle in the lobby for 1 minute!**`
      })
    }).catch(console.error);
  }

  if (session.type === "bonds" && session.currentBond >= (session.target_bond || 0)) {
    session.endTime = Date.now();
    completed.set(user, session);
    sessions.delete(user);
    lastSeen.delete(user);
    saveStorage();

    const embed = {
      embeds: [{
        title: "✅ **BOND JOKI COMPLETED**",
        description: `**Username:** ${username}\n` +
          `📈 Bonds Gained: ${session.currentBond || 0}`,
        footer: { text: `- ${session.nama_store || "Unknown Store"}` }
      }]
    };

    fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
      body: JSON.stringify(embed)
    }).catch(console.error);
  }

  res.json({ ok: true });
});

app.post("/start-job", express.urlencoded({ extended: false }), (req, res) => {
  const {
    username,
    no_order,
    nama_store,
    jam_selesai_joki,
    target_bond,
    type
  } = req.body;

  if (!username || !no_order || !nama_store) {
    return res.status(400).send("Missing required fields");
  }

  const u = username.toLowerCase();
  const duration = parseFloat(jam_selesai_joki) || 0;
  const target = parseInt(target_bond) || 0;
  const jokiType = type || "afk";
  const endTime = Date.now() + (jokiType === "afk" ? duration * 3600000 : 999999999);

  pending.set(u, {
    username,
    no_order,
    nama_store,
    jam_selesai_joki: duration,
    target_bond: target,
    type: jokiType,
    startTime: null,
    endTime,
    status: "waiting"
  });

  // ✅ Redirect to dashboard after success
  res.redirect("/dashboard");
});

// === Status UI
app.get("/status", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      body {
        margin: 0;
        padding: 0;
        font-family: sans-serif;
        background: #18181b;
        color: #eee;
        display: flex;
        justify-content: center;
        align-items: center;
        min-height: 100vh;
      }

      .container {
        width: 90%;
        max-width: 480px;
        background: #1f1f25;
        border-radius: 10px;
        padding: 24px;
        box-shadow: 0 0 12px #00000050;
        text-align: center;
      }

      h1 {
        font-size: 24px;
        margin-bottom: 16px;
      }

      input {
        width: 100%;
        padding: 14px;
        font-size: 18px;
        margin-bottom: 16px;
        background: #2a2a33;
        color: #eee;
        border: none;
        border-radius: 6px;
      }

      button {
        width: 100%;
        padding: 14px;
        font-size: 18px;
        background: #3b82f6;
        color: #fff;
        border: none;
        border-radius: 6px;
        margin-bottom: 20px;
      }

      #r {
        font-size: 18px;
        line-height: 1.6;
      }

      a {
        color: #60a5fa;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Check Joki Status</h1>
      <input id="u" placeholder="Enter Username..." />
      <button onclick="check()">Check</button>
      <div id="r"></div>
    </div>

    <script>
      let interval;
      function fmtTime(s) {
        const h = Math.floor(s / 3600),
              m = Math.floor((s % 3600) / 60),
              sec = s % 60;
        return \`\${h}h \${m}m \${sec}s\`;
      }
      function fmtMS(ms) {
        const m = Math.floor(ms / 60000),
              s = Math.floor((ms % 60000) / 1000);
        return \`\${m}m \${s}s\`;
      }

      async function check() {
        const u = document.getElementById("u").value.trim().toLowerCase();
        const rDiv = document.getElementById("r");
        if (!u) return;

        async function update() {
          const d = await fetch("/status/" + u).then(r => r.json()).catch(() => null);
          if (!d || d.error) {
            rDiv.innerHTML = "<span style='color:#f87171;'>❌ No session found.</span>";
            clearInterval(interval);
            return;
          }

          if (d.status === "completed") {
            const clean = d.no_order?.replace(/^OD000000/, "") || "";
            rDiv.innerHTML = \`
              ✅ <strong>Joki Completed</strong><br>
              Order Number: \${d.no_order}<br>
              <a href="https://www.itemku.com/riwayat-pembelian/detail-pesanan/\${clean}" target="_blank">View Order</a><br>
              Thanks For Using \${d.nama_store} ❤️
            \`;
            clearInterval(interval);
          } else if (d.status === "pending") {
            rDiv.innerHTML = "⌛ <strong>" + u + "</strong> is waiting to start.";
          } else {
            const rem = Math.floor((d.endTime - Date.now()) / 1000);
            const ago = Date.now() - d.lastSeen;
            rDiv.innerHTML =
              '🧍 <strong>' + d.username + '</strong> is <span style="color:#34d399;">ONLINE</span><br>' +
              '🕒 Time left: ' + fmtTime(rem) + '<br>' +
              '👁️ Last Checked: ' + fmtMS(ago);
          }
        }

        clearInterval(interval);
        await update();
        interval = setInterval(update, 1000);
      }
    </script>
  </body>
</html>
  `);
});

// === Status API
app.get("/status/:username", (req, res) => {
  const u = req.params.username?.toLowerCase();
  if (sessions.has(u)) {
    const s = sessions.get(u);
    const seen = lastSeen.get(u);
    const offline = !seen || (Date.now() - seen > 180000);
    return res.json({
      username: s.username,
      status: "active",
      type: s.type,
      endTime: s.endTime,
      lastSeen: seen,
      offline
    });
  }
  if (pending.has(u)) return res.json({ username: u, status: "pending" });
  if (completed.has(u)) {
    const s = completed.get(u);
    return res.json({
      username: s.username,
      status: "completed",
      no_order: s.no_order,
      nama_store: s.nama_store
    });
  }
  res.status(404).json({ error: "No session" });
});

// === Send Job ID
app.post("/send-job", async (req, res) => {
  const { username, placeId, jobId, join_url } = req.body;
  const user = username?.toLowerCase();
  if (!user || !placeId || !jobId || !join_url) {
    return res.status(400).json({ error: "Missing data" });
  }

  const s = sessions.get(user);
  if (!s) return res.status(404).json({ error: "No active session" });

  // Send plain jobId as normal message
  await fetch(`https://discord.com/api/v10/channels/${JOB_CHANNEL}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
    body: JSON.stringify({ content: `🧩 \`${jobId}\`` })
  }).catch(console.error);

  // Send embed message
  const embed = {
    embeds: [{
      title: `🧩 Job ID for ${username}`,
      description: `**Place ID:** \`${placeId}\`\n**Job ID:** \`${jobId}\``,
      color: 0x3498db,
      fields: [{ name: "Join Link", value: `[Click to Join](${join_url})` }]
    }]
  };

  fetch(`https://discord.com/api/v10/channels/${JOB_CHANNEL}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
    body: JSON.stringify(embed)
  }).catch(console.error);

  res.json({ ok: true });
});

// === /join: Roblox mobile redirect
app.get("/join", (req, res) => {
  const { place, job } = req.query;
  if (!place || !job) return res.status(400).send("Missing place/job");
  const uri = `roblox://experiences/start?placeId=${place}&gameId=${job}`;
  res.send(`
  <!DOCTYPE html><html><body style="background:#18181b;color:#eee;display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;">
    <div style="text-align:center;">
      <h1>🔗 Redirecting to Roblox...</h1>
      <a href="${uri}" style="color:#3b82f6;">Tap here if not redirected</a>
    </div>
    <script>setTimeout(() => { location.href = "${uri}" }, 1500)</script>
  </body></html>`);
});

// === Watchdog (3-min heartbeat)
setInterval(() => {
  const now = Date.now();
  sessions.forEach((s, u) => {
    const seen = lastSeen.get(u) || 0;

    if (!s.warned && s.endTime && now > s.endTime) {
      fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
        body: JSON.stringify({ content: `⏳ ${s.username}'s joki ended.` })
      }).catch(console.error);
      s.warned = true;
    }

    if (!s.offline && now - seen > 180000) {
      fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
        body: JSON.stringify({ content: `🔴 @everyone – **${s.username} is OFFLINE.** No heartbeat in 3 minutes.` })
      }).catch(console.error);
      s.offline = true;
    }

    // Reset offline status if resumed
    if (s.offline && now - seen <= 180000) {
      s.offline = false;
    }
  });
}, 60000);

// === Start Server
app.listen(PORT, () => {
  console.log(`✅ Proxy running on http://localhost:${PORT}`);
  console.log(`🌐 To expose via Cloudflare:\ncloudflared tunnel --url http://localhost:${PORT}`);
});