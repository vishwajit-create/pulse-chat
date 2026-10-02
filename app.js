/**
 * PulseChat Production Server with Comprehensive Audit & Moderation Logging
 */

const express = require('express');
const http = require('http');
const path = require('path');
const morgan = require('morgan');
const fs = require('fs');
const { Server } = require('socket.io');
const { logEvent, analyzeViolation, getClientIp, getLogs, AUDIT_FILE } = require('./logger');

const app = express();
const server = http.createServer(app);

// Modern Socket.io configuration with CORS and transports
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// App configuration
const port = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_KEY || 'audit2026';

app.set('port', port);
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

// Security & Parsing Middlewares
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0
}));

// Basic HTML sanitization helper for client-rendered messages
function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// In-memory state tracking for active connections
const clients = {};          // { [userName]: socketId }
const socketsOfClients = {}; // { [socketId]: userName }

// ============================================================================
// Web Routes
// ============================================================================

app.get('/', (req, res) => {
  res.redirect('/chat');
});

app.get('/chat', (req, res) => {
  res.render('chat', { title: 'PulseChat - Modern Realtime Messaging' });
});

// Health check endpoint for cloud platforms (Render, Railway, Fly, AWS, etc.)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    connectedClients: Object.keys(clients).length
  });
});

// Admin Audit & Compliance Console
app.get('/admin/audit', (req, res) => {
  const reqKey = req.query.key;
  const isAuthorized = (reqKey === ADMIN_SECRET);

  if (!isAuthorized) {
    return res.render('admin_audit', { authorized: false, key: '' });
  }

  const logs = getLogs({ limit: 300 });
  const totalEvents = logs.length;
  const flaggedCount = logs.filter(l => l.isFlagged).length;
  const onlineUsers = Object.keys(clients).length;

  res.render('admin_audit', {
    authorized: true,
    key: reqKey,
    logs: logs,
    stats: {
      totalEvents,
      flaggedCount,
      onlineUsers
    }
  });
});

// Admin Export Logs (Download raw .jsonl audit file)
app.get('/admin/export-logs', (req, res) => {
  const reqKey = req.query.key;
  if (reqKey !== ADMIN_SECRET) {
    return res.status(403).send('Unauthorized. Provide valid ?key= parameter.');
  }

  if (fs.existsSync(AUDIT_FILE)) {
    res.download(AUDIT_FILE, `chat_audit_${new Date().toISOString().split('T')[0]}.jsonl`);
  } else {
    res.status(404).send('No logs recorded yet.');
  }
});

// Admin JSON API (for external dashboards or automated monitoring tools)
app.get('/api/admin/audit-logs', (req, res) => {
  const reqKey = req.query.key || req.headers['x-admin-key'];
  if (reqKey !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const logs = getLogs(req.query);
  res.json({ count: logs.length, logs });
});

// ============================================================================
// Socket.io Realtime Events with Audit Trail
// ============================================================================

io.on('connection', (socket) => {
  const clientIp = getClientIp(socket);
  const userAgent = socket.handshake.headers['user-agent'] || 'unknown';

  // Handle setting username
  socket.on('set username', (rawName) => {
    const userName = (rawName || '').trim();
    
    // Validation
    if (!userName || userName.length > 24) {
      socket.emit('userNameError', { message: 'Username must be between 1 and 24 characters.' });
      return;
    }

    if (userName.toLowerCase() === 'all') {
      socket.emit('userNameError', { message: '"All" is a reserved name. Please choose another.' });
      return;
    }

    // Check if name is already taken
    const existingSocketId = clients[userName];
    if (existingSocketId && existingSocketId !== socket.id) {
      socket.emit('userNameError', { message: `Username "${userName}" is already taken.` });
      return;
    }

    // Register active user
    clients[userName] = socket.id;
    socketsOfClients[socket.id] = userName;

    // AUDIT LOG: Record user registration with IP and User-Agent
    logEvent({
      eventType: 'USER_JOIN',
      ip: clientIp,
      userAgent: userAgent,
      socketId: socket.id,
      sender: userName,
      target: 'Global Room',
      message: `${userName} entered the room`,
      isFlagged: false,
      flags: []
    });

    // Welcome packet to the user
    socket.emit('welcome', {
      userName: userName,
      currentUsers: JSON.stringify(Object.keys(clients))
    });

    // Notify all other clients
    socket.broadcast.emit('userJoined', { userName: userName });
  });

  // Handle messages
  socket.on('message', (msg) => {
    if (!msg || typeof msg.message !== 'string') return;
    
    const sender = socketsOfClients[socket.id];
    if (!sender) {
      socket.emit('userNameError', { message: 'Please select a username first.' });
      return;
    }

    const rawMessage = msg.message.trim();
    if (!rawMessage) return;

    // Analyze message for potential violations (slurs, spam, suspicious links, phishing)
    const violationAnalysis = analyzeViolation(rawMessage);

    // AUDIT LOG: Record message audit entry with IP, recipient, and violation tags
    logEvent({
      eventType: 'MESSAGE',
      ip: clientIp,
      userAgent: userAgent,
      socketId: socket.id,
      sender: sender,
      target: msg.target || 'All',
      message: rawMessage, // Preserves exact raw text for legal/moderation evidence
      isFlagged: violationAnalysis.isFlagged,
      flags: violationAnalysis.flags
    });

    // Sanitize for browser presentation
    const cleanMessage = escapeHtml(rawMessage);
    const timeString = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    const payload = {
      source: sender,
      message: cleanMessage,
      target: msg.target || 'All',
      time: timeString
    };

    if (payload.target === 'All') {
      // Broadcast to everybody
      io.emit('message', payload);
    } else {
      // Private 1-on-1 direct message
      const targetSocketId = clients[payload.target];
      if (targetSocketId) {
        // Send to target
        io.to(targetSocketId).emit('message', payload);
        // Echo back to sender
        if (targetSocketId !== socket.id) {
          socket.emit('message', payload);
        }
      } else {
        socket.emit('messageError', { message: `User "${payload.target}" is no longer online.` });
      }
    }
  });

  // Handle typing status
  socket.on('typing', (data) => {
    const sender = socketsOfClients[socket.id];
    if (sender) {
      socket.broadcast.emit('userTyping', {
        userName: sender,
        target: data && data.target ? data.target : 'All'
      });
    }
  });

  socket.on('stopTyping', () => {
    const sender = socketsOfClients[socket.id];
    if (sender) {
      socket.broadcast.emit('userStopTyping', { userName: sender });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    const userName = socketsOfClients[socket.id];
    delete socketsOfClients[socket.id];
    
    if (userName) {
      delete clients[userName];
      
      // AUDIT LOG: Record disconnect event
      logEvent({
        eventType: 'USER_LEAVE',
        ip: clientIp,
        userAgent: userAgent,
        socketId: socket.id,
        sender: userName,
        target: 'Global Room',
        message: `${userName} disconnected`,
        isFlagged: false,
        flags: []
      });

      io.emit('userLeft', { userName: userName });
    }
  });
});

server.listen(port, () => {
  console.log(`PulseChat listening on port ${port} (http://localhost:${port})`);
  console.log(`Audit Console: http://localhost:${port}/admin/audit?key=${ADMIN_SECRET}`);
});
