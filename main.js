

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

  // Sync replays to playlists - runs during auto-refresh (3x daily)
  async function syncReplaysToPlaylists() {
    try {
      console.log('[PLUGIN] Starting replay-to-playlist sync...');
      
      const cameras = (await storageManager.getData('cameras')) || {};
      const sniffers = (await storageManager.getData('sniffers')) || {};
      const { addVideoToPlaylist } = require('./lib-peertube-api.js');
      
      let teamsChecked = 0;
      let replaysAdded = 0;
      
      for (const teamId in cameras) {
        const teamData = cameras[teamId];
        
        // Skip if no permanent live or no seasons
        if (!teamData.permanentLiveVideoId || !teamData.seasons) {
          continue;
        }
        
        teamsChecked++;
        
        // Get current season's playlist
        const currentYear = new Date().getFullYear();
        const seasonData = teamData.seasons[currentYear];
        
        if (!seasonData || !seasonData.playlistId) {
          continue;
        }
        
        // Find OAuth token for this team
        let snifferOAuthToken = null;
        const cameraAssignments = (await storageManager.getData('camera-assignments')) || {};
        
        for (const snifferId in cameraAssignments) {
          const assignments = cameraAssignments[snifferId];
          for (const cameraId in assignments) {
            if (assignments[cameraId].teamId === teamId) {
              snifferOAuthToken = sniffers[snifferId]?.oauthToken;
              break;
            }
          }
          if (snifferOAuthToken) break;
        }
        
        if (!snifferOAuthToken) {
          console.log(`[PLUGIN] No OAuth token found for team ${teamData.teamName}`);
          continue;
        }
        
        // Fetch videos from channel
        const baseUrl = await peertubeHelpers.config.getWebserverUrl();
        const channelId = teamData.channelId;
        
        try {
          const res = await fetch(`${baseUrl}/api/v1/video-channels/${channelId}/videos?count=50&sort=-publishedAt`, {
            headers: { 'Authorization': `Bearer ${snifferOAuthToken}` }
          });
          
          if (!res.ok) {
            console.log(`[PLUGIN] Failed to fetch videos for ${teamData.teamName}: ${res.status}`);
            continue;
          }
          
          const { data: videos } = await res.json();
          
          // Get videos already in playlist
          const playlistRes = await fetch(`${baseUrl}/api/v1/video-playlists/${seasonData.playlistId}/videos?count=500`, {
            headers: { 'Authorization': `Bearer ${snifferOAuthToken}` }
          });
          
          const playlistVideos = playlistRes.ok ? (await playlistRes.json()).data : [];
          const playlistVideoIds = new Set(playlistVideos.map(v => v.video.id));
          
          // Find replays not in playlist
          // Replays: not live, not the permanent live video itself, created this season
          const seasonStart = new Date(currentYear, 7, 1); // August 1st
          const replays = videos.filter(v => 
            !v.isLive && 
            v.id !== teamData.permanentLiveVideoId &&
            new Date(v.createdAt) >= seasonStart &&
            !playlistVideoIds.has(v.id)
          );
          
          // Add replays to playlist
          for (const replay of replays) {
            try {
              await addVideoToPlaylist({
                playlistId: seasonData.playlistId,
                videoId: replay.id,
                oauthToken: snifferOAuthToken,
                peertubeHelpers,
                settingsManager
              });
              
              replaysAdded++;
              console.log(`[PLUGIN] Added replay to playlist: ${replay.name} → ${teamData.teamName} ${currentYear}`);
            } catch (err) {
              console.error(`[PLUGIN] Failed to add replay ${replay.id} to playlist:`, err.message);
            }
          }
          
        } catch (err) {
          console.error(`[PLUGIN] Error syncing replays for ${teamData.teamName}:`, err);
        }
      }
      
      console.log(`[PLUGIN] Replay sync complete: checked ${teamsChecked} teams, added ${replaysAdded} replays to playlists`);
      
    } catch (err) {
      console.error('[PLUGIN] Error in syncReplaysToPlaylists:', err);
    }
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

      // Import shared title generator
      const { generateGameTitle } = require('./lib-game-title.js');

      const teamHeaders = school.teamHeaders || [];
      let schedules = (await storageManager.getData('hudl-schedules')) || {};
      let matchupCount = 0;
      for (const team of teamHeaders) {
        let games = [];
        let error = null;
        try {
          games = await hudlLimiter.enqueue(() => { requestCount++; return hudl.fetchTeamSchedule(team.id, 'auto-refresh'); });
          matchupCount += games.length;

          // Add generated title to each game
          const teamData = {
            sport: team.sport,
            gender: team.gender,
            teamLevel: team.teamLevel
          };
          games = games.map(game => ({
            ...game,
            generatedTitle: generateGameTitle(game, teamData, school.fullName)
          }));
        } catch (e) { error = e.message; }
        schedules[team.id] = {
          teamId: team.id,
          teamName: team.name,
          sport: team.sport,
          gender: team.gender,
          teamLevel: team.teamLevel,
          seasonYear: team.currentSeasonYear || null,
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
      
      // Sync replays to playlists after schedule refresh
      await syncReplaysToPlaylists();
      
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

  // Calculate next refresh time (3x daily: aligned with school schedule)
  // 9 AM - After school starts, catch overnight updates
  // 3 PM - School ends, catch same-day additions for evening games
  // 9 PM - Evening, catch late updates before next day
  async function calculateNextRefreshTime() {
    try {
      const now = Date.now();
      const morning = new Date().setHours(9, 0, 0, 0); // 9 AM
      const afternoon = new Date().setHours(15, 0, 0, 0); // 3 PM
      const evening = new Date().setHours(21, 0, 0, 0); // 9 PM
      const tomorrowMorning = new Date(morning + 24 * 60 * 60 * 1000);

      let nextRefresh;
      let description;

      if (now < morning) {
        nextRefresh = morning;
        description = '9 AM (morning refresh)';
      } else if (now < afternoon) {
        nextRefresh = afternoon;
        description = '3 PM (afternoon refresh)';
      } else if (now < evening) {
        nextRefresh = evening;
        description = '9 PM (evening refresh)';
      } else {
        nextRefresh = tomorrowMorning;
        description = 'tomorrow at 9 AM';
      }

      const minutesUntil = Math.max(5, (nextRefresh - now) / 60000);
      console.log(`[PLUGIN HUDL auto-refresh] Next refresh at ${description} (in ${Math.round(minutesUntil)} minutes).`);
      console.log(`[PLUGIN HUDL auto-refresh] Note: Refreshing 3x daily conserves HUDL API quota. Manual refresh always available.`);
      return minutesUntil;
    } catch (err) {
      console.error('[PLUGIN HUDL auto-refresh] Error calculating next refresh time:', err);
      return 360; // Fallback to 6 hours on error
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

    // Store next refresh time globally for API access
    global.__HUDL_NEXT_AUTO_REFRESH_AT__ = new Date(Date.now() + msUntilNext).toISOString();

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
  } catch (e) { }
  try {
    const routerHudl = require('./router-hudl.js');
    if (routerHudl.setStorageManager && storageManager) {
      routerHudl.setStorageManager(storageManager);
    }
  } catch (e) { }

  try {
    const routerStatus = require('./router-status.js');
    if (routerStatus.setStorageManager && storageManager) {
      routerStatus.setStorageManager(storageManager);
    }
  } catch (e) { }
  try {
    const routerError = require('./router-error.js');
    if (routerError.setStorageManager && storageManager) {
      routerError.setStorageManager(storageManager);
    }
  } catch (e) { }
  try {
    const permLiveMgr = require('./lib-permanent-live-manager.js');
    if (permLiveMgr.setPeertubeHelpers) {
      permLiveMgr.setPeertubeHelpers(peertubeHelpers);
    }
  } catch (e) { }


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

async function unregister() {
  return
}

module.exports = {
  register,
  unregister
}
