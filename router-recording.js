
// Export a factory function for dependency injection
module.exports = function createRecordingRouter({ storageManager, settingsManager, peertubeHelpers }) {
	const express = require('express');
	const router = express.Router();
	const { requireAuth } = require('./lib-auth-manager.js');

	// POST /recording-started
	router.post('/recording-started', requireAuth, async (req, res) => {
		const snifferId = req.snifferId;
		const event = req.body || {};
		if (!event || typeof event !== 'object' || Array.isArray(event) || !event.cameraId || typeof event.cameraId !== 'string') {
			return res.status(400).json({
				acknowledged: false,
				message: 'Request body must be an object with cameraId (string)',
				error: 'Invalid input'
			});
		}
		if (!storageManager) return res.status(500).json({ error: 'PLUGIN_STORAGE_NOT_INITIALIZED' });
		let log = (await storageManager.getData('recording-log')) || {};
		if (!log[snifferId]) log[snifferId] = [];
		log[snifferId].push({
			type: 'started',
			...event,
			timestamp: new Date().toISOString()
		});
		await storageManager.storeData('recording-log', log);
		// Stream token validation
		const sniffers = (await storageManager.getData('sniffers')) || {};
		const snifferEntry = sniffers[snifferId];
		const expectedStreamToken = snifferEntry && snifferEntry.streamToken;
		const receivedToken = req.headers['x-stream-token'] || req.headers['authorization'] || null;
		if (receivedToken !== expectedStreamToken) {
			console.warn('[PLUGIN] 401: Stream token mismatch', { snifferId, receivedToken, expectedStreamToken });
			return res.status(401).json({
				acknowledged: false,
				message: 'Invalid stream token',
				error: 'Stream token mismatch'
			});
		}
		try {
			const { createPeerTubeLiveVideo } = require('./lib-peertube-api.js');
			// Look up camera assignment by cameraId
			const cameraAssignments = (await storageManager.getData('camera-assignments')) || {};
			const cameraAssignment = cameraAssignments[snifferId] && cameraAssignments[snifferId][event.cameraId];
			if (!cameraAssignment) {
				return res.status(404).json({
					acknowledged: false,
					message: 'Camera assignment not found',
					error: 'No camera config'
				});
			}
			   const snifferToken = snifferEntry && snifferEntry.oauthToken;
			   if (!snifferToken) {
				   return res.status(401).json({
					   acknowledged: false,
					   message: 'No PeerTube OAuth token found for sniffer',
					   error: 'No OAuth token'
				   });
			   }
			   const liveStream = await createPeerTubeLiveVideo({
				   channelId: cameraAssignment.channelId,
				   name: cameraAssignment.streamTitle || cameraAssignment.cameraId || 'Live Stream',
				   description: cameraAssignment.streamDescription || '',
				   category: cameraAssignment.defaultStreamCategory,
				   privacy: cameraAssignment.privacyId,
				   oauthToken: snifferToken,
				   peertubeHelpers,
				   settingsManager
			   });
			return res.status(200).json({
				acknowledged: true,
				message: 'Recording started',
				streamId: liveStream.id,
				liveStream,
				isDuplicate: false,
				permanent: false
			});
		} catch (err) {
			return res.status(500).json({
				acknowledged: false,
				message: 'Failed to start recording',
				error: err.message
			});
		}
	});

	// POST /recording-started-hudl
	router.post('/recording-started-hudl', requireAuth, async (req, res) => {
			   const snifferId = req.snifferId;
			   const event = req.body || {};
			   const streamToken = req.headers['x-stream-token'] || req.headers['authorization'] || null;
			   console.log('[PLUGIN HUDL] /recording-started-hudl called:', {
				   snifferId,
				   cameraId: event.cameraId,
				   token: streamToken ? (typeof streamToken === 'string' ? streamToken.substring(0, 8) + '...' : streamToken) : null,
				   event
			   });
		       if (!event || typeof event !== 'object' || Array.isArray(event) || !event.cameraId || typeof event.cameraId !== 'string') {
			       console.warn('[PLUGIN HUDL] Invalid input for /recording-started-hudl:', event);
			       return res.status(400).json({
				       acknowledged: false,
				       message: 'Request body must be an object with cameraId (string)',
				       error: 'Invalid input'
			       });
		       }
			       if (!storageManager) {
			       console.error('[PLUGIN HUDL] storageManager not initialized');
			       return res.status(500).json({ error: 'PLUGIN_STORAGE_NOT_INITIALIZED' });
		       }
		       let log = (await storageManager.getData('recording-log')) || {};
		       if (!log[snifferId]) log[snifferId] = [];
		       log[snifferId].push({
			       type: 'started-permanent',
			       ...event,
			       timestamp: new Date().toISOString()
		       });
		       await storageManager.storeData('recording-log', log);
		// Use or create a permanent live stream via PeerTube API, using sniffer context
		try {
			const { getOrCreatePermanentLiveStream } = require('./lib-peertube-api.js');
			const { getMatchupKey, THUMBNAIL_DIR } = require('./lib-matchup-thumbnail.js');
			const path = require('path');
			const fs = require('fs');
					 const sniffers = (await storageManager.getData('sniffers')) || {};
					 const snifferEntry = sniffers[snifferId];
					 const snifferOAuthToken = snifferEntry && snifferEntry.oauthToken;
					 const expectedStreamToken = snifferEntry && snifferEntry.streamToken;
					 // Stream token validation (after expectedStreamToken is defined)
					 if (streamToken !== expectedStreamToken) {
						 console.warn('[PLUGIN HUDL] 401: Stream token mismatch', { snifferId, receivedToken: streamToken, expectedStreamToken });
						 return res.status(401).json({
							 acknowledged: false,
							 message: 'Stream token mismatch',
							 error: 'Invalid stream token'
						 });
					 }
					 console.log('[PLUGIN HUDL] Recording start debug:', {
						 snifferId,
						 receivedToken: streamToken,
						 expectedStreamToken,
						 hasOAuthToken: !!snifferOAuthToken
					 });
					 if (!snifferOAuthToken) {
						 console.warn('[PLUGIN HUDL] 401: No PeerTube OAuth token found for sniffer', { snifferId, sniffers: Object.keys(sniffers), snifferEntry });
						 return res.status(401).json({
							 acknowledged: false,
							 message: 'No PeerTube OAuth token found for sniffer',
							 error: 'No OAuth token',
							 snifferId,
							 snifferEntry
						 });
					 }
			// Look up camera assignment by cameraId
					       const cameraAssignments = (await storageManager.getData('camera-assignments')) || {};
					       const cameraAssignment = cameraAssignments[snifferId] && cameraAssignments[snifferId][event.cameraId];
					       if (!cameraAssignment) {
						       console.warn('[PLUGIN HUDL] 404: Camera assignment not found', {
							       snifferId,
							       cameraId: event.cameraId,
							       cameraAssignments: cameraAssignments[snifferId] || {},
							       allAssignments: cameraAssignments
						       });
						       return res.status(404).json({
							       acknowledged: false,
							       message: 'Camera assignment not found',
							       error: 'No camera config',
							       snifferId,
							       cameraId: event.cameraId,
							       cameraAssignments: cameraAssignments[snifferId] || {},
							       allAssignments: cameraAssignments
						       });
					       }
						       // No need to check for cameraAssignment.oauthToken; always use snifferToken
			// Match correct game for the day using startTime (±15 minutes) and cameraId assignment
			const schedules = (await storageManager.getData('hudl-schedules')) || {};
			const hudlMappings = (await storageManager.getData('hudl-mappings')) || {};
			let matchedGame = null;
			let matchedTeamId = null;
			let matchedChannelId = null;
			let thumbnailPath = undefined;
			let teamsToCheck = Object.entries(schedules);
			// Filter teams by cameraId assignment if present
			if (event.cameraId) {
				// Find teams with cameraId assigned (hudlMappings[teamId].cameraId === event.cameraId)
				const filtered = teamsToCheck.filter(([teamId, teamData]) => {
					const mapping = hudlMappings[teamId];
					return mapping && mapping.cameraId && mapping.cameraId === event.cameraId;
				});
				if (filtered.length > 0) {
					teamsToCheck = filtered;
				}
				// If no teams have cameraId assigned, fallback to all teams
			}
		if (event.startTime) {
			const eventTime = new Date(event.startTime).getTime();
			const earlyWindowMs = 15 * 60 * 1000; // 15 minutes before game start
			const maxGameDurationMs = 3 * 60 * 60 * 1000; // 3 hours fallback for single games
			const eventDate = new Date(event.startTime).setHours(0, 0, 0, 0);
			
			for (const [teamId, teamData] of teamsToCheck) {
				const games = teamData.games || [];
					for (const game of games) {
						// Use timeUtc if available, fallback to date for backwards compatibility
						const gameTimeField = game.timeUtc || game.date;
						if (!gameTimeField) continue;
						
						// Only match HOME games - camera cannot detect away games
						// scheduleEntryLocation: 1 = HOME, 2 = AWAY, 0/3 = NEUTRAL (numeric enum from HUDL API)
						if (game.scheduleEntryLocation !== undefined && game.scheduleEntryLocation !== 1) {
							continue;
						}
						
						// Skip games that have already been played
						// scheduleEntryOutcome: 0 = not played, 1 = WIN, 2 = LOSS (numeric enum from HUDL API)
						if (game.scheduleEntryOutcome !== undefined && game.scheduleEntryOutcome !== 0) {
							continue;
						}
						
						const gameStartTime = new Date(gameTimeField).getTime();
						const gameDate = new Date(gameTimeField).setHours(0, 0, 0, 0);
						
						// Find next game scheduled for this team on the same day
						let nextGameStartTime = null;
						for (const nextGame of games) {
							if (nextGame.id === game.id) continue;
							const nextGameTime = new Date(nextGame.timeUtc || nextGame.date).getTime();
							const nextGameDate = new Date(nextGame.timeUtc || nextGame.date).setHours(0, 0, 0, 0);
							if (nextGameDate === gameDate && nextGameTime > gameStartTime) {
								if (!nextGameStartTime || nextGameTime < nextGameStartTime) {
									nextGameStartTime = nextGameTime;
								}
							}
						}
						
						// Upper limit: next game start time, or game start + 3 hours
						const upperLimit = nextGameStartTime || (gameStartTime + maxGameDurationMs);
						
						// Match if EITHER:
						// 1. Within 15 minutes BEFORE game start (early detection)
						// 2. OR (after game start, before upper limit, same day, not finished)
						const isEarlyDetection = eventTime < gameStartTime && (gameStartTime - eventTime) <= earlyWindowMs;
						const isInProgress = eventTime >= gameStartTime 
						                     && eventTime < upperLimit
						                     && gameDate === eventDate
						                     && game.scheduleEntryOutcome === 0;
						
					if (isEarlyDetection || isInProgress) {
						matchedGame = game;
						matchedTeamId = teamId;
						matchedChannelId = hudlMappings[teamId]?.channelId;
						// Check for existing matchup thumbnail
							if (game.homeTeamId && game.awayTeamId) {
								const matchupKey = getMatchupKey(game.homeTeamId, game.awayTeamId);
								const possiblePath = path.join(THUMBNAIL_DIR, matchupKey);
								if (fs.existsSync(possiblePath)) {
									thumbnailPath = possiblePath;
								}
							}
							break;
						}
					}
					if (matchedGame) break;
				}
			}
			
			// Import shared title generator
			const { generateGameTitle } = require('./lib-game-title.js');
			
			// Get school name and team data for matched game to generate title
			let generatedTitle = null;
			if (matchedGame && matchedTeamId) {
				const orgData = (await storageManager.getData('hudl-organization')) || {};
				const schoolName = orgData.name || null;
				const teamData = schedules[matchedTeamId];
				generatedTitle = generateGameTitle(matchedGame, teamData, schoolName);
			}
			
			// Prepare camera assignment for permanent live stream
			const assignmentForStream = {
				cameraId: cameraAssignment.cameraId,
				channelId: matchedChannelId || cameraAssignment.channelId,
				streamTitle: generatedTitle || cameraAssignment.streamTitle || cameraAssignment.cameraId || 'Live Stream',
				streamDescription: matchedGame ? (matchedGame.description || cameraAssignment.streamDescription || '') : (cameraAssignment.streamDescription || ''),
				defaultStreamCategory: cameraAssignment.defaultStreamCategory,
			privacyId: cameraAssignment.privacyId,
			thumbnailPath,
			oauthToken: snifferOAuthToken
		};
		// Update permanent live video with matched game metadata and thumbnail, or fallback to camera config
		const liveStream = await getOrCreatePermanentLiveStream(snifferId, cameraAssignment.cameraId, assignmentForStream, snifferOAuthToken, peertubeHelpers, settingsManager, storageManager);
		return res.status(200).json({
			acknowledged: true,
			message: matchedGame ? 'Using HUDL live video (matched game)' : 'Using HUDL live video (fallback config)',
				streamId: liveStream.videoId,
				liveStream,
				isDuplicate: !liveStream.isNew,
				hudl: true,
				thumbnailUsed: thumbnailPath || null,
				matchedGame: matchedGame || null,
				matchedTeamId: matchedTeamId || null
			});
		} catch (err) {
			console.error('[PLUGIN HUDL] Error in /recording-started-hudl:', {
				message: err.message,
				stack: err.stack,
				error: err
			});
			return res.status(500).json({
				acknowledged: false,
				message: 'Failed to start permanent live',
				error: err.message,
				stack: err.stack,
				details: err
			});
		}
	});

	// POST /recording-stopped
	router.post('/recording-stopped', requireAuth, async (req, res) => {
		const snifferId = req.snifferId;
		const event = req.body || {};
		const sniffers = (await storageManager.getData('sniffers')) || {};
		const snifferEntry = sniffers[snifferId];
		const expectedStreamToken = snifferEntry && snifferEntry.streamToken;
		const receivedToken = req.headers['x-stream-token'] || req.headers['authorization'] || null;
		if (receivedToken !== expectedStreamToken) {
			console.warn('[PLUGIN] 401: Stream token mismatch', { snifferId, receivedToken, expectedStreamToken });
			return res.status(401).json({
				acknowledged: false,
				message: 'Invalid stream token',
				error: 'Stream token mismatch'
			});
		}
		if (!event || typeof event !== 'object' || Array.isArray(event) || !event.cameraId || typeof event.cameraId !== 'string') {
			return res.status(400).json({
				acknowledged: false,
				message: 'Request body must be an object with cameraId (string)',
				error: 'Invalid input'
			});
		}
		if (!storageManager) return res.status(500).json({ error: 'PLUGIN_STORAGE_NOT_INITIALIZED' });
		let log = (await storageManager.getData('recording-log')) || {};
		if (!log[snifferId]) log[snifferId] = [];
		log[snifferId].push({
			type: 'stopped',
			...event,
			timestamp: new Date().toISOString()
		});
		await storageManager.storeData('recording-log', log);
		return res.status(200).json({
			acknowledged: true,
			message: 'Recording stopped'
		});
	});

	return router;
};
