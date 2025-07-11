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
app.use(cookieParser());

const failedLogins = new Map();
const pending = new Map();    // username → pending config
const sessions = new Map();   // username → active
const completed = new Map();  // username → completed
const lastSeen = new Map();   // username → timestamp

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
  let html = `
  <html>
  <head>
    <title>Joki Dashboard</title>
    <style>
      body { background: #0f0f0f; color: white; font-family: sans-serif; padding: 2rem; }
      input, select { background: #1f1f1f; color: white; border: 1px solid #333; padding: 5px; }
      table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
      th, td { border: 1px solid #333; padding: 8px; text-align: center; }
      .config-inputs { display: flex; gap: 1rem; margin-bottom: 1rem; }
    </style>
  </head>
  <body>
    <h1>Joki Dashboard</h1>

    <form action="/start-job" method="POST">
      <div class="config-inputs">
        <input name="username" placeholder="Username" required>
        <input name="order" placeholder="Order Number" required>
        <input name="store" placeholder="Store Name" required>
        <select name="type">
          <option value="afk">AFK</option>
          <option value="bonds">Bonds</option>
        </select>
        <input name="hour" placeholder="Hour (for AFK)">
        <input name="targetBond" placeholder="Target Bond (for Bonds)">
        <button type="submit">Start Job</button>
      </div>
    </form>
`;

  function row(d, type = "pending") {
    let extra = "";
    let bondInfo = "";
    if (d.type === "bonds") {
      bondInfo = `${d.currentBond || 0} / ${d.targetBond}`;
      if (type === "completed") extra = `<td>${new Date(d.completedAt).toLocaleString()}</td>`;
      else extra = `<td>${bondInfo}</td>`;
    } else {
      if (type === "active") {
        const timeLeft = Math.max(0, d.endTime - Date.now());
        extra = `<td>${Math.floor(timeLeft / 1000)}s</td>`;
      } else if (type === "completed") {
        extra = `<td>${new Date(d.completedAt).toLocaleString()}</td>`;
      } else extra = `<td>—</td>`;
    }

    const cancel = type === "active" ? `<td><form action="/cancel-job" method="POST"><input type="hidden" name="username" value="${d.username}"><button type="submit">Cancel</button></form></td>` : "<td>—</td>";

    return `
      <tr>
        <td>${d.username}</td>
        <td>${d.store}</td>
        <td>${d.order}</td>
        <td>${d.type}</td>
        ${extra}
        ${cancel}
      </tr>`;
  }

  html += `<h2>Pending Sessions</h2><table><tr><th>Username</th><th>Store</th><th>Order</th><th>Type</th><th>Info</th><th>Action</th></tr>`;
  for (const d of pending.values()) html += row(d, "pending");
  html += `</table>`;

  html += `<h2>Active Sessions</h2><table><tr><th>Username</th><th>Store</th><th>Order</th><th>Type</th><th>Time Left / Bond</th><th>Action</th></tr>`;
  for (const d of sessions.values()) html += row(d, "active");
  html += `</table>`;

  html += `<h2>Completed Sessions</h2>
  <input id="search" placeholder="Search by username..." oninput="searchTable()" style="margin:10px 0;width:100%;">
  <table id="completed-table"><tr><th>Username</th><th>Store</th><th>Order</th><th>Type</th><th>Date</th><th>Action</th></tr>`;
  for (const d of completed.values()) html += row(d, "completed");
  html += `</table>`;

  html += `
  <script>
    function searchTable() {
      const value = document.getElementById("search").value.toLowerCase();
      const rows = document.querySelectorAll("#completed-table tr");
      for (let i = 1; i < rows.length; i++) {
        const rowText = rows[i].innerText.toLowerCase();
        rows[i].style.display = rowText.includes(value) ? "" : "none";
      }
    }
  </script>
  </body></html>`;

  res.send(html);
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