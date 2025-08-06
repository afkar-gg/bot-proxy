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
  const redirectTo = req.query.redirect || "/";
  const errorMsg = req.query.error === "1" ? "❌ Password salah!" : "";

  res.send(`
  <!DOCTYPE html>
  <html lang="id">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Login</title>
    <style>
      body {
        margin: 0;
        height: 100vh;
        background: linear-gradient(135deg, #1e3a8a, #9333ea);
        color: #eee;
        display: flex;
        justify-content: center;
        align-items: center;
        font-family: 'Segoe UI', sans-serif;
      }
      .form-container {
        background: #1f1f25;
        padding: 24px;
        border-radius: 12px;
        width: 90%;
        max-width: 320px;
        box-shadow: 0 4px 18px #0006;
      }
      .error {
        color: #f87171;
        margin-bottom: 12px;
        text-align: center;
        font-weight: bold;
      }
      .form-container input,
      .form-container button {
        width: 100%;
        padding: 12px;
        margin: 10px 0 0;
        border: none;
        border-radius: 6px;
        font-size: 16px;
        box-sizing: border-box;
      }
      input {
        background: #2a2a33;
        color: #eee;
      }
      button {
        background: #3b82f6;
        color: #fff;
        cursor: pointer;
        font-weight: bold;
        margin-top: 14px;
      }
    </style>
  </head>
  <body>
    <form class="form-container" method="POST" action="/login-submit?redirect=${encodeURIComponent(redirectTo)}">
      <h2 style="margin-bottom: 10px; text-align:center;">🔐 Dashboard Login</h2>
      ${errorMsg ? `<div class="error">${errorMsg}</div>` : ""}
      <input type="password" name="password" placeholder="Enter password" required />
      <button type="submit">Login</button>
    </form>
  </body>
  </html>
  `);
});

app.post("/login-submit", express.urlencoded({ extended: true }), (req, res) => {
  const { password } = req.body;
  const redirectTo = req.query.redirect || "/";

  if (password !== DASH_PASS) {
    // Redirect back with error message
    return res.redirect(`/login?redirect=${encodeURIComponent(redirectTo)}&error=1`);
  }

  res.cookie("dash_auth", DASH_PASS, { httpOnly: true });
  res.redirect(redirectTo);
});

