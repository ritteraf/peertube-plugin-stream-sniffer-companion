

// Global process-level error handlers for debugging
process.on('uncaughtException', err => {
  console.error('[PLUGIN uncaughtException]', err);
});
process.on('unhandledRejection', err => {
  console.error('[PLUGIN unhandledRejection]', err);
});

const express = require('express');
const routerIndex = require('./router-index.js');

async function register({ getRouter, registerSetting, settingsManager, storageManager, peertubeHelpers }) {
        // Get the plugin router instance from PeerTube
        const router = getRouter();
      // --- HUDL Auto-Refresh Logic ---
      const hudl = require('./lib-hudl-scraper.js');
      // Local getPluginSettings using injected settingsManager
      async function getPluginSettings() {
        if (settingsManager) {
          const snifferAuthSecret = await settingsManager.getSetting('sniffer-auth-secret');
          const hudlOrgUrl = await settingsManager.getSetting('hudl-org-url');
          const scheduleCacheMinutes = await settingsManager.getSetting('schedule-cache-minutes');
          return {
            'sniffer-auth-secret': snifferAuthSecret,
            'hudl-org-url': hudlOrgUrl,
            'schedule-cache-minutes': scheduleCacheMinutes
          };
        }
        // Fallback for dev/test only
        return {
          'sniffer-auth-secret': process.env.SNIFFER_AUTH_SECRET || '',
          'hudl-org-url': process.env.HUDL_ORG_URL || '',
          'schedule-cache-minutes': 60
        };
      }

      const hudlLimiter = require('./lib-hudl-rate-limiter.js');
      async function autoRefreshHudlSchedules() {
        try {
          const settings = await getPluginSettings();
          const hudlOrgUrl = settings['hudl-org-url'] || process.env.HUDL_ORG_URL || '';
          if (!hudlOrgUrl) {
            console.log('[PLUGIN HUDL auto-refresh] HUDL org URL not configured, skipping refresh.');
            return;
          }
          const school = await hudlLimiter.enqueue(() => hudl.fetchSchoolData(hudlOrgUrl, 'auto-refresh'));
          const teamHeaders = school.teamHeaders || [];
          let schedules = (await storageManager.getData('hudl-schedules')) || {};
          for (const team of teamHeaders) {
            let games = [];
            let error = null;
            try {
              games = await hudlLimiter.enqueue(() => hudl.fetchTeamSchedule(team.id, 'auto-refresh'));
            } catch (e) { error = e.message; }
            schedules[team.id] = {
              teamId: team.id,
              teamName: team.name,
              sport: team.sport,
              logoURL: team.logo,
              games,
              lastScraped: new Date().toISOString()
            };
            if (error) {
              console.error(`[PLUGIN HUDL auto-refresh] Failed to refresh team ${team.name}:`, error);
            }
            // No need for manual delay, limiter enforces delay
          }
          await storageManager.storeData('hudl-schedules', schedules);
          console.log(`[PLUGIN HUDL auto-refresh] Refreshed schedules for ${teamHeaders.length} teams at`, new Date().toISOString());
        } catch (err) {
          console.error('[PLUGIN HUDL auto-refresh] Error during auto-refresh:', err);
        }
      }

      // Ensure only one HUDL auto-refresh interval is active at a time
      if (global.__HUDL_AUTO_REFRESH_INTERVAL_ID__) {
        clearInterval(global.__HUDL_AUTO_REFRESH_INTERVAL_ID__);
        global.__HUDL_AUTO_REFRESH_INTERVAL_ID__ = null;
        console.log('[PLUGIN HUDL auto-refresh] Cleared previous auto-refresh interval.');
      }
      setTimeout(async () => {
        let intervalMs = 60 * 60 * 1000; // default 60 min
        try {
          const settings = await getPluginSettings();
          const min = parseInt(settings['schedule-cache-minutes'], 10);
          if (!isNaN(min) && min > 0) intervalMs = min * 60 * 1000;
        } catch {}
        await autoRefreshHudlSchedules(); // Initial run
        global.__HUDL_AUTO_REFRESH_INTERVAL_ID__ = setInterval(autoRefreshHudlSchedules, intervalMs);
        console.log(`[PLUGIN HUDL auto-refresh] Scheduled every ${intervalMs / 60000} minutes.`);
      }, 10000); // Wait 10s after startup
    // DEBUG: Print HUDL org URL from settings on plugin startup
    // HUDL org URL debug print removed (was using readJson)

  // Initialize storageManager from peertubeHelpers
  // Debug: print all plugin helpers
  if (peertubeHelpers && peertubeHelpers.plugin) {
    console.log('[PLUGIN main.js] peertubeHelpers.plugin:', peertubeHelpers.plugin);
  }
  console.log('[PLUGIN main.js] storageManager injected:', !!storageManager);


  // Wire storageManager into lib-auth-manager for token/sniffer storage
  const authManager = require('./lib-auth-manager.js');
  if (authManager.setStorageManager && storageManager) {
    authManager.setStorageManager(storageManager);
  }

  // Wire storageManager into lib-camera-registry for camera assignment storage
  try {
    const cameraRegistry = require('./lib-camera-registry.js');
    if (cameraRegistry.setStorageManager && storageManager) {
      cameraRegistry.setStorageManager(storageManager);
    }
  } catch (e) {
    console.error('[PLUGIN] Failed to wire storageManager to lib-camera-registry:', e);
  }

  // Wire settingsManager and storageManager into router-auth
  const routerAuth = require('./router-auth.js');
  if (routerAuth.setSettingsManager) {
    routerAuth.setSettingsManager(settingsManager);
  }
  if (routerAuth.setPeertubeHelpers) {
    routerAuth.setPeertubeHelpers(peertubeHelpers);
  }
  if (routerAuth.setStorageManager && storageManager) {
    routerAuth.setStorageManager(storageManager);
  }

  // Wire settingsManager and storageManager into router-config
  try {
    const routerConfig = require('./router-config.js');
    if (routerConfig.setSettingsManager) {
      routerConfig.setSettingsManager(settingsManager);
    }
    if (routerConfig.setPeertubeHelpers) {
      routerConfig.setPeertubeHelpers(peertubeHelpers);
    }
    if (routerConfig.setStorageManager && storageManager) {
      routerConfig.setStorageManager(storageManager);
    }
  } catch (e) {
    console.error('[PLUGIN] Failed to wire settingsManager/storageManager/peertubeHelpers to router-config:', e);
  }

  // Wire peertubeHelpers into router-config.js
  try {
    console.log('[PLUGIN main.js] About to require router-config.js and inject peertubeHelpers');
    const routerConfig = require('./router-config.js');
    if (routerConfig.setPeertubeHelpers) {
      routerConfig.setPeertubeHelpers(peertubeHelpers);
    }
  } catch (e) {
    console.error('[PLUGIN] Failed to wire peertubeHelpers to router-config:', e);
  }
  // Optionally, wire peertubeHelpers and storageManager into other routers/modules as needed
  try {
    const routerRecording = require('./router-recording.js');
    if (routerRecording.setPeertubeHelpers) {
      routerRecording.setPeertubeHelpers(peertubeHelpers);
    }
    if (routerRecording.setStorageManager && storageManager) {
      routerRecording.setStorageManager(storageManager);
    }
  } catch (e) {}
  try {
    const routerHudl = require('./router-hudl.js');
    if (routerHudl.setStorageManager && storageManager) {
      routerHudl.setStorageManager(storageManager);
    }
  } catch (e) {}

  try {
    const routerStatus = require('./router-status.js');
    if (routerStatus.setStorageManager && storageManager) {
      routerStatus.setStorageManager(storageManager);
    }
  } catch (e) {}
  try {
    const routerError = require('./router-error.js');
    if (routerError.setStorageManager && storageManager) {
      routerError.setStorageManager(storageManager);
    }
  } catch (e) {}
  try {
    const permLiveMgr = require('./lib-permanent-live-manager.js');
    if (permLiveMgr.setPeertubeHelpers) {
      permLiveMgr.setPeertubeHelpers(peertubeHelpers);
    }
  } catch (e) {}


  // Use getRouter to mount all plugin routes

  // Add a /ping test route for debugging
  router.get('/ping', (req, res) => {
    res.json({ pong: true });
  });

  // Mount all routes under /router using the new factory
  const createPluginRouter = require('./router-index.js');
  router.use('/', createPluginRouter({
    storageManager,
    settingsManager,
    peertubeHelpers
  }));

  // Register plugin settings (minimal UI)
  registerSetting({
    name: 'sniffer-auth-secret',
    label: 'Sniffer Authentication Secret',
    type: 'input',
    required: true,
    description: "Secret key for authenticating Stream Sniffer apps. Generate a secure random value (32+ characters). Copy/Paste this value during setup the of your stream sniffer(s). This will allow your sniffer(s) to communicate with PeerTube.",
    default: ''
  });
  registerSetting({
    name: 'peertube-base-url',
    label: 'PeerTube Base URL (Fallback)',
    type: 'input',
    required: false,
    description: 'If set, this URL will be used as the PeerTube instance base URL if automatic detection fails. Example: https://video.example.com',
    default: ''
  });
  registerSetting({
    name: 'hudl-org-url',
    label: 'HUDL Organization URL',
    type: 'input',
    required: false,
    description: "This is your HUDL 'fan' page. You can find this by searching for your school at fan.hudl.com"
  });
  registerSetting({
    name: 'schedule-cache-minutes',
    label: 'HUDL Schedule refresh interval (minutes)',
    type: 'input',
    required: false,
    description: 'This value will control how often the plugin will check HUDL for updates to your team schedules. You can always manually refresh the team schedules inside your sniffer app.',
    default: 60
  });
}

async function unregister () {
  return
}

module.exports = {
  register,
  unregister
}
