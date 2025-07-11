const express = require("express");
const cookieParser = require("cookie-parser");
const fs = require("fs");
const { spawn } = require("child_process");
const config = require("./config.json");
const fetch = (...args) => import("node-fetch").then(m => m.default(...args));

const BOT_TOKEN = config.BOT_TOKEN;
const CHANNEL = config.CHANNEL_ID;
const JOB_CHANNEL = config.JOB_CHANNEL_ID || CHANNEL;
const DASH_PASS = config.DASHBOARD_PASSWORD || "secret";
const PORT = 3000;

if (!BOT_TOKEN || !CHANNEL) {
  console.error("❌ BOT_TOKEN or CHANNEL_ID missing");
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(cookieParser());

// ==== Storage ====
const STORE = "storage.json";
function loadStore() {
  if (!fs.existsSync(STORE)) return {};
  return JSON.parse(fs.readFileSync(STORE));
}
function saveStore(store) {
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2));
}
function persist() {
  saveStore({
    pending: Object.fromEntries(pending),
    sessions: Object.fromEntries(sessions),
    completed: Object.fromEntries(completed),
  });
}

const failedLogins = new Map();
const pending = new Map();
const sessions = new Map();
const completed = new Map();
const lastSeen = new Map();

const store = loadStore();
Object.entries(store.pending || {}).forEach(([k, v]) => pending.set(k, v));
Object.entries(store.sessions || {}).forEach(([k, v]) => sessions.set(k, v));
Object.entries(store.completed || {}).forEach(([k, v]) => completed.set(k, v));

// ==== Auth Middleware ====
function requireAuth(req, res, next) {
  const open = [
    "/track", "/check", "/complete", "/send-job",
    "/status", "/status/", "/join", "/login", "/login-submit"
  ];
  if (open.some(p => req.path.startsWith(p))) return next();
  if (req.cookies.dash_auth === DASH_PASS) return next();
  return res.redirect("/login");
}
app.use(requireAuth);

// ==== Login Page ====
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

app.post("/login-submit", express.urlencoded({ extended: false }), (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const rec = failedLogins.get(ip) || { count: 0, last: 0 };
  if (rec.count >= 10 && Date.now() - rec.last < 5 * 60 * 1000) {
    return res.send("⛔ Too many attempts! Try again later.");
  }
  if (req.body.password === DASH_PASS) {
    res.cookie("dash_auth", DASH_PASS, { httpOnly: true });
    failedLogins.delete(ip);
    return res.redirect("/dashboard");
  }
  failedLogins.set(ip, { count: rec.count + 1, last: Date.now() });
  res.send("❌ Invalid password. <a href='/login'>Retry</a>");
});

// ==== /dashboard ====
app.get("/dashboard", (req, res) => {
  function formatDate(ms) {
    if (!ms) return "-";
    const d = new Date(ms);
    const pad = n => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderSection(items, label, allowCancel, searchEnabled = false) {
    const tableId = label.replace(/\s+/g, '-').toLowerCase(); // e.g. completed-sessions

    const rows = items.length
      ? items.map(s => `
        <tr>
          <td>${s.username}</td>
          <td>${s.no_order}</td>
          <td>${s.nama_store}</td>
          <td>${s.timeLeft}</td>
          <td>${s.status}</td>
          ${allowCancel ? `<td><button onclick="location='/cancel/${s.username}'" style="background:#ef4444;color:#fff;border:none;padding:4px 8px;border-radius:4px;">✖</button></td>` : ""}
        </tr>
      `).join("")
      : `<tr><td colspan="${allowCancel ? 6 : 5}" style="color:#888;text-align:center;">No ${label}</td></tr>`;

    return `
      <div style="margin:auto;max-width:720px;margin-bottom:32px;">
        <h3 style="text-align:center;">${label}</h3>
        ${searchEnabled ? `
        <div style="text-align:center;margin-bottom:10px;">
          <input type="text" id="search-${tableId}" placeholder="Search..." oninput="filterTable('${tableId}')" 
            style="padding:8px 12px;background:#2a2a33;color:#eee;border:none;border-radius:4px;width:60%;">
        </div>` : ""}
        <div style="overflow-x:auto;">
          <table id="${tableId}" style="min-width:600px;width:100%;border-collapse:collapse;text-align:center;color:#eee;">
            <thead>
              <tr style="background:#2a2a33;">
                <th>User</th>
                <th>Order</th>
                <th>Store</th>
                <th>${label === "Completed Sessions" ? "Date" : "Time Left"}</th>
                <th>Status</th>
                ${allowCancel ? "<th>Action</th>" : ""}
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  const now = Date.now();

  const pendArr = Array.from(pending.values()).map(s => ({
    ...s,
    timeLeft: Math.max(0, Math.ceil((s.endTime - now) / 60000)) + " min",
    status: "PENDING"
  }));

  const actArr = Array.from(sessions.values()).map(s => ({
    ...s,
    timeLeft: Math.max(0, Math.ceil((s.endTime - now) / 60000)) + " min",
    status: s.offline ? "OFFLINE" : "ONLINE"
  }));

  const compArr = Array.from(completed.values()).map(s => ({
    ...s,
    timeLeft: formatDate(s.completedAt),
    status: "COMPLETED"
  }));

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Joki Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="margin:20px;background:#18181b;color:#eee;font-family:sans-serif;">
  <h1 style="text-align:center;margin-bottom:16px;">Joki Dashboard</h1>

  <div style="max-width:500px;margin:auto;background:#1f1f25;padding:16px;border:1px solid #333;border-radius:8px;margin-bottom:32px;">
    <form id="jobForm" style="display:flex;flex-direction:column;">
      <input name="username" placeholder="Username" required style="padding:10px;margin:6px 0;background:#2a2a33;color:#eee;border-radius:4px;border:none;" />
      <input name="no_order" placeholder="Order ID" required style="padding:10px;margin:6px 0;background:#2a2a33;color:#eee;border-radius:4px;border:none;" />
      <input name="nama_store" placeholder="Store Name" required style="padding:10px;margin:6px 0;background:#2a2a33;color:#eee;border-radius:4px;border:none;" />
      <input name="jam_selesai_joki" type="number" step="any" placeholder="Hours (e.g. 1.5)" required style="padding:10px;margin:6px 0;background:#2a2a33;color:#eee;border-radius:4px;border:none;" />
      <button type="submit" style="padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:4px;">Start Job</button>
    </form>
  </div>

  ${renderSection(pendArr, "Pending Sessions", false)}
  ${renderSection(actArr, "Active Sessions", true)}
  ${renderSection(compArr, "Completed Sessions", false, true)}

  <script>
    document.getElementById("jobForm").onsubmit = async e => {
      e.preventDefault();
      await fetch("/start-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(e.target)))
      });
      location.reload();
    };

    function filterTable(id) {
      const input = document.getElementById("search-" + id).value.toLowerCase();
      const table = document.getElementById(id);
      const rows = table.querySelectorAll("tbody tr");

      rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(input) ? "" : "none";
      });
    }
  </script>
</body>
</html>
`);
});

// ==== Start Job ====
app.post("/start-job", (req, res) => {
  const { username, no_order, nama_store, jam_selesai_joki } = req.body;
  const endTime = Date.now() + parseFloat(jam_selesai_joki) * 3600000;
  const key = username.toLowerCase();
  pending.set(key, { username, no_order, nama_store, endTime });
  persist();
  res.json({ ok: true });
});

// ==== Cancel Session or Job ====
app.get("/cancel/:username", (req, res) => {
  const key = req.params.username.toLowerCase();
  pending.delete(key);
  sessions.delete(key);
  lastSeen.delete(key);
  completed.delete(key);
  persist();
  res.redirect("/dashboard");
});


// ==== /track (start or resume session) ====
app.post("/track", (req, res) => {
  const { username } = req.body;
  const key = username.toLowerCase();

  if (sessions.has(key)) {
    const s = sessions.get(key);
    lastSeen.set(key, Date.now());
    s.offline = false;
    persist();
    return res.json({ ok: true, endTime: s.endTime });
  }

  if (!pending.has(key)) {
    return res.status(404).json({ error: "No pending job" });
  }

  const job = pending.get(key);
  pending.delete(key);

  const session = {
    ...job,
    startTime: Date.now(),
    messageId: null,
    channel: CHANNEL,
    warned: false,
    offline: false,
    endTime: job.endTime
  };

  sessions.set(key, session);
  lastSeen.set(key, Date.now());
  persist();

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
    .then(d => session.messageId = d.id)
    .catch(console.error);

  res.json({ ok: true, endTime: session.endTime });
});

// ==== /check (heartbeat) ====
app.post("/check", (req, res) => {
  const { username } = req.body;
  const key = username.toLowerCase();
  const s = sessions.get(key);
  if (!s) return res.status(404).json({ error: "No active session" });

  lastSeen.set(key, Date.now());
  s.offline = false;
  persist();
 fetch(`https://discord.com/api/v10/channels/${s.channel}/messages/${s.messageId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
    body: JSON.stringify({
      content: `🟢 Online — Last Checked: <t:${Math.floor(Date.now() / 1000)}:R>`
    })
  }).catch(console.error);

  res.json({ ok: true });
});

// ==== /complete ====
app.post("/complete", (req, res) => {
  const { username } = req.body;
  const key = username.toLowerCase();
  const s = sessions.get(key);
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

  // Send to Discord
  fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${BOT_TOKEN}`
    },
    body: JSON.stringify(embed)
  }).catch(console.error);

  // Save to completed log with timestamp
  completed.set(key, {
    ...s,
    completedAt: Date.now()
  });

  // Cleanup
  sessions.delete(key);
  lastSeen.delete(key);

  res.json({ ok: true });
});

// ==== /send-job ====
app.post("/send-job", (req, res) => {
  const { username, placeId, jobId, join_url } = req.body;
  const key = username.toLowerCase();
  const s = sessions.get(key) || { username };

  // 1️⃣ Send plain Job ID first
  fetch(`https://discord.com/api/v10/channels/${JOB_CHANNEL}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${BOT_TOKEN}`
    },
    body: JSON.stringify({
      content: `Job ID: \`\`${jobId}\`\``
    })
  }).then(() => {
    // 2️⃣ Then send embed after a short delay
    setTimeout(() => {
      const embed = {
        embeds: [{
          title: `🧩 Job ID for ${s.username}`,
          description: `**Place ID:** \`${placeId}\`\n**Job ID:** \`${jobId}\``,
          color: 0x3498db,
          fields: [
            {
              name: "Join Link",
              value: `[Click to Join](${join_url})`
            }
          ]
        }]
      };

      fetch(`https://discord.com/api/v10/channels/${JOB_CHANNEL}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bot ${BOT_TOKEN}`
        },
        body: JSON.stringify(embed)
      }).catch(err => {
        console.error("❌ Failed to send embed:", err);
      });

    }, 500); // short delay to ensure plain text appears above
  }).catch(err => {
    console.error("❌ Failed to send plain Job ID:", err);
  });

  res.json({ ok: true });
});

// ==== /join (mobile redirect) ====
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
</body></html>`);
});

// ==== /status UI (with auto-refresh)
app.get("/status", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
  <head>
    <title>Joki Status</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body style="margin:0;padding:20px;height:100vh;background:#18181b;color:#eee;display:flex;justify-content:center;align-items:center;font-family:sans-serif;">
    <div style="width:100%;max-width:420px;text-align:center;">
      <h1>Check Joki Status</h1>
      <input id="u" placeholder="Username" style="width:90%;padding:12px;font-size:18px;margin-top:12px;border:none;border-radius:4px;background:#2a2a33;color:#eee;" />
      <button onclick="check()" style="margin:12px;padding:12px 20px;font-size:18px;background:#3b82f6;color:#fff;border:none;border-radius:4px;">Check</button>
      <div id="r" style="margin-top:24px;font-size:20px;line-height:1.5;"></div>
    </div>

    <script>
      let interval;
      const rDiv = document.getElementById("r");

      function fmtTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        return \`\${h}h \${m}m \${s}s\`;
      }

      function fmtMS(ms) {
        const m = Math.floor(ms / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        return \`\${m}m \${s}s\`;
      }

      function check() {
        const u = document.getElementById("u").value.trim();
        if (!u) return;
        if (interval) clearInterval(interval);
        refresh(u);
        interval = setInterval(() => refresh(u), 1000);
      }

      async function refresh(u) {
        try {
          const d = await fetch("/status/" + u).then(r => r.json());
          if (d.error) {
            rDiv.innerHTML = '<span style="color:#f87171;">❌ ' + d.error + '</span>';
            clearInterval(interval);
            return;
          }

          if (d.status === "completed") {
            const clean = (d.no_order || "").replace(/^OD000000/, "");
            rDiv.innerHTML = \`
              ✅ <strong>Joki Completed</strong> ✅<br>
              Order Number : \${d.no_order}<br>
              <a href="https://www.itemku.com/riwayat-pembelian/detail-pesanan/\${clean}" target="_blank" style="color:#3b82f6;">View Order</a><br>
              Thanks For Using \${d.nama_store} ❤️
            \`;
            clearInterval(interval);
          } else if (d.status === "pending") {
            rDiv.innerHTML = \`⌛ <strong>\${d.username}</strong> is <span style="color:#fbbf24;">waiting to start</span>.\`;
          } else {
            const rem = Math.floor((d.endTime - Date.now()) / 1000);
            const ago = Date.now() - d.lastSeen;
            const offline = d.lastSeen === "offline";

            rDiv.innerHTML = \`
              🧍 <strong>\${d.username}</strong> is <span style="color:\${offline ? '#f87171' : '#34d399'};">\${offline ? "OFFLINE" : "ONLINE"}</span><br>
              🕒 Time left: \${fmtTime(rem)}<br>
              👁️ Last Checked: \${offline ? "∞" : fmtMS(ago)}
            \`;
          }
        } catch (e) {
          rDiv.innerHTML = "❌ Failed to fetch status";
          clearInterval(interval);
        }
      }
    </script>
  </body>
</html>
  `);
});

// ==== /status/:username API
app.get("/status/:username", (req, res) => {
  const key = req.params.username.toLowerCase();

  if (sessions.has(key)) {
    const s = sessions.get(key);
    const seen = lastSeen.get(key);
    const offline = !seen || Date.now() - seen > 3 * 60 * 1000;
    return res.json({
      username: s.username,
      status: "running",
      endTime: s.endTime,
      lastSeen: offline ? "offline" : seen
    });
  }

  if (pending.has(key)) {
    return res.json({ username: key, status: "pending" });
  }

  if (completed.has(key)) {
    const s = completed.get(key);
    return res.json({
      username: s.username,
      status: "completed",
      no_order: s.no_order || "-",
      nama_store: s.nama_store || "-"
    });
  }

  res.status(404).json({ error: `No session for ${key}` });
});

// ==== Watchdog (every minute)
setInterval(() => {
  const now = Date.now();
  sessions.forEach((s, u) => {
    const seen = lastSeen.get(u) || 0;

    if (!s.warned && now > s.endTime) {
      fetch(`https://discord.com/api/v10/channels/${s.channel}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
        body: JSON.stringify({ content: `⏳ ${u}'s joki ended.` })
      }).catch(console.error);
      s.warned = true;
    }

    if (!s.offline && now - seen > 3 * 60 * 1000) {
      fetch(`https://discord.com/api/v10/channels/${s.channel}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
        body: JSON.stringify({ content: `🔴 @everyone — **${u} is OFFLINE.** No activity in 3 minutes.` })
      }).catch(console.error);
      s.offline = true;
    }
  });
}, 60 * 1000);

// ==== Start Server
app.listen(PORT, () => {
  console.log(`✅ Proxy live at http://localhost:${PORT}`);
  console.log(`🌐 To expose via Cloudflare tunnel, run:`);
  console.log(`   cloudflared tunnel --url http://localhost:${PORT} --loglevel info`);
});