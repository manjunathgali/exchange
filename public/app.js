(function () {
  'use strict';

  // ============================================================
  // STATE
  // ============================================================
  let selfPeer = null;
  const peers = new Map(); // peerId -> { id, name }
  const peerConnections = new Map(); // peerId -> RTCPeerConnection
  const dataChannels = new Map(); // peerId -> RTCDataChannel

  let currentTransfer = null; // { file, to }
  let incomingTransfer = null; // { from, fileName, fileSize, fileType }
  let receivedChunks = [];
  let receivedSize = 0;
  let pollTimer = null;
  let isTransferring = false;
  let selectedPeerForDrop = null;
  let activeChatPeer = null; // peerId of the peer we're chatting with
  const chatHistory = new Map(); // peerId -> [{ text, sent, time }]

  const CHUNK_SIZE = 64 * 1024; // 64KB chunks
  const POLL_IDLE_MS = 2000; // Poll interval when idle
  const POLL_ACTIVE_MS = 400; // Poll interval during signaling (faster for ICE)

  // ============================================================
  // DOM ELEMENTS
  // ============================================================
  const selfInfo = document.getElementById('self-info');
  const selfIcon = document.getElementById('self-icon');
  const selfNameEl = document.getElementById('self-name');
  const statusDot = document.getElementById('status-dot');
  const noPeers = document.getElementById('no-peers');
  const peersGrid = document.getElementById('peers-grid');
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const transferOverlay = document.getElementById('transfer-overlay');
  const transferTitle = document.getElementById('transfer-title');
  const transferFileName = document.getElementById('transfer-file-name');
  const progressFill = document.getElementById('progress-fill');
  const transferStatus = document.getElementById('transfer-status');
  const cancelTransfer = document.getElementById('cancel-transfer');
  const receiveOverlay = document.getElementById('receive-overlay');
  const receiveInfo = document.getElementById('receive-info');
  const acceptBtn = document.getElementById('accept-btn');
  const rejectBtn = document.getElementById('reject-btn');
  const toastContainer = document.getElementById('toast-container');

  // Chat & action menu elements
  const chatOverlay = document.getElementById('chat-overlay');
  const chatPeerName = document.getElementById('chat-peer-name');
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const chatSendBtn = document.getElementById('chat-send');
  const chatCloseBtn = document.getElementById('chat-close');
  const peerActionOverlay = document.getElementById('peer-action-overlay');
  const actionPeerName = document.getElementById('action-peer-name');
  const actionSendFile = document.getElementById('action-send-file');
  const actionSendMsg = document.getElementById('action-send-msg');
  const actionCancel = document.getElementById('action-cancel');

  // ============================================================
  // DEVICE DETECTION
  // ============================================================
  function detectDevice() {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua)) return { icon: '📱', type: 'iPhone' };
    if (/Android/.test(ua)) return { icon: '📱', type: 'Android' };
    if (/Macintosh/.test(ua)) return { icon: '💻', type: 'Mac' };
    if (/Windows/.test(ua)) return { icon: '🖥️', type: 'Windows' };
    if (/Linux/.test(ua)) return { icon: '🐧', type: 'Linux' };
    return { icon: '💻', type: 'Device' };
  }

  // ============================================================
  // SIGNALING (HTTP POLLING)
  // ============================================================
  function generateId() {
    const arr = new Uint8Array(8);
    crypto.getRandomValues(arr);
    return Array.from(arr, b => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
  }

  function generateName() {
    const adjectives = ['Swift', 'Bright', 'Calm', 'Bold', 'Warm', 'Cool', 'Quick', 'Keen', 'Pure', 'Wise', 'Fair', 'True'];
    const nouns = ['Bear', 'Fox', 'Eagle', 'Wolf', 'Dolphin', 'Tiger', 'Hawk', 'Otter', 'Lynx', 'Raven', 'Panda', 'Falcon'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    return `${adj} ${noun}`;
  }

  async function apiCall(body) {
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.warn('API call failed:', e.message);
      return null;
    }
  }

  async function sendSignal(to, message) {
    return apiCall({ action: 'signal', peerId: selfPeer.id, to, message });
  }

  // ============================================================
  // PEER MANAGEMENT
  // ============================================================
  async function join() {
    const device = detectDevice();
    selfPeer = { id: generateId(), name: generateName() };

    selfIcon.textContent = device.icon;
    selfNameEl.textContent = selfPeer.name;
    selfInfo.classList.remove('hidden');

    const result = await apiCall({ action: 'join', peerId: selfPeer.id, peerName: selfPeer.name });
    if (result && result.peers) {
      syncPeers(result.peers);
    }

    startPolling(POLL_IDLE_MS);
  }

  function startPolling(interval) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(poll, interval);
  }

  async function poll() {
    if (!selfPeer) return;
    const result = await apiCall({ action: 'poll', peerId: selfPeer.id });
    if (!result) {
      statusDot.classList.remove('online');
      return;
    }
    statusDot.classList.add('online');

    if (result.peers) {
      syncPeers(result.peers);
    }

    if (result.messages && result.messages.length > 0) {
      // Speed up polling when receiving signaling messages
      if (!isTransferring) {
        startPolling(POLL_ACTIVE_MS);
        // Slow back down after 10s of no messages
        setTimeout(() => {
          if (!isTransferring) startPolling(POLL_IDLE_MS);
        }, 10000);
      }
      for (const msg of result.messages) {
        handleSignal(msg);
      }
    }
  }

  function syncPeers(peerList) {
    const newIds = new Set(peerList.map(p => p.id));
    let hasNewPeers = false;

    // New peers
    for (const p of peerList) {
      if (!peers.has(p.id)) {
        showToast(`${p.name} appeared`, 'success');
        hasNewPeers = true;
      }
      peers.set(p.id, p);
    }

    // Left peers
    for (const [id, peer] of peers) {
      if (!newIds.has(id)) {
        peers.delete(id);
        cleanupPeerConnection(id);
        peerLocations.delete(id);
        showToast(`${peer.name} left`);
      }
    }

    renderPeers();

    // Share our location with new peers
    if (hasNewPeers) {
      onPeerJoinedSendLocation();
    }
  }

  // ============================================================
  // SIGNAL HANDLING
  // ============================================================
  function handleSignal(msg) {
    switch (msg.type) {
      case 'offer': handleOffer(msg); break;
      case 'answer': handleAnswer(msg); break;
      case 'ice-candidate': handleIceCandidate(msg); break;
      case 'file-request': handleFileRequest(msg); break;
      case 'file-response': handleFileResponse(msg); break;
      case 'chat-message': handleChatMessage(msg); break;
      case 'location-update': handleLocationUpdate(msg); break;
    }
  }

  // ============================================================
  // UI RENDERING
  // ============================================================
  function renderPeers() {
    if (peers.size === 0) {
      noPeers.classList.remove('hidden');
      peersGrid.classList.add('hidden');
      return;
    }

    noPeers.classList.add('hidden');
    peersGrid.classList.remove('hidden');
    peersGrid.innerHTML = '';

    peers.forEach((peer, id) => {
      const card = document.createElement('div');
      card.className = 'peer-card';
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', `Send file to ${peer.name}`);
      card.innerHTML = `
        <span class="peer-icon">💻</span>
        <span class="peer-name">${escapeHtml(peer.name)}</span>
        <span class="peer-tap-hint">Tap to send</span>
      `;
      card.addEventListener('click', () => selectPeer(id));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectPeer(id);
        }
      });
      peersGrid.appendChild(card);
    });
  }

  function selectPeer(peerId) {
    selectedPeerForDrop = peerId;
    const peer = peers.get(peerId);
    if (!peer) return;

    // Show action menu
    actionPeerName.textContent = peer.name;
    peerActionOverlay.dataset.peerId = peerId;
    peerActionOverlay.classList.remove('hidden');
  }

  // Action menu handlers
  actionSendFile.addEventListener('click', () => {
    const peerId = peerActionOverlay.dataset.peerId;
    peerActionOverlay.classList.add('hidden');
    fileInput.dataset.targetPeer = peerId;
    fileInput.click();
  });

  actionSendMsg.addEventListener('click', () => {
    const peerId = peerActionOverlay.dataset.peerId;
    peerActionOverlay.classList.add('hidden');
    openChat(peerId);
  });

  actionCancel.addEventListener('click', () => {
    peerActionOverlay.classList.add('hidden');
  });

  // ============================================================
  // FILE SELECTION & DRAG-DROP
  // ============================================================
  fileInput.addEventListener('change', (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const targetPeerId = fileInput.dataset.targetPeer;
    if (!targetPeerId) return;

    initiateTransfer(files[0], targetPeerId);
    fileInput.value = '';
  });

  // Drag and drop
  let dragCounter = 0;

  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (peers.size > 0) {
      dropZone.classList.remove('hidden');
    }
  });

  document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dropZone.classList.add('hidden');
    }
  });

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropZone.classList.add('hidden');

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    // If only one peer, send to them directly
    if (peers.size === 1) {
      const peerId = peers.keys().next().value;
      initiateTransfer(files[0], peerId);
    } else if (peers.size > 1) {
      // Store file and let user pick peer
      showToast('Tap a device to send the file');
      // Store file temporarily
      window.__pendingDropFile = files[0];
    }
  });

  // ============================================================
  // FILE TRANSFER INITIATION
  // ============================================================
  function initiateTransfer(file, targetPeerId) {
    const peer = peers.get(targetPeerId);
    if (!peer) {
      showToast('Peer not found', 'error');
      return;
    }

    sendSignal(targetPeerId, {
      type: 'file-request',
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type || 'application/octet-stream'
    });

    currentTransfer = { file, to: targetPeerId };
    transferTitle.textContent = 'Waiting for acceptance...';
    transferFileName.textContent = `"${file.name}" (${formatSize(file.size)}) → ${peer.name}`;
    progressFill.style.width = '0%';
    transferStatus.textContent = 'Waiting for the other device to accept...';
    transferOverlay.classList.remove('hidden');

    // Speed up polling for response
    startPolling(POLL_ACTIVE_MS);
  }

  // ============================================================
  // FILE REQUEST / RESPONSE
  // ============================================================
  function handleFileRequest(msg) {
    const senderPeer = peers.get(msg.from);
    const senderName = senderPeer ? senderPeer.name : 'Someone';

    incomingTransfer = {
      from: msg.from,
      fileName: msg.fileName,
      fileSize: msg.fileSize,
      fileType: msg.fileType
    };

    receiveInfo.textContent = `${senderName} wants to send you "${msg.fileName}" (${formatSize(msg.fileSize)})`;
    receiveOverlay.classList.remove('hidden');
  }

  acceptBtn.addEventListener('click', () => {
    receiveOverlay.classList.add('hidden');
    if (!incomingTransfer) return;

    sendSignal(incomingTransfer.from, { type: 'file-response', accepted: true });

    transferTitle.textContent = 'Receiving...';
    transferFileName.textContent = `"${incomingTransfer.fileName}" (${formatSize(incomingTransfer.fileSize)})`;
    progressFill.style.width = '0%';
    transferStatus.textContent = 'Establishing connection...';
    transferOverlay.classList.remove('hidden');

    receivedChunks = [];
    receivedSize = 0;
    isTransferring = true;
    startPolling(POLL_ACTIVE_MS);
  });

  rejectBtn.addEventListener('click', () => {
    receiveOverlay.classList.add('hidden');
    if (!incomingTransfer) return;

    sendSignal(incomingTransfer.from, { type: 'file-response', accepted: false });
    incomingTransfer = null;
  });

  function handleFileResponse(msg) {
    if (!currentTransfer) return;

    if (msg.accepted) {
      transferTitle.textContent = 'Sending...';
      transferStatus.textContent = 'Establishing connection...';
      isTransferring = true;
      createConnectionAndSend(msg.from, currentTransfer.file);
    } else {
      transferOverlay.classList.add('hidden');
      showToast('Transfer declined', 'error');
      currentTransfer = null;
      startPolling(POLL_IDLE_MS);
    }
  }

  // ============================================================
  // WEBRTC
  // ============================================================
  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ]
  };

  function createConnectionAndSend(peerId, file) {
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections.set(peerId, pc);

    // Batch ICE candidates to reduce API calls
    let iceCandidateBuffer = [];
    let iceFlushTimer = null;

    function flushIceCandidates() {
      if (iceCandidateBuffer.length === 0) return;
      const candidates = iceCandidateBuffer.splice(0);
      for (const candidate of candidates) {
        sendSignal(peerId, { type: 'ice-candidate', candidate });
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        iceCandidateBuffer.push(event.candidate);
        clearTimeout(iceFlushTimer);
        iceFlushTimer = setTimeout(flushIceCandidates, 100);
      } else {
        // All candidates gathered
        flushIceCandidates();
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        showToast('Connection failed. Try again.', 'error');
        transferOverlay.classList.add('hidden');
        cleanupPeerConnection(peerId);
        currentTransfer = null;
        isTransferring = false;
        startPolling(POLL_IDLE_MS);
      }
    };

    const channel = pc.createDataChannel('file-transfer', { ordered: true });
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      transferStatus.textContent = 'Connected! Sending...';
      sendFileData(channel, file);
    };

    channel.onerror = () => {
      showToast('Transfer error', 'error');
      transferOverlay.classList.add('hidden');
      currentTransfer = null;
      isTransferring = false;
      startPolling(POLL_IDLE_MS);
    };

    dataChannels.set(peerId, channel);

    pc.createOffer().then((offer) => {
      return pc.setLocalDescription(offer);
    }).then(() => {
      sendSignal(peerId, { type: 'offer', sdp: pc.localDescription });
    });
  }

  function handleOffer(msg) {
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections.set(msg.from, pc);

    // Batch ICE candidates
    let iceCandidateBuffer = [];
    let iceFlushTimer = null;

    function flushIceCandidates() {
      if (iceCandidateBuffer.length === 0) return;
      const candidates = iceCandidateBuffer.splice(0);
      for (const candidate of candidates) {
        sendSignal(msg.from, { type: 'ice-candidate', candidate });
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        iceCandidateBuffer.push(event.candidate);
        clearTimeout(iceFlushTimer);
        iceFlushTimer = setTimeout(flushIceCandidates, 100);
      } else {
        flushIceCandidates();
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        showToast('Connection lost', 'error');
        transferOverlay.classList.add('hidden');
        cleanupPeerConnection(msg.from);
        incomingTransfer = null;
        isTransferring = false;
        startPolling(POLL_IDLE_MS);
      }
    };

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      channel.binaryType = 'arraybuffer';
      dataChannels.set(msg.from, channel);

      channel.onmessage = (e) => receiveChunk(e.data);

      channel.onerror = () => {
        showToast('Transfer error', 'error');
        transferOverlay.classList.add('hidden');
        incomingTransfer = null;
        isTransferring = false;
        startPolling(POLL_IDLE_MS);
      };
    };

    pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
      .then(() => pc.createAnswer())
      .then((answer) => pc.setLocalDescription(answer))
      .then(() => {
        sendSignal(msg.from, { type: 'answer', sdp: pc.localDescription });
      });
  }

  function handleAnswer(msg) {
    const pc = peerConnections.get(msg.from);
    if (pc) {
      pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    }
  }

  function handleIceCandidate(msg) {
    const pc = peerConnections.get(msg.from);
    if (pc && msg.candidate) {
      pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
    }
  }

  // ============================================================
  // FILE DATA TRANSFER
  // ============================================================
  function sendFileData(channel, file) {
    let offset = 0;
    const totalSize = file.size;

    function sendNextChunk() {
      if (channel.readyState !== 'open') return;

      // Backpressure control
      if (channel.bufferedAmount > CHUNK_SIZE * 16) {
        setTimeout(sendNextChunk, 20);
        return;
      }

      const end = Math.min(offset + CHUNK_SIZE, totalSize);
      const slice = file.slice(offset, end);

      const reader = new FileReader();
      reader.onload = () => {
        if (channel.readyState !== 'open') return;

        channel.send(reader.result);
        offset = end;

        const pct = Math.round((offset / totalSize) * 100);
        progressFill.style.width = pct + '%';
        transferStatus.textContent = `${pct}% — ${formatSize(offset)} / ${formatSize(totalSize)}`;

        if (offset < totalSize) {
          // Use setTimeout to avoid blocking the UI
          setTimeout(sendNextChunk, 0);
        } else {
          // Send empty buffer as end-of-file signal
          channel.send(new ArrayBuffer(0));
          setTimeout(() => {
            transferOverlay.classList.add('hidden');
            showToast(`"${file.name}" sent!`, 'success');
            currentTransfer = null;
            isTransferring = false;
            startPolling(POLL_IDLE_MS);
          }, 500);
        }
      };
      reader.readAsArrayBuffer(slice);
    }

    sendNextChunk();
  }

  function receiveChunk(data) {
    if (!incomingTransfer) return;

    // Empty buffer = end of file
    if (data.byteLength === 0) {
      const blob = new Blob(receivedChunks, { type: incomingTransfer.fileType });
      downloadBlob(blob, incomingTransfer.fileName);

      transferOverlay.classList.add('hidden');
      showToast(`"${incomingTransfer.fileName}" received!`, 'success');

      receivedChunks = [];
      receivedSize = 0;
      incomingTransfer = null;
      isTransferring = false;
      startPolling(POLL_IDLE_MS);
      return;
    }

    receivedChunks.push(data);
    receivedSize += data.byteLength;

    const pct = Math.round((receivedSize / incomingTransfer.fileSize) * 100);
    progressFill.style.width = pct + '%';
    transferStatus.textContent = `${pct}% — ${formatSize(receivedSize)} / ${formatSize(incomingTransfer.fileSize)}`;
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // ============================================================
  // CLEANUP
  // ============================================================
  function cleanupPeerConnection(peerId) {
    const pc = peerConnections.get(peerId);
    if (pc) {
      pc.close();
      peerConnections.delete(peerId);
    }
    const ch = dataChannels.get(peerId);
    if (ch) {
      try { ch.close(); } catch (e) {}
      dataChannels.delete(peerId);
    }
  }

  cancelTransfer.addEventListener('click', () => {
    transferOverlay.classList.add('hidden');
    if (currentTransfer) {
      cleanupPeerConnection(currentTransfer.to);
      currentTransfer = null;
    }
    if (incomingTransfer) {
      cleanupPeerConnection(incomingTransfer.from);
      incomingTransfer = null;
      receivedChunks = [];
      receivedSize = 0;
    }
    isTransferring = false;
    startPolling(POLL_IDLE_MS);
  });

  // ============================================================
  // CHAT / MESSAGING
  // ============================================================
  function openChat(peerId) {
    activeChatPeer = peerId;
    const peer = peers.get(peerId);
    chatPeerName.textContent = peer ? `💬 ${peer.name}` : '💬 Chat';
    renderChatMessages();
    chatOverlay.classList.remove('hidden');
    chatInput.focus();
  }

  function closeChat() {
    chatOverlay.classList.add('hidden');
    activeChatPeer = null;
  }

  chatCloseBtn.addEventListener('click', closeChat);
  chatOverlay.addEventListener('click', (e) => {
    if (e.target === chatOverlay) closeChat();
  });

  function renderChatMessages() {
    const messages = chatHistory.get(activeChatPeer) || [];
    if (messages.length === 0) {
      chatMessages.innerHTML = '<div class="chat-empty">No messages yet. Say hi! 👋</div>';
      return;
    }

    chatMessages.innerHTML = '';
    for (const msg of messages) {
      const div = document.createElement('div');
      div.className = `chat-msg ${msg.sent ? 'sent' : 'received'}`;
      div.innerHTML = `${escapeHtml(msg.text)}<span class="msg-time">${msg.time}</span>`;
      chatMessages.appendChild(div);
    }
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text || !activeChatPeer) return;

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Store locally
    if (!chatHistory.has(activeChatPeer)) chatHistory.set(activeChatPeer, []);
    chatHistory.get(activeChatPeer).push({ text, sent: true, time });

    // Send via signaling server
    sendSignal(activeChatPeer, { type: 'chat-message', text });

    chatInput.value = '';
    renderChatMessages();
  }

  chatSendBtn.addEventListener('click', sendChatMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  function handleChatMessage(msg) {
    const fromPeer = peers.get(msg.from);
    const fromName = fromPeer ? fromPeer.name : 'Someone';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Store in history
    if (!chatHistory.has(msg.from)) chatHistory.set(msg.from, []);
    chatHistory.get(msg.from).push({ text: msg.text, sent: false, time });

    // If chat is open with this peer, re-render
    if (activeChatPeer === msg.from) {
      renderChatMessages();
    } else {
      // Show notification toast that opens chat on click
      const toast = document.createElement('div');
      toast.className = 'toast message';
      toast.textContent = `💬 ${fromName}: ${msg.text.length > 40 ? msg.text.slice(0, 40) + '...' : msg.text}`;
      toast.style.cursor = 'pointer';
      toast.addEventListener('click', () => {
        toast.remove();
        openChat(msg.from);
      });
      toastContainer.appendChild(toast);
      setTimeout(() => { if (toast.parentNode) toast.remove(); }, 5000);
    }
  }

  // ============================================================
  // MAP & LOCATION
  // ============================================================
  const mapSection = document.getElementById('map-section');
  const mapContainer = document.getElementById('map');
  const mapToggleBtn = document.getElementById('map-toggle');
  let map = null;
  let mapMarkers = new Map(); // peerId -> marker
  let selfMarker = null;
  let selfLocation = null;
  let mapVisible = true;

  function initMap() {
    if (map) return;
    map = L.map('map', {
      zoomControl: false,
      attributionControl: false
    }).setView([20, 0], 2);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19
    }).addTo(map);

    // Add zoom control to top-right
    L.control.zoom({ position: 'topright' }).addTo(map);
  }

  function requestLocation() {
    if (!navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        selfLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        // Share location with peers via signaling
        broadcastLocation();
        updateMapMarkers();
      },
      (err) => {
        console.warn('Geolocation denied:', err.message);
        // Still show map if peers share their location
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
    );
  }

  function broadcastLocation() {
    if (!selfLocation || !selfPeer) return;
    // Send location to all connected peers
    peers.forEach((peer, peerId) => {
      sendSignal(peerId, {
        type: 'location-update',
        lat: selfLocation.lat,
        lng: selfLocation.lng
      });
    });
  }

  // Store peer locations
  const peerLocations = new Map(); // peerId -> { lat, lng }

  function handleLocationUpdate(msg) {
    if (msg.lat && msg.lng) {
      peerLocations.set(msg.from, { lat: msg.lat, lng: msg.lng });
      updateMapMarkers();
    }
  }

  function updateMapMarkers() {
    const hasAnyLocation = selfLocation || peerLocations.size > 0;
    if (!hasAnyLocation) return;

    // Show map section
    mapSection.classList.remove('hidden');
    initMap();

    const bounds = [];

    // Self marker
    if (selfLocation) {
      bounds.push([selfLocation.lat, selfLocation.lng]);
      if (selfMarker) {
        selfMarker.setLatLng([selfLocation.lat, selfLocation.lng]);
      } else {
        const icon = L.divIcon({
          className: '',
          html: `<div class="device-marker self"></div>`,
          iconSize: [14, 14],
          iconAnchor: [7, 7]
        });
        selfMarker = L.marker([selfLocation.lat, selfLocation.lng], { icon })
          .addTo(map)
          .bindTooltip(`<div class="device-marker-label">📍 You (${selfPeer.name})</div>`, {
            permanent: false,
            direction: 'top',
            offset: [0, -10],
            className: ''
          });
      }
    }

    // Peer markers
    peerLocations.forEach((loc, peerId) => {
      bounds.push([loc.lat, loc.lng]);
      const peer = peers.get(peerId);
      const name = peer ? peer.name : 'Device';

      if (mapMarkers.has(peerId)) {
        mapMarkers.get(peerId).setLatLng([loc.lat, loc.lng]);
      } else {
        const icon = L.divIcon({
          className: '',
          html: `<div class="device-marker"></div>`,
          iconSize: [14, 14],
          iconAnchor: [7, 7]
        });
        const marker = L.marker([loc.lat, loc.lng], { icon })
          .addTo(map)
          .bindTooltip(`<div class="device-marker-label">💻 ${escapeHtml(name)}</div>`, {
            permanent: false,
            direction: 'top',
            offset: [0, -10],
            className: ''
          });
        mapMarkers.set(peerId, marker);
      }
    });

    // Remove markers for peers that left
    for (const [peerId, marker] of mapMarkers) {
      if (!peerLocations.has(peerId)) {
        map.removeLayer(marker);
        mapMarkers.delete(peerId);
      }
    }

    // Fit bounds
    if (bounds.length > 0) {
      if (bounds.length === 1) {
        map.setView(bounds[0], 14);
      } else {
        map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
      }
    }

    // Invalidate size in case map was hidden
    setTimeout(() => map.invalidateSize(), 100);
  }

  // Map toggle
  mapToggleBtn.addEventListener('click', () => {
    mapVisible = !mapVisible;
    mapContainer.classList.toggle('collapsed', !mapVisible);
    mapToggleBtn.textContent = mapVisible ? 'Hide Map' : 'Show Map';
    if (mapVisible && map) {
      setTimeout(() => map.invalidateSize(), 100);
    }
  });

  // Send location to new peers when they join
  function onPeerJoinedSendLocation() {
    if (selfLocation) {
      broadcastLocation();
    }
  }

  // ============================================================
  // UTILITIES
  // ============================================================
  function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = 'toast' + (type ? ' ' + type : '');
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 3000);
  }

  // ============================================================
  // PAGE LIFECYCLE
  // ============================================================
  window.addEventListener('beforeunload', () => {
    if (selfPeer) {
      // sendBeacon for reliable leave notification
      const payload = JSON.stringify({ action: 'leave', peerId: selfPeer.id });
      navigator.sendBeacon('/api/rooms', payload);
    }
    if (pollTimer) clearInterval(pollTimer);
  });

  // Rejoin on visibility change (mobile tab switching)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && selfPeer) {
      // Re-register immediately
      apiCall({ action: 'join', peerId: selfPeer.id, peerName: selfPeer.name });
      poll();
    }
  });

  // ============================================================
  // INIT
  // ============================================================
  join();
  requestLocation();

})();
