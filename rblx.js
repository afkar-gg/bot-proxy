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
const version = "v2.3.2 beta";
const changelog = [
  "testing improved ui",
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
  fs.writeFileSync(STORAGE_FILE, JSON.stringify({ completed: [] }, null, 2));
}

const saved = JSON.parse(fs.readFileSync(STORAGE_FILE, "utf8"));
if (saved.completed) saved.completed.forEach(s => completed.set(s.username.toLowerCase(), s));
if (saved.pending) saved.pending.forEach(s => pending.set(s.username.toLowerCase(), s));
if (saved.sessions) saved.sessions.forEach(s => sessions.set(s.username.toLowerCase(), s));
if (saved.lastSeen) Object.entries(saved.lastSeen).forEach(([k, v]) => lastSeen.set(k, v));
if (saved.lastSent) Object.entries(saved.lastSent).forEach(([k, v]) => lastSent.set(k, v));

console.log("~$ Restored data from storage.json");

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
      background: #18181b;
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

// === Auth Middleware ===
function requireAuth(req, res, next) {
  const open = [
    "/status", "/login", "/login-submit",
    "/track", "/check", "/complete", "/bond", "/join",
    "/send-job", "/start-job", "/status/", "/graph", "/disconnected", "/jadwal", "/schedule", "/current-subject", "/order", "/upload-gag-data", "/download-gag-data"
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
  res.redirect("/");
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
  }

  const pendList = Array.from(pending.values());
  const activeList = Array.from(sessions.values());
  const completedList = Array.from(completed.values());

  res.send(`
<!DOCTYPE html>
<html lang="id">
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
    .container { max-width:1000px; margin:auto; }
    h1 { color:#3b82f6; text-align:center; }
    .card {
      background:#1d1d28;
      padding:20px;
      margin-bottom:20px;
      border-radius:14px;
      box-shadow:0 4px 20px #0008;
    }
    input, select, button {
      width:100%; padding:12px; margin-top:8px;
      border:none; border-radius:6px;
      background:#2a2a33; color:#eee;
      font-size:16px;
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

      // Move to completed
      session.completedAt = Date.now();
      sessions.delete(user);
      lastSeen.delete(user);
      completed.set(user, session);
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
  res.send(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Check Joki Status</title>
  <style>
    body {
      margin:0; padding:0; background:#18181b; color:#eee;
      font-family:'Inter',sans-serif; display:flex; align-items:center; justify-content:center;
      min-height:100vh;
    }
    .main-container {
      width:90%; max-width:500px; padding:20px;
      background:#23232b; border-radius:12px; box-shadow:0 2px 16px #0008;
      text-align:center;
    }
    input#u, button {
      width:100%; padding:12px; margin-top:12px;
      border:none; border-radius:4px; font-size:16px;
    }
    input#u { background:#2a2a33; color:#eee; }
    button {
      background:#3b82f6; color:#fff; cursor:pointer;
    }
    .status-frame {
      margin-top:20px; padding:16px;
      background:#2c2c34; border-radius:8px; box-shadow:0 2px 10px #000;
      text-align:center;
    }
    .qr-frame {
      margin-top:12px; padding:16px;
      background:#1f1f25; border-radius:8px;
      text-align:left; font-size:14px;
    }
    h3 { margin-bottom:8px; color:#3b82f6; }
    @media(min-width:768px) {
      .main-container { max-width:80%; }
    }
  </style>
</head>
<body>
  <div class="main-container">
    <h2>🔍 Cek Status Joki</h2>
    <input id="u" placeholder="Username atau Order ID"/>
    <button onclick="startCheck()">Check</button>

    <div id="r" class="status-frame"></div>

    <div class="qr-frame">
      <h3>Mau Diskon Untuk Pembelian Selanjutnya?</h3>
      <p>Minta kode QRIS ke owner via WhatsApp untuk dapat harga lebih murah.</p>
      <h3>Apakah Tidak Bisa Mendapatkan Diskon Di Itemku?</h3>
      <p>Karena ada pajak 12% dari Itemku, saya hanya bisa berikan harga segitu. Ini QRIS saya sebelum pindah ke Itemku.</p>
      <h3>Dulu Berjualan Dimana?</h3>
      <p>🤫</p>
    </div>
  </div>

  <script>
    let interval;
    function startCheck() {
      clearInterval(interval);
      const q = document.getElementById('u').value.trim();
      if (!q) return;
      check(q);
      interval = setInterval(() => check(q), 1000);
    }

    async function check(q) {
      const out = document.getElementById('r');
      try {
        const res = await fetch('/status/' + encodeURIComponent(q), {
          headers: { "Accept": "application/json" }
        });
        const d = await res.json();

        if (!res.ok) {
          out.innerHTML = '❌ ' + d.error;
          clearInterval(interval);
          return;
        }

        if (d.status === 'pending') {
          out.innerHTML = '⌛ <b>' + d.username + '</b> sedang menunggu...';
        } else if (d.status === 'running' || d.status === 'inactive') {
          const rem = Math.max(0, Math.floor((d.endTime - Date.now()) / 1000));
          const h = Math.floor(rem / 3600), m = Math.floor((rem % 3600) / 60), s = rem % 60;
          const lastSeenAgo = Math.max(0, Date.now() - d.lastSeen);
          const lm = Math.floor(lastSeenAgo / 60000);
          const ls = Math.floor((lastSeenAgo % 60000) / 1000);

          let text = (d.status === 'inactive' ? '🔴 ' : '🟢 ') + '<b>' + d.username + '</b> aktif<br>';
          if (d.type === 'bonds') {
            text += '📈 Gained: ' + d.gained + ' / ' + d.targetBonds + ' bonds<br>';
          } else {
            text += '⏳ Time left: ' + h + 'h ' + m + 'm ' + s + 's<br>';
          }
          text += '👁️ Last seen: ' + lm + 'm ' + ls + 's ago<br>';
          text += '🎮 Activity: ' + d.activity;
          out.innerHTML = text;
        } else if (d.status === 'completed') {
          let text = '✅ <b>' + d.username + '</b> selesai<br>';
          text += '🧾 Order: ' + d.no_order + '<br>';
          if (d.gained !== undefined) text += '📈 Gained: ' + d.gained + ' bonds';
          out.innerHTML = text;
          clearInterval(interval);
        }
      } catch {
        out.innerHTML = '❌ Error fetching status';
        clearInterval(interval);
      }
    }
  </script>
</body>
</html>`);
});
app.get("/status/:query", (req, res) => {
  const q = req.params.query.toLowerCase();
  const findSession = coll =>
    Array.from(coll.values()).find(
      s => s.username.toLowerCase() === q ||
           (s.no_order && s.no_order.toLowerCase() === q)
    );
  const session = findSession(sessions) || findSession(pending) || findSession(completed);
  if (!session) return res.status(404).json({ error: `No session found for ${req.params.query}` });

  const now = Date.now();
  const isActive = sessions.has(session.username.toLowerCase());
  const isCompleted = completed.has(session.username.toLowerCase());

  let status = isCompleted ? "completed" :
               (isActive ? "running" : "pending");

  let timeLeft = session.endTime - now;

  const seen = session.type === "bonds"
    ? lastSent.get(session.username.toLowerCase())
    : lastSeen.get(session.username.toLowerCase()) || 0;

  if (isActive && now - seen > 120_000) {
    status = "inactive";
  }

  const base = {
    username: session.username,
    status,
    type: session.type,
    no_order: session.no_order,
    nama_store: session.nama_store
  };

  if (status === "running" || status === "inactive") {
    return res.json({
      ...base,
      endTime: session.endTime,
      timeLeft: Math.max(0, timeLeft),
      lastSeen: seen,
      activity: session.placeId === GAME_PLACE_ID ? "Gameplay"
               : session.placeId === LOBBY_PLACE_ID ? "Lobby"
               : "Unknown",
      currentBonds: session.current_bonds,
      targetBonds: session.target_bond,
      gained: session.type === "bonds" ? session.current_bonds - session.start_bonds : undefined
    });
  }

  if (status === "completed") {
    return res.json({
      ...base,
      completedAt: session.completedAt || session.endTime,
      gained: session.type === "bonds" ? session.current_bonds - session.start_bonds : undefined
    });
  }

  return res.json(base); // pending
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
<html lang="id">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Cek Order</title>
  <style>
    body {
      margin: 0; padding: 0;
      background: #18181b; color: #eee;
      font-family: 'Inter', sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh;
    }
    .container {
      width: 90%; max-width: 500px;
      background: #23232b; padding: 20px;
      border-radius: 12px; text-align: center;
      box-shadow: 0 2px 16px #0008;
    }
    input, button {
      width: 100%; padding: 12px;
      margin-top: 12px; border: none;
      border-radius: 4px; font-size: 16px;
    }
    input {
      background: #2a2a33; color: #eee;
    }
    button {
      background: #3b82f6; color: #fff;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="container">
    <h2>🔍 Cek Order</h2>
    <input id="q" placeholder="Order ID (Contoh: OD000000123456)"/>
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
      <h1>🔗 Redirecting to Roblox...</h1>
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