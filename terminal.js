const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const pty = require("node-pty");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  path: "/terminal/socket.io",
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Manage multiple terminals
const terminals = {};  // id -> { term, sockets: Set, history: string }

// Clean ANSI & shell prompt
const stripAnsi = s =>
  s
    .replace(/[\u001b\u009b][[()#;?]*((\d{1,4}(;\d{0,4})*)?[0-9A-ORZcf-nqry=><])/g, "")
    .replace(root@localhost, "$")
    .replace(/\u0007/g, "")
    .replace(/\]\d+;[^\u0007]*\u0007/g, "");

app.get("/:id", (req, res) => {
  const id = req.params.id;
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Terminal ${id}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"/>
  <style>
    html, body {
      margin:0; padding-top:env(safe-area-inset-top,8px);
      background:#0f1117; color:#eee; font-family:monospace;
      height:100vh; overflow:hidden;
    }
    #output {
      padding:10px; white-space:pre-wrap; overflow-y:auto;
      height:calc(100vh - 50px); box-sizing:border-box;
    }
    #input {
      width:100%; padding:12px; border:none; outline:none;
      background:#1e1e2e; color:#fff; font-size:16px;
      box-sizing:border-box; border-top:1px solid #333;
    }
  </style>
</head>
<body>
  <div id="output"></div>
  <input id="input" placeholder="Type command..." autocomplete="off" autofocus />
  <script src="/terminal/socket.io/socket.io.js"></script>
  <script>
    const id = "${id}";
    const socket = io("/", {
      path: "/terminal/socket.io",
      query: { id }
    });
    const out = document.getElementById("output"), inp = document.getElementById("input");
    function append(msg) {
      out.textContent += msg;
      out.scrollTop = out.scrollHeight;
    }
    socket.on("history", append);
    socket.on("output", append);
    inp.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        const cmd = inp.value.trim();
        append("\\n$ " + cmd + "\\n");
        socket.emit("cmd", cmd);
        inp.value = "";
      }
    });
  </script>
</body>
</html>
  `);
});

io.on("connection", socket => {
  const id = socket.handshake.query.id;
  if (!id) return socket.disconnect();

  if (!terminals[id]) {
    const term = pty.spawn("bash", [], {
      name: "xterm-color",
      cols: 80, rows: 30,
      cwd: process.env.HOME, env: process.env
    });
    terminals[id] = { term, sockets: new Set(), history: "" };

    term.on("data", data => {
      const clean = stripAnsi(data);
      terminals[id].history += clean;
      terminals[id].sockets.forEach(s => s.emit("output", clean));
    });
    console.log(`✅ Terminal ${id} started`);
  }

  const ctx = terminals[id];
  ctx.sockets.add(socket);

  // Send existing history
  if (ctx.history) socket.emit("history", ctx.history);

  socket.on("cmd", cmd => {
    if (cmd === "clear") {
      ctx.history = "";
      ctx.sockets.forEach(s => s.emit("output", "\x1b[2J\x1b[0;0HTerminal cleared.\n"));
      return;
    }
    ctx.term.write(cmd + "\n");
  });

  socket.on("disconnect", () => {
    ctx.sockets.delete(socket);
    console.log(`📤 Client disconnected from terminal ${id}`);
    // Optionally cleanup if no sockets left
  });
});

server.listen(3001, () => {
  console.log("🚀 Multi-terminal server at http://localhost:3001/{id}");
});