// trtw.tv Service Worker — Central orchestrator
// Manages tab capture, offscreen document lifecycle, and message routing

const State = {
  IDLE: 'idle',
  STARTING: 'starting',
  CAPTURING: 'capturing',
  STOPPING: 'stopping',
  ERROR: 'error'
};

let captureState = State.IDLE;
let activeTabId = null;

// ── Message Router ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'start-capture':
      handleStartCapture(message.tabId).then(sendResponse);
      return true;

    case 'stop-capture':
      handleStopCapture().then(sendResponse);
      return true;

    case 'get-state':
      sendResponse({ state: captureState, activeTabId });
      return false;

    case 'transcription':
      forwardToContentScript(message);
      return false;

    case 'model-progress':
      // Relay model download progress to popup
      // Popup listens via chrome.runtime.onMessage
      return false;

    case 'capture-error':
      captureState = State.ERROR;
      updateBadge();
      return false;
  }
});

// ── Keyboard Shortcut ───────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-subtitles') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    if (captureState === State.CAPTURING) {
      await handleStopCapture();
    } else if (captureState === State.IDLE) {
      await handleStartCapture(tab.id);
    }
  }
});

// ── Capture Lifecycle ───────────────────────────────────────────

async function handleStartCapture(tabId) {
  if (captureState !== State.IDLE) {
    return { success: false, error: 'Already capturing' };
  }

  try {
    captureState = State.STARTING;
    activeTabId = tabId;
    updateBadge();

    // Get stream ID for the target tab
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId
    });

    // Ensure offscreen document exists
    await ensureOffscreenDocument();

    // Send stream ID to offscreen document
    await chrome.runtime.sendMessage({
      type: 'start-audio-capture',
      target: 'offscreen',
      data: { streamId, tabId }
    });

    captureState = State.CAPTURING;
    updateBadge();
    return { success: true };

  } catch (error) {
    captureState = State.ERROR;
    activeTabId = null;
    updateBadge();
    console.error('[trtw.tv] Capture start failed:', error);
    return { success: false, error: error.message };
  }
}

async function handleStopCapture() {
  if (captureState !== State.CAPTURING) {
    return { success: false, error: 'Not capturing' };
  }

  try {
    captureState = State.STOPPING;
    updateBadge();

    // Tell offscreen document to stop
    await chrome.runtime.sendMessage({
      type: 'stop-audio-capture',
      target: 'offscreen'
    });

    // Close offscreen document
    await chrome.offscreen.closeDocument();

    // Clear subtitles from content script before resetting state
    const tabToClean = activeTabId;
    captureState = State.IDLE;
    activeTabId = null;
    updateBadge();

    if (tabToClean) {
      chrome.tabs.sendMessage(tabToClean, { type: 'clear-subtitles' }).catch(() => {});
    }

    return { success: true };

  } catch (error) {
    const tabToClean = activeTabId;
    captureState = State.IDLE;
    activeTabId = null;
    updateBadge();
    if (tabToClean) {
      chrome.tabs.sendMessage(tabToClean, { type: 'clear-subtitles' }).catch(() => {});
    }
    console.error('[trtw.tv] Capture stop failed:', error);
    return { success: true }; // Still consider it stopped
  }
}

// ── Offscreen Document ──────────────────────────────────────────

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab audio and run Whisper transcription'
  });
}

// ── Forward Transcriptions to Content Script ────────────────────

function forwardToContentScript(message) {
  if (!activeTabId) return;

  chrome.tabs.sendMessage(activeTabId, {
    type: 'subtitle-update',
    text: message.text,
    language: message.language,
    timestamp: message.timestamp
  }).catch(() => {
    // Tab might have been closed
  });
}

// ── Badge Management ────────────────────────────────────────────

function updateBadge() {
  const badges = {
    [State.IDLE]: { text: '', color: '#666' },
    [State.STARTING]: { text: '...', color: '#EAB308' },
    [State.CAPTURING]: { text: 'ON', color: '#22C55E' },
    [State.STOPPING]: { text: '...', color: '#EAB308' },
    [State.ERROR]: { text: '!', color: '#EF4444' }
  };

  const badge = badges[captureState] || badges[State.IDLE];
  chrome.action.setBadgeText({ text: badge.text });
  chrome.action.setBadgeBackgroundColor({ color: badge.color });
}

// ── Tab Cleanup ─────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) {
    handleStopCapture();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && changeInfo.url) {
    handleStopCapture();
  }
});

// ── Init ────────────────────────────────────────────────────────

updateBadge();
console.log('[trtw.tv] Service worker loaded');
