const express = require("express");
const cookieParser = require("cookie-parser");
const { spawn } = require("child_process");
const config = require("./config.json");
const fetch = (...args) => import("node-fetch").then(m => m.default(...args));

const BOT_TOKEN = config.BOT_TOKEN;
const CHANNEL = config.CHANNEL_ID;
const JOB_CHANNEL = config.JOB_CHANNEL_ID || CHANNEL;
const DASH_PASS = config.DASHBOARD_PASSWORD || "secret";

if (!BOT_TOKEN || !CHANNEL) {
  console.error("❌ BOT_TOKEN or CHANNEL_ID missing");
  process.exit(1);
}

const PORT = 3000;
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

const fs = require("fs");
const STORAGE_FILE = "./storage.json";
const pending = new Map();
const sessions = new Map();
const lastSeen = new Map();
const completed = new Map();

// Load from storage.json if it exists
if (fs.existsSync(STORAGE_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(STORAGE_FILE));
    for (const item of data.completed || []) {
      completed.set(item.username, item);
    }
  } catch (err) {
    console.error("❌ Failed to load storage.json:", err.message);
  }
}

function requireAuth(req, res, next) {
  const open = [
    "/bond", "/check", "/complete", "/send-job",
    "/status", "/status/", "/join", "/login", "/login-submit"
  ];
  if (open.some(p => req.path.startsWith(p))) return next();
  if (req.cookies.dash_auth === DASH_PASS) return next();
  return res.redirect("/login");
}
app.use(requireAuth);

