/**
 * PulseChat Production Server
 */

const express = require('express');
const http = require('http');
const path = require('path');
const morgan = require('morgan');
const { Server } = require('socket.io');

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

// Basic HTML sanitization helper
function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Routes
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

// In-memory state tracking
const clients = {};          // { [userName]: socketId }
const socketsOfClients = {}; // { [socketId]: userName }

io.on('connection', (socket) => {
  console.log(`[Socket Connected] id=${socket.id}`);

  // Handle setting username
  socket.on('set username', (rawName) => {
    const userName = (rawName || '').trim();
    
    // Validation: 1-24 characters, alphanumeric and basic symbols
    if (!userName || userName.length > 24) {
      socket.emit('userNameError', { message: 'Username must be between 1 and 24 characters.' });
      return;
    }

    if (userName.toLowerCase() === 'all') {
      socket.emit('userNameError', { message: '"All" is a reserved name. Please choose another.' });
      return;
    }

    // Check if name is taken by another client
    const existingSocketId = clients[userName];
    if (existingSocketId && existingSocketId !== socket.id) {
      socket.emit('userNameError', { message: `Username "${userName}" is already taken.` });
      return;
    }

    // Success: register user
    clients[userName] = socket.id;
    socketsOfClients[socket.id] = userName;

    // Send welcome packet to the user
    socket.emit('welcome', {
      userName: userName,
      currentUsers: JSON.stringify(Object.keys(clients))
    });

    // Notify all other users
    socket.broadcast.emit('userJoined', { userName: userName });
    console.log(`[User Registered] ${userName} (${socket.id})`);
  });

  // Handle messages
  socket.on('message', (msg) => {
    if (!msg || typeof msg.message !== 'string') return;
    
    const sender = socketsOfClients[socket.id];
    if (!sender) {
      socket.emit('userNameError', { message: 'Please select a username first.' });
      return;
    }

    const cleanMessage = escapeHtml(msg.message.trim());
    if (!cleanMessage) return;

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
        // Also send echo back to sender if distinct
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
      io.emit('userLeft', { userName: userName });
      console.log(`[User Left] ${userName}`);
    }
  });
});

server.listen(port, () => {
  console.log(`PulseChat server listening on port ${port} (http://localhost:${port})`);
});
