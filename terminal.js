const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const pty = require("node-pty");

// === App Setup
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  path: "/terminal/socket.io",
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// === Web UI for /terminal
app.get("/terminal", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Terminal</title>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <style>
    body {
      margin: 0;
      background: #0f1117;
      color: #eee;
      font-family: monospace;
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    #term {
      flex: 1;
      padding: 10px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 14px;
    }
    #input {
      border: none;
      padding: 12px;
      font-size: 16px;
      background: #1f1f2b;
      color: #fff;
      width: 100%;
      box-sizing: border-box;
    }
  </style>
</head>
<body>
  <div id="term">🖥️ Terminal Connected...\n</div>
  <input id="input" placeholder="Type command..." />
  <script src="/terminal/socket.io/socket.io.js"></script>
  <script>
    const socket = io("/", { path: "/terminal/socket.io" });
    const term = document.getElementById("term");
    const input = document.getElementById("input");

    function append(data) {
      term.textContent += data;
      term.scrollTop = term.scrollHeight;
    }

    socket.on("output", append);

    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        const cmd = input.value.trim();
        if (cmd) {
          append("\\n$ " + cmd + "\\n");
          socket.emit("cmd", cmd);
          input.value = "";
        }
      }
    });
  </script>
</body>
</html>
  `);
});

// === Strip ANSI
const stripAnsi = s => s.replace(
  /[\u001b\u009b][[()#;?]*((\d{1,4}(;\d{0,4})*)?[0-9A-ORZcf-nqry=><])/g, ''
);

// === Socket terminal
io.on("connection", socket => {
  const shell = pty.spawn("bash", [], {
    name: "xterm-color",
    cols: 80,
    rows: 30,
    cwd: process.env.HOME,
    env: process.env
  });

  shell.on("data", data => socket.emit("output", stripAnsi(data)));
  socket.on("cmd", cmd => shell.write(cmd + "\n"));
  socket.on("disconnect", () => shell.kill());
});

// === Run
server.listen(3001, () => {
  console.log("✅ Terminal running at http://localhost:3001/terminal");
});