app.get("/dashboard", (req, res) => {
  const now = Date.now();

  function renderRow(d, type) {
    let info = "–";
    if (d.type === "bonds") {
      info = `${d.currentBond || 0} / ${d.targetBond}`;
    } else if (d.type === "afk" && type === "active") {
      const timeLeft = Math.max(0, Math.floor((d.endTime - now) / 60000));
      info = `${timeLeft} min`;
    } else if (type === "completed") {
      info = new Date(d.completedAt || now).toLocaleString();
    }

    const cancelBtn = type === "active"
      ? `<form method="POST" action="/cancel-job"><input type="hidden" name="username" value="${d.username}"><button class="cancel">✖</button></form>`
      : "–";

    return `
      <tr>
        <td>${d.username}</td>
        <td>${d.order}</td>
        <td>${d.store}</td>
        <td>${d.type}</td>
        <td>${info}</td>
        <td>${cancelBtn}</td>
      </tr>`;
  }

  const renderTable = (label, list, type) => `
    <h3>${label}</h3>
    <table>
      <thead><tr><th>User</th><th>Order</th><th>Store</th><th>Type</th><th>${type === "completed" ? "Date" : "Info"}</th><th>Action</th></tr></thead>
      <tbody>
        ${list.length ? list.map(d => renderRow(d, type)).join("") : `<tr><td colspan="6" class="empty">No ${label.toLowerCase()}.</td></tr>`}
      </tbody>
    </table>`;

  const pendingList = Array.from(pending.values());
  const activeList = Array.from(sessions.values());
  const completedList = Array.from(completed.values());

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      background: #18181b;
      color: #eee;
      font-family: sans-serif;
      margin: 0;
      padding: 1rem;
    }
    h1, h3 {
      text-align: center;
    }
    form.config {
      max-width: 500px;
      margin: 1rem auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    input, select, button {
      padding: 10px;
      font-size: 16px;
      border-radius: 6px;
      border: none;
    }
    input, select {
      background: #2a2a33;
      color: white;
    }
    button {
      background: #3b82f6;
      color: white;
      font-weight: bold;
      cursor: pointer;
    }
    button.cancel {
      background: #ef4444;
      padding: 4px 10px;
      font-size: 14px;
    }
    table {
      width: 100%;
      margin-top: 1rem;
      border-collapse: collapse;
      font-size: 15px;
    }
    th, td {
      padding: 10px;
      border: 1px solid #333;
      text-align: center;
    }
    .empty {
      color: #aaa;
      text-align: center;
    }
  </style>
</head>
<body>
  <h1>Joki Dashboard</h1>

  <form class="config" method="POST" action="/start-job">
    <input name="username" placeholder="Username" required>
    <input name="order" placeholder="Order ID" required>
    <input name="store" placeholder="Store Name" required>
    <select name="type">
      <option value="afk">AFK</option>
      <option value="bonds">Bonds</option>
    </select>
    <input name="hour" placeholder="Hours (AFK only)">
    <input name="targetBond" placeholder="Bond Goal (Bonds only)">
    <button type="submit">Start Session</button>
  </form>

  <div style="max-width: 1000px; margin: 0 auto;">
    ${renderTable("Pending Sessions", pendingList, "pending")}
    ${renderTable("Active Sessions", activeList, "active")}
    ${renderTable("Completed Sessions", completedList, "completed")}
  </div>
</body>
</html>
`);
});

// --- /login page ---
app.get("/login", (req, res) => {
  res.send(`
<!DOCTYPE html><html><body style="margin:0;padding:0;height:100vh;background:#18181b;color:#eee;display:flex;justify-content:center;align-items:center;font-family:sans-serif;">
<form method="POST" action="/login-submit" style="display:flex;flex-direction:column;width:260px;">
<input type="password" name="password" placeholder="Password" required
style="padding:10px;margin:6px 0;border:none;border-radius:4px;background:#2a2a33;color:#eee;"/>
<button type="submit" style="padding:10px;background:#3b82f6;color:#fff;border:none;border-radius:4px;">Login</button>
</form>
</body></html>`);
});

// --- /login-submit handler ---
app.post("/login-submit", express.urlencoded({ extended: false }), (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const pass = req.body.password;
  const rec = failedLogins.get(ip) || { count: 0, last: 0 };

  if (rec.count >= 10 && Date.now() - rec.last < 5 * 60 * 1000) {
    return res.send("⛔ Too many attempts! Try again later.");
  }

  if (pass === DASH_PASS) {
    res.cookie("dash_auth", DASH_PASS, { httpOnly: true });
    failedLogins.delete(ip);
    return res.redirect("/dashboard");
  }

  failedLogins.set(ip, { count: rec.count + 1, last: Date.now() });
  res.send("❌ Invalid password. <a href='/login'>Retry</a>");
});

app.post("/start-job", (req, res) => {
  const { username, order, store, hour, targetBond, type } = req.body;
  const key = username.toLowerCase();
  const job = {
    username,
    order,
    store,
    type: type === "bonds" ? "bonds" : "afk"
  };

  if (job.type === "afk") {
    const hours = parseFloat(hour) || 1;
    job.endTime = Date.now() + hours * 3600000;
  } else {
    job.targetBond = parseInt(targetBond) || 0;
    job.currentBond = 0;
  }

  pending.set(key, job);
  res.redirect("/dashboard");
});

app.post("/cancel-job", (req, res) => {
  const { username } = req.body;
  const key = username.toLowerCase();
  pending.delete(key);
  sessions.delete(key);
  completed.delete(key);
  lastSeen.delete(key);
  res.redirect("/dashboard");
});

app.post("/send-job", (req, res) => {
  const { username, placeId, jobId, join_url } = req.body;
  const key = username.toLowerCase();
  const s = sessions.get(key);
  if (!s) return res.status(404).json({ error: "No session" });

  const embed = {
    content: `\`\`${jobId}\`\``,
    embeds: [{
      title: `🧩 Job ID for ${username}`,
      description: `**Place ID:** \`${placeId}\`\n**Job ID:** \`${jobId}\``,
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

app.post("/bond", async (req, res) => {
  const { username, bonds, placeId, alert } = req.body;
  const key = username.toLowerCase();

  // 🔔 Lobby Idle Alert
  if (alert === "lobby_idle") {
    const u = sessions.get(key) || pending.get(key);
    if (u) {
      await fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
        body: JSON.stringify({
          content: `🔴 @everyone — **${username}** has been idle in lobby for more than 1 minute!`
        })
      }).catch(console.error);
    }
    return res.json({ ok: true });
  }

  // Ignore if bonds not provided
  if (typeof bonds !== "number") {
    return res.status(400).json({ error: "Missing bond count" });
  }

  // 🎯 If session not started, move from pending → sessions
  if (!sessions.has(key)) {
    const job = pending.get(key);
    if (!job) return res.status(404).json({ error: "No pending job" });

    pending.delete(key);
    const session = {
      ...job,
      type: "bonds",
      startBonds: bonds,
      currentBond: bonds,
      placeId,
      startTime: Date.now(),
      completedAt: null,
      warned: false,
      offline: false
    };
    sessions.set(key, session);
    lastSeen.set(key, Date.now());

    // 🟢 Start webhook
    const embed = {
      embeds: [{
        title: "📊 **Bond Joki Started**",
        description:
          `**Username:** ${username}\n` +
          `**Order ID:** ${job.order}\n` +
          `**Target Bonds:** ${job.targetBond}\n` +
          `**Starting Bonds:** ${bonds}\n\n` +
          `Store: ${job.store || "-"}\nStarted at <t:${Math.floor(Date.now() / 1000)}:F>`
      }]
    };

    await fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
      body: JSON.stringify(embed)
    }).catch(console.error);

    return res.json({ ok: true, started: true });
  }

  // ✅ Update session progress
  const session = sessions.get(key);
  session.currentBond = bonds;
  session.placeId = placeId;
  lastSeen.set(key, Date.now());

  // ✅ Check for bond goal completion
  if (!session.completedAt && session.targetBond && (bonds - session.startBonds >= session.targetBond)) {
    session.completedAt = Date.now();
    sessions.delete(key);
    completed.set(key, session);

    // ✅ Completion webhook
    const embed = {
      embeds: [{
        title: "✅ **Bond Joki Completed**",
        description:
          `**Username:** ${username}\n` +
          `**Order ID:** ${session.order}\n` +
          `**Final Bonds:** ${bonds} / ${session.targetBond}\n\n` +
          `✅ Thanks for using ${session.store || "-"}\nCompleted at <t:${Math.floor(Date.now() / 1000)}:F>`
      }]
    };

    await fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
      body: JSON.stringify(embed)
    }).catch(console.error);
  }

  res.json({ ok: true, progress: bonds });
});

app.get("/status/:username", (req, res) => {
  const u = req.params.username.toLowerCase();

  if (sessions.has(u)) {
    const s = sessions.get(u);
    const last = lastSeen.get(u) || 0;
    const now = Date.now();
    const offline = now - last > 3 * 60 * 1000;

    const base = {
      username: s.username,
      store: s.store,
      order: s.order,
      type: s.type,
      placeId: s.placeId || null,
      lastSeen: offline ? "offline" : last,
      status: offline ? "offline" : "online"
    };

    if (s.type === "bonds") {
      base.startBonds = s.startBonds || 0;
      base.currentBond = s.currentBond || 0;
      base.bondGoal = s.targetBond;
    } else if (s.type === "afk") {
      base.endTime = s.endTime;
    }

    return res.json(base);
  }

  if (pending.has(u)) {
    const p = pending.get(u);
    return res.json({
      username: p.username,
      status: "pending",
      type: p.type,
      store: p.store,
      order: p.order
    });
  }

  if (completed.has(u)) {
    const c = completed.get(u);
    const result = {
      username: c.username,
      status: "completed",
      type: c.type,
      completedAt: c.completedAt,
      store: c.store,
      order: c.order
    };

    if (c.type === "bonds") {
      result.bondGoal = c.targetBond;
      result.totalBonds = c.currentBond || c.startBonds || 0;
    }

    return res.json(result);
  }

  res.status(404).json({ error: `No session for ${req.params.username}` });
});

// --- /complete (for AFK sessions) ---
app.post("/complete", (req, res) => {
  const { username } = req.body;
  const key = username.toLowerCase();
  const s = sessions.get(key);
  if (!s) return res.status(404).json({ error: "No session" });

  if (s.type !== "afk") {
    return res.status(400).json({ error: "Not an AFK-type session" });
  }

  const now = Date.now();
  s.completedAt = now;
  sessions.delete(key);
  lastSeen.delete(key);
  completed.set(key, s);

  const clean = s.order?.replace(/^OD000000/, "") || s.order || "unknown";

  const embed = {
    embeds: [{
      title: "✅ **AFK Joki Completed**",
      description:
        `**Username:** ${s.username}\n` +
        `**Order ID:** ${s.order}\n` +
        `[🔗 View Order](https://www.itemku.com/riwayat-pembelian/detail-pesanan/${clean})\n\n` +
        `✅ Completed at <t:${Math.floor(now / 1000)}:F>`,
      footer: { text: `- ${s.store || "Store"}` }
    }]
  };

  fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
    body: JSON.stringify(embed)
  }).catch(console.error);

  res.json({ ok: true });
});