// === Dashboard ===
app.get("/dashboard", (req, res) => {
  const now = Date.now();

  const formatAmount = s => {
    if (s.type === "bonds") return `${s.current_bonds - s.start_bonds || 0} bonds`;
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
            <form method="GET" action="/cancel/${s.username}">
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
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard</title>
  <style>
    body {
      margin: 0;
      padding: 20px;
      background: #18181b;
      color: #ececec;
      font-family: 'Inter', Arial, sans-serif;
    }
    .container {
      max-width: 1000px;
      margin: auto;
    }
    h1 {
      color: #3b82f6;
      text-align: center;
    }
    .card {
      background: #23232b;
      padding: 20px;
      margin-bottom: 20px;
      border-radius: 14px;
      box-shadow: 0 2px 16px #0006;
    }
    input, select, button {
      width: 100%;
      padding: 10px;
      margin-top: 8px;
      border: none;
      border-radius: 6px;
      background: #2a2a33;
      color: #eee;
      font-size: 14px;
    }
    button {
      background: #3b82f6;
      font-weight: bold;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 16px;
      font-size: 14px;
    }
    th, td {
      padding: 10px;
      border-bottom: 1px solid #333;
      text-align: left;
    }
    th {
      background: #2a2a33;
      color: #eee;
    }
    @media (max-width: 768px) {
      body {
        padding: 10px;
      }
      input, select, button {
        font-size: 16px;
      }
      table {
        font-size: 12px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Joki Dashboard</h1>

    <div class="card">
      <h2>Buat Job Baru</h2>
      <form id="jobForm">
        <input name="username" placeholder="Username" required />
        <input name="no_order" placeholder="Order ID" required />
        <input name="nama_store" placeholder="Nama Store" required />
        <input name="jam_selesai_joki" type="number" step="any" placeholder="Durasi (jam)" />
        <input name="target_bond" type="number" placeholder="Target Bond (untuk bonds)" />
        <select name="type" required>
          <option value="afk">AFK</option>
          <option value="bonds">Bonds</option>
        </select>
        <button type="submit">🚀 Mulai Job</button>
      </form>
    </div>

    <div class="card">
      <h2>Pending Jobs</h2>
      <div style="overflow-x:auto;">
        <table>
          <tr>
            <th>Username</th>
            <th>Order</th>
            <th>Store</th>
            <th>Type</th>
            <th>Info</th>
            <th>Action</th>
          </tr>
          ${renderRows(pendList, "pending")}
        </table>
      </div>
    </div>

    <div class="card">
      <h2>Active Jobs</h2>
      <div style="overflow-x:auto;">
        <table>
          <tr>
            <th>Username</th>
            <th>Order</th>
            <th>Store</th>
            <th>Type</th>
            <th>Info</th>
            <th>Action</th>
          </tr>
          ${renderRows(activeList, "active")}
        </table>
      </div>
    </div>

    <div class="card">
      <h2>Completed Jobs</h2>
      <div style="overflow-x:auto;">
        <table>
          <tr>
            <th>Username</th>
            <th>Order</th>
            <th>Store</th>
            <th>Type</th>
            <th>Info</th>
            <th>Action</th>
          </tr>
          ${renderRows(completedList, "completed")}
        </table>
      </div>
    </div>
  </div>

  <script>
    document.getElementById("jobForm").onsubmit = async e => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target));
      await fetch("/start-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });
      location.reload();
    };
  </script>
</body>
</html>
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

app.get("/cancel/:username", (req, res) => {
  const u = req.params.username.toLowerCase();
  pending.delete(u);
  sessions.delete(u);
  lastSeen.delete(u);
  completed.delete(u);
  res.redirect("/dashboard");
});

// === Track ===
app.post("/track", (req, res) => {
  const { username } = req.body;
  const user = username.toLowerCase();

  if (sessions.has(user)) {
    lastSeen.set(user, Date.now());
    return res.json({ ok: true, endTime: sessions.get(user).endTime });
  }

  if (!pending.has(user)) return res.status(404).json({ error: "No pending job" });

  const job = pending.get(user);
  pending.delete(user);

  const session = {
    ...job,
    startTime: Date.now(),
    warned: false,
    offline: false,
    bonds: 0,
    startBonds: 0
  };

  sessions.set(user, session);
  lastSeen.set(user, Date.now());

  // Optionally send a start webhook
  res.json({ ok: true, endTime: session.endTime });
});

app.post("/check", (req, res) => {
  const { username } = req.body;
  const user = username.toLowerCase();

  const s = sessions.get(user);
  if (!s) return res.status(404).json({ error: "No active session" });

  lastSeen.set(user, Date.now());

  fetch(`https://discord.com/api/v10/channels/${s.channel}/messages/${s.messageId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${BOT_TOKEN}`
    },
    body: JSON.stringify({
      content: `🟢 Online — Last Checked: <t:${Math.floor(Date.now() / 1000)}:R>`
    })
  }).catch(console.error);

  res.json({ ok: true });
});

// === Complete (AFK-type)
app.post("/complete", (req, res) => {
  const { username } = req.body;
  const user = username.toLowerCase();
  const s = sessions.get(user);
  if (!s) return res.status(404).json({ error: "No session" });

  const now = Math.floor(Date.now() / 1000);
  const clean = s.no_order.replace(/^OD000000/, "");

  const embed = {
    embeds: [{
      title: "✅ **JOKI COMPLETED**",
      description:
        `**Username:** ${s.username}\n` +
        `**Order ID:** ${s.no_order}\n` +
        `[🔗 View Order](https://tokoku.itemku.com/riwayat-pesanan/rincian/${clean})\n\n` +
        `⏰ Completed at: <t:${now}:f>`,
      footer: { text: `- ${s.nama_store}` }
    }]
  };

  fetch(`https://discord.com/api/v10/channels/${s.channel}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${BOT_TOKEN}`
    },
    body: JSON.stringify(embed)
  }).catch(console.error);

  sessions.delete(user);
  lastSeen.delete(user);
  completed.set(user, s);
  res.json({ ok: true });
});


