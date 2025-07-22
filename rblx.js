const express = require("express");
const cookieParser = require("cookie-parser");
const fs = require("fs");
const config = require("./config.json");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const STORAGE_FILE = "./storage.json";
const BOT_TOKEN = config.BOT_TOKEN;
const CHANNEL = config.CHANNEL_ID;
const JOB_CHANNEL = config.JOB_CHANNEL_ID;
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

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="id">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>WELCOME TO AFKARSTORE</title>
      <style>
        body {
          background: #18181b;
          color: #ececec;
          font-family: 'Inter', Arial, sans-serif;
          margin: 0;
          min-height: 100vh;
          display: flex;
          justify-content: center;
          align-items: flex-start;
        }
        .container {
          width: 100%;
          max-width: 420px;
          margin: 32px 12px;
          background: #23232b;
          border-radius: 14px;
          box-shadow: 0 2px 16px #0006;
          padding: 24px 20px;
        }
        h1, h2 {
          color: #3b82f6;
          margin-top: 0;
          margin-bottom: 0.5em;
          font-size: 1.7em;
          text-align: center;
        }
        h2 {
          font-size: 1.2em;
          margin-top: 1.4em;
        }
        .subtitle {
          text-align: center;
          margin-bottom: 1.2em;
          font-size: 1em;
        }
        a {
          color: #38bdf8;
          text-decoration: none;
          font-weight: bold;
          transition: color 0.2s;
        }
        a:hover {
          color: #3b82f6;
        }
        p, ul {
          color: #ececec;
          font-size: 1em;
          line-height: 1.6;
          margin-top: 0;
        }
        ul {
          padding-left: 1.2em;
        }
        @media (max-width: 500px) {
          .container {
            margin: 0;
            border-radius: 0;
            min-height: 100vh;
            box-shadow: none;
            padding: 20px 8px;
          }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>WELCOME TO AFKARSTORE</h1>
        <p style="text-align:center">
          Selamat datang di bagian kecil dari store saya, ini adalah tempat dimana saya menyimpan informasi joki (tidak akan menyimpan password), semoga dengan adanya ini mungkin bisa mempermudah untuk pembeli dan penjoki (saya sendiri 🗿)
        </p>

        <h2>Kenapa Pilih Afkarstore?</h2>
        <ul>
          <li>Harga yang terjangkau (biasanya termurah di itemku)</li>
          <li>memiliki sistem online checker (akan cek jika akun online atau tidak)</li>
          <li>otomatis menghitung kapan selesai nya joki</li>
          <li>bla bla bla (malas yapping)</li>
        </ul>

        <h2>Knp Lu Bikin Website Ini?</h2>
        <p style="text-align:center">
          Cukup langka yg punya website buat jadiin tool utk joki (apalagi roblox 😂). Sambil emg sengaja bikin projek kecil sambil belajar ama chatgpt. Dan juga biar beda dari yang lain, lebih keren, dan berkualitas tinggi. walau masih berkembang dari fitur2 keren lainnya, ini udh cukup keren buat joki roblox
        </p>
        <div class="subtitle">
          Pencet <a href="https://afkar-store.web.id/status" target="_blank">Disini</a> jika anda sedang ingin melihat status joki kalian
        </div>
      </div>
    </body>
    </html>
  `);
});

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
});
app.post("/login-submit", express.urlencoded({ extended: true }), (req, res) => {
  const { password } = req.body;

  if (password !== DASH_PASS) return res.send("❌ Wrong password");

  res.cookie("dash_auth", DASH_PASS, { httpOnly: true });
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

// === /track Endpoint ===
app.post('/track', (req, res) => {
    const { username } = req.body;
    if (!username) {
        return res.status(400).json({ error: 'Missing username' });
    }

    const user = username.toLowerCase(); // Normalize username

    let job = sessions.get(user);

    // If not in sessions, but in pending: move to sessions!
    if (!job) {
        job = pending.get(user);
        if (job) {
            pending.delete(user);
            // Assume job.startTime and job.endTime are always set
            sessions.set(user, job);
            saveStorage();
        } else {
            return res.status(404).json({ error: 'No job found for this user' });
        }
    }
    lastSeen.set(user, Date.now());
    res.json({
        endTime: job.endTime,
        startTime: job.startTime,
        duration: job.duration
    });
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

  fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
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

// === bond
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
              `**Username:** ${session.username}\n` +
              `**Order ID:** ${session.no_order}\n` +
              `[🔗 View Order](https://tokoku.itemku.com/riwayat-pesanan/rincian/${clean})\n\n` +
              `⏰ Completed at: <t:${now}:f>`,
            footer: { text: `- ${session.nama_store}` }
          }]
        })
      }).catch(console.error);

      sessions.delete(user);
      lastSeen.delete(user);
      completed.set(user, session);
      return res.json({ ok: true, completed: true });
    }
    return res.json({ ok: true });
  }

  res.status(404).json({ error: "No active session" });
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

  if (!username || !placeId || !jobId || !join_url) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const embed = {
    content: `\`\`${jobId}\`\``,
    embeds: [{
      title: `🧩 Job ID for ${username}`,
      description: `**Place ID:** \`${placeId}\`\n**Job ID:** \`${jobId}\``,
      color: 0x3498db,
      fields: [{ name: "Join Link", value: `[Click to Join](${join_url})` }]
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

// === /check
app.post("/check", (req, res) => {
  const { username } = req.body;
  const user = username.toLowerCase();
  const s = sessions.get(user);
  if (!s) return res.status(404).json({ error: "No active session" });
  lastSeen.set(user, Date.now());
  res.json({ ok: true });
});

// === /complete 
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

  fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
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

// === /join redirect
app.get("/join", (req, res) => {
  const { place, job } = req.query;
  if (!place || !job) return res.status(400).send("Missing place/job");
  const uri = `roblox://experiences/start?placeId=${place}&gameId=${job}`;
  job = pending.get(username);
  pending.delete(username);
  sessions.set(username, job);
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
  sessions.forEach((s, uname) => {
    // Skip if the user is already in completed sessions
    if (completed.has(uname)) return;

    const seen = lastSeen.get(uname) || 0;

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