const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const pty = require("node-pty");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  path: "/terminal/socket.io",
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// === Serve UI ===
app.get("/terminal", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Web Terminal</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body { margin: 0; background: #111; color: #fff; font-family: monospace; }
        #terminal { width: 100%; height: 100vh; padding: 10px; box-sizing: border-box; overflow-y: auto; white-space: pre-wrap; }
        input { width: 100%; padding: 10px; font-family: monospace; background: #222; color: #fff; border: none; box-sizing: border-box; }
      </style>
    </head>
    <body>
      <div id="terminal"></div>
      <input id="input" placeholder="Type command..." />
      <script src="/terminal/socket.io/socket.io.js"></script>
      <script>
        const socket = io("/", { path: "/terminal/socket.io" });
        const terminal = document.getElementById("terminal");
        const input = document.getElementById("input");

        socket.on("output", data => {
          terminal.innerText += data;
          terminal.scrollTop = terminal.scrollHeight;
        });

        input.addEventListener("keydown", e => {
          if (e.key === "Enter") {
            socket.emit("input", input.value + "\\n");
            input.value = "";
          }
        });
      </script>
    </body>
    </html>
  `);
});

// === WebSocket Terminal Bridge ===
io.on("connection", socket => {
  const shell = pty.spawn("bash", [], {
    name: "xterm-color",
    cols: 80,
    rows: 24,
    cwd: process.env.HOME,
    env: process.env
  });

  shell.on("data", data => {
    socket.emit("output", data);
  });

  socket.on("input", data => {
    shell.write(data);
  });

  socket.on("disconnect", () => {
    shell.kill();
  });
});

// === Start Terminal Server ===
server.listen(3001, () => {
  console.log("🖥️ Terminal available at http://localhost:3001/terminal");
});