// === Bond Endpoint
app.post("/bond", async (req, res) => {
  const { username, bonds, placeId, alert } = req.body;
  if (!username) return res.status(400).json({ error: "Missing username" });

  const user = username.toLowerCase();
  const session = sessions.get(user);

  // 🟡 Handle idle alert from lobby
  if (alert === "lobby_idle") {
    await fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
      body: JSON.stringify({
        content: `⚠️ @everyone ${username} has been idle in the lobby for too long.`
      })
    }).catch(console.error);
    return res.json({ ok: true, alert: "idle_sent" });
  }

  // 🟢 Update active session
  if (session) {
    session.lastPlaceId = placeId;
    session.bonds = bonds;
    if (session.startBonds === undefined) {
      session.startBonds = bonds;
    }

    // Check if bond goal met
    if (session.type === "bonds" && session.target_bond && (bonds - session.startBonds >= session.target_bond)) {
      const now = Math.floor(Date.now() / 1000);
      const clean = session.no_order.replace(/^OD000000/, "");

      // Send Discord message
      await fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
        body: JSON.stringify({
          embeds: [{
            title: "✅ **JOKI COMPLETED**",
            description:
              `**Username:** ${username}\n` +
              `**Order ID:** ${session.no_order}\n` +
              `[🔗 View Order](https://tokoku.itemku.com/riwayat-pesanan/rincian/${clean})\n\n` +
              `📈 Final Bonds: ${bonds}`,
            footer: { text: `- ${session.nama_store}` },
            timestamp: new Date().toISOString()
          }]
        })
      }).catch(console.error);

      completed.set(user, {
        ...session,
        amount: `${bonds - session.startBonds} bonds`,
        status: "completed"
      });
      sessions.delete(user);
      lastSeen.delete(user);
      saveStorage();

      return res.json({ ok: true, completed: true });
    }

    // Normal update
    lastSeen.set(user, Date.now());
    return res.json({ ok: true });
  }

  // 🔴 If no active session, log anyway
  const embed = {
    embeds: [{
      title: "🎮 **Bond Tracker**",
      description:
        `**Username:** ${username}\n` +
        `**Bonds:** ${bonds}\n` +
        `**Status:** ${
          placeId == "70876832253163" ? "Getting Bonds" :
          placeId == "116495829188952" ? "In Lobby" : "Unknown"
        }`,
      footer: { text: `Place ID: ${placeId}` },
      timestamp: new Date().toISOString()
    }]
  };

  await fetch(`https://discord.com/api/v10/channels/${JOB_CHANNEL}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
    body: JSON.stringify(embed)
  }).catch(console.error);

  res.json({ ok: true });
});

app.post("/start-job", (req, res) => {
  const { username, no_order, nama_store, jam_selesai_joki, target_bond, joki_type } = req.body;
  const user = username.toLowerCase();
  const now = Date.now();
  const endTime = now + (Number(jam_selesai_joki) || 1) * 3600000;

  pending.set(user, {
    username,
    no_order,
    nama_store,
    joki_type: type || "afk",
    endTime,
    target_bond: Number(target_bond) || 0,
    status: "PENDING",
    created: now
  });

  res.redirect("/dashboard");
});

// === Status UI
app.get("/status", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Status Checker</title>
    <style>
      body {
        margin: 0;
        padding: 20px;
        height: 100vh;
        background: #18181b;
        color: #eee;
        display: flex;
        justify-content: center;
        align-items: center;
        font-family: sans-serif;
      }
      #container {
        width: 100%;
        max-width: 420px;
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
        cursor: pointer;
      }
      #r {
        margin-top: 24px;
        font-size: 18px;
        line-height: 1.5;
      }
    </style>
  </head>
  <body>
    <div id="container">
      <h1>Check Joki Status</h1>
      <input id="u" placeholder="Username" />
      <button onclick="check()">Check</button>
      <div id="r"></div>
    </div>

    <script>
      const rDiv = document.getElementById("r");
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
        if (!u) return;

        clearInterval(interval);
        rDiv.innerHTML = "⏳ Loading...";

        async function fetchStatus() {
          try {
            const d = await fetch("/status/" + u).then(r => r.json());

            if (d.error) {
              rDiv.innerHTML = '<span style="color:#f87171;">❌ ' + d.error + '</span>';
              clearInterval(interval);
              return;
            }

            if (d.status === "completed") {
              const clean = d.no_order.replace(/^OD000000/, "");
              rDiv.innerHTML = \`
                ✅ <strong>Joki Completed</strong><br>
                Order Number : \${d.no_order}<br>
                <a href="https://www.itemku.com/riwayat-pembelian/detail-pesanan/\${clean}" style="color:#3b82f6;" target="_blank">View Order</a><br>
                Thanks For Using <strong>\${d.nama_store}</strong> ❤️
              \`;
              clearInterval(interval);
            } else if (d.status === "pending") {
              rDiv.innerHTML = '⌛ <strong>' + d.username + '</strong> is pending to start.';
            } else {
              const ago = Date.now() - d.lastSeen;
              const activity = d.activity || "Unknown";

              let details = \`
                🧍 <strong>\${d.username}</strong> is <span style="color:#34d399;">ONLINE</span><br>
                📌 Current Activity: <strong>\${activity}</strong><br>\`;

              if (d.type === "bonds") {
                details += \`📈 Bonds Gained: \${d.gained ?? 0}<br>\`;
              } else {
                const rem = Math.floor((d.endTime - Date.now()) / 1000);
                details += \`🕒 Time left: \${fmtTime(rem)}<br>\`;
              }

              details += \`👁️ Last Checked: \${fmtMS(ago)}\`;
              rDiv.innerHTML = details;
            }
          } catch (e) {
            rDiv.innerHTML = "⚠️ Failed to check.";
            clearInterval(interval);
          }
        }

        await fetchStatus();
        interval = setInterval(fetchStatus, 1000);
      }
    </script>
  </body>
</html>
`);
});

