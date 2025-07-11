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
  function renderSection(items, label, showCancel) {
    const rows = items.length
      ? items.map(s => `
        <tr>
          <td>${s.username}</td>
          <td>${s.no_order}</td>
          <td>${s.nama_store}</td>
          <td>${s.type === "bonds" ? (s.bondsGained || 0) + "/" + (s.target_bond || 0) : s.timeLeft}</td>
          <td>${s.status}</td>
          <td>${showCancel ? `<button onclick="location='/cancel/${s.username}'" style="background:#ef4444;color:#fff;border:none;padding:4px 8px;border-radius:4px;">✖</button>` : ''}</td>
        </tr>`).join("")
      : `<tr><td colspan="6" style="color:#888;text-align:center;">No ${label}</td></tr>`;

    return `
      <h3 style="margin-top:24px;">${label}</h3>
      <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;margin-bottom:10px;color:#eee;">
        <tr style="background:#2a2a33;">
          <th>User</th><th>Order</th><th>Store</th><th>${label === "Completed Sessions" ? "Amount" : "Time Left"}</th><th>Status</th><th>Action</th>
        </tr>
        ${rows}
      </table>
      </div>`;
  }

  const now = Date.now();
  const pendArr = Array.from(pending.values()).map(s => ({
    ...s,
    timeLeft: Math.max(0, Math.ceil((s.endTime - now) / 60000)),
    status: "PENDING"
  }));
  const actArr = Array.from(sessions.values()).map(s => ({
    ...s,
    timeLeft: Math.max(0, Math.ceil((s.endTime - now) / 60000)),
    status: s.offline ? "OFFLINE" : "ONLINE"
  }));
  const compArr = Array.from(completed.values()).map(s => ({
    ...s,
    timeLeft: s.completedAt ? new Date(s.completedAt).toLocaleString() : "-"
  }));

  res.send(`
<!DOCTYPE html>
<html><head><title>Joki Dashboard</title></head>
<body style="margin:20px;background:#18181b;color:#eee;font-family:sans-serif;">
<h1 style="text-align:center;">Joki Dashboard</h1>

<div style="max-width:500px;margin:auto;background:#1f1f25;padding:16px;border:1px solid #333;border-radius:8px;">
  <form id="jobForm" style="display:flex;flex-direction:column;">
    <input name="username" placeholder="Username" required style="padding:10px;margin:6px 0;background:#2a2a33;color:#eee;border-radius:4px;border:none;" />
    <input name="no_order" placeholder="Order ID" required style="padding:10px;margin:6px 0;background:#2a2a33;color:#eee;border-radius:4px;border:none;" />
    <input name="nama_store" placeholder="Store Name" required style="padding:10px;margin:6px 0;background:#2a2a33;color:#eee;border-radius:4px;border:none;" />
    <input name="jam_selesai_joki" type="number" step="any" placeholder="Duration (hours)" style="padding:10px;margin:6px 0;background:#2a2a33;color:#eee;border-radius:4px;border:none;" />
    <input name="target_bond" type="number" placeholder="Target Bond (for bonds type)" style="padding:10px;margin:6px 0;background:#2a2a33;color:#eee;border-radius:4px;border:none;" />
    <select name="type" required style="padding:10px;margin:6px 0;background:#2a2a33;color:#eee;border-radius:4px;border:none;">
      <option value="afk">AFK</option>
      <option value="bonds">Bonds</option>
    </select>
    <button type="submit" style="padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:4px;">Start Job</button>
  </form>
</div>

<div style="max-width:90%;margin:auto;">
  ${renderSection(pendArr, "Pending Sessions", false)}
  ${renderSection(actArr, "Active Sessions", true)}
  ${renderSection(compArr, "Completed Sessions", false)}
</div>

<script>
  document.getElementById("jobForm").onsubmit = async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    await fetch("/start-job", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(data)
    });
    location.reload();
  };
</script>
</body></html>`);
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
  const { username, bonds = 0, placeId = "", alert } = req.body;
  const u = username?.toLowerCase();
  if (!u) return res.status(400).json({ error: "Missing username" });

  const now = Date.now();

  // Lobby idle alert
  if (alert === "lobby_idle") {
    const pendingJob = pending.get(u) || sessions.get(u);
    if (pendingJob) {
      await fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
        body: JSON.stringify({
          content: `🔴 @everyone — **${username} is idle in lobby.**`
        })
      }).catch(console.error);
    }
    return res.json({ ok: true });
  }

  // If session already active, just update bonds
  if (sessions.has(u)) {
    const s = sessions.get(u);
    s.current_bonds = bonds;
    lastSeen.set(u, now);
    return res.json({ ok: true, status: "updated" });
  }

  // If job is pending, convert to session
  if (pending.has(u)) {
    const job = pending.get(u);
    pending.delete(u);

    const session = {
      ...job,
      startTime: now,
      type: "bonds",
      current_bonds: bonds,
      bondsGained: 0,
      warned: false,
      offline: false,
      completedAt: null,
      placeId
    };

    sessions.set(u, session);
    lastSeen.set(u, now);

    const embed = {
      embeds: [{
        title: "🎮 **JOKI STARTED (BONDS)**",
        description:
          `**Username:** ${username}\n` +
          `**Order ID:** ${job.no_order}\n` +
          `[🔗 View Order](https://tokoku.itemku.com/riwayat-pesanan/rincian/${job.no_order.replace(/^OD000000/, "")})\n\n` +
          `**Target Bonds:** ${job.target_bond}\n` +
          `**Start Bonds:** ${bonds}\n` +
          `**Time:** <t:${Math.floor(now / 1000)}:f>`,
        footer: { text: `- ${job.nama_store}` }
      }]
    };

    await fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
      body: JSON.stringify(embed)
    }).catch(console.error);

    return res.json({ ok: true, started: true });
  }

  return res.status(404).json({ error: "No pending or active session for this user." });
});


app.post("/start-job", (req, res) => {
  const { username, no_order, nama_store, jam_selesai_joki, target_bond, type } = req.body;
  const endTime = Date.now() + (parseFloat(jam_selesai_joki || 0) * 3600000);

  const job = {
    username,
    no_order,
    nama_store,
    endTime,
    target_bond: parseInt(target_bond || 0),
    type: type || "afk"
  };

  pending.set(username.toLowerCase(), job);
  saveStorage();
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