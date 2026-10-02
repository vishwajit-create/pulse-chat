/**
 * Audit Logger & Moderation Tracker for PulseChat
 */

const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, 'logs');
const AUDIT_FILE = path.join(LOGS_DIR, 'chat_audit.jsonl');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// In-memory buffer of recent audit entries (for instant admin viewer querying)
const MAX_IN_MEMORY_LOGS = 1000;
const memoryLogs = [];

// Lightweight violation rules (can be extended with custom keywords or regexes)
const SUSPICIOUS_PATTERNS = [
  { name: 'DISCORD_OR_EXTERNAL_INVITE', regex: /(discord\.gg|t\.me|telegram\.me|bit\.ly)/i },
  { name: 'SUSPECTED_PHISHING_LINK', regex: /(https?:\/\/[^\s]+)/i },
  { name: 'REPEATED_CHAR_FLOOD', regex: /(.)\1{10,}/i }
];

// Basic list of abusive / toxic keywords for flag marking
const ABUSE_KEYWORDS = [
  'scam', 'hack', 'ddos', 'exploit', 'phish', 'kill', 'threat'
];

/**
 * Checks a message for potential policy violations
 */
function analyzeViolation(text) {
  const flags = [];
  if (!text || typeof text !== 'string') return { isFlagged: false, flags };

  const lower = text.toLowerCase();

  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.regex.test(text)) {
      flags.push(pattern.name);
    }
  }

  for (const word of ABUSE_KEYWORDS) {
    const wordRegex = new RegExp(`\\b${word}\\b`, 'i');
    if (wordRegex.test(lower)) {
      flags.push(`KEYWORD_${word.toUpperCase()}`);
    }
  }

  return {
    isFlagged: flags.length > 0,
    flags
  };
}

/**
 * Extract real client IP from Socket.io handshake (handling reverse proxies like Render/Cloudflare)
 */
function getClientIp(socket) {
  if (!socket || !socket.handshake) return 'unknown';
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return socket.handshake.address || (socket.conn && socket.conn.remoteAddress) || 'unknown';
}

/**
 * Record an audit event
 */
function logEvent(event) {
  const entry = {
    id: 'evt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
    timestamp: new Date().toISOString(),
    ...event
  };

  // Add to memory buffer
  memoryLogs.unshift(entry);
  if (memoryLogs.length > MAX_IN_MEMORY_LOGS) {
    memoryLogs.pop();
  }

  // Append asynchronously to disk in JSON Lines format (.jsonl)
  const line = JSON.stringify(entry) + '\n';
  fs.appendFile(AUDIT_FILE, line, (err) => {
    if (err) {
      console.error('[Audit Log Error] Failed to write entry:', err);
    }
  });

  if (entry.isFlagged) {
    console.warn(`[AUDIT VIOLATION FLAGGED] User=${entry.sender} IP=${entry.ip} Flags=${entry.flags.join(', ')} Message="${entry.message}"`);
  }

  return entry;
}

/**
 * Query recent audit logs with filters
 */
function getLogs(filter = {}) {
  let results = [...memoryLogs];

  if (filter.user) {
    const q = filter.user.toLowerCase();
    results = results.filter(e => 
      (e.sender && e.sender.toLowerCase().includes(q)) || 
      (e.target && e.target.toLowerCase().includes(q))
    );
  }

  if (filter.flaggedOnly) {
    results = results.filter(e => e.isFlagged);
  }

  if (filter.eventType) {
    results = results.filter(e => e.eventType === filter.eventType);
  }

  if (filter.search) {
    const q = filter.search.toLowerCase();
    results = results.filter(e => e.message && e.message.toLowerCase().includes(q));
  }

  const limit = Math.min(parseInt(filter.limit) || 100, 500);
  return results.slice(0, limit);
}

module.exports = {
  logEvent,
  analyzeViolation,
  getClientIp,
  getLogs,
  AUDIT_FILE
};
