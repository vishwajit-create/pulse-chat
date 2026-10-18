/**
 * PulseChat Standalone & Vercel-ready Server
 * Powered by Supabase Realtime & Postgres
 */

const express = require('express');
const path = require('path');
const morgan = require('morgan');

const app = express();
const port = process.env.PORT || 3000;

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin/audit', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/health', (req, res) => {
  require('./api/health')(req, res);
});

app.listen(port, () => {
  console.log(`PulseChat (Supabase Realtime) listening on port ${port}`);
  console.log(`Chat: http://localhost:${port}/chat`);
  console.log(`Admin Console: http://localhost:${port}/admin/audit?key=a582bada4cc1da841b5a851cba3e1809`);
});
