// HUDL endpoints

// Export a factory function for dependency injection
let globalRefreshLock = null;
let nextAutoRefreshAt = null;

module.exports = function createHudlRouter({ storageManager, settingsManager, peertubeHelpers }) {
		// ...existing code...
		const express = require('express');
		const router = express.Router();
		// ...existing code...
		// Serve matchup thumbnail images directly
		const path = require('path');
		const fs = require('fs');
		router.get('/thumbnail/:filename', async (req, res) => {
			const { filename } = req.params;
			if (!filename || !filename.match(/^matchup_[A-Za-z0-9=]+_[A-Za-z0-9=]+\.jpg$/)) {
				return res.status(400).json({ error: 'Invalid filename.' });
			}
			const pluginDir = process.env.PEERTUBE_PLUGIN_PATH || __dirname;
			const thumbnailPath = path.join(__dirname, 'static', 'matchup-thumbnails', filename);
			if (!fs.existsSync(thumbnailPath)) {
				return res.status(404).json({ error: 'Thumbnail not found.' });
			}
			res.setHeader('Content-Type', 'image/jpeg');
			res.sendFile(thumbnailPath);
		});
	// Helper to get staleness threshold from settings or default
	async function getStalenessThreshold() {
		let thresholdSec = 5 * 60; // default 5 min
		if (settingsManager && typeof settingsManager.getSetting === 'function') {
			const val = await settingsManager.getSetting('hudl_cache_staleness_threshold');
			if (val && !isNaN(Number(val))) thresholdSec = Number(val);
		}
		return thresholdSec * 1000; // always return ms for internal use
	}

	// Helper to queue a background refresh for a single team
	async function queueTeamScheduleRefresh(teamId, snifferId, hudlOrgUrl) {
		// Fire and forget: refresh just this team, update cache
		(async () => {
			try {
				const school = await hudlLimiter.enqueue(() => hudl.fetchSchoolData(hudlOrgUrl, snifferId));
				const team = (school.teamHeaders || []).find(t => t.id === teamId);
				if (!team) return;
				const games = await hudlLimiter.enqueue(() => hudl.fetchTeamSchedule(team.id, snifferId));
				let schedules = (await storageManager.getData('hudl-schedules')) || {};
				schedules[team.id] = {
					teamId: team.id,
					teamName: team.name,
					sport: team.sport,
					gender: team.gender || null,
					level: team.teamLevel || null,
					seasonYear: team.currentSeasonYear || null,
					logoURL: team.logo,
					games,
					lastScraped: new Date().toISOString()
				};
				await storageManager.storeData('hudl-schedules', schedules);
				console.log(`[PLUGIN HUDL] Refreshed schedule for team ${team.name} (${team.id}) in background.`);
			} catch (e) {
				console.warn('[PLUGIN HUDL] Failed to refresh team schedule in background:', e.message);
			}
		})();
	}
	// (removed duplicate router initialization)
	const { requireAuth } = require('./lib-auth-manager.js');

	// Centralized HUDL rate limiter
	const hudlLimiter = require('./lib-hudl-rate-limiter.js');

	// Helper to check and set global refresh lock
	function isRefreshInProgress() {
		return globalRefreshLock && globalRefreshLock.expiresAt > Date.now();
	}
	function setGlobalRefreshLock(timeoutMs = 10 * 60 * 1000) { // default 10 min
		globalRefreshLock = {
			startedAt: new Date(),
			expiresAt: Date.now() + timeoutMs
		};
	}
	function clearGlobalRefreshLock() {
		globalRefreshLock = null;
	}
	function getNextAutoRefreshAt() {
		return nextAutoRefreshAt ? new Date(nextAutoRefreshAt).toISOString() : null;
	}
	function setNextAutoRefreshAt(timeoutMs = 60 * 60 * 1000) {
		nextAutoRefreshAt = Date.now() + timeoutMs;
	}

	// GET /hudl/organization
	const hudl = require('./lib-hudl-scraper.js');
	router.get('/organization', requireAuth, async (req, res) => {
		let hudlOrgUrl = '';
		if (settingsManager) {
			hudlOrgUrl = await settingsManager.getSetting('hudl-org-url');
		}
		if (!hudlOrgUrl && storageManager) {
			const settings = (await storageManager.getData('settings')) || {};
			hudlOrgUrl = settings['hudl-org-url'] || '';
		}
		hudlOrgUrl = hudlOrgUrl || process.env.HUDL_ORG_URL || '';
		if (!hudlOrgUrl) {
			return res.status(200).json({
				configured: false,
				message: 'HUDL organization URL not configured'
			});
		}

		try {
			// Load cached organization data from storage
			const cachedOrg = (await storageManager.getData('hudl-organization')) || null;
			const hudlMappings = (await storageManager.getData('hudl-mappings')) || {};
			const hudlSchedules = (await storageManager.getData('hudl-schedules')) || {};

			if (!cachedOrg) {
				return res.status(200).json({
					configured: true,
					organization: null,
					teams: [],
					message: 'HUDL organization not yet scraped. Please refresh schedules.',
					needsRefresh: true
				});
			}

			// Build teams array from cached data
			const teams = Object.values(hudlSchedules).map(schedule => {
				const mapping = hudlMappings[schedule.teamId];
				
				// Get current season's playlist (if exists)
				const currentSeasonYear = schedule.seasonYear;
				const currentSeasonPlaylist = mapping?.seasons?.[currentSeasonYear];
				
				return {
					teamId: schedule.teamId,
					teamName: schedule.teamName,
					sport: schedule.sport,
					gender: schedule.gender || null,
					level: schedule.level || null,
					seasonYear: schedule.seasonYear || null,
					logoURL: schedule.logoURL || null,
					currentSeason: schedule.currentSeason || null,
					mapped: !!mapping,
					channelId: mapping ? mapping.channelId : null,
					cameraId: mapping ? (typeof mapping.cameraId === 'string' ? mapping.cameraId : '') : '',
					category: mapping && mapping.category !== undefined ? mapping.category : null,
					privacy: mapping && mapping.privacy !== undefined ? mapping.privacy : null,
					commentsEnabled: mapping && mapping.commentsEnabled !== undefined ? mapping.commentsEnabled : null,
					downloadEnabled: mapping && mapping.downloadEnabled !== undefined ? mapping.downloadEnabled : null,
					customTags: mapping && Array.isArray(mapping.customTags) ? mapping.customTags : null,
					description: mapping && mapping.description !== undefined ? mapping.description : null,
					permanentLiveVideoId: mapping ? mapping.permanentLiveVideoId || null : null,
					playlistId: currentSeasonPlaylist?.playlistId || null,
					playlistName: currentSeasonPlaylist?.playlistName || null,
					rtmpUrl: null,
					streamKey: null,
					lastScraped: schedule.lastScraped || null
				};
			});

			return res.status(200).json({
				configured: true,
				organization: cachedOrg,
				teams,
				message: `Found ${teams.length} teams`,
				needsRefresh: false
			});
		} catch (err) {
			return res.status(500).json({
				configured: false,
				message: 'Failed to load HUDL organization info from cache',
				error: err.message
			});
		}
	});

	// POST /hudl/teams
	router.post('/teams', requireAuth, async (req, res) => {
		const { teams } = req.body || {};
		if (!Array.isArray(teams) || teams.length === 0) {
			return res.status(400).json({
				success: false,
				message: 'No teams provided',
				results: []
			});
		}
		for (const team of teams) {
			if (!team.teamId || typeof team.teamId !== 'string' || !team.teamName || typeof team.teamName !== 'string' || typeof team.channelId !== 'number' || !team.channelHandle || typeof team.channelHandle !== 'string') {
				return res.status(400).json({
					success: false,
					message: 'Each team must have teamId (string), teamName (string), channelId (number), and channelHandle (string)',
					results: []
				});
			}
		}
		// Save mapping to persistent storage
		if (!storageManager) return res.status(500).json({ error: 'PLUGIN_STORAGE_NOT_INITIALIZED' });
		let hudlMappings = (await storageManager.getData('hudl-mappings')) || {};
		const results = [];
		for (const team of teams) {
			// Save mapping with team-specific settings
			hudlMappings[team.teamId] = {
				teamId: team.teamId,
				teamName: team.teamName,
				channelId: team.channelId,
				channelHandle: team.channelHandle,
				cameraId: typeof team.cameraId === 'string' ? team.cameraId : '',
				// Per-team video settings (optional, will use camera defaults if not provided)
				category: team.category !== undefined ? team.category : undefined,
				privacy: team.privacy !== undefined ? team.privacy : undefined,
				commentsEnabled: team.commentsEnabled !== undefined ? team.commentsEnabled : undefined,
				downloadEnabled: team.downloadEnabled !== undefined ? team.downloadEnabled : undefined,
				customTags: Array.isArray(team.customTags) ? team.customTags : undefined,
				description: team.description !== undefined ? team.description : undefined,
				// Permanent live video credentials (ONE per team, reused across all seasons)
				permanentLiveVideoId: hudlMappings[team.teamId]?.permanentLiveVideoId || null,
				permanentLiveRtmpUrl: hudlMappings[team.teamId]?.permanentLiveRtmpUrl || null,
				permanentLiveStreamKey: hudlMappings[team.teamId]?.permanentLiveStreamKey || null,
				seasons: hudlMappings[team.teamId]?.seasons || {},
				currentSeasonYear: hudlMappings[team.teamId]?.currentSeasonYear || null
			};
			results.push({
				teamName: team.teamName,
				success: true,
				channelId: team.channelId,
				channelHandle: team.channelHandle,
				cameraId: typeof team.cameraId === 'string' ? team.cameraId : '',
				gamesFound: null,
				error: null
			});
		}
		await storageManager.storeData('hudl-mappings', hudlMappings);
		return res.status(200).json({
			success: true,
			message: 'Teams mapped successfully',
			results
		});
	});

	// POST /hudl/match-game
	router.post('/match-game', requireAuth, async (req, res) => {
		const { timestamp, windowMinutes } = req.body || {};
		if (!timestamp || typeof timestamp !== 'string' || typeof windowMinutes !== 'number') {
			return res.status(400).json({
				found: false,
				message: 'timestamp (string) and windowMinutes (number) are required'
			});
		}
		try {
			// Use HUDL API to find the game
			let hudlOrgUrl = '';
			if (settingsManager) {
				hudlOrgUrl = await settingsManager.getSetting('hudl-org-url');
			}
			if (!hudlOrgUrl && storageManager) {
				const settings = (await storageManager.getData('settings')) || {};
				hudlOrgUrl = settings['hudl-org-url'] || '';
			}
			hudlOrgUrl = hudlOrgUrl || process.env.HUDL_ORG_URL || '';
			if (!hudlOrgUrl) {
				return res.status(400).json({ found: false, message: 'HUDL organization URL not configured' });
			}
			// 1. Find game in cache (from hudl-schedules)
			let schedules = (await storageManager.getData('hudl-schedules')) || {};
			let foundGame = null;
			let foundTeam = null;
			let teamIdToRefresh = null;
			for (const teamId in schedules) {
				const sched = schedules[teamId];
				for (const g of sched.games || []) {
					const gameTime = new Date(g.timeUtc).getTime();
					const reqTime = new Date(timestamp).getTime();
					if (Math.abs(gameTime - reqTime) <= windowMinutes * 60 * 1000) {
						foundGame = g;
						foundTeam = sched;
						teamIdToRefresh = teamId;
						break;
					}
				}
				if (foundGame) break;
			}
			if (!foundGame) {
				return res.status(200).json({ found: false, message: 'No matching game found' });
			}
			// 2. Check cache freshness for this team
			let scheduleRefreshQueued = false;
			const lastScrapedAt = foundTeam.lastScraped ? new Date(foundTeam.lastScraped).getTime() : 0;
			const cacheAge = Date.now() - lastScrapedAt;
			const stalenessThreshold = await getStalenessThreshold();
			if (cacheAge > stalenessThreshold) {
				// Synchronously refresh this team's schedule before matching
				try {
					const hudlLimiter = require('./lib-hudl-rate-limiter.js');
					const hudl = require('./lib-hudl-scraper.js');
					const school = await hudlLimiter.enqueue(() => hudl.fetchSchoolData(hudlOrgUrl, req.snifferId));
					const team = (school.teamHeaders || []).find(t => t.id === teamIdToRefresh);
					if (team) {
						const games = await hudlLimiter.enqueue(() => hudl.fetchTeamSchedule(team.id, req.snifferId));
						schedules[team.id] = {
							teamId: team.id,
							teamName: team.name,
							sport: team.sport,
							gender: team.gender || null,
							level: team.teamLevel || null,
							seasonYear: team.currentSeasonYear || null,
							logoURL: team.logo,
							games,
							lastScraped: new Date().toISOString()
						};
						await storageManager.storeData('hudl-schedules', schedules);
						foundTeam = schedules[team.id];
						foundGame = null;
						for (const g of foundTeam.games || []) {
							const gameTime = new Date(g.timeUtc).getTime();
							const reqTime = new Date(timestamp).getTime();
							if (Math.abs(gameTime - reqTime) <= windowMinutes * 60 * 1000) {
								foundGame = g;
								break;
							}
						}
					}
				} catch (e) {
					return res.status(500).json({ found: false, message: 'Failed to refresh HUDL schedule for team', error: e.message });
				}
			}
			// 3. Lookup channel mapping
			const hudlMappings = (await storageManager.getData('hudl-mappings')) || {};
			const mapping = hudlMappings[foundTeam.teamId] || {};
			// 4. Return game metadata (fresh), and flag if refresh was needed
			return res.status(200).json({
				found: !!foundGame,
				game: foundGame,
				channelId: mapping.channelId || null,
				permanentLiveVideoId: mapping.permanentLiveVideoId || null,
				permanentLiveRtmpUrl: mapping.permanentLiveRtmpUrl || null,
				permanentLiveStreamKey: mapping.permanentLiveStreamKey || null,
				scheduleRefreshQueued: cacheAge > stalenessThreshold,
				message: foundGame ? 'Game matched' : 'No matching game found after refresh'
			});
		} catch (err) {
			return res.status(500).json({ found: false, message: 'Failed to match game', error: err.message });
		}
	});

	// GET /hudl/schedules
	router.get('/schedules', async (req, res) => {
		   // Serve cached schedule data only
		   const { teamId } = req.query;
		   try {
			   let schedules = (await storageManager.getData('hudl-schedules')) || {};
			   let hudlMappings = (await storageManager.getData('hudl-mappings')) || {};
			   let teams = Object.values(schedules);
			   const { getPeerTubeChannels } = require('./lib-peertube-api.js');
			   // Get sniffer username from settings or env
			   let snifferUsername = null;
			   if (settingsManager) {
				   snifferUsername = await settingsManager.getSetting('sniffer-username');
			   }
			   snifferUsername = snifferUsername || process.env.SNIFFER_USERNAME || null;
			   // Fetch all channels for sniffer user (authenticated)
			   let channelMap = {};
			   if (snifferUsername) {
				   try {
					   const channelRes = await getPeerTubeChannels({ username: snifferUsername, peertubeHelpers, settingsManager });
					   for (const ch of channelRes.channels) {
						   channelMap[ch.id] = {
							   channelName: ch.displayName || ch.name || null,
							   channelIcon: ch.avatar && ch.avatar.path ? ch.avatar.path : null
						   };
					   }
				   } catch (e) {
					   // If channel fetch fails, fallback to nulls
				   }
			   }
			   const fetch = require('node-fetch');
			   const { generateMatchupThumbnail, getMatchupKey, THUMBNAIL_DIR } = require('./lib-matchup-thumbnail.js');
			const pluginVersion = require('./package.json').version;
			const pluginShortName = 'stream-sniffer-companion';
			const publicThumbnailBase = `/plugins/${pluginShortName}/${pluginVersion}/static/matchup-thumbnails`; // PeerTube static route
			   teams = await Promise.all(teams.map(async team => {
				   const mapping = hudlMappings[team.teamId] || {};
				   const cameraId = mapping.cameraId || null;
				   const channelId = mapping.channelId || null;
				   const channelHandle = mapping.channelHandle || null;
				   let channelName = null;
				   let channelIcon = null;
				   if (channelHandle) {
					   try {
						   let baseUrl = null;
						   if (peertubeHelpers && peertubeHelpers.config && typeof peertubeHelpers.config.getWebserverUrl === 'function') {
							   baseUrl = peertubeHelpers.config.getWebserverUrl();
						   } else if (process.env.PEERTUBE_BASE_URL) {
							   baseUrl = process.env.PEERTUBE_BASE_URL;
						   }
						   if (baseUrl) {
							   const res = await fetch(`${baseUrl}/api/v1/video-channels/${encodeURIComponent(channelHandle)}`);
							   if (res.ok) {
								   const data = await res.json();
								   channelName = data.displayName || data.name || null;
								   channelIcon = data.avatars && data.avatars.length > 0 ? data.avatars[0].path : null;
							   }
						   }
					   } catch (e) {
						   console.warn(`[PLUGIN HUDL] Channel fetch failed for handle ${channelHandle}:`, e.message);
					   }
				   }
				   if (!channelName || !channelIcon) {
					   console.warn(`[PLUGIN HUDL] Channel metadata missing for teamId ${team.teamId}, channelHandle ${channelHandle}`);
				   }
				   // Only reference existing matchup thumbnails
				   const fs = require('fs');
				   let gamesWithThumbnails = [];
				   if (Array.isArray(team.games)) {
					   const teamId = team.id || team.teamId || (team.details && team.details.id);
					   gamesWithThumbnails = team.games.map(g => {
						   let matchupThumbnailUrl = null;
						   try {
							   const opponentId = g.opponentDetails && g.opponentDetails.schoolId;
							   const matchupKey = getMatchupKey(teamId, opponentId);
							   const thumbnailPath = `${THUMBNAIL_DIR}/${matchupKey}`;
							   if (fs.existsSync(thumbnailPath)) {
								   matchupThumbnailUrl = `${publicThumbnailBase}/${matchupKey}`;
								   console.log(`[HUDL SCHEDULES] Found thumbnail for teamId ${teamId}, opponentId ${opponentId}, gameId ${g.id}: ${matchupThumbnailUrl}`);
							   } else {
								   console.log(`[HUDL SCHEDULES] No thumbnail for teamId ${teamId}, opponentId ${opponentId}, gameId ${g.id} (tried: ${thumbnailPath})`);
							   }
						   } catch (e) {
							   console.warn(`[PLUGIN HUDL] Failed to check matchup thumbnail for teamId ${teamId}, gameId ${g.id}:`, e.message);
						   }
						   return { ...g, matchupThumbnailUrl };
					   });
				   }
				   return {
					   ...team,
					   cameraId,
					   channelId,
					   channelHandle,
					   channelName,
					   channelIcon,
					   games: gamesWithThumbnails
				   };
			   }));
			   if (teamId) {
				   teams = teams.filter(t => t.teamId === teamId);
			   }
			   return res.status(200).json({
				   teams,
				   totalTeams: teams.length,
				   refreshInProgress: isRefreshInProgress(),
				   nextAutoRefreshAt: getNextAutoRefreshAt()
			   });
		   } catch (err) {
			   return res.status(500).json({
				   teams: [],
				   totalTeams: 0,
				   refreshInProgress: isRefreshInProgress(),
				   nextAutoRefreshAt: getNextAutoRefreshAt(),
				   message: 'Failed to fetch cached HUDL schedules',
				   error: err.message
			   });
		   }
	});

	// POST /hudl/schedules/refresh
	router.post('/schedules/refresh', requireAuth, async (req, res) => {
		   const log = (...args) => console.log('[HUDL SCHEDULE REFRESH]', ...args);
		   let hudlOrgUrl = '';
		   const refreshStart = Date.now();
		   log('Refresh requested', { time: new Date(refreshStart).toISOString(), force: req.body?.force });
		   if (settingsManager) {
			   hudlOrgUrl = await settingsManager.getSetting('hudl-org-url');
		   }
		   if (!hudlOrgUrl && storageManager) {
			   const settings = (await storageManager.getData('settings')) || {};
			   hudlOrgUrl = settings['hudl-org-url'] || '';
		   }
		   hudlOrgUrl = hudlOrgUrl || process.env.HUDL_ORG_URL || '';
		   const { force } = req.body || {};
		   if (!hudlOrgUrl) {
			   log('No HUDL org URL configured');
			   return res.status(400).json({
				   success: false,
				   message: 'HUDL organization URL not configured',
				   results: []
			   });
		   }
		   // Check global lock
		   if (isRefreshInProgress()) {
			   log('Refresh already in progress');
			   return res.status(409).json({
				   error: 'REFRESH_IN_PROGRESS',
				   message: 'Schedule refresh already in progress',
				   retryAfter: new Date(globalRefreshLock.expiresAt).toISOString()
			   });
		   }
		   setGlobalRefreshLock();
		   setNextAutoRefreshAt();
		   try {
		   const schoolFetchStart = Date.now();
		   log('Fetching school data...');
		   const school = await hudlLimiter.enqueue(() => hudl.fetchSchoolData(hudlOrgUrl, req.snifferId));
		   log('School data fetched', { durationMs: Date.now() - schoolFetchStart });
		   
		   // Store organization data for /organization endpoint
		   const orgData = {
			   name: school.fullName,
			   id: school.id,
			   orgURL: hudlOrgUrl,
			   lastScraped: new Date().toISOString()
		   };
		   await storageManager.storeData('hudl-organization', orgData);
		   log('Organization data cached');
		   
		   const teamHeaders = school.teamHeaders || [];
			   let schedules = (await storageManager.getData('hudl-schedules')) || {};
			   const results = [];
			   for (const team of teamHeaders) {
				   const teamStart = Date.now();
				   let games = [];
				   let error = null;
				   log(`Fetching schedule for team ${team.name} (${team.id})...`);
				   try {
					   games = await hudlLimiter.enqueue(() => hudl.fetchTeamSchedule(team.id, req.snifferId));
					   log(`Fetched schedule for team ${team.name} (${team.id})`, { gamesCount: games.length, durationMs: Date.now() - teamStart });
				   } catch (e) {
					   error = e.message;
					   log(`Error fetching schedule for team ${team.name} (${team.id}):`, error);
				   }
				   schedules[team.id] = {
					   teamId: team.id,
					   teamName: team.name,
					   sport: team.sport,
					   logoURL: team.logo,
					   games,
					   lastScraped: new Date().toISOString()
				   };
				   results.push({
					   teamName: team.name,
					   refreshed: !error,
					   cached: false,
					   gamesCount: games.length,
					   error
				   });
			   }
			   const storeStart = Date.now();
			   log('About to store schedules', {
				   teamIds: Object.keys(schedules),
				   gamesPerTeam: Object.fromEntries(Object.entries(schedules).map(([id, t]) => [id, t.games?.length || 0]))
			   });
			   await storageManager.storeData('hudl-schedules', schedules);
			   log('Schedules stored', {
				   durationMs: Date.now() - storeStart,
				   storedTeamIds: Object.keys(schedules),
				   storedGamesPerTeam: Object.fromEntries(Object.entries(schedules).map(([id, t]) => [id, t.games?.length || 0]))
			   });
			   clearGlobalRefreshLock();
			   log('Global refresh lock cleared');
			   // After storing schedules, trigger image generation in background
			   setImmediate(() => {
				   log('Triggering background matchup thumbnail generation...');
				   const { generateMatchupThumbnail } = require('./lib-matchup-thumbnail.js');
				   for (const team of teamHeaders) {
					   const games = schedules[team.id]?.games || [];
					   for (const g of games) {
						   generateMatchupThumbnail(
							   team.logo,
							   g.opponentDetails && g.opponentDetails.profileImageUri,
							   team.id,
							   g.opponentDetails && g.opponentDetails.schoolId ? g.opponentDetails.schoolId : '',
							   team.name,
							   g.opponentDetails && g.opponentDetails.name ? g.opponentDetails.name : ''
						   )
						   .catch(err => console.warn(`[PLUGIN HUDL] Thumbnail generation failed for ${team.id}:`, err.message));
					   }
				   }
			   });
			   log('Responding to client', { totalDurationMs: Date.now() - refreshStart });
			   return res.status(200).json({
				   success: true,
				   message: 'Schedules refreshed',
				   results
			   });
		   } catch (err) {
			   clearGlobalRefreshLock();
			   log('Error during refresh:', err.message);
			   return res.status(500).json({
				   success: false,
				   message: 'Failed to refresh schedules',
				   results: [],
				   error: err.message
			   });
		   }
	   });

	// POST /hudl/schedules/refresh/:teamId
	router.post('/schedules/refresh/:teamId', requireAuth, async (req, res) => {
	       let hudlOrgUrl = '';
	       if (settingsManager) {
		       hudlOrgUrl = await settingsManager.getSetting('hudl-org-url');
	       }
	       if (!hudlOrgUrl && storageManager) {
		       const settings = (await storageManager.getData('settings')) || {};
		       hudlOrgUrl = settings['hudl-org-url'] || '';
	       }
	       hudlOrgUrl = hudlOrgUrl || process.env.HUDL_ORG_URL || '';
	       const { teamId } = req.params;
	       if (!hudlOrgUrl) {
		       return res.status(400).json({
			       success: false,
			       message: 'HUDL organization URL not configured',
			       error: 'Not configured'
		       });
	       }
	       if (!teamId || typeof teamId !== 'string') {
		       return res.status(400).json({
			       success: false,
			       message: 'teamId (string) is required in URL',
			       error: 'Invalid teamId'
		       });
	       }
		   try {
			   const school = await hudlLimiter.enqueue(() => hudl.fetchSchoolData(hudlOrgUrl, req.snifferId));
			   const team = (school.teamHeaders || []).find(t => t.id === teamId);
			   if (!team) {
				   return res.status(404).json({
					   success: false,
					   message: 'Team not found',
					   error: 'Not found'
				   });
			   }
			   let games = [];
			   let error = null;
			   try {
				   games = await hudlLimiter.enqueue(() => hudl.fetchTeamSchedule(team.id, req.snifferId));
			   } catch (e) { error = e.message; }
			   let schedules = (await storageManager.getData('hudl-schedules')) || {};
			   schedules[team.id] = {
				   teamId: team.id,
				   teamName: team.name,
				   sport: team.sport,
				   seasonYear: team.currentSeasonYear || null,
				   logoURL: team.logo,
				   games,
				   lastScraped: new Date().toISOString()
			   };
			   await storageManager.storeData('hudl-schedules', schedules);
			   // After storing schedule, trigger image generation in background
			   setImmediate(() => {
				   const { generateMatchupThumbnail } = require('./lib-matchup-thumbnail.js');
				   for (const g of games) {
					   generateMatchupThumbnail(
						   team.logo,
						   g.opponentDetails && g.opponentDetails.profileImageUri,
						   team.id,
						   g.opponentDetails && g.opponentDetails.schoolId ? g.opponentDetails.schoolId : '',
						   team.name,
						   g.opponentDetails && g.opponentDetails.name ? g.opponentDetails.name : ''
					   )
					   .catch(err => console.warn(`[PLUGIN HUDL] Thumbnail generation failed for ${team.id}:`, err.message));
				   }
			   });
			   return res.status(200).json({
				   teamName: team.name,
				   refreshed: !error,
				   cached: false,
				   gamesCount: games.length,
				   error
			   });
	       } catch (err) {
		       return res.status(500).json({
			       success: false,
			       message: 'Failed to refresh team schedule',
			       error: err.message
		       });
	       }
	});

	return router;
};
