/**
 * PulseChat Client Application
 */

var socket = null;
var myUserName = null;
var currentTarget = 'All'; // 'All' or specific username
var soundEnabled = true;
var typingTimer = null;
var isCurrentlyTyping = false;

// Avatar gradient palettes
var AVATAR_COLORS = [
  'linear-gradient(135deg, #6366f1, #8b5cf6)',
  'linear-gradient(135deg, #06b6d4, #3b82f6)',
  'linear-gradient(135deg, #10b981, #059669)',
  'linear-gradient(135deg, #f59e0b, #d97706)',
  'linear-gradient(135deg, #ec4899, #be185d)',
  'linear-gradient(135deg, #8b5cf6, #c026d3)'
];

function getAvatarStyle(name) {
  var hash = 0;
  for (var i = 0; i < (name || '').length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  var index = Math.abs(hash) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index];
}

// Subtle pleasant Web Audio chime
function playNotificationChime() {
  if (!soundEnabled) return;
  try {
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    var ctx = new AudioCtx();
    var now = ctx.currentTime;
    
    var osc1 = ctx.createOscillator();
    var gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now); // D5
    gain1.gain.setValueAtTime(0.08, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.2);

    var osc2 = ctx.createOscillator();
    var gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880, now + 0.08); // A5
    gain2.gain.setValueAtTime(0.08, now + 0.08);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.08);
    osc2.stop(now + 0.35);
  } catch(e) {
    // audio context muted or unsupported
  }
}

function scrollToBottom() {
  var win = $('#msgWindow');
  if (win.length) {
    win.stop().animate({ scrollTop: win[0].scrollHeight }, 200);
  }
}

// Switch messaging recipient (All vs Direct Message)
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

  // Close mobile sidebar if open
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

// Render message in conversation stream
function renderMessage(msg) {
  var isOutgoing = (msg.source === myUserName);
  var isPrivate = (msg.target !== 'All');
  var initial = (msg.source || '?').charAt(0).toUpperCase();
  var avatarStyle = getAvatarStyle(msg.source);
  var timeStr = msg.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  var row = $('<div class="msg-row"></div>').addClass(isOutgoing ? 'outgoing' : 'incoming');

  // Avatar for incoming
  if (!isOutgoing) {
    var avatar = $('<div class="avatar-bubble"></div>')
      .css('background', avatarStyle)
      .text(initial);
    row.append(avatar);
  }

  var bubble = $('<div class="msg-bubble"></div>');

  // Header info
  var header = $('<div class="msg-header"></div>');
  var sender = $('<span class="msg-sender"></span>').text(isOutgoing ? 'You' : msg.source);
  header.append(sender);

  if (isPrivate) {
    var privBadge = $('<span class="msg-badge-priv">🔒 Private</span>');
    header.append(privBadge);
  }
  bubble.append(header);

  // Message body
  var text = $('<div class="msg-text"></div>').html(msg.message);
  bubble.append(text);

  // Footer with time
  var footer = $('<div class="msg-footer"></div>');
  var timeSpan = $('<span></span>').text(timeStr);
  footer.append(timeSpan);
  bubble.append(footer);

  row.append(bubble);
  $('#msgWindow').append(row);
  scrollToBottom();

  if (!isOutgoing) {
    playNotificationChime();
  }
}

// System event pill ("Alice joined the room")
function renderSystemMessage(text) {
  var sys = $('<div class="msg-system"></div>').html(text);
  $('#msgWindow').append(sys);
  scrollToBottom();
}

// Update the online user list
function updateUsersList(users) {
  var list = $('#usersList');
  list.empty();

  var otherCount = 0;

  users.forEach(function(uName) {
    if (uName === myUserName) return; // Don't list self as a contact
    otherCount++;

    var initial = uName.charAt(0).toUpperCase();
    var avatarStyle = getAvatarStyle(uName);
    var isActive = (currentTarget === uName);

    var li = $('<li class="user-item"></li>')
      .attr('data-username', uName)
      .toggleClass('active', isActive);

    var avatarWrap = $('<div class="avatar-wrapper"></div>');
    var av = $('<div class="avatar-bubble"></div>')
      .css('background', avatarStyle)
      .text(initial);
    var dot = $('<div class="status-dot-sm"></div>');
    avatarWrap.append(av).append(dot);

    var nameText = $('<span class="user-name-text"></span>').text(uName);
    li.append(avatarWrap).append(nameText);

    li.on('click', function() {
      setTarget(uName);
    });

    list.append(li);
  });

  var totalOnline = users.length;
  $('#onlineCountBadge').text(totalOnline);
  $('#headerOnlineText').text(totalOnline + (totalOnline === 1 ? ' User Online' : ' Users Online'));

  // If currently messaging someone who left, revert to All
  if (currentTarget !== 'All' && users.indexOf(currentTarget) === -1) {
    renderSystemMessage('<em>@' + currentTarget + ' left the conversation. Switched to Global Room.</em>');
    setTarget('All');
  }
}

// Join the chat
function submitJoin() {
  var name = $('#userName').val().trim();
  if (!name) {
    $('#feedback').addClass('error').text('Please enter a display name.');
    $('#userName').focus();
    return;
  }
  $('#feedback').removeClass('error').text('Connecting...');
  $('#btnJoin').prop('disabled', true);
  socket.emit('set username', name);
}

// Send current message
function submitMessage() {
  var text = $('#msgInput').val().trim();
  if (!text) return;

  socket.emit('message', {
    message: text,
    target: currentTarget
  });

  // Stop typing indicator immediately
  if (isCurrentlyTyping) {
    isCurrentlyTyping = false;
    socket.emit('stopTyping');
  }

  $('#msgInput').val('');
}

// Handle typing emit
function handleTypingKeystroke() {
  if (!isCurrentlyTyping) {
    isCurrentlyTyping = true;
    socket.emit('typing', { target: currentTarget });
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(function() {
    isCurrentlyTyping = false;
    socket.emit('stopTyping');
  }, 1200);
}

// Document Ready
$(function() {
  socket = io();

  // Socket Events
  socket.on('welcome', function(data) {
    myUserName = data.userName;

    // Setup self card
    $('#myAvatar')
      .css('background', getAvatarStyle(myUserName))
      .text(myUserName.charAt(0).toUpperCase());
    $('#myDisplayTag').text(myUserName);

    // Transition from modal to main app
    $('#joinModal').fadeOut(250, function() {
      $('#appShell').removeClass('hidden');
      $('#msgInput').focus();
    });

    try {
      var currentList = JSON.parse(data.currentUsers || '[]');
      updateUsersList(currentList);
    } catch(e) {}
  });

  socket.on('userNameError', function(err) {
    $('#btnJoin').prop('disabled', false);
    $('#feedback').addClass('error').text(err.message || 'Username error occurred.');
    $('#userName').focus();
  });

  socket.on('userJoined', function(data) {
    renderSystemMessage('✨ <strong>' + data.userName + '</strong> joined the room');
    // Refresh user list request
    var existingUsers = [];
    $('.user-item').each(function() {
      existingUsers.push($(this).data('username'));
    });
    if (existingUsers.indexOf(data.userName) === -1) {
      existingUsers.push(data.userName);
    }
    if (myUserName) existingUsers.push(myUserName);
    updateUsersList(existingUsers);
  });

  socket.on('userLeft', function(data) {
    renderSystemMessage('👋 <strong>' + data.userName + '</strong> left');
    var existingUsers = [];
    $('.user-item').each(function() {
      var u = $(this).data('username');
      if (u !== data.userName) existingUsers.push(u);
    });
    if (myUserName) existingUsers.push(myUserName);
    updateUsersList(existingUsers);
  });

  socket.on('message', function(msg) {
    renderMessage(msg);
  });

  socket.on('messageError', function(err) {
    renderSystemMessage('⚠️ ' + (err.message || 'Failed to deliver message.'));
  });

  var incomingTypingTimer = null;
  socket.on('userTyping', function(data) {
    if (data.userName === myUserName) return;
    
    // Show if public and we are in global, or if direct to us
    var shouldShow = (data.target === 'All' && currentTarget === 'All') ||
                     (data.target === myUserName && currentTarget === data.userName);
    if (shouldShow) {
      $('#typingUserText').text(data.userName + ' is typing...');
      $('#typingIndicator').removeClass('hidden');
      clearTimeout(incomingTypingTimer);
      incomingTypingTimer = setTimeout(function() {
        $('#typingIndicator').addClass('hidden');
      }, 3000);
    }
  });

  socket.on('userStopTyping', function() {
    $('#typingIndicator').addClass('hidden');
  });

  // UI Listeners
  $('#btnJoin').on('click', submitJoin);
  $('#userName').on('keypress', function(e) {
    if (e.keyCode === 13) {
      submitJoin();
      e.preventDefault();
    }
  });

  $('#chatForm').on('submit', function(e) {
    e.preventDefault();
    submitMessage();
  });

  $('#msgInput').on('input', handleTypingKeystroke);

  $('#chanGlobal').on('click', function() {
    setTarget('All');
  });

  $('#btnCancelPrivate').on('click', function() {
    setTarget('All');
  });

  // Mobile menu buttons
  $('#btnOpenSidebar').on('click', openMobileSidebar);
  $('#btnCloseSidebar').on('click', closeMobileSidebar);
  $('#sidebarOverlay').on('click', closeMobileSidebar);

  // Sound toggle
  $('#btnSoundToggle').on('click', function() {
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

  // Quick emoji insertion
  $('.btn-emoji').on('click', function() {
    var emoji = $(this).data('emoji');
    var input = $('#msgInput');
    input.val(input.val() + emoji);
    input.focus();
  });

  // Focus initial username input
  setTimeout(function() {
    $('#userName').focus();
  }, 200);
});
