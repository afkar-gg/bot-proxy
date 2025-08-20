const express = require("express");
const cookieParser = require("cookie-parser");
const fs = require("fs");
const config = require("./config.json");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { exec } = require("child_process");
const path = require("path");
const GAG_FILE = path.join(__dirname, "gagdata.json");
const gagDataStore = new Map();

// === Version Info ===
const version = "v2.4.3 beta";
const changelog = [
  "status fix",
];

const STORAGE_FILE = "./storage.json";
const BOT_TOKEN = config.BOT_TOKEN;
const CHANNEL = config.CHANNEL_ID;
const JOB_CHANNEL = config.JOB_CHANNEL_ID;
const DASH_PASS = config.DASHBOARD_PASSWORD || "secret";
const GAME_PLACE_ID = 70876832253163;
const LOBBY_PLACE_ID = 116495829188952;
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
  fs.writeFileSync(STORAGE_FILE, JSON.stringify({ completed: {} }, null, 2));
}
const saved = JSON.parse(fs.readFileSync(STORAGE_FILE, "utf8"));
if (Array.isArray(saved.completed)) {
  // old format (array)
  saved.completed.forEach(s => {
    const uname = s.username.toLowerCase();
    if (!completed.has(uname)) completed.set(uname, []);
    completed.get(uname).push(s);
  });
} else if (saved.completed) {
  // new format (object of arrays)
  Object.entries(saved.completed).forEach(([uname, arr]) => {
    completed.set(uname, arr);
  });
}
if (saved.pending) saved.pending.forEach(s => pending.set(s.username.toLowerCase(), s));
if (saved.sessions) saved.sessions.forEach(s => sessions.set(s.username.toLowerCase(), s));
if (saved.lastSeen) Object.entries(saved.lastSeen).forEach(([k, v]) => lastSeen.set(k, v));
if (saved.lastSent) Object.entries(saved.lastSent).forEach(([k, v]) => lastSent.set(k, v));

function saveStorage() {
  // flatten Maps to JSON-compatible objects
  const data = {
    completed: Object.fromEntries(completed),   // username → [sessions...]
    pending: Array.from(pending.values()),
    sessions: Array.from(sessions.values()),
    lastSeen: Object.fromEntries(lastSeen),
    lastSent: Object.fromEntries(lastSent)
  };
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2));
}

// Load existing data from disk on boot
if (fs.existsSync(GAG_FILE)) {
  try {
    const raw = fs.readFileSync(GAG_FILE, "utf8");
    const obj = JSON.parse(raw);
    Object.entries(obj).forEach(([user, data]) => gagDataStore.set(user, data));
    console.log("✅ Loaded gagdata.json");
  } catch (e) {
    console.error("⚠️ Failed loading gagdata.json:", e);
  }
}

// Helper to write on updates
function saveGAG() {
  const out = Object.fromEntries(gagDataStore);
  fs.writeFileSync(GAG_FILE, JSON.stringify(out, null, 2));
}

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>WELCOME TO AFKARSTORE</title>
  <style>
    body {
      background: linear-gradient(to bottom right, #0f172a, #1e3a8a);
      color: #ececec;
      font-family: 'Inter', Arial, sans-serif;
      margin: 0;
      padding: 20px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .container {
      width: 100%;
      max-width: 420px;
    }
    .card {
      background: #23232b;
      border-radius: 14px;
      box-shadow: 0 2px 16px #0006;
      padding: 20px;
      margin-bottom: 20px;
    }
    h1, h2 {
      color: #3b82f6;
      margin-top: 0;
    }
    h2 {
      font-size: 1.2em;
      margin-top: 1.2em;
    }
    a {
      color: #38bdf8;
      text-decoration: none;
      font-weight: bold;
    }
    a:hover {
      color: #3b82f6;
    }
    ul {
      padding-left: 1.2em;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>WELCOME TO AFKARSTORE</h1>
      <p>Selamat datang di bagian kecil dari store saya, ini adalah tempat dimana saya menyimpan informasi joki (tidak akan menyimpan password), semoga dengan adanya ini mungkin bisa mempermudah untuk pembeli dan penjoki (saya sendiri 🗿)</p>
    </div>
    <div class="card">
      <h2>Kenapa Pilih Afkarstore?</h2>
      <ul>
        <li>Harga yang terjangkau (biasanya termurah di itemku)</li>
        <li>memiliki sistem online checker (akan cek jika akun online atau tidak)</li>
        <li>otomatis menghitung kapan selesai nya joki</li>
        <li>bla bla bla (malas yapping)</li>
      </ul>
    </div>
    <div class="card">
      <h2>Knp Lu Bikin Website Ini?</h2>
      <p>Cukup langka yg punya website buat jadiin tool utk joki (apalagi roblox 😂). Sambil emg sengaja bikin projek kecil sambil belajar ama chatgpt. Dan juga biar beda dari yang lain, lebih keren, dan berkualitas tinggi. walau masih berkembang dari fitur2 keren lainnya, ini udh cukup keren buat joki roblox</p>
    </div>
    <div class="card" style="text-align:center;">
      <p>Pencet <a href="/status" target="_blank">Disini</a> jika anda sedang ingin melihat status joki kalian</p>
    </div>
  </div>
</body>
</html>
  `);
});

// === Authentication Middleware ===
function safeRedirect(url) {
  // Ensure redirect path is safe (internal only)
  if (typeof url !== "string") return "/";
  if (!url.startsWith("/")) return "/";
  if (url.startsWith("//")) return "/";
  return url;
}

function requireAuth(req, res, next) {
  // Publicly accessible routes
  const open = [
    "/status", "/login", "/login-submit",
    "/track", "/check", "/complete", "/bond", "/join",
    "/send-job", "/start-job", "/status/", "/graph", "/disconnected",
    "/jadwal", "/schedule", "/current-subject", "/order",
    "/upload-gag-data", "/download-gag-data"
  ];
  if (open.some(p => req.path.startsWith(p))) return next();

  // If correct cookie exists, allow access
  if (req.cookies?.dash_auth === DASH_PASS) return next();

  // Not authenticated, redirect to login with redirect path
  const redirectTo = encodeURIComponent(safeRedirect(req.originalUrl));
  return res.redirect(`/login?redirect=${redirectTo}`);
}
app.use(requireAuth);

// === Login Page ===
app.get("/login", (req, res) => {
  const redirectTo = req.query.redirect || "/";
  const errorMsg = req.query.error === "1" ? "❌ Wrong password!" : "";

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

// === Handle Login Submission ===
app.post("/login-submit", express.urlencoded({ extended: true }), (req, res) => {
  const { password } = req.body;
  const redirectTo = safeRedirect(req.query.redirect || "/");

  // Wrong password, redirect back to login with error
  if (password !== DASH_PASS) {
    return res.redirect(`/login?redirect=${encodeURIComponent(redirectTo)}&error=1`);
  }

  // Set authentication cookie (HTTP only)
  res.cookie("dash_auth", DASH_PASS, { httpOnly: true });

  // Redirect to originally requested page (safe)
  res.redirect(redirectTo);
});

// === Dashboard
app.get("/dashboard", (req, res) => {
  const now = Date.now();

  function formatAmount(s) {
    if (s.type === "bonds") return `${(s.current_bonds - s.start_bonds) || 0} bonds`;
    if (s.startTime && s.endTime) {
      const minutes = Math.round((s.endTime - s.startTime) / 60000);
      return `${minutes} min`;
    }
    return "-";
  }

  function renderRows(items, type) {
    if (!items.length) {
      return `<tr><td colspan="7" style="color:#aaa;text-align:center;">No ${type} sessions</td></tr>`;
    }
    return items.map(s => `
      <tr>
        <td>${s.username}</td>
        <td>${s.no_order || "-"}</td>
        <td>${s.nama_store || "-"}</td>
        <td>${s.type || "afk"}</td>
        <td>${formatAmount(s)}</td>
        <td>
          ${s.no_order ? `
          <form method="GET" action="/cancel/${s.username}/${s.no_order}" 
                onsubmit="return confirmDelete('${s.username}','${s.no_order}', this)">
            <button style="padding:4px 8px;background:#ef4444;color:#fff;border:none;border-radius:4px;cursor:pointer;">✖ Remove</button>
          </form>` : `-`}
        </td>
      </tr>
    `).join("");
  }

  const pendList = Array.from(pending.values());
  const activeList = Array.from(sessions.values());
  const completedList = Array.from(completed.values()).flat(); // flatten arrays of sessions
  
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Dashboard</title>
  <style>
    body {
      margin:0; padding:20px;
      background: linear-gradient(135deg, #0f0f1b, #1226a5);
      color:#ececec;
      font-family:'Inter',Arial,sans-serif;
      min-height: 100vh;
    }
    .container { max-width:1100px; margin:auto; }
    h1 { color:#3b82f6; text-align:center; }
    .card {
      background:#1d1d28;
      padding:20px;
      margin-bottom:20px;
      border-radius:14px;
      box-shadow:0 4px 20px #0008;
    }
    input, select, button {
      width:100%;
      padding:12px;
      margin-top:8px;
      border:none;
      border-radius:6px;
      background:#2a2a33;
      color:#eee;
      font-size:16px;
      box-sizing: border-box;
    }
    button { background:#3b82f6; font-weight:bold; cursor:pointer; }
    table {
      width:100%;
      border-collapse:collapse;
      margin-top:16px;
      font-size:14px;
    }
    th,td {
      padding:10px;
      border-bottom:1px solid #333;
      text-align:left;
    }
    th {
      background:#2a2a33;
      color:#eee;
    }
    tr:hover { background:#2a2a33; }
    .bottom-buttons {
      display:flex;
      gap:10px;
      margin:20px 0;
    }
    .bottom-buttons form { flex:1; }
    .bottom-buttons button {
      width:100%;
      padding:12px;
      border:none;
      border-radius:6px;
      color:#fff;
      font-size:16px;
      cursor:pointer;
    }
    .shutdown-btn { background:#ef4444; }
    .update-btn { background:#10b981; }
    .version {
      text-align:center;
      font-size:14px;
      color:#aaa;
    }
    @media(max-width:768px){
      input, select, button { font-size:18px; }
      table { font-size:12px; }
    }

    /* Confirmation modal */
    .modal {
      display:none;
      position:fixed;
      top:0; left:0; right:0; bottom:0;
      background:#000a;
      align-items:center;
      justify-content:center;
      z-index:1000;
    }
    .modal-content {
      background:#1d1d28;
      padding:20px;
      border-radius:10px;
      max-width:400px;
      text-align:center;
      box-shadow:0 0 20px #0008;
    }
    .modal-content h3 {
      margin-top:0;
      color:#3b82f6;
    }
    .modal-buttons {
      margin-top:20px;
      display:flex;
      gap:10px;
      justify-content:center;
    }
    .modal-buttons button {
      flex:1;
      padding:10px;
      border:none;
      border-radius:6px;
      font-size:14px;
      cursor:pointer;
    }
    .confirm-btn { background:#ef4444; color:#fff; }
    .cancel-btn { background:#374151; color:#fff; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Job Dashboard</h1>
    <div id="banner" style="display:none; padding:10px; margin:10px 0; border-radius:6px; text-align:center;"></div>
    <div class="card">
      <h2>Create New Job</h2>
      <form id="jobForm">
        <input name="username" placeholder="Username" required />
        <input name="no_order" placeholder="Order ID" required />
        <input name="nama_store" placeholder="Store Name" required />
        <input name="jam_selesai_joki" type="number" step="any" placeholder="Duration (hours)" />
        <input name="target_bond" type="number" placeholder="Target Bond (for bonds)" />
        <select name="type" required>
          <option value="afk">AFK</option>
          <option value="bonds">Bonds</option>
        </select>
        <button type="submit">🚀 Start Job</button>
      </form>
    </div>

    <div class="card">
      <h2>Pending Jobs</h2>
      <div style="overflow-x:auto;">
        <table>
          <tr><th>Username</th><th>Order</th><th>Store</th><th>Type</th><th>Info</th><th>Action</th></tr>
          ${renderRows(pendList, "pending")}
        </table>
      </div>
    </div>

    <div class="card">
      <h2>Active Jobs</h2>
      <div style="overflow-x:auto;">
        <table>
          <tr><th>Username</th><th>Order</th><th>Store</th><th>Type</th><th>Info</th><th>Action</th></tr>
          ${renderRows(activeList, "active")}
        </table>
      </div>
    </div>

    <div class="card">
      <h2>Completed Jobs</h2>
      <div style="overflow-x:auto;">
        <table>
          <tr><th>Username</th><th>Order</th><th>Store</th><th>Type</th><th>Info</th><th>Action</th></tr>
          ${renderRows(completedList, "completed")}
        </table>
      </div>
    </div>

    <div class="bottom-buttons">
      <form method="POST" action="/shutdown">
        <button type="submit" class="shutdown-btn">🔴 Shutdown</button>
      </form>
      <form method="POST" action="/restart">
        <button type="submit" class="update-btn">🟢 Update</button>
      </form>
    </div>

    <div class="version">
      version: ${version}<br>
      ${changelog.map(l => `• ${l}`).join("<br>")}
    </div>
  </div>

  <!-- Confirmation modal -->
  <div class="modal" id="confirmModal">
    <div class="modal-content">
      <h3>Confirm Delete</h3>
      <p id="confirmText"></p>
      <div class="modal-buttons">
        <button id="confirmYes" class="confirm-btn">Remove</button>
        <button id="confirmNo" class="cancel-btn">Cancel</button>
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

    // Banner message on load
    const params = new URLSearchParams(window.location.search);
    const banner = document.getElementById("banner");
    if (params.has("removed")) {
      banner.textContent = "✅ Removed job " + params.get("removed");
      banner.style.display = "block";
      banner.style.background = "#10b981";
      banner.style.color = "#fff";
    } else if (params.has("error")) {
      banner.textContent = "⚠️ Job not found";
      banner.style.display = "block";
      banner.style.background = "#ef4444";
      banner.style.color = "#fff";
    }

    // Confirmation modal logic
    let pendingForm = null;
    function confirmDelete(username, orderId, formEl) {
      pendingForm = formEl;
      document.getElementById("confirmText").textContent =
        \`Username: \${username} | Order ID: \${orderId}\`;
      document.getElementById("confirmModal").style.display = "flex";
      return false; // block form submit until confirmed
    }
    document.getElementById("confirmYes").onclick = () => {
      if (pendingForm) pendingForm.submit();
    };
    document.getElementById("confirmNo").onclick = () => {
      document.getElementById("confirmModal").style.display = "none";
      pendingForm = null;
    };
  </script>
</body>
</html>
  `);
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
app.get("/cancel/:username/:order", (req, res) => {
  const uname = req.params.username.toLowerCase();
  const order = req.params.order.toLowerCase();

  let removed = false;

  // Active
  if (sessions.has(uname)) {
    const s = sessions.get(uname);
    if (s.no_order && s.no_order.toLowerCase() === order) {
      sessions.delete(uname);
      lastSeen.delete(uname);
      lastSent.delete(uname);
      removed = true;
    }
  }

  // Pending
  if (pending.has(uname)) {
    const s = pending.get(uname);
    if (s.no_order && s.no_order.toLowerCase() === order) {
      pending.delete(uname);
      removed = true;
    }
  }

  // Completed
  if (completed.has(uname)) {
    const arr = completed.get(uname);
    const newArr = arr.filter(s => !s.no_order || s.no_order.toLowerCase() !== order);
    if (newArr.length !== arr.length) {
      completed.set(uname, newArr);
      removed = true;
    }
  }

  if (removed) {
    saveStorage();
    return res.redirect(`/dashboard?removed=${uname}:${order}`);
  } else {
    return res.redirect("/dashboard?error=notfound");
  }
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${BOT_TOKEN}`
      },
      body: JSON.stringify({
        content: `⚠️ @everyone ${username} has been idle in the lobby for too long.`
      })
    }).catch(console.error);
    return res.json({ ok: true, alert: "idle_sent" });
  }

  // 🟢 Update active session
  if (session) {
    session.lastPlaceId = placeId;
    session.current_bonds = bonds;

    if (session.start_bonds === undefined || session.start_bonds === 0) {
      session.start_bonds = bonds;
    }

    // Check if bond goal met
    if (
      session.type === "bonds" &&
      session.target_bond &&
      (bonds - session.start_bonds >= session.target_bond)
    ) {
      const now = Math.floor(Date.now() / 1000);
      const clean = session.no_order.replace(/^OD000000/, "");

      // ✅ Notify Discord
      await fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bot ${BOT_TOKEN}`
        },
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

      // Move to completed (append to array)
      session.completedAt = Date.now();
      sessions.delete(user);
      lastSeen.delete(user);
      if (!completed.has(user)) completed.set(user, []);
      completed.get(user).push(session);
      saveStorage();

      return res.json({ ok: true, completed: true });
    }

    // Update heartbeat
    lastSent.set(user, Date.now());
    saveStorage();

    return res.json({ ok: true });
  }

  return res.status(404).json({ error: "No active session" });
});

// === /status (UI Page)

app.get("/status", (req, res) => {
  res.send('<!DOCTYPE html>\
<html lang="en">\
<head>\
  <meta charset="UTF-8">\
  <meta name="viewport" content="width=device-width,initial-scale=1.0">\
  <title>Status Checker</title>\
  <style>\
    body {margin:0; padding:20px; background:#0f172a; color:#f1f5f9; font-family:sans-serif;}\
    h1 { color:#3b82f6; text-align:center; }\
    .card { background:#1e293b; padding:20px; margin:20px auto; max-width:500px; border-radius:8px; box-shadow:0 2px 6px #0008;}\
    input, button { width:100%; padding:12px; margin:6px 0; border:none; border-radius:6px; font-size:16px;}\
    input { background:#334155; color:#f1f5f9; }\
    button { background:#3b82f6; color:#fff; font-weight:bold; cursor:pointer; }\
    #result { margin-top:20px; white-space:pre-line; }\
    h4 { margin:10px 0 4px 0; }\
    .qr-frame { margin-top:20px; padding:16px; background:#0d9488; border-radius:8px; color:#ecfdf5;}\
    .qr-frame h3 { margin:10px 0 6px; }\
    .qr-frame p { margin:4px 0; }\
  </style>\
</head>\
<body>\
  <h1>Status Checker</h1>\
  <div class="card">\
    <form id="searchForm">\
      <input id="username" placeholder="Enter username" required />\
      <button type="submit">Search</button>\
    </form>\
    <div id="result"></div>\
    <div class="qr-frame">\
      <h3>Mau Diskon Untuk Pembelian Selanjutnya?</h3>\
      <p>Minta kode QRIS ke owner via WhatsApp untuk dapat harga lebih murah.</p>\
      <h3>Kenapa Tidak Bisa Mendapatkan Diskon Di Itemku?</h3>\
      <p>Karena ada pajak 12% dari Itemku, saya hanya bisa berikan harga segitu. Ini QRIS saya sebelum pindah ke Itemku.</p>\
      <p><i>Note:</i> ini hanya berlaku untuk pembeli yang bisa scan QRIS. Selain itu, DM untuk payment lainnya.</p>\
    </div>\
  </div>\
  <script>\
    var refreshTimer = null;\
    document.getElementById("searchForm").onsubmit = async function(e) {\
      e.preventDefault();\
      var query = document.getElementById("username").value.trim();\
      if (!query) return;\
      if (refreshTimer) clearInterval(refreshTimer);\
      await loadStatus(query);\
      refreshTimer = setInterval(function() { loadStatus(query); }, 1000);\
    };\
    async function loadStatus(query) {\
      try {\
        var res = await fetch("/status/" + encodeURIComponent(query) + "?format=json");\
        var data = await res.json();\
        var resultEl = document.getElementById("result");\
        resultEl.innerHTML = "";\
        if (data.pending) {\
          resultEl.textContent = data.message;\
        } else if (data.active) {\
          if (data.offline) {\
            resultEl.textContent = "🔴 " + data.username + " offline";\
            return;\
          }\
          var html = "<div>🟢 \\"" + data.username + "\\" aktif</div>";\
          if (data.timeLeft) html += "<div>⏳ Time left: " + msToTime(data.timeLeft) + "</div>";\
          if (data.lastSeen) html += "<div>👁️ Last seen: " + msToTime(data.lastSeen) + " ago</div>";\
          if (data.completed.length) {\
            html += "<h4>Completed sessions:</h4>";\
            data.completed.forEach(function(c) {\
              html += "<div>\\"" + c.username + "\\" selesai (order: " + (c.no_order || "-") + ")</div>";\
            });\
          }\
          resultEl.innerHTML = html;\
        } else if (data.completed && data.completed.length) {\
          var html2 = "<h4>Completed sessions:</h4>";\
          data.completed.forEach(function(c) {\
            html2 += "<div>\\"" + c.username + "\\" selesai (order: " + (c.no_order || "-") + ")</div>";\
          });\
          resultEl.innerHTML = html2;\
        } else if (data.offline) {\
          resultEl.textContent = data.message;\
        } else {\
          resultEl.textContent = data.message;\
        }\
      } catch (err) {\
        document.getElementById("result").textContent = "⚠️ Error loading status";\
      }\
    }\
    function msToTime(ms) {\
      var seconds = Math.floor(ms / 1000);\
      var minutes = Math.floor(seconds / 60);\
      var hours = Math.floor(minutes / 60);\
      seconds %= 60; minutes %= 60;\
      return hours + "h " + minutes + "m " + seconds + "s";\
    }\
  </script>\
</body>\
</html>');
});
app.get("/status/:query", (req, res) => {
  const uname = req.params.query.toLowerCase();
  const format = req.query.format || "json"; // json | text
  const legacy = req.query.legacy === "1";

  let result = {
    username: uname,
    pending: false,
    active: false,
    completed: [],
    offline: false,
    message: ""
  };

  // Pending
  if (pending.has(uname)) {
    result.pending = true;
    result.message = "⌛ " + uname + " sedang menunggu...";

    if (format === "text") return res.send(result.message);
    if (legacy) return res.json({ status: "pending", username: uname, message: result.message });
    return res.json(result);
  }

  // Active
  if (sessions.has(uname)) {
    const s = sessions.get(uname);
    const timeLeft = s.endTime ? s.endTime - Date.now() : 0;
    const lastSeenTime = lastSeen.has(uname) ? Date.now() - lastSeen.get(uname) : null;

    result.active = true;
    result.offline = !!s.offline;
    result.message = result.offline
      ? "🔴 " + uname + " offline"
      : "🟢 \"" + uname + "\" aktif";

    if (timeLeft) result.timeLeft = timeLeft;
    if (lastSeenTime !== null) result.lastSeen = lastSeenTime;

    const completedSessions = completed.get(uname) || [];
    result.completed = completedSessions.map(c => ({
      username: c.username,
      no_order: c.no_order || null,
      nama_store: c.nama_store || null,
      completedAt: c.completedAt || null
    }));

    if (format === "text") {
      if (result.offline) return res.send(result.message);

      let activeMessage =
        "🟢 \"" + uname + "\" aktif\n" +
        "⏳ Time left: " + (timeLeft > 0 ? msToTime(timeLeft) : "Expired") + "\n" +
        "👁️ Last seen: " + (lastSeenTime != null ? msToTime(lastSeenTime) + " ago" : "Unknown");

      const completedMessages = result.completed.map(c =>
        "\"" + c.username + "\" job selesai (order: " + (c.no_order || "-") + ")"
      );

      return res.send([activeMessage].concat(
        completedMessages.length ? ["\ncompleted session(s):"].concat(completedMessages) : []
      ).join("\n"));
    }

    if (legacy) {
      return res.json({
        status: result.offline ? "offline" : "active",
        username: uname,
        timeLeft,
        lastSeen: lastSeenTime,
        completed: result.completed,
        offline: result.offline
      });
    }

    return res.json(result);
  }

  // Completed only
  if (completed.has(uname)) {
    const completedSessions = completed.get(uname);
    result.completed = completedSessions.map(c => ({
      username: c.username,
      no_order: c.no_order || null,
      nama_store: c.nama_store || null,
      completedAt: c.completedAt || null
    }));
    result.message = "completed only";

    if (format === "text") {
      return res.send(result.completed.map(c =>
        "\"" + c.username + "\" job selesai (order: " + (c.no_order || "-") + ")"
      ).join("\n"));
    }
    if (legacy) {
      return res.json({ status: "completed", username: uname, completed: result.completed });
    }
    return res.json(result);
  }

  // Nothing found
  result.message = "No session found for \"" + uname + "\".";
  if (format === "text") return res.send(result.message);
  if (legacy) return res.json({ status: "notfound", username: uname, message: result.message });
  return res.json(result);
});

function msToTime(ms) {
  let seconds = Math.floor(ms / 1000);
  let minutes = Math.floor(seconds / 60);
  let hours = Math.floor(minutes / 60);
  seconds %= 60;
  minutes %= 60;
  return hours + "h " + minutes + "m " + seconds + "s";
}

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
  if (!completed.has(user)) completed.set(user, []);
  completed.get(user).push(s);
  saveStorage();
  res.json({ ok: true });
});

// === /Disconnected 
app.post("/disconnected", (req, res) => {
  const { username, reason = "Unknown", placeId } = req.body;
  if (!username) return res.status(400).json({ error: "Missing username" });

  const embed = {
    embeds: [
      {
        title: `❌ Player Disconnected`,
        color: 0xff0000,
        fields: [
          { name: "Username", value: username, inline: true },
          { name: "Reason", value: reason, inline: true },
          { name: "Place ID", value: placeId || "Unknown", inline: true }
        ],
        timestamp: new Date().toISOString()
      }
    ]
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

// === /order (UI Page)
app.get("/order", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Check Order</title>
  <style>
    body {
      margin:0; padding:20px;
      background: linear-gradient(135deg, #0f0f1b, #1226a5);
      color:#ececec;
      font-family:'Inter',Arial,sans-serif;
      min-height: 100vh;
      display:flex;
      justify-content:center;
      align-items:center;
    }
    .container {
      width: 90%; max-width: 500px;
      background: #1d1d28;
      padding: 20px;
      border-radius: 14px;
      box-shadow: 0 4px 20px #0008;
      text-align: center;
    }
    input, button {
      width: 100%;
      padding: 12px;
      margin-top: 12px;
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
    }
    @media(max-width:768px){
      input, button { font-size:18px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h2>🔍 Check Order</h2>
    <input id="q" placeholder="Order ID (Example: OD000000123456)" />
    <button onclick="startCheck()">Check Order</button>
  </div>
  <script>
    function startCheck() {
      const q = document.getElementById("q").value.trim();
      if (!q || !q.startsWith("OD")) return;
      const clean = q.replace(/^OD000000/, "");
      window.location.href = "/order/" + clean;
    }
  </script>
</body>
</html>
  `);
});

// === /order/:clean (Direct Redirect)
app.get("/order/:clean", (req, res) => {
  const { clean } = req.params;
  res.redirect(`https://tokoku.itemku.com/riwayat-pesanan/rincian/${clean}`);
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
      <h1>Function was discontinued.</h1>
      <a href="${uri}" style="color:#3b82f6;">Tap here if not redirected</a>
    </div>
    <script>setTimeout(() => { location.href = "${uri}" }, 1500)</script>
  </body></html>`);
});

// Shutdown and restart server (protected by requireAuth)
app.post("/shutdown", (req, res) => {
  res.send("🔴 Server shutting down...");
  process.exit(0);
});

app.post("/restart", (req, res) => {
  require("child_process").exec("bash ./rblx.sh", (err, stdout, stderr) => {
    if (err) console.error(err);
    res.send("🔄 Restarted via rblx.sh");
  });
});

// gag upload data
app.post("/upload-gag-data", express.json(), (req, res) => {
  const { username, data } = req.body || {};
  if (!username || !data) {
    return res.status(400).json({ error: "Missing username or data" });
  }

  const key = username.toLowerCase();
  gagDataStore.set(key, data);
  saveGAG();  // Persist to gagdata.json

  console.log(`📥 GAG data saved for ${key}`);
  res.json({ success: true });
});

// === /send-job ===
app.post("/send-job", async (req, res) => {
  const { jobId = "Unknown", username = "User", join_url = "", placeId = "N/A" } = req.body;
  const s = sessions.get(username);
  if (!s) return res.status(404).json({ error: "No session" });

  try {
    await fetch(`https://discord.com/api/v10/channels/${s.JOB_CHANNEL}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${BOT_TOKEN}`
      },
      body: JSON.stringify({
        embeds: [{
          title: `🧩 Job ID for ${username}`,
          description: `**Place ID:** \`${placeId}\`\n**Job ID:** \`${jobId}\``,
          fields: [{
            name: "Join Link",
            value: `[Click to Join Game](${join_url})`
          }],
          color: 0x3498db
        }]
      })
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// request download data to speedhub
app.get("/download-gag-data", (req, res) => {
  const username = (req.query.username || "").toLowerCase();
  if (!username) {
    return res.status(400).json({ error: "Missing username" });
  }

  const data = gagDataStore.get(username);
  if (!data) {
    return res.status(404).json({ error: "GAG data not found" });
  }

  res.json(data);
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
const vers = version
const clog = changelog
app.listen(PORT, () => {
  console.log(`~$ Proxy running on http://localhost:${PORT}`);
  console.log(`~$ To expose via Cloudflare:\ncloudflared tunnel start my-tunnel`);
  console.log(vers)
  console.log(clog)
});