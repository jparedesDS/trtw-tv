// trtw.tv Content Script — Subtitle Overlay for Twitch & YouTube
// Injects Netflix-quality subtitles over the video player

(() => {
  'use strict';

  // ── Site Detection ──────────────────────────────────────────

  const SITES = {
    twitch: {
      host: 'twitch.tv',
      selectors: [
        '.video-player__container',
        '[data-a-target="video-player"]',
        '.video-player',
        'video'
      ]
    },
    youtube: {
      host: 'youtube.com',
      selectors: [
        '#movie_player',
        '.html5-video-player',
        '#player-container',
        'video'
      ]
    }
  };

  function detectSite() {
    const host = window.location.hostname;
    for (const [name, config] of Object.entries(SITES)) {
      if (host.includes(config.host)) return { name, ...config };
    }
    return null;
  }

  // ── Overlay Manager ─────────────────────────────────────────

  let container = null;
  let subtitleEl = null;
  let langBadge = null;
  let statusDot = null;
  let fadeTimeout = null;
  let langTimeout = null;
  let observer = null;
  let currentPlayerEl = null;

  function createOverlay() {
    if (container) return;

    container = document.createElement('div');
    container.id = 'trtw-subtitle-container';

    subtitleEl = document.createElement('div');
    subtitleEl.id = 'trtw-subtitle-text';

    langBadge = document.createElement('div');
    langBadge.id = 'trtw-lang-badge';

    statusDot = document.createElement('div');
    statusDot.id = 'trtw-status';

    container.appendChild(statusDot);
    container.appendChild(langBadge);
    container.appendChild(subtitleEl);

    return container;
  }

  function findPlayerContainer(site) {
    for (const selector of site.selectors) {
      const el = document.querySelector(selector);
      if (el) {
        // If we found a <video> element, use its parent as container
        if (el.tagName === 'VIDEO') {
          return el.parentElement;
        }
        return el;
      }
    }
    return null;
  }

  function attachOverlay(site) {
    const playerEl = findPlayerContainer(site);
    if (!playerEl || playerEl === currentPlayerEl) return;

    // Remove from previous container if any
    if (container && container.parentElement) {
      container.parentElement.removeChild(container);
    }

    createOverlay();

    // Ensure the player container has relative positioning
    const playerPosition = getComputedStyle(playerEl).position;
    if (playerPosition === 'static') {
      playerEl.style.position = 'relative';
    }

    playerEl.appendChild(container);
    currentPlayerEl = playerEl;

    // Apply saved settings
    applySettings();

    console.log(`[trtw.tv] Overlay attached to ${site.name} player`);
  }

  function destroyOverlay() {
    if (container && container.parentElement) {
      container.parentElement.removeChild(container);
    }
    container = null;
    subtitleEl = null;
    langBadge = null;
    statusDot = null;
    currentPlayerEl = null;
    clearTimeout(fadeTimeout);
    clearTimeout(langTimeout);
  }

  // ── Subtitle Display ───────────────────────────────────────

  let lastText = '';

  function showSubtitle(text, language) {
    if (!subtitleEl || !text) return;

    // Deduplication: skip if same as last text
    if (text === lastText) return;
    lastText = text;

    // Clear existing timeouts
    clearTimeout(fadeTimeout);

    // Update text
    subtitleEl.textContent = text;

    // Animate in
    subtitleEl.classList.remove('trtw-fading');
    // Force reflow for animation restart
    void subtitleEl.offsetWidth;
    subtitleEl.classList.add('trtw-visible');

    // Show language badge briefly
    if (language && language !== 'auto') {
      showLanguageBadge(language);
    }

    // Show status dot
    if (statusDot) {
      statusDot.classList.add('trtw-active');
    }

    // Fade out after 5 seconds of no new subtitles
    fadeTimeout = setTimeout(() => {
      if (subtitleEl) {
        subtitleEl.classList.remove('trtw-visible');
        subtitleEl.classList.add('trtw-fading');
      }
    }, 5000);
  }

  function showLanguageBadge(lang) {
    if (!langBadge) return;
    clearTimeout(langTimeout);

    langBadge.textContent = lang.toUpperCase();
    langBadge.classList.add('trtw-visible');

    langTimeout = setTimeout(() => {
      langBadge.classList.remove('trtw-visible');
    }, 3000);
  }

  function clearSubtitles() {
    if (subtitleEl) {
      subtitleEl.classList.remove('trtw-visible');
      subtitleEl.classList.add('trtw-fading');
    }
    if (statusDot) {
      statusDot.classList.remove('trtw-active');
    }
    lastText = '';
  }

  // ── Settings ────────────────────────────────────────────────

  async function applySettings() {
    if (!container) return;

    const defaults = {
      fontSize: 20,
      textColor: '#FFFFFF',
      bgOpacity: 0.78,
      subtitlePosition: 'bottom'
    };

    try {
      const settings = await chrome.storage.sync.get(defaults);
      container.style.setProperty('--trtw-font-size', settings.fontSize + 'px');
      container.style.setProperty('--trtw-text-color', settings.textColor);

      if (subtitleEl) {
        subtitleEl.style.background = `rgba(0, 0, 0, ${settings.bgOpacity})`;
      }

      // Position
      container.className = 'trtw-position-' + settings.subtitlePosition;
      container.id = 'trtw-subtitle-container';
    } catch {
      // Use defaults from CSS
    }
  }

  // Listen for settings changes
  chrome.storage.onChanged.addListener((changes) => {
    const relevant = ['fontSize', 'textColor', 'bgOpacity', 'subtitlePosition'];
    if (relevant.some(key => key in changes)) {
      applySettings();
    }
  });

  // ── SPA Navigation Handling ─────────────────────────────────

  let observerDebounce = null;

  function setupObserver(site) {
    if (observer) observer.disconnect();

    observer = new MutationObserver(() => {
      // Debounce to avoid excessive DOM queries on dynamic pages
      clearTimeout(observerDebounce);
      observerDebounce = setTimeout(() => {
        const playerEl = findPlayerContainer(site);
        if (playerEl && playerEl !== currentPlayerEl) {
          attachOverlay(site);
        }
      }, 500);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // ── Message Listener ────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    switch (message.type) {
      case 'subtitle-update':
        showSubtitle(message.text, message.language);
        break;

      case 'clear-subtitles':
        clearSubtitles();
        break;
    }
  });

  // ── Fullscreen Handling ─────────────────────────────────────

  document.addEventListener('fullscreenchange', () => {
    const site = detectSite();
    if (site) {
      // Re-attach after a small delay to let the DOM settle
      setTimeout(() => attachOverlay(site), 200);
    }
  });

  // ── Init ────────────────────────────────────────────────────

  function init() {
    const site = detectSite();
    if (!site) return;

    console.log(`[trtw.tv] Content script loaded on ${site.name}`);

    // Try to attach immediately
    attachOverlay(site);

    // Also set up observer for SPA navigation
    setupObserver(site);

    // Retry attachment after a delay (page might still be loading)
    if (!currentPlayerEl) {
      setTimeout(() => attachOverlay(site), 2000);
    }
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