app.get("/status", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Joki Status</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      height: 100vh;
      background: #18181b;
      color: #eee;
      display: flex;
      justify-content: center;
      align-items: center;
      font-family: sans-serif;
    }
    .container {
      width: 100%;
      max-width: 400px;
      text-align: center;
    }
    input {
      width: 80%;
      padding: 12px;
      font-size: 18px;
      margin-top: 12px;
      border: none;
      border-radius: 4px;
      background: #2a2a33;
      color: #eee;
    }
    button {
      margin: 12px;
      padding: 12px 20px;
      font-size: 18px;
      background: #3b82f6;
      color: #fff;
      border: none;
      border-radius: 4px;
    }
    #r {
      margin-top: 24px;
      font-size: 20px;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Check Joki Status</h1>
    <input id="u" placeholder="Username"/>
    <button onclick="check()">Check</button>
    <div id="r"></div>
  </div>
  <script>
    let interval = null;

    function fmtTime(s) {
      const h = Math.floor(s/3600), m = Math.floor((s%3600)/60)%60, sec = s % 60;
      return \`\${h}h \${m}m \${sec}s\`;
    }

    function fmtMS(ms) {
      const m = Math.floor(ms/60000), s = Math.floor((ms%60000)/1000)%60;
      return \`\${m}m \${s}s\`;
    }

    async function check() {
      const u = document.getElementById("u").value.trim().toLowerCase();
      if (!u) return;
      if (interval) clearInterval(interval);
      const rDiv = document.getElementById("r");

      async function update() {
        const d = await fetch("/status/" + u).then(r => r.json()).catch(() => null);
        if (!d || d.error) {
          rDiv.innerHTML = '<span style="color:#f87171;">❌ Not found</span>';
          if (interval) clearInterval(interval);
          return;
        }

        if (d.status === "completed") {
          if (d.type === "bonds") {
            rDiv.innerHTML = \`
              ✅ Joki Completed ✅<br>
              Order Number : \${d.order}<br>
              Bonds Gained: \${d.totalBonds} / \${d.bondGoal}<br>
              Thanks For Using \${d.store} ❤️
            \`;
          } else {
            const clean = d.order.replace(/^OD000000/, "");
            rDiv.innerHTML = \`
              ✅ Joki Completed ✅<br>
              Order Number : \${d.order}<br>
              <a href="https://www.itemku.com/riwayat-pembelian/detail-pesanan/\${clean}" style="color:#3b82f6;">View Order</a><br>
              Thanks For Using \${d.store} ❤️
            \`;
          }
          clearInterval(interval);
          return;
        }

        if (d.status === "pending") {
          rDiv.innerHTML = \`⌛ <strong>\${d.username}</strong> is pending to start.<br>Store: \${d.store}<br>Order: \${d.order}\`;
          return;
        }

        if (d.status === "offline") {
          rDiv.innerHTML = \`
            🧍 <strong>\${d.username}</strong> is <span style="color:#f87171;">OFFLINE</span><br>
            Last Seen: 3+ min ago
          \`;
          return;
        }

        if (d.type === "bonds") {
          const goal = d.bondGoal || 0;
          const now = d.currentBond || 0;
          const pct = Math.min(100, Math.floor((now - d.startBonds) / goal * 100));
          rDiv.innerHTML = \`
            🧍 <strong>\${d.username}</strong> is <span style="color:#34d399;">ONLINE</span><br>
            🎯 Bond Goal: \${now} / \${goal} (\${pct}% complete)<br>
            📍 Place ID: \${d.placeId}
          \`;
        } else {
          const rem = Math.floor((d.endTime - Date.now()) / 1000);
          const ago = Date.now() - d.lastSeen;
          rDiv.innerHTML = \`
            🧍 <strong>\${d.username}</strong> is <span style="color:#34d399;">ONLINE</span><br>
            🕒 Time left: \${fmtTime(rem)}<br>
            👁️ Last Checked: \${fmtMS(ago)}
          \`;
        }
      }

      update();
      interval = setInterval(update, 1000);
    }
  </script>
</body>
</html>
`);
});

// --- /join redirect ---
app.get("/join", (req, res) => {
  const { place, job } = req.query;
  if (!place || !job) return res.status(400).send("Missing place/job");
  const uri = `roblox://experiences/start?placeId=${place}&gameId=${job}`;
  res.send(`
<!DOCTYPE html><html><body style="margin:0;padding:0;height:100vh;background:#18181b;color:#eee;display:flex;justify-content:center;align-items:center;font-family:sans-serif;">
  <div style="text-align:center;">
    <h1>🔗 Redirecting ...</h1>
    <a href="${uri}" style="color:#3b82f6;">Tap here if not redirected</a>
  </div>
  <script>setTimeout(() => { location.href = "${uri}" }, 1000);</script>
</body></html>`);
});

// --- Watchdog for AFK & Bond Sessions ---
setInterval(() => {
  const now = Date.now();
  sessions.forEach((s, u) => {
    const seen = lastSeen.get(u) || 0;

    if (!s.warned && s.type === "afk" && now > s.endTime) {
      fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
        body: JSON.stringify({ content: `⏳ ${u}'s AFK session ended.` })
      }).catch(console.error);
      s.warned = true;
    }

    if (!s.offline && now - seen > 3 * 60 * 1000) {
      fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
        body: JSON.stringify({ content: `🔴 @everyone – **${u} is OFFLINE.** No heartbeat in 3 minutes.` })
      }).catch(console.error);
      s.offline = true;
    }
  });
}, 60 * 1000);

// --- Start Server (no cloudflare)
app.listen(PORT, () => {
  console.log(`✅ Proxy live on http://localhost:${PORT}`);
  console.log(`🔗 Run this in another terminal to expose:\n`);
  console.log(`   cloudflared tunnel --url http://localhost:${PORT}`);
});