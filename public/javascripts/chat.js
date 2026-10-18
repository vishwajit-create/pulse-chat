/**
 * PulseChat Client with Supabase Realtime (Serverless Vercel-ready)
 */

const SUPABASE_URL = 'https://xsppndniabvdntvsivwm.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhzcHBuZG5pYWJ2ZG50dnNpdndtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIyOTgxODIsImV4cCI6MjEwNzg3NDE4Mn0.f3jQmV-feyZorkfD1ZWM3dsNBwV3oSjuKsNeGHm2ni4';

// Initialize Supabase Client instance (avoid colliding with global 'supabase' from CDN)
const sbClient = (window.supabase && window.supabase.createClient)
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

let realtimeChannel = null;
let myUserName = null;
let currentTarget = 'All';
let soundEnabled = true;
let isCurrentlyTyping = false;
let typingTimer = null;
let incomingTypingTimer = null;

// Avatar palettes
const AVATAR_COLORS = [
  'linear-gradient(135deg, #6366f1, #8b5cf6)',
  'linear-gradient(135deg, #06b6d4, #3b82f6)',
  'linear-gradient(135deg, #10b981, #059669)',
  'linear-gradient(135deg, #f59e0b, #d97706)',
  'linear-gradient(135deg, #ec4899, #be185d)',
  'linear-gradient(135deg, #8b5cf6, #c026d3)'
];

function getAvatarStyle(name) {
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index];
}

// Client-side HTML escape for display
function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Violation detector
const SUSPICIOUS_PATTERNS = [
  { name: 'DISCORD_OR_EXTERNAL_INVITE', regex: /(discord\.gg|t\.me|telegram\.me|bit\.ly)/i },
  { name: 'SUSPECTED_PHISHING_LINK', regex: /(https?:\/\/[^\s]+)/i },
  { name: 'REPEATED_CHAR_FLOOD', regex: /(.)\1{10,}/i }
];
const ABUSE_KEYWORDS = ['scam', 'hack', 'ddos', 'exploit', 'phish', 'kill', 'threat'];

function analyzeViolation(text) {
  const flags = [];
  if (!text) return { isFlagged: false, flags };
  const lower = text.toLowerCase();

  for (const p of SUSPICIOUS_PATTERNS) {
    if (p.regex.test(text)) flags.push(p.name);
  }
  for (const word of ABUSE_KEYWORDS) {
    const r = new RegExp(`\\b${word}\\b`, 'i');
    if (r.test(lower)) flags.push(`KEYWORD_${word.toUpperCase()}`);
  }
  return { isFlagged: flags.length > 0, flags };
}

// Log audit record directly to Supabase Postgres
async function logAuditEvent(entry) {
  if (!sbClient) return;
  try {
    const analysis = analyzeViolation(entry.message || '');
    await sbClient.from('chat_audit_logs').insert([{
      event_type: entry.event_type,
      sender: entry.sender,
      target: entry.target || 'All',
      message: entry.message || '',
      is_flagged: analysis.isFlagged,
      flags: analysis.flags,
      user_agent: navigator.userAgent
    }]);
  } catch (e) {
    console.error('Audit log failed:', e);
  }
}

// Web Audio Chime
function playNotificationChime() {
  if (!soundEnabled) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now);
    gain1.gain.setValueAtTime(0.08, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.2);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880, now + 0.08);
    gain2.gain.setValueAtTime(0.08, now + 0.08);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.08);
    osc2.stop(now + 0.35);
  } catch(e) {}
}

function scrollToBottom() {
  const win = $('#msgWindow');
  if (win.length) {
    win.stop().animate({ scrollTop: win[0].scrollHeight }, 200);
  }
}

function setTarget(target) {
  currentTarget = target;
  if (target === 'All') {
    $('#targetIcon').text('#');
    $('#targetTitle').text('Global Room');
    $('#targetBadge').text('Public').removeClass('private');
    $('#targetSubtitle').text('Messages are visible to all connected users');
    $('#privateBanner').addClass('hidden');
    $('#msgInput').attr('placeholder', 'Message #Global Room... (Press Enter to send)');
    $('.channel-item').addClass('active');
    $('.user-item').removeClass('active');
  } else {
    $('#targetIcon').text('@');
    $('#targetTitle').text(target);
    $('#targetBadge').text('Private 🔒').addClass('private');
    $('#targetSubtitle').text('End-to-end direct conversation with @' + target);
    $('#privateTargetName').text(target);
    $('#privateBanner').removeClass('hidden');
    $('#msgInput').attr('placeholder', 'Direct message @' + target + '... (Press Enter to send)');
    $('.channel-item').removeClass('active');
    $('.user-item').removeClass('active');
    $('.user-item[data-username="' + target + '"]').addClass('active');
  }
  closeMobileSidebar();
  $('#msgInput').focus();
}

function closeMobileSidebar() {
  $('#sidebar').removeClass('open');
  $('#sidebarOverlay').removeClass('active');
}

function openMobileSidebar() {
  $('#sidebar').addClass('open');
  $('#sidebarOverlay').addClass('active');
}

function renderMessage(msg) {
  const isOutgoing = (msg.source === myUserName);
  const isPrivate = (msg.target !== 'All');
  const initial = (msg.source || '?').charAt(0).toUpperCase();
  const avatarStyle = getAvatarStyle(msg.source);
  const timeStr = msg.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const row = $('<div class="msg-row"></div>').addClass(isOutgoing ? 'outgoing' : 'incoming');

  if (!isOutgoing) {
    const avatar = $('<div class="avatar-bubble"></div>')
      .css('background', avatarStyle)
      .text(initial);
    row.append(avatar);
  }

  const bubble = $('<div class="msg-bubble"></div>');
  const header = $('<div class="msg-header"></div>');
  const sender = $('<span class="msg-sender"></span>').text(isOutgoing ? 'You' : msg.source);
  header.append(sender);

  if (isPrivate) {
    const privBadge = $('<span class="msg-badge-priv">🔒 Private</span>');
    header.append(privBadge);
  }
  bubble.append(header);

  const text = $('<div class="msg-text"></div>').html(escapeHtml(msg.message));
  bubble.append(text);

  const footer = $('<div class="msg-footer"></div>');
  const timeSpan = $('<span></span>').text(timeStr);
  footer.append(timeSpan);
  bubble.append(footer);

  row.append(bubble);
  $('#msgWindow').append(row);
  scrollToBottom();

  if (!isOutgoing) {
    playNotificationChime();
  }
}

function renderSystemMessage(htmlText) {
  const sys = $('<div class="msg-system"></div>').html(htmlText);
  $('#msgWindow').append(sys);
  scrollToBottom();
}

function updateUsersList(onlineUsers) {
  const list = $('#usersList');
  list.empty();

  onlineUsers.forEach((uName) => {
    if (uName === myUserName) return;

    const initial = uName.charAt(0).toUpperCase();
    const avatarStyle = getAvatarStyle(uName);
    const isActive = (currentTarget === uName);

    const li = $('<li class="user-item"></li>')
      .attr('data-username', uName)
      .toggleClass('active', isActive);

    const avatarWrap = $('<div class="avatar-wrapper"></div>');
    const av = $('<div class="avatar-bubble"></div>')
      .css('background', avatarStyle)
      .text(initial);
    const dot = $('<div class="status-dot-sm"></div>');
    avatarWrap.append(av).append(dot);

    const nameText = $('<span class="user-name-text"></span>').text(uName);
    li.append(avatarWrap).append(nameText);

    li.on('click', () => setTarget(uName));
    list.append(li);
  });

  const total = onlineUsers.length;
  $('#onlineCountBadge').text(total);
  $('#headerOnlineText').text(total + (total === 1 ? ' User Online' : ' Users Online'));

  if (currentTarget !== 'All' && !onlineUsers.includes(currentTarget)) {
    renderSystemMessage('<em>@' + currentTarget + ' is offline. Switched to Global Room.</em>');
    setTarget('All');
  }
}

// Join room via Supabase Realtime
async function submitJoin() {
  const name = $('#userName').val().trim();
  if (!name || name.length > 24) {
    $('#feedback').addClass('error').text('Username must be 1 to 24 characters.');
    return;
  }
  if (name.toLowerCase() === 'all') {
    $('#feedback').addClass('error').text('"All" is reserved.');
    return;
  }

  if (!sbClient) {
    $('#feedback').addClass('error').text('Supabase client failed to load. Check internet connection.');
    return;
  }

  $('#btnJoin').prop('disabled', true);
  $('#feedback').removeClass('error').text('Connecting to Supabase Realtime...');

  myUserName = name;

  try {
    // Initialize Realtime Channel with Broadcast & Presence
    realtimeChannel = sbClient.channel('room:pulse-global', {
      config: {
        broadcast: { self: true },
        presence: { key: myUserName }
      }
    });

    // 1. Broadcast Message Listener
    realtimeChannel.on('broadcast', { event: 'message' }, ({ payload }) => {
      if (payload.target === 'All' || payload.target === myUserName || payload.source === myUserName) {
        renderMessage(payload);
      }
    });

    // 2. Typing indicator listener
    realtimeChannel.on('broadcast', { event: 'typing' }, ({ payload }) => {
      if (payload.user === myUserName) return;
      const shouldShow = (payload.target === 'All' && currentTarget === 'All') ||
                         (payload.target === myUserName && currentTarget === payload.user);
      if (shouldShow) {
        $('#typingUserText').text(payload.user + ' is typing...');
        $('#typingIndicator').removeClass('hidden');
        clearTimeout(incomingTypingTimer);
        incomingTypingTimer = setTimeout(() => {
          $('#typingIndicator').addClass('hidden');
        }, 3000);
      }
    });

    realtimeChannel.on('broadcast', { event: 'stopTyping' }, ({ payload }) => {
      if (payload.user !== myUserName) {
        $('#typingIndicator').addClass('hidden');
      }
    });

    // 3. Presence Sync Listener (Online Users)
    realtimeChannel.on('presence', { event: 'sync' }, () => {
      const state = realtimeChannel.presenceState();
      const onlineUsers = Object.keys(state);
      updateUsersList(onlineUsers);
    });

    realtimeChannel.on('presence', { event: 'join' }, ({ key }) => {
      if (key !== myUserName) {
        renderSystemMessage('✨ <strong>' + key + '</strong> joined');
      }
    });

    realtimeChannel.on('presence', { event: 'leave' }, ({ key }) => {
      renderSystemMessage('👋 <strong>' + key + '</strong> left');
    });

    // Subscribe to channel
    realtimeChannel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        // Track presence
        await realtimeChannel.track({
          user: myUserName,
          onlineAt: new Date().toISOString()
        });

        // Audit Log
        logAuditEvent({
          event_type: 'USER_JOIN',
          sender: myUserName,
          target: 'Global Room',
          message: `${myUserName} entered the room`
        });

        // Show Main UI
        $('#myAvatar')
          .css('background', getAvatarStyle(myUserName))
          .text(myUserName.charAt(0).toUpperCase());
        $('#myDisplayTag').text(myUserName);

        $('#joinModal').fadeOut(250, () => {
          $('#appShell').removeClass('hidden');
          $('#msgInput').focus();
        });
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        $('#btnJoin').prop('disabled', false);
        $('#feedback').addClass('error').text('Connection error (' + status + '). Please try again.');
      }
    });
  } catch (err) {
    console.error('Join error:', err);
    $('#btnJoin').prop('disabled', false);
    $('#feedback').addClass('error').text('Error: ' + (err.message || 'Failed to connect.'));
  }
}

function submitMessage() {
  const text = $('#msgInput').val().trim();
  if (!text || !realtimeChannel) return;

  const payload = {
    source: myUserName,
    message: text,
    target: currentTarget,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };

  // Broadcast to other users over Supabase Realtime
  realtimeChannel.send({
    type: 'broadcast',
    event: 'message',
    payload: payload
  });

  // Record audit log in Supabase Postgres
  logAuditEvent({
    event_type: 'MESSAGE',
    sender: myUserName,
    target: currentTarget,
    message: text
  });

  // Stop typing
  if (isCurrentlyTyping) {
    isCurrentlyTyping = false;
    realtimeChannel.send({
      type: 'broadcast',
      event: 'stopTyping',
      payload: { user: myUserName }
    });
  }

  $('#msgInput').val('');
}

function handleTypingKeystroke() {
  if (!realtimeChannel) return;
  if (!isCurrentlyTyping) {
    isCurrentlyTyping = true;
    realtimeChannel.send({
      type: 'broadcast',
      event: 'typing',
      payload: { user: myUserName, target: currentTarget }
    });
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    isCurrentlyTyping = false;
    realtimeChannel.send({
      type: 'broadcast',
      event: 'stopTyping',
      payload: { user: myUserName }
    });
  }, 1200);
}

// Setup Event Listeners
$(function() {
  $('#btnJoin').on('click', submitJoin);
  $('#userName').on('keypress', (e) => {
    if (e.keyCode === 13) {
      submitJoin();
      e.preventDefault();
    }
  });

  $('#chatForm').on('submit', (e) => {
    e.preventDefault();
    submitMessage();
  });

  $('#msgInput').on('input', handleTypingKeystroke);

  $('#chanGlobal').on('click', () => setTarget('All'));
  $('#btnCancelPrivate').on('click', () => setTarget('All'));

  $('#btnOpenSidebar').on('click', openMobileSidebar);
  $('#btnCloseSidebar').on('click', closeMobileSidebar);
  $('#sidebarOverlay').on('click', closeMobileSidebar);

  $('#btnSoundToggle').on('click', () => {
    soundEnabled = !soundEnabled;
    if (soundEnabled) {
      $('#iconSoundOn').removeClass('hidden');
      $('#iconSoundOff').addClass('hidden');
      playNotificationChime();
    } else {
      $('#iconSoundOn').addClass('hidden');
      $('#iconSoundOff').removeClass('hidden');
    }
  });

  $('.btn-emoji').on('click', function() {
    const emoji = $(this).data('emoji');
    const input = $('#msgInput');
    input.val(input.val() + emoji);
    input.focus();
  });

  setTimeout(() => $('#userName').focus(), 200);
});
