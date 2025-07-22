// terminal-server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/terminal', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Web Terminal</title>
  <style>
    body { margin:0; background:#1e1e2e; color:#eee; font-family:monospace; display:flex; flex-direction:column; height:100vh; }
    #output { flex:1; padding:10px; overflow-y:auto; white-space:pre-wrap; }
    input {
      width:calc(100% - 20px);
      margin:10px;
      padding:10px;
      border:none;
      border-radius:4px;
      background:#111;
      color:#eee;
      font-size:16px;
      outline:none;
    }
    @media(min-width:600px) {
      input { font-size:18px; }
    }
  </style>
</head>
<body>
  <div id="output"></div>
  <input id="input" placeholder="Type command..." autofocus/>
  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();
    const out = document.getElementById('output');
    const inp = document.getElementById('input');

    socket.on('data', d => {
      out.textContent += d;
      out.scrollTop = out.scrollHeight;
    });

    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const cmd = inp.value;
        out.textContent += '\\n$ ' + cmd + '\\n';
        socket.emit('cmd', cmd);
        inp.value = '';
      }
    });
  </script>
</body>
</html>
  `);
});

io.on('connection', socket => {
  const shell = spawn('/bin/bash', { cwd: process.cwd() });

  shell.stdout.on('data', d => socket.emit('data', d.toString()));
  shell.stderr.on('data', d => socket.emit('data', d.toString()));
  socket.on('cmd', cmd => shell.stdin.write(cmd + '\n'));
  socket.on('disconnect', () => shell.kill());
});

server.listen(3000, () => {
  console.log("✅ Terminal available at http://localhost:3000/terminal");
});