// === Status API
app.get("/status/:username", (req, res) => {
  const u = req.params.username.toLowerCase();

  if (sessions.has(u)) {
    const s = sessions.get(u);
    const seen = lastSeen.get(u);
    const offline = !seen || Date.now() - seen > 180000;

    const activity =
      s.lastPlaceId === "116495829188952" ? "Creating Room" :
      s.lastPlaceId === "70876832253163" ? "Getting Bonds" :
      "Unknown";

    const gained = s.bonds != null && s.startBonds != null ? (s.bonds - s.startBonds) : null;

    return res.json({
      username: s.username,
      status: "running",
      type: s.type,
      endTime: s.endTime,
      lastSeen: offline ? "offline" : seen,
      activity,
      bonds: s.bonds,
      gained
    });
  }

  if (pending.has(u)) {
    return res.json({ username: u, status: "pending" });
  }

  if (completed.has(u)) {
    const s = completed.get(u);
    return res.json({
      username: s.username,
      status: "completed",
      no_order: s.no_order,
      nama_store: s.nama_store,
      amount: s.amount || "-"
    });
  }

  res.status(404).json({ error: `No session for ${u}` });
});

// === Send Job ID
app.post("/send-job", (req, res) => {
  const { username, placeId, jobId, join_url } = req.body;
  const user = username.toLowerCase();
  const s = sessions.get(user);
  if (!s) return res.status(404).json({ error: "No session" });

  const embed = {
    content: `\`\`${jobId}\`\``,
    embeds: [{
      title: `🧩 Job ID for ${username}`,
      description: `**Place ID:** \`${placeId}\`\n**Job ID:** \`${jobId}\``,
      color: 0x3498db,
      fields: [{ name: "Join Link", value: `[Click to Join](${join_url})` }]
    }]
  };

  fetch(`https://discord.com/api/v10/channels/${JOB_CHANNEL_ID || s.channel}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${BOT_TOKEN}`
    },
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
        headers: { "Content-Type": "application/json", Authorization: `