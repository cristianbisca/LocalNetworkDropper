/**
 * LND - Local Network File & Clip Dropper
 * Frontend Application Logic
 */

(async function() {
  'use strict';

  // ─── State ────────────────────────────────────────────────────────────────
  let ws = null;
  let clientId = null;
  let reconnectTimer = null;
  let clipboardSyncTimeout = null;
  const items = new Map(); // id -> item data
  let authRequired = false;
  let authToken = null;

  // Debug logging - controlled by server via init message, or ?debug=1 URL param
  let debugMode = new URLSearchParams(window.location.search).get('debug') === '1';

  function dbg(...args) {
    if (debugMode) console.log('[LND-DEBUG]', ...args);
  }

  // ─── Authentication ──────────────────────────────────────────────────────
  async function checkAuthStatus() {
    try {
      const response = await fetch('/api/auth/status');
      const data = await response.json();
      authRequired = data.authRequired;
      dbg('Auth required:', authRequired);

      if (authRequired) {
        // Check for stored token
        authToken = sessionStorage.getItem('lnd_token');
        if (authToken) {
          // Validate the token by making a test request
          const valid = await validateToken();
          if (!valid) {
            sessionStorage.removeItem('lnd_token');
            authToken = null;
            showLoginOverlay();
            return false;
          }
          hideLoginOverlay();
          return true;
        } else {
          showLoginOverlay();
          return false;
        }
      } else {
        hideLoginOverlay();
        return true;
      }
    } catch (err) {
      console.error('[LND] Auth check failed:', err);
      return true; // Allow access on error to avoid lockout
    }
  }

  async function validateToken() {
    try {
      const response = await fetch('/api/health', {
        headers: { 'X-LND-Token': authToken }
      });
      return response.ok;
    } catch (err) {
      return false;
    }
  }

  function showLoginOverlay() {
    const overlay = document.getElementById('loginOverlay');
    if (overlay) overlay.style.display = 'flex';
  }

  function hideLoginOverlay() {
    const overlay = document.getElementById('loginOverlay');
    if (overlay) overlay.style.display = 'none';
  }

  async function handleLogin(e) {
    e.preventDefault();
    const user = document.getElementById('loginUser').value;
    const password = document.getElementById('loginPassword').value;
    const errorEl = document.getElementById('loginError');

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, password })
      });

      const data = await response.json();

      if (data.success) {
        authToken = data.token;
        sessionStorage.setItem('lnd_token', authToken);
        errorEl.style.display = 'none';
        hideLoginOverlay();
        dbg('Login successful');
        // Now connect WebSocket with token
        connectWebSocket();
      } else {
        errorEl.textContent = data.error || 'Login failed';
        errorEl.style.display = 'block';
      }
    } catch (err) {
      errorEl.textContent = 'Connection error. Please try again.';
      errorEl.style.display = 'block';
    }
  }

  // Attach login form handler
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', handleLogin);
  }

  // ─── API Helper with Auth ────────────────────────────────────────────────
  async function authenticatedFetch(url, options = {}) {
    if (!options.headers) options.headers = {};
    if (authToken) {
      options.headers['X-LND-Token'] = authToken;
    }
    return fetch(url, options);
  }

  // ─── Initialize with Auth Check ──────────────────────────────────────────
  const authOk = await checkAuthStatus();
  if (!authOk) {
    // Wait for login before proceeding
    return;
  }

  // Continue normal initialization after successful auth

  // ─── DOM Elements ─────────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const connectionStatus = $('#connectionStatus');
  const statusDot = connectionStatus.querySelector('.status-dot');
  const statusText = connectionStatus.querySelector('.status-text');
  const clientCountEl = $('#clientCount');
  const countNumber = clientCountEl.querySelector('.count-number');

  const dropZone = $('#dropZone');
  const fileInput = $('#fileInput');
  const browseBtn = $('#browseBtn');
  const dragOverlay = $('#dragOverlay');

  const clipboardText = $('#clipboardText');
  const clipboardStatus = $('#clipboardStatus');
  const copyClipboardBtn = $('#copyClipboardBtn');

  const itemsList = $('#itemsList');
  const emptyState = $('#emptyState');
  const clearItemsBtn = $('#clearItemsBtn');

  const shareTextInput = $('#shareTextInput');
  const shareTextTitle = $('#shareTextTitle');
  const shareTextBtn = $('#shareTextBtn');

  const toastContainer = $('#toastContainer');

  // ─── WebSocket Connection ────────────────────────────────────────────────
  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    let wsUrl = `${protocol}://${window.location.host}`;

    // Append auth token as query parameter if available
    if (authToken) {
      wsUrl += `?token=${encodeURIComponent(authToken)}`;
    }

    dbg('Connecting to WebSocket:', wsUrl);
    updateConnectionStatus('connecting');

    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
      dbg('WebSocket connected');
      updateConnectionStatus('connected');
      clearTimeout(reconnectTimer);
    };
    
    ws.onmessage = (event) => {
      try {
        const rawData = event.data;
        dbg('<<< WS raw message received:', rawData.slice(0, 200));
        const message = JSON.parse(rawData);
        dbg('<<< WS parsed type:', message.type);
        handleMessage(message);
      } catch (err) {
        console.error('[LND] Failed to parse message:', err);
      }
    };
    
    ws.onclose = () => {
      dbg('WebSocket disconnected');
      updateConnectionStatus('disconnected');
      scheduleReconnect();
    };
    
    ws.onerror = (err) => {
      console.error('[LND] WebSocket error:', err);
      updateConnectionStatus('error');
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    
    const delay = Math.min(1000 * Math.pow(2, Math.random()), 30000);
    console.log(`[LND] Reconnecting in ${Math.round(delay)}ms...`);
    
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, delay);
  }

  function updateConnectionStatus(status) {
    statusDot.className = 'status-dot';
    
    switch (status) {
      case 'connected':
        statusDot.classList.add('connected');
        statusText.textContent = 'Connected';
        break;
      case 'connecting':
        statusText.textContent = 'Connecting...';
        break;
      case 'error':
        statusText.textContent = 'Connection Error';
        break;
      default:
        statusDot.classList.add('disconnected');
        statusText.textContent = 'Disconnected';
    }
  }

  function updateClientCount(count) {
    countNumber.textContent = count || 0;
  }

  // ─── Message Handler ─────────────────────────────────────────────────────
  function handleMessage(message) {
    switch (message.type) {
      case 'init':
        clientId = message.payload.clientId;
        if (typeof message.payload.debug === 'boolean') {
          debugMode = message.payload.debug;
        }
        updateClientCount(message.payload.clientCount);
        
        // Restore clipboard
        if (message.payload.clipboard?.text) {
          clipboardText.value = message.payload.clipboard.text;
          updateClipboardStatus('Synced');
        }
        
        // Restore items
        if (message.payload.items) {
          message.payload.items.forEach(item => {
            items.set(item.id, item);
            renderItem(item);
          });
          updateEmptyState();
        }
        break;
      
      case 'clipboard_update':
        handleClipboardUpdate(message.payload);
        break;
      
      case 'new_item':
        const newItem = message.payload;
        items.set(newItem.id, newItem);
        renderItem(newItem);
        updateEmptyState();
        showToast(`${newItem.type === 'file' ? '📁' : '📝'} ${newItem.name || newItem.title} received`, 'success');
        break;
      
      case 'client_connected':
        updateClientCount(message.payload.clientCount);
        showToast(`👤 Device connected (${message.payload.deviceName})`, 'info');
        break;
      
      case 'client_disconnected':
        updateClientCount(message.payload.clientCount);
        break;
      
      case 'device_discovered':
        console.log('[LND] Device discovered:', message.payload.name);
        break;
      
      case 'pong':
        // Keepalive response, no action needed
        break;
    }
  }

  // ─── Clipboard Sync ──────────────────────────────────────────────────────
  // Track the last text we locally typed to distinguish our own echo from remote updates
  let lastLocalText = '';

  function handleClipboardUpdate(payload) {
    const remoteText = payload.text || '';
    const currentText = clipboardText.value;
    
    dbg('clipboard_update received:', {
      remoteLen: remoteText.length,
      currentLen: currentText.length,
      same: remoteText === currentText
    });
    
    // Only update if the content differs from what we currently have.
    // This prevents echo loops without relying on fragile timestamp windows,
    // and ensures remote changes always reach other devices regardless of latency.
    if (remoteText !== currentText) {
      lastLocalText = remoteText;
      clipboardText.value = remoteText;
      updateClipboardStatus('Synced');
      dbg('Clipboard updated from remote:', remoteText.slice(0, 50));
    } else {
      dbg('Clipboard skipped (content identical)');
    }
  }

  function updateClipboardStatus(text) {
    clipboardStatus.textContent = text || '';
  }

  function sendClipboardUpdate() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const text = clipboardText.value;

      dbg('Sending clipboard_update:', { len: text.length, preview: text.slice(0, 50) });
      
      ws.send(JSON.stringify({
        type: 'clipboard_update',
        payload: { text }
      }));
      
      lastLocalText = text;
      updateClipboardStatus('Syncing...');
      
      // Reset status after a delay
      setTimeout(() => {
        updateClipboardStatus('Synced ✓');
      }, 1000);
    } else {
      dbg('Cannot send clipboard_update: WebSocket not open (state:', ws?.readyState, ')');
    }
  }

  // Debounced clipboard sync - reduced delay for snappier feel
  clipboardText.addEventListener('input', () => {
    clearTimeout(clipboardSyncTimeout);
    clipboardSyncTimeout = setTimeout(sendClipboardUpdate, 500);
  });

  // ─── Items Rendering ─────────────────────────────────────────────────────
  function renderItem(item) {
    const card = document.createElement('div');
    card.className = 'item-card';
    card.dataset.itemId = item.id;
    
    if (item.type === 'file') {
      card.innerHTML = `
        <div class="item-icon">${getFileIcon(item.mimeType, item.name)}</div>
        <div class="item-details">
          <div class="item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
          <div class="item-meta">
            <span>${formatFileSize(item.size)}</span>
            <span>from ${escapeHtml(item.sourceDevice || 'unknown')}</span>
            <span>${formatTime(item.timestamp)}</span>
          </div>
        </div>
        <div class="item-actions">
          <a href="/api/download/${encodeURIComponent(item.fileName)}" 
             download="${escapeHtml(item.name)}" 
             class="btn-icon" title="Download"
             onclick="event.preventDefault(); downloadFile('${item.id}');">
            ⬇️
          </a>
          <button class="btn-icon danger" title="Delete" onclick="deleteItem('${item.id}')">🗑️</button>
        </div>
      `;
    } else if (item.type === 'text') {
      const preview = item.content?.slice(0, 200);
      card.innerHTML = `
        <div class="item-icon">📝</div>
        <div class="item-details">
          <div class="item-name" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
          <div class="item-meta">
            <span>${(item.content || '').length} chars</span>
            <span>from ${escapeHtml(item.sourceDevice || 'unknown')}</span>
            <span>${formatTime(item.timestamp)}</span>
          </div>
          ${preview ? `<div class="text-item-preview">${escapeHtml(preview)}${(item.content || '').length > 200 ? '...' : ''}</div>` : ''}
        </div>
        <div class="item-actions">
          <button class="btn-icon" title="Copy to clipboard" onclick="copyTextItem('${item.id}')">📋</button>
          <button class="btn-icon danger" title="Delete" onclick="deleteItem('${item.id}')">🗑️</button>
        </div>
      `;
    }
    
    // Insert at the beginning (newest first)
    if (itemsList.contains(emptyState)) {
      itemsList.insertBefore(card, emptyState);
    } else {
      itemsList.prepend(card);
    }
  }

  function updateEmptyState() {
    const hasItems = items.size > 0;
    if (emptyState) {
      emptyState.style.display = hasItems ? 'none' : 'flex';
    }
  }

  // ─── File Upload ─────────────────────────────────────────────────────────
  async function uploadFiles(files) {
    for (const file of files) {
      const formData = new FormData();
      formData.append('file', file);
      
      try {
        showToast(`⏳ Uploading ${file.name}...`, 'info');
        
        // Add auth header manually for FormData (authenticatedFetch doesn't set Content-Type for FormData)
        const headers = {};
        if (authToken) headers['X-LND-Token'] = authToken;
        const response = await fetch('/api/upload', {
          method: 'POST',
          headers,
          body: formData
        });
        
        const result = await response.json();
        
        if (result.success) {
          // Don't add to local items since it will come back via WebSocket
          showToast(`✅ ${file.name} shared!`, 'success');
        } else {
          throw new Error(result.error || 'Upload failed');
        }
      } catch (err) {
        console.error('[LND] Upload error:', err);
        showToast(`❌ Failed to upload ${file.name}: ${err.message}`, 'error');
      }
    }
  }

  // ─── Text Share ──────────────────────────────────────────────────────────
  async function shareText() {
    const text = shareTextInput.value.trim();
    const title = shareTextTitle.value.trim();
    
    if (!text) {
      showToast('⚠️ Please enter some text to share', 'error');
      return;
    }
    
    // Send via WebSocket for real-time broadcast
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'text_share',
        payload: { text, title }
      }));
      
      showToast('✅ Text shared!', 'success');
      shareTextInput.value = '';
      shareTextTitle.value = '';
    } else {
      // Fallback to HTTP API
      try {
        const response = await authenticatedFetch('/api/text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, title })
        });
        
        const result = await response.json();
        
        if (result.success) {
          showToast('✅ Text shared!', 'success');
          shareTextInput.value = '';
          shareTextTitle.value = '';
        } else {
          throw new Error(result.error || 'Share failed');
        }
      } catch (err) {
        console.error('[LND] Share text error:', err);
        showToast(`❌ Failed to share: ${err.message}`, 'error');
      }
    }
  }

  // ─── Drag & Drop ─────────────────────────────────────────────────────────
  let dragCounter = 0;

  // Handle drop zone events
  dropZone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
      dropZone.classList.remove('drag-over');
    }
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropZone.classList.remove('drag-over');
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      uploadFiles(files);
    }
  });

  // Handle global drag & drop with overlay
  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    dragOverlay.classList.add('visible');
  });

  document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
      dragOverlay.classList.remove('visible');
    }
  });

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dragOverlay.classList.remove('visible');
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      uploadFiles(files);
    }
  });

  // ─── Tabs ────────────────────────────────────────────────────────────────
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      
      // Update active tab button
      $$('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      // Update active content
      $$('.tab-content').forEach(content => content.classList.remove('active'));
      $(`#${targetTab}`).classList.add('active');
    });
  });

  // ─── Toast Notifications ────────────────────────────────────────────────
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    
    toastContainer.appendChild(toast);
    
    // Remove after animation completes
    setTimeout(() => {
      if (toast.parentNode) {
        toast.remove();
      }
    }, 3000);
  }

  // ─── Utility Functions ──────────────────────────────────────────────────
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function formatTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    
    if (diffMs < 60000) return 'just now';
    if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m ago`;
    if (diffMs < 86400000) return `${Math.floor(diffMs / 3600000)}h ago`;
    
    return date.toLocaleDateString();
  }

  function getFileIcon(mimeType, fileName) {
    if (!mimeType && !fileName) return '📄';
    
    if (mimeType) {
      if (mimeType.startsWith('image/')) return '🖼️';
      if (mimeType.startsWith('video/')) return '🎬';
      if (mimeType.startsWith('audio/')) return '🎵';
      if (mimeType.includes('pdf')) return '📕';
      if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar') || mimeType.includes('compress')) return '🗜️';
      if (mimeType.includes('javascript') || mimeType.includes('json')) return '⚙️';
      if (mimeType.includes('html') || mimeType.includes('css')) return '🌐';
    }
    
    // Fallback to extension check
    const ext = fileName?.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'pdf': return '📕';
      case 'doc': case 'docx': return '📘';
      case 'xls': case 'xlsx': return '📊';
      case 'ppt': case 'pptx': return '📙';
      case 'zip': case 'rar': case '7z': return '🗜️';
      case 'jpg': case 'jpeg': case 'png': case 'gif': case 'webp': case 'svg': return '🖼️';
      case 'mp4': case 'avi': case 'mkv': return '🎬';
      case 'mp3': case 'wav': case 'flac': return '🎵';
      case 'txt': return '📝';
      case 'js': case 'ts': case 'py': case 'java': return '💻';
      default: return '📄';
    }
  }

  // ─── Global Functions (for onclick handlers) ─────────────────────────────
  window.downloadFile = function(itemId) {
    const item = items.get(itemId);
    if (item && item.fileName) {
      const link = document.createElement('a');
      link.href = `/api/download/${encodeURIComponent(item.fileName)}`;
      link.download = item.name;
      link.click();
    }
  };

  window.copyTextItem = function(itemId) {
    const item = items.get(itemId);
    if (item && item.content) {
      navigator.clipboard.writeText(item.content).then(() => {
        showToast('📋 Copied to clipboard!', 'success');
      }).catch(() => {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = item.content;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showToast('📋 Copied to clipboard!', 'success');
      });
    }
  };

  window.deleteItem = async function(itemId) {
    try {
      const response = await authenticatedFetch(`/api/items/${itemId}`, { method: 'DELETE' });
      const result = await response.json();
      
      if (result.success) {
        items.delete(itemId);
        const card = $(`.item-card[data-item-id="${itemId}"]`);
        if (card) card.remove();
        updateEmptyState();
        showToast('🗑️ Item deleted', 'info');
      }
    } catch (err) {
      console.error('[LND] Delete error:', err);
      showToast('❌ Failed to delete item', 'error');
    }
  };

  // ─── Event Listeners ─────────────────────────────────────────────────────
  
  // Browse button & drop zone click -> open file dialog
  browseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  dropZone.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      uploadFiles(fileInput.files);
      fileInput.value = ''; // Reset for next use
    }
  });

  // Copy clipboard button
  copyClipboardBtn.addEventListener('click', () => {
    const text = clipboardText.value;
    if (text) {
      navigator.clipboard.writeText(text).then(() => {
        showToast('📋 Copied to system clipboard!', 'success');
      }).catch(() => {
        // Fallback
        clipboardText.select();
        document.execCommand('copy');
        showToast('📋 Copied to system clipboard!', 'success');
      });
    } else {
      showToast('⚠️ Nothing to copy', 'error');
    }
  });

  // Clear items button
  clearItemsBtn.addEventListener('click', async () => {
    if (items.size === 0) return;

    try {
      await authenticatedFetch('/api/items/clear', { method: 'POST' });
      items.clear();
      
      // Remove all item cards
      $$('.item-card').forEach(card => card.remove());
      updateEmptyState();
      showToast('🗑️ All items cleared', 'info');
    } catch (err) {
      console.error('[LND] Clear error:', err);
      showToast('❌ Failed to clear items', 'error');
    }
  });

  // Share text button
  shareTextBtn.addEventListener('click', shareText);

  // Share text on Ctrl+Enter
  shareTextInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      shareText();
    }
  });

  // ─── Keepalive Ping ──────────────────────────────────────────────────────
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 30000);

  // ─── Initialize ──────────────────────────────────────────────────────────
  connectWebSocket();
  
  console.log('[LND] Application initialized');
})();