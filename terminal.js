const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const pty = require("node-pty");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  path: "/terminal/socket.io",
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Active shell sessions (key: sessionId)
const terminals = {};

const stripAnsi = s =>
  s
    .replace(/[\u001b\u009b][[()#;?]*((\d{1,4}(;\d{0,4})*)?[0-9A-ORZcf-nqry=><])/g, "")
    .replace(/\u0007/g, "")
    .replace(/\]\d+;[^\u0007]*\u0007/g, "")
    .replace(/userland@localhost:[^\n]*\n?/g, "");

app.get("/terminal", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Terminal</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"/>
  <style>
    html, body {
      margin: 0;
      padding-top: env(safe-area-inset-top, 8px);
      background: #0f1117;
      color: #eee;
      font-family: monospace;
      height: 100vh;
      overflow: hidden;
    }
    #output {
      padding: 10px;
      white-space: pre-wrap;
      overflow-y: auto;
      height: calc(100vh - 50px);
      box-sizing: border-box;
    }
    #input {
      width: 100%;
      padding: 12px;
      border: none;
      outline: none;
      background: #1e1e2e;
      color: #fff;
      font-size: 16px;
      box-sizing: border-box;
      border-top: 1px solid #333;
    }
  </style>
</head>
<body>
  <div id="output">🖥️ Terminal Ready...\n</div>
  <input id="input" placeholder="Type command..." autocomplete="off" autofocus />
  <script src="/terminal/socket.io/socket.io.js"></script>
  <script>
    const sessionId = localStorage.getItem("terminalSessionId") || crypto.randomUUID();
    localStorage.setItem("terminalSessionId", sessionId);

    const socket = io("/", {
      path: "/terminal/socket.io",
      query: { sessionId }
    });

    const out = document.getElementById("output");
    const inp = document.getElementById("input");

    function append(msg) {
      out.textContent += msg;
      out.scrollTop = out.scrollHeight;
    }

    socket.on("output", append);

    inp.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        const cmd = inp.value.trim();
        if (cmd) {
          append("\\n$ " + cmd + "\\n");
          socket.emit("cmd", cmd);
          inp.value = "";
        }
      }
    });
  </script>
</body>
</html>
  `);
});

io.on("connection", socket => {
  const { sessionId } = socket.handshake.query;
  if (!sessionId) return socket.disconnect();

  let term = terminals[sessionId];

  if (!term) {
    term = pty.spawn("bash", [], {
      name: "xterm-color",
      cols: 80,
      rows: 30,
      cwd: process.env.HOME,
      env: process.env
    });

    terminals[sessionId] = term;
    console.log("🧠 Created new PTY for", sessionId);
  }

  // Send output to browser
  const onData = data => socket.emit("output", stripAnsi(data));
  term.on("data", onData);

  // Receive commands
  socket.on("cmd", cmd => term.write(cmd + "\n"));

  socket.on("disconnect", () => {
    term.off("data", onData);
    console.log("📤 Socket disconnected from", sessionId);
    // Leave PTY running
  });
});

server.listen(3001, () => {
  console.log("✅ Persistent Terminal running at http://localhost:3001/terminal");
});