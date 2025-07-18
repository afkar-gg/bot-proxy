// Made By ChatGPT With Advanced Prompt (from @afkar on discord)
// Constants and save mechanism
const express = require("express");
const cookieParser = require("cookie-parser");
const fs = require("fs");
const config = require("./config.json");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const STORAGE_FILE = "./storage.json";
const BOT_TOKEN = config.BOT_TOKEN;
const CHANNEL = config.CHANNEL_ID;
const JOB_CHANNEL = config.JOB_CHANNEL || CHANNEL;
const DASH_PASS = config.DASHBOARD_PASSWORD || "secret";
const PORT = config.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

const pending = new Map();
const sessions = new Map();
const lastSeen = new Map();
const lastSent = new Map();
const completed = new Map();

if (!BOT_TOKEN || !CHANNEL) {
  console.error("❌ Missing BOT_TOKEN or CHANNEL_ID in config.json");
  process.exit(1);
}

if (!fs.existsSync(STORAGE_FILE)) {
  fs.writeFileSync(STORAGE_FILE, JSON.stringify({ completed: [] }, null, 2));
}

const saved = JSON.parse(fs.readFileSync(STORAGE_FILE, "utf8"));
if (saved.completed) saved.completed.forEach(s => completed.set(s.username.toLowerCase(), s));
if (saved.pending) saved.pending.forEach(s => pending.set(s.username.toLowerCase(), s));
if (saved.sessions) saved.sessions.forEach(s => sessions.set(s.username.toLowerCase(), s));
if (saved.lastSeen) Object.entries(saved.lastSeen).forEach(([k, v]) => lastSeen.set(k, v));
if (saved.lastSent) Object.entries(saved.lastSent).forEach(([k, v]) => lastSent.set(k, v));

console.log("✅ Restored data from storage.json");

function saveStorage() {
  const data = {
    completed: Array.from(completed.values()),
    pending: Array.from(pending.values()),
    sessions: Array.from(sessions.values()),
    lastSeen: Object.fromEntries(lastSeen),
    lastSent: Object.fromEntries(lastSent)
  };
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2));
}

// === Auth Middleware ===
function requireAuth(req, res, next) {
  const open = [
    "/status", "/login", "/login-submit",
    "/track", "/check", "/complete", "/bond", "/join",
    "/send-job", "/start-job", "/status/"
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
});app.post("/login-submit", (req, res) => {
  const { password } = req.body;
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  if (password !== ADMIN_PASSWORD) {
    return res.status(403).send("❌ Invalid password.");
  }

  // Save authenticated IP
  if (!authed.has(ip)) {
    authed.add(ip);
    console.log(`✅ New device authenticated: ${ip}`);
    saveStorage();
  }

  res.redirect("/dashboard");
});

// === Dashboard ===// === Dashboard ===
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
    bondsGained: s.current_bonds && s.start_bonds ? s.current_bonds - s.start_bonds : 0,
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

// === /start-job ===
app.post("/start-job", async (req, res) => {
  const {
    username,
    no_order,
    nama_store,
    jam_selesai_joki,
    target_bond,
    type
  } = req.body;

  const user = username.toLowerCase();
  const now = Date.now();
  const hours = parseFloat(jam_selesai_joki || "0") || 0;
  const endTime = now + hours * 3600 * 1000;

  const session = {
    username,
    no_order,
    nama_store,
    endTime,
    type,
    start_bonds: 0,
    current_bonds: 0,
    target_bond: parseInt(target_bond || "0"),
    startTime: now
  };

  pending.set(user, session);
  saveStorage();

  // Send embed to Discord (yellow for start)
  const embed = {
    embeds: [{
      title: `🚀 New Joki Started – ${username}`,
      description: `**Type:** ${type}\n**Order:** ${no_order}\n**Store:** ${nama_store}`,
      color: 0xffd700,
      fields: [{
        name: "End Time",
        value: `<t:${Math.floor(endTime / 1000)}:R>`,
        inline: true
      }, {
        name: "Start Time",
        value: `<t:${Math.floor(now / 1000)}:F>`,
        inline: true
      }]
    }]
  };

  fetch(`https://discord.com/api/v10/channels/${JOB_CHANNEL}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${BOT_TOKEN}`
    },
    body: JSON.stringify(embed)
  }).catch(console.error);

  res.json({ ok: true });
});

// === /cancel/:username ===
app.get("/cancel/:username", (req, res) => {
  const uname = req.params.username.toLowerCase();
  if (pending.has(uname)) pending.delete(uname);
  if (sessions.has(uname)) sessions.delete(uname);
  saveStorage();
  res.redirect("/dashboard");
});

// === /status (UI Page)
app.get("/status", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
  <head>
    <title>Status Checker</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  </head>
  <body style="margin:0;padding:0;background:#18181b;color:#eee;font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;">
    <div style="width:100%;max-width:440px;padding:20px;text-align:center;">
      <h2>🔍 Check Joki Status</h2>
      <input id="u" placeholder="Username" style="width:100%;padding:12px;margin-top:12px;border:none;border-radius:4px;background:#2a2a33;color:#eee;font-size:16px;" />
      <button onclick="startCheck()" style="margin-top:12px;padding:10px 16px;background:#3b82f6;color:#fff;border:none;border-radius:4px;font-size:16px;">Check</button>
      <div id="r" style="margin-top:20px;font-size:16px;line-height:1.5;"></div>
    </div>

    <script>
      let interval;
      function startCheck() {
        const user = document.getElementById("u").value.trim().toLowerCase();
        if (!user) return;
        clearInterval(interval);
        check(user);
        interval = setInterval(() => check(user), 1000);
      }

      async function check(u) {
        const out = document.getElementById("r");
        try {
          const d = await fetch("/status/" + u).then(r => r.json());

          if (d.error) {
            out.innerHTML = "❌ " + d.error;
            clearInterval(interval);
            return;
          }

          if (d.status === "pending") {
            out.innerHTML = \`⌛ <b>\${u}</b> is waiting to start...\`;
            return;
          }

          if (d.status === "completed") {
            const clean = d.no_order?.replace(/^OD000000/, "") || "";
            const bondText = d.type === "bonds"
              ? \`📈 Gained: \${d.gained} bonds\`
              : "";
            out.innerHTML = \`
              ✅ <b>Joki Completed</b><br/>
              🧾 Order Number: \${d.no_order}<br/>
              🔗 <a href="https://www.itemku.com/riwayat-pembelian/detail-pesanan/\${clean}" style="color:#3b82f6;" target="_blank">View Order</a><br/>
              ❤️ Thanks for using <b>\${d.nama_store}</b><br/>
              \${bondText}
            \`;
            clearInterval(interval);
            return;
          }

          const remaining = Math.floor((d.endTime - Date.now()) / 1000);
          const h = Math.floor(remaining / 3600),
                m = Math.floor((remaining % 3600) / 60),
                s = remaining % 60;
          const lastSeenAgo = Date.now() - d.lastSeen;
          const lm = Math.floor(lastSeenAgo / 60000), ls = Math.floor((lastSeenAgo % 60000) / 1000);

          const bondText = d.type === "bonds"
            ? \`<br>📈 Gained: \${d.gained} / \${d.targetBonds}<br>💰 Bonds: \${d.currentBonds}\`
            : \`<br>⏳ Time Left: \${h}h \${m}m \${s}s\`;

          const timeLabel = d.type === "bonds" ? "📤 Last Sent" : "👁️ Last Check";

          out.innerHTML = \`
            🟢 <b>\${u}</b> is ACTIVE<br/>
            \${d.type !== "afk" ? \`🎮 Activity: <b>\${d.activity || "Unknown"}</b><br/>\` : ""}
            \${bondText}
            <br>\${timeLabel}: \${lm}m \${ls}s ago
          \`;
        } catch (e) {
          out.innerHTML = "❌ Error fetching status";
          clearInterval(interval);
        }
      }
    </script>
  </body>
</html>
  `);
});
app.get("/status/:username", (req, res) => {
  const uname = req.params.username.toLowerCase();
  const now = Date.now();

  if (sessions.has(uname)) {
    const s = sessions.get(uname);
    const seen = s.type === "bonds" ? lastSent.get(uname) : lastSeen.get(uname);
    const offline = !seen || now - seen > 3 * 60 * 1000;

    let activity = "Unknown";
    if (s.placeId === "70876832253163") activity = "Gameplay";
    else if (s.placeId === "116495829188952") activity = "Lobby";

    const isBond = s.type === "bonds";

    return res.json({
      username: uname,
      status: "running",
      type: s.type,
      lastSeen: offline ? "offline" : seen,
      endTime: s.endTime,
      activity,
      currentBonds: isBond ? s.current_bonds : undefined,
      targetBonds: isBond ? s.target_bond : undefined,
      gained: isBond ? s.current_bonds - s.start_bonds : undefined
    });
  }

  if (pending.has(uname)) {
    const p = pending.get(uname);
    return res.json({
      username: uname,
      status: "pending",
      type: p.type
    });
  }

  if (completed.has(uname)) {
    const c = completed.get(uname);
    const isBond = c.type === "bonds";
    return res.json({
      username: uname,
      status: "completed",
      type: c.type,
      no_order: c.no_order,
      nama_store: c.nama_store,
      completedAt: c.completedAt || c.endTime,
      gained: isBond ? c.current_bonds - c.start_bonds : undefined
    });
  }

  return res.status(404).json({ error: `No session for ${uname}` });
});

// === /send-job
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

// === /join redirect
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

// === Heartbeat watchdog
setInterval(() => {
  const now = Date.now();
  sessions.forEach((s, u) => {
    const seen = lastSeen.get(u) || 0;

    if (s.type !== "afk" && !s.warned && now > s.endTime) {
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