

// Global process-level error handlers for debugging (guarded to avoid duplicate listeners)
if (!global.__SN_SNIFFER_ERROR_HANDLERS__) {
  process.on('uncaughtException', err => {
    console.error('[PLUGIN uncaughtException]', err);
  });
  process.on('unhandledRejection', err => {
    console.error('[PLUGIN unhandledRejection]', err);
  });
  global.__SN_SNIFFER_ERROR_HANDLERS__ = true;
}

const express = require('express');
const routerIndex = require('./router-index.js');

async function register({ getRouter, registerSetting, settingsManager, storageManager, peertubeHelpers }) {
        // Get the plugin router instance from PeerTube
        const router = getRouter();

        // Register HUDL cache staleness threshold setting (in seconds)
        await registerSetting({
          name: 'hudl_cache_staleness_threshold',
          label: 'HUDL Cache Staleness Threshold (seconds)',
          type: 'number',
          default: 300, // 5 minutes
          description: 'How old (in seconds) a team schedule cache can be before the plugin auto-refreshes it. Default: 300 (5 minutes).',
          required: false
        });
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
        let requestCount = 0;
        const school = await hudlLimiter.enqueue(() => { requestCount++; return hudl.fetchSchoolData(hudlOrgUrl, 'auto-refresh'); });
        
        // Store organization data for /organization endpoint
        const orgData = {
          name: school.fullName,
          id: school.id,
          orgURL: hudlOrgUrl,
          lastScraped: new Date().toISOString()
        };
        await storageManager.storeData('hudl-organization', orgData);
        
        const teamHeaders = school.teamHeaders || [];
          let schedules = (await storageManager.getData('hudl-schedules')) || {};
          let matchupCount = 0;
          for (const team of teamHeaders) {
            let games = [];
            let error = null;
            try {
              games = await hudlLimiter.enqueue(() => { requestCount++; return hudl.fetchTeamSchedule(team.id, 'auto-refresh'); });
              matchupCount += games.length;
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
          }
          await storageManager.storeData('hudl-schedules', schedules);
          console.log(`[PLUGIN HUDL auto-refresh] Refreshed schedules for ${teamHeaders.length} teams at`, new Date().toISOString());
          console.log(`[PLUGIN HUDL auto-refresh] Total HUDL API requests made in this run: ${requestCount}`);
          console.log(`[PLUGIN HUDL auto-refresh] Matchups parsed: ${matchupCount}`);
          // After storing schedules, trigger image generation in background
          setImmediate(() => {
            const { generateMatchupThumbnail } = require('./lib-matchup-thumbnail.js');
            const fs = require('fs');
            const path = require('path');
            const { getMatchupKey, THUMBNAIL_DIR } = require('./lib-matchup-thumbnail.js');
            let imageCacheHits = 0;
            let imageGenerated = 0;
            for (const team of teamHeaders) {
              const games = schedules[team.id]?.games || [];
              for (const g of games) {
                const homeId = team.id || 'no_logo';
                const homeLogo = team.logo || null;
                const awayId = (g.opponentDetails && g.opponentDetails.schoolId) || 'no_logo';
                const awayLogo = (g.opponentDetails && g.opponentDetails.profileImageUri) || null;
                const matchupKey = getMatchupKey(homeId, awayId);
                const thumbnailPath = path.join(THUMBNAIL_DIR, matchupKey);
                if (fs.existsSync(thumbnailPath)) {
                  imageCacheHits++;
                } else {
                  generateMatchupThumbnail(homeLogo, awayLogo, homeId, awayId)
                    .then(() => { imageGenerated++; })
                    .catch(thumbErr => {
                      console.warn(`[PLUGIN HUDL] Failed to generate matchup thumbnail for ${homeId} vs ${awayId}:`, thumbErr.message);
                    });
                }
              }
            }
            console.log(`[PLUGIN HUDL auto-refresh] Images generated: ${imageGenerated}, images already existed: ${imageCacheHits}`);
          });
        } catch (err) {
          console.error('[PLUGIN HUDL auto-refresh] Error during auto-refresh:', err);
        }
      }

      // Calculate next refresh time based on game schedule (adaptive scheduling)
      async function calculateNextRefreshTime() {
        try {
          const schedules = (await storageManager.getData('hudl-schedules')) || {};
          const now = Date.now();
          const today = new Date().setHours(0, 0, 0, 0);
          
          // Get all unplayed games for today across all teams
          let todaysGames = [];
          for (const teamId in schedules) {
            const games = schedules[teamId].games || [];
            for (const game of games) {
              const gameTimeField = game.timeUtc || game.date;
              if (!gameTimeField) continue;
              const gameTime = new Date(gameTimeField);
              const gameDate = new Date(gameTime).setHours(0, 0, 0, 0);
              // Only include HOME games not yet played
              if (gameDate === today 
                  && game.scheduleEntryLocation === 1 
                  && game.scheduleEntryOutcome === 0) {
                todaysGames.push(gameTime.getTime());
              }
            }
          }
          
          // Sort games chronologically
          todaysGames.sort((a, b) => a - b);
          
          // NO GAMES TODAY - minimal refresh schedule
          if (todaysGames.length === 0) {
            const noon = new Date().setHours(12, 0, 0, 0);
            const midnight = new Date().setHours(24, 0, 0, 0);
            
            if (now < noon) {
              const minutesUntilNoon = Math.max(5, (noon - now) / 60000);
              console.log(`[PLUGIN HUDL auto-refresh] No games today. Next refresh at noon (in ${Math.round(minutesUntilNoon)} minutes).`);
              return minutesUntilNoon;
            } else {
              const minutesUntilMidnight = Math.max(5, (midnight - now) / 60000);
              console.log(`[PLUGIN HUDL auto-refresh] No games today. Next refresh at midnight (in ${Math.round(minutesUntilMidnight)} minutes).`);
              return minutesUntilMidnight;
            }
          }
          
          // GAMES TODAY - aggressive refresh schedule
          const firstGame = todaysGames[0];
          const lastGame = todaysGames[todaysGames.length - 1];
          const twoHoursBeforeFirst = firstGame - (2 * 60 * 60 * 1000);
          const threeHoursAfterLast = lastGame + (3 * 60 * 60 * 1000);
          
          // Before game window starts: refresh 2 hours before first game
          if (now < twoHoursBeforeFirst) {
            const minutesUntil = Math.max(5, (twoHoursBeforeFirst - now) / 60000);
            console.log(`[PLUGIN HUDL auto-refresh] ${todaysGames.length} game(s) today. Next refresh 2 hours before first game (in ${Math.round(minutesUntil)} minutes).`);
            return minutesUntil;
          }
          
          // During game window (2hr before first → 3hr after last): every 30 min
          if (now >= twoHoursBeforeFirst && now < threeHoursAfterLast) {
            console.log(`[PLUGIN HUDL auto-refresh] GAME DAY ACTIVE - ${todaysGames.length} game(s) today. Polling every 30 minutes.`);
            return 30; // 30 minutes
          }
          
          // After all games done: back to midnight refresh
          const midnight = new Date().setHours(24, 0, 0, 0);
          const minutesUntilMidnight = Math.max(5, (midnight - now) / 60000);
          console.log(`[PLUGIN HUDL auto-refresh] All games complete. Next refresh at midnight (in ${Math.round(minutesUntilMidnight)} minutes).`);
          return minutesUntilMidnight;
        } catch (err) {
          console.error('[PLUGIN HUDL auto-refresh] Error calculating next refresh time:', err);
          return 60; // Fallback to 60 minutes on error
        }
      }

      // Dynamic refresh scheduler
      async function scheduleNextRefresh() {
        // Clear any existing timeout
        if (global.__HUDL_AUTO_REFRESH_TIMEOUT_ID__) {
          clearTimeout(global.__HUDL_AUTO_REFRESH_TIMEOUT_ID__);
          global.__HUDL_AUTO_REFRESH_TIMEOUT_ID__ = null;
        }
        
        // Calculate next refresh time
        const minutesUntilNext = await calculateNextRefreshTime();
        const msUntilNext = minutesUntilNext * 60 * 1000;
        
        // Schedule next refresh
        global.__HUDL_AUTO_REFRESH_TIMEOUT_ID__ = setTimeout(async () => {
          await autoRefreshHudlSchedules();
          await scheduleNextRefresh(); // Reschedule after completion
        }, msUntilNext);
        
        console.log(`[PLUGIN HUDL auto-refresh] Next refresh scheduled in ${Math.round(minutesUntilNext)} minutes.`);
      }

      // Ensure only one HUDL auto-refresh interval is active at a time
      if (global.__HUDL_AUTO_REFRESH_INTERVAL_ID__) {
        clearInterval(global.__HUDL_AUTO_REFRESH_INTERVAL_ID__);
        global.__HUDL_AUTO_REFRESH_INTERVAL_ID__ = null;
        console.log('[PLUGIN HUDL auto-refresh] Cleared previous auto-refresh interval.');
      }
      if (global.__HUDL_AUTO_REFRESH_TIMEOUT_ID__) {
        clearTimeout(global.__HUDL_AUTO_REFRESH_TIMEOUT_ID__);
        global.__HUDL_AUTO_REFRESH_TIMEOUT_ID__ = null;
        console.log('[PLUGIN HUDL auto-refresh] Cleared previous auto-refresh timeout.');
      }
      
      // Start adaptive refresh system after 5 minute delay
      setTimeout(async () => {
        console.log('[PLUGIN HUDL auto-refresh] Starting adaptive refresh system...');
        await autoRefreshHudlSchedules(); // Initial run
        await scheduleNextRefresh(); // Schedule next based on game schedule
      }, 5 * 60 * 1000); // Wait 5 minutes after startup
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
