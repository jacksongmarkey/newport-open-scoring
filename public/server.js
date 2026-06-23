const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Render persistent disk (mounted at /var/data) — falls back to local for dev
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/var/data') ? '/var/data' : __dirname);
const DATA_FILE = path.join(DATA_DIR, 'scores.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Admin reset token — set ADMIN_TOKEN env var on Render to enable secure resets
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'newport2026';

// CORS — allow the main site to call this API
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// SSE clients
let sseClients = [];

// Par values for 18 holes (standard par 72 — adjust as needed)
const PARS = [4,5,3,4,4,3,4,5,4, 4,3,5,4,4,3,5,4,4];

// Load or initialize scores
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('loadData error:', e);
  }
  return { teams: [], locked: false };
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('saveData error:', e);
  }
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  sseClients = sseClients.filter(res => !res.writableEnded);
  sseClients.forEach(res => {
    try { res.write(`data: ${msg}\n\n`); } catch (e) { /* client gone */ }
  });
}

function calcTotals(team) {
  let gross = 0, net = 0, holesPlayed = 0;
  team.scores.forEach((s, i) => {
    if (s !== null && s !== undefined && s !== '') {
      const score = parseInt(s);
      gross += score;
      net += score - PARS[i];
      holesPlayed++;
    }
  });
  return { gross, net, holesPlayed };
}

// Health check (Render uses this to verify the service is up)
app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

// GET all data
app.get('/api/state', (req, res) => {
  const data = loadData();
  res.json({ ...data, pars: PARS });
});

// POST - add a team
app.post('/api/teams', (req, res) => {
  const data = loadData();
  const { name, players } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Team name required' });
  if (data.teams.find(t => t.name.toLowerCase() === name.toLowerCase().trim())) {
    return res.status(400).json({ error: 'Team name already exists' });
  }
  const team = {
    id: Date.now().toString(),
    name: name.trim(),
    players: (players || '').trim(),
    scores: Array(18).fill(null),
    createdAt: new Date().toISOString()
  };
  data.teams.push(team);
  saveData(data);
  broadcast({ type: 'update', teams: data.teams, pars: PARS });
  res.json(team);
});

// POST - update a score
app.post('/api/score', (req, res) => {
  const data = loadData();
  const { teamId, hole, score } = req.body; // hole is 0-indexed
  const team = data.teams.find(t => t.id === teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (hole < 0 || hole > 17) return res.status(400).json({ error: 'Invalid hole' });
  const val = score === '' || score === null ? null : parseInt(score);
  team.scores[hole] = val;
  saveData(data);
  broadcast({ type: 'update', teams: data.teams, pars: PARS });
  res.json({ ok: true });
});

// DELETE - reset all scores (admin, requires token)
app.delete('/api/reset', (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Admin token required' });
  }
  saveData({ teams: [], locked: false });
  broadcast({ type: 'update', teams: [], pars: PARS });
  res.json({ ok: true });
});

// SSE endpoint for live updates
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  const data = loadData();
  res.write(`data: ${JSON.stringify({ type: 'update', teams: data.teams, pars: PARS })}\n\n`);
  sseClients.push(res);
  // Keep-alive ping every 25 seconds (prevents some proxies from closing the connection)
  const keepAlive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (e) {}
  }, 25000);
  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients = sseClients.filter(c => c !== res);
  });
});

// Static files served LAST so API routes take priority
app.use(express.static(PUBLIC_DIR));

// Render assigns a dynamic port via process.env.PORT
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Newport Open Scoring running on port ${PORT}`));
