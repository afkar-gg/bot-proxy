const express = require("express");
const cookieParser = require("cookie-parser");
const { spawn } = require("child_process");
const config = require("./config.json");
const fetch = (...args) => import("node-fetch").then(m => m.default(...args));

const BOT_TOKEN = config.BOT_TOKEN;
const CHANNEL = config.CHANNEL_ID;
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
const pending = new Map();
const sessions = new Map();
const lastSeen = new Map();
const completed = new Map();

function requireAuth(req, res, next) {
  const open = [
    "/track","/check","/complete","/send-job",
    "/status","/status/","/join","/login","/login-submit"
  ];
  if (open.some(p => req.path.startsWith(p))) return next();
  if (req.cookies.dash_auth === DASH_PASS) return next();
  return res.redirect("/login");
}
app.use(requireAuth);

// --- Login Pages ---
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

// --- Dashboard ---
app.get("/dashboard", (req, res) => {
  function renderSection(items, label, allowCancel) {
    const rows = items.length
      ? items.map(s => `
        <tr>
          <td>${s.username}</td>
          <td>${s.no_order}</td>
          <td>${s.nama_store}</td>
          <td>${s.timeLeft}</td>
          <td>${s.status}</td>
          <td>${allowCancel ? `<button onclick="location='/cancel/${s.username}'" style="background:#ef4444;color:#fff;border:none;padding:4px 8px;border-radius:4px;">✖</button>` : ''}</td>
        </tr>`).join("")
      : `<tr><td colspan="6" style="color:#888;text-align:center;">No ${label}</td></tr>`;

    return `
      <h3>${label}</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;color:#eee;">
        <tr style="background:#2a2a33;"><th>User</th><th>Order</th><th>Store</th><th>Left (m)</th><th>Status</th><th></th></tr>
        ${rows}
      </table>`;
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
    timeLeft: "-",
    status: "COMPLETED"
  }));

  res.send(`
<!DOCTYPE html><html><body style="margin:20px;background:#18181b;color:#eee;font-family:sans-serif;">
<h1 style="text-align:center;">Joki Dashboard</h1>
<div style="max-width:500px;margin:auto;background:#1f1f25;padding:16px;border:1px solid #333;border-radius:8px;margin-bottom:20px;">
<form id="jobForm" style="display:flex;flex-direction:column;">
<input name="username" placeholder="Username" required style="padding:10px;margin:6px 0;background:#2a2a33;color:#eee;border-radius:4px;border:none;"/>
<input name="no_order" placeholder="Order ID" required style="padding:10px;margin:6px 0;background:#2a2a33;color:#eee;border-radius:4px;border:none;"/>
<input name="nama_store" placeholder="Store Name" required style="padding:10px;margin:6px 0;background:#2a2a33;color:#eee;border-radius:4px;border:none;"/>
<input name="jam_selesai_joki" type="number" step="any" placeholder="Hours (e.g. 1.5)" required style="padding:10px;margin:6px 0;background:#2a2a33;color:#eee;border-radius:4px;border:none;"/>
<button type="submit" style="padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:4px;">Start Job</button>
</form>
</div>
${renderSection(pendArr, "Pending Jobs", false)}
${renderSection(actArr, "Active Sessions", true)}
${renderSection(compArr, "Completed Sessions", false)}

<script>
document.getElementById("jobForm").onsubmit = async e => {
  e.preventDefault();
  await fetch("/start-job", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(Object.fromEntries(new FormData(e.target)))
  });
  location.reload();
};
</script>
</body></html>
`);
});

// --- Cancel Job ---
app.get("/cancel/:username", (req, res) => {
  const u = req.params.username;
  pending.delete(u);
  sessions.delete(u);
  lastSeen.delete(u);
  res.redirect("/dashboard");
});

// --- /start-job ---
app.post("/start-job", (req, res) => {
  const { username, no_order, nama_store, jam_selesai_joki } = req.body;
  if (!username || !no_order || !nama_store || !jam_selesai_joki) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const hours = parseFloat(jam_selesai_joki);
  const endTime = Date.now() + hours * 3600000;

  pending.set(username, {
    username,
    no_order,
    nama_store,
    jam_selesai_joki: hours,
    endTime,
    status: "waiting"
  });

  res.json({ ok: true });
});

// --- /track with resume ---
app.post("/track", (req, res) => {
  const { username } = req.body;
  if (sessions.has(username)) {
    lastSeen.set(username, Date.now());
    return res.json({ ok: true, endTime: sessions.get(username).endTime });
  }
  if (!pending.has(username)) {
    return res.status(404).json({ error: "No pending job" });
  }

  const job = pending.get(username);
  pending.delete(username);
  const session = { ...job, startTime: Date.now(), messageId: null, channel: CHANNEL, warned: false, offline: false };
  session.endTime = job.endTime;
  sessions.set(username, session);
  lastSeen.set(username, Date.now());

  const now = Math.floor(Date.now() / 1000);
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

// --- /check ---
app.post("/check", (req, res) => {
  const { username } = req.body;
  const s = sessions.get(username);
  if (!s) return res.status(404).json({ error: "No active session" });

  lastSeen.set(username, Date.now());

  fetch(`https://discord.com/api/v10/channels/${s.channel}/messages/${s.messageId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
    body: JSON.stringify({
      content: `🟢 Online — Last Checked: <t:${Math.floor(Date.now() / 1000)}:R>`
    })
  }).catch(console.error);

  res.json({ ok: true });
});

// --- /complete ---
app.post("/complete", (req, res) => {
  const { username } = req.body;
  const s = sessions.get(username);
  if (!s) return res.status(404).json({ error: "No session" });

  const now = Math.floor(Date.now() / 1000);
  const clean = s.no_order.replace(/^OD000000/, "");
  const embed = {
    embeds: [{
      title: "✅ **JOKI COMPLETED**",
      description:
        `**Username:** ${username}\n` +
        `**Order ID:** ${s.no_order}\n` +
        `[🔗 View Order](https://tokoku.itemku.com/riwayat-pesanan/rincian/${clean})\n\n` +
        `⏰ Completed at: <t:${now}:f>`,
      footer: { text: `- ${s.nama_store}` }
    }]
  };

  fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
    body: JSON.stringify(embed)
  }).catch(console.error);

  sessions.delete(username);
  lastSeen.delete(username);
  completed.set(username, s);
  res.json({ ok: true });
});

// --- /send-job ---
app.post("/send-job", (req, res) => {
  const { username, placeId, jobId, join_url } = req.body;
  const s = sessions.get(username);
  if (!s) return res.status(404).json({ error: "No session" });

  const embed = {
    embeds: [{
      title: `🧩 Job ID for ${username}`,
      description: `**Place ID:** \`${placeId}\`\n**Job ID:** \`${jobId}\``,
      color: 0x3498db,
      fields: [{ name: "Join Link", value: `[Click to Join](${join_url})` }]
    }]
  };

  fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
    body: JSON.stringify(embed)
  }).catch(console.error);

  res.json({ ok: true });
});

// --- /status page ---
app.get("/status", (req, res) => {
  res.send(`
<!DOCTYPE html><html><body style="margin:0;padding:20px;height:100vh;background:#18181b;color:#eee;display:flex;justify-content:center;align-items:center;font-family:sans-serif;">
  <div style="width:100%;max-width:400px;text-align:center;">
    <h1>Check Joki Status</h1>
    <input id="u" placeholder="Username" style="width:80%;padding:12px;font-size:18px;margin-top:12px;border:none;border-radius:4px;background:#2a2a33;color:#eee;"/>
    <button onclick="check()" style="margin:12px;padding:12px 20px;font-size:18px;background:#3b82f6;color:#fff;border:none;border-radius:4px;">Check</button>
    <div id="r" style="margin-top:24px;font-size:20px;line-height:1.5;"></div>
  </div>
  <script>
    function fmtTime(s) {
      const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s % 60;
      return \`\${h.toString().padStart(2,'0')}:\${m.toString().padStart(2,'0')}:\${sec.toString().padStart(2,'0')}\`;
    }
    function fmtMS(ms) {
      const m = Math.floor(ms/60000), s = Math.floor((ms%60000)/1000);
      return \`\${m}m \${s}s\`;
    }
    async function check() {
      const u = document.getElementById("u").value.trim();
      if (!u) return;
      const d = await fetch("/status/" + u).then(r => r.json());
      const out = document.getElementById("r");
      if (d.error) {
        out.innerHTML = '<span style="color:#f87171;">❌ ' + d.error + '</span>';
      } else if (d.status === "completed") {
        const clean = d.no_order.replace(/^OD000000/, "");
        out.innerHTML =
          '✅ <strong>completed</strong><br>' +
          'Order Number: ' + d.no_order + '<br>' +
          'Check Your Order <a href="https://www.itemku.com/riwayat-pembelian/detail-pesanan/' + clean + '" style="color:#3b82f6;">Here</a><br>' +
          'Thanks for using ' + d.nama_store + ' ❤️';
      } else if (d.status === "pending") {
        out.innerHTML = '⌛ <strong>' + d.username + '</strong> is pending to start.';
      } else {
        const rem = Math.floor((d.endTime - Date.now()) / 1000),
              msAgo = Date.now() - d.lastSeen;
        out.innerHTML =
          '🧍 <strong>' + d.username + '</strong> is <span style="color:#34d399;">ONLINE</span><br>' +
          '🕒 Time left: ' + fmtTime(rem) + '<br>' +
          '👁️ Last Checked: ' + fmtMS(msAgo);
      }
    }
  </script>
</body></html>`);
});

// --- /status API ---
app.get("/status/:username", (req, res) => {
  const u = req.params.username;
  if (sessions.has(u)) {
    const s = sessions.get(u);
    const seen = lastSeen.get(u);
    const offline = !seen || Date.now() - seen > 3 * 60 * 1000;
    return res.json({ username: u, status: "running", endTime: s.endTime, lastSeen: offline ? "offline" : seen });
  }
  if (pending.has(u)) {
    return res.json({ username: u, status: "pending" });
  }
  if (completed.has(u)) {
    const s = completed.get(u);
    return res.json({ username: u, status: "completed", no_order: s.no_order, nama_store: s.nama_store });
  }
  res.status(404).json({ error: `No session for ${u}` });
});

// --- /join endpoint ---
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

// --- Watchdog ---
setInterval(() => {
  sessions.forEach((s, u) => {
    const seen = lastSeen.get(u) || 0;
    const now = Date.now();

    if (!s.warned && now > s.endTime) {
      fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bot ${BOT_TOKEN}` },
        body: JSON.stringify({ content: `⏳ ${u}'s joki ended.` })
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

// --- Start server + Cloudflare ---
app.listen(PORT, () => {
  console.log(`✅ Proxy live on port ${PORT}`);
  const tun = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${PORT}`, "--loglevel", "info"]);
  tun.stdout.on("data", d => { const t = d.toString(); if (t.includes("trycloudflare.com") || t.includes("cfargotunnel.com")) console.log("🌐 Tunnel URL:", t.trim()); });
  tun.stderr.on("data", d => { const t = d.toString(); if (t.includes("trycloudflare.com") || t.includes("cfargotunnel.com")) console.log("🌐 Tunnel URL:", t.trim()); });
});