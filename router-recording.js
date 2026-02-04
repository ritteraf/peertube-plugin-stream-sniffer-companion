
// Export a factory function for dependency injection
module.exports = function createRecordingRouter({ storageManager, settingsManager, peertubeHelpers }) {
	const express = require('express');
	const router = express.Router();
	const { requireAuth } = require('./lib-auth-manager.js');

	// Initialize global session tracking
	if (!global.__ACTIVE_RECORDING_SESSIONS__) {
		global.__ACTIVE_RECORDING_SESSIONS__ = {};
	}

	// GET /active-streams - Public endpoint (no auth required) for FalconCast app
	router.get('/active-streams', async (req, res) => {
		try {
			const sessions = global.__ACTIVE_RECORDING_SESSIONS__ || {};
			const activeStreams = [];

			// Flatten sessions from all sniffers
			for (const snifferId in sessions) {
				for (const cameraId in sessions[snifferId]) {
					const session = sessions[snifferId][cameraId];
					const startTime = new Date(session.startTime);
					const now = new Date();
					const durationMs = now - startTime;
					const durationSeconds = Math.floor(durationMs / 1000);

					activeStreams.push({
						snifferId,
						cameraId,
						teamName: session.teamName,
						opponent: session.opponent,
					liveVideoId: session.liveVideoId,
					videoUrl: session.videoUrl || null,
						startTime: session.startTime,
						durationSeconds
					});
				}
			}

			return res.status(200).json({
				activeStreams,
				count: activeStreams.length
			});
		} catch (err) {
			console.error('[PLUGIN] Error fetching active streams:', err);
			return res.status(500).json({
				error: 'Failed to fetch active streams',
				message: err.message
			});
		}
	});

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
		// Create live video for matched game using PeerTube API
		try {
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

			console.log('[PLUGIN HUDL] Game matching started:', {
				cameraId: event.cameraId,
				startTime: event.startTime,
				totalTeams: teamsToCheck.length,
				hasMappings: Object.keys(hudlMappings).length > 0
			});

			// Filter teams by cameraId assignment if present
			if (event.cameraId) {
				// Find teams with cameraId assigned (hudlMappings[teamId].cameraId === event.cameraId)
				const filtered = teamsToCheck.filter(([teamId, teamData]) => {
					const mapping = hudlMappings[teamId];
					return mapping && mapping.cameraId && mapping.cameraId === event.cameraId;
				});
				if (filtered.length > 0) {
					teamsToCheck = filtered;
					console.log(`[PLUGIN HUDL] Filtered to ${filtered.length} team(s) with cameraId '${event.cameraId}'`);
				} else {
					console.log(`[PLUGIN HUDL] No teams mapped to cameraId '${event.cameraId}', checking all teams`);
				}
				// If no teams have cameraId assigned, fallback to all teams
			}
			if (event.startTime) {
				const eventTime = new Date(event.startTime).getTime();
				const earlyWindowMs = 15 * 60 * 1000; // 15 minutes before game start
				const maxGameDurationMs = 3 * 60 * 60 * 1000; // 3 hours fallback for single games
				const eventDate = new Date(event.startTime).setHours(0, 0, 0, 0);

				let gamesEvaluated = 0;
				let gamesFilteredByLocation = 0;
				let gamesFilteredByOutcome = 0;

				for (const [teamId, teamData] of teamsToCheck) {
					const games = teamData.games || [];
					for (const game of games) {
						gamesEvaluated++;
						// Use timeUtc if available, fallback to date for backwards compatibility
						const gameTimeField = game.timeUtc || game.date;
						if (!gameTimeField) continue;

						// Only match HOME games - camera cannot detect away games
						// scheduleEntryLocation: 1 = HOME, 2 = AWAY, 0/3 = NEUTRAL (numeric enum from HUDL API)
						if (game.scheduleEntryLocation !== undefined && game.scheduleEntryLocation !== 1) {
							gamesFilteredByLocation++;
							continue;
						}

						// Skip games that have already been played
						// scheduleEntryOutcome: 0 = not played, 1 = WIN, 2 = LOSS (numeric enum from HUDL API)
						if (game.scheduleEntryOutcome !== undefined && game.scheduleEntryOutcome !== 0) {
							gamesFilteredByOutcome++;
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
							console.log('[PLUGIN HUDL] ✓ Game matched:', {
								opponent: game.opponentDetails?.name,
								gameTime: gameTimeField,
								recordingTime: event.startTime,
								teamName: teamData.teamName,
								matchReason: isEarlyDetection ? 'early-detection' : 'in-progress'
							});
							// Check for existing matchup thumbnail
							// matchedTeamId is the home team (we filter for home games only)
							// opponentDetails.schoolId is the away team
							const opponentSchoolId = game.opponentDetails?.schoolId;
							if (teamId && opponentSchoolId) {
								const matchupKey = getMatchupKey(teamId, opponentSchoolId);
								const possiblePath = path.join(THUMBNAIL_DIR, matchupKey);
								if (fs.existsSync(possiblePath)) {
									thumbnailPath = possiblePath;
									console.log('[PLUGIN HUDL] ✓ Matchup thumbnail found and will be applied:', possiblePath);
								} else {
									console.log('[PLUGIN HUDL] ✗ Matchup thumbnail not cached (will use default):', possiblePath);
								}
							} else {
								console.log('[PLUGIN HUDL] Cannot determine matchup thumbnail - missing team or opponent ID');
							}
							break;
						}
					}
					if (matchedGame) break;
				}

				if (!matchedGame) {
					console.log('[PLUGIN HUDL] ✗ No game matched:', {
						gamesEvaluated,
						filteredByLocation: gamesFilteredByLocation,
						filteredByOutcome: gamesFilteredByOutcome,
						reason: gamesEvaluated === 0 ? 'no-games-in-schedules' : 'no-time-match'
					});
					
					// Fallback: Try refreshing teams for this camera and retry matching
					const settings = await settingsManager.getSetting('hudl-org-url');
					const hudlOrgUrl = settings || process.env.HUDL_ORG_URL || '';
					
					if (hudlOrgUrl && event.cameraId && event.startTime) {
						console.log('[PLUGIN HUDL] Attempting fallback refresh for late-added games...');
						const { refreshAndRetryMatch } = require('./lib-fallback-match.js');
						
						const fallbackMatch = await refreshAndRetryMatch({
							cameraId: event.cameraId,
							snifferId,
							startTime: event.startTime,
							storageManager,
							hudlOrgUrl
						});
						
						if (fallbackMatch) {
							matchedGame = fallbackMatch.game;
							matchedTeamId = fallbackMatch.teamId;
							matchedChannelId = hudlMappings[fallbackMatch.teamId]?.channelId;
							
							console.log('[PLUGIN HUDL] ✓ Game matched via fallback:', {
								opponent: fallbackMatch.game.opponentDetails?.name,
								teamName: schedules[fallbackMatch.teamId]?.teamName
							});
							
							// Generate thumbnail for this matchup
							const opponentSchoolId = fallbackMatch.game.opponentDetails?.schoolId;
							if (fallbackMatch.teamId && opponentSchoolId) {
								const { generateSingleThumbnail } = require('./lib-thumbnail-generator.js');
								const teamData = schedules[fallbackMatch.teamId];
								const result = await generateSingleThumbnail({
									homeTeamId: fallbackMatch.teamId,
									homeLogo: teamData?.logoURL || null,
									awayTeamId: opponentSchoolId,
									awayLogo: fallbackMatch.game.opponentDetails?.profileImageUri || null
								});
								if (result.path) {
									thumbnailPath = result.path;
									if (result.generated) {
										console.log('[PLUGIN HUDL] ✓ Generated new thumbnail for late-added game');
									}
								}
							}
						}
					}
				}
			} else {
				console.log('[PLUGIN HUDL] No startTime provided, skipping game matching');
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

			// MATCHED GAME: Use pre-created scheduled live video
			if (matchedGame && matchedTeamId) {
				const teamMapping = hudlMappings[matchedTeamId];
				if (!teamMapping) {
					console.error('[PLUGIN HUDL] Team mapping not found for matched team:', matchedTeamId);
					return res.status(500).json({
						acknowledged: false,
						message: 'Team mapping not found',
						error: 'Configuration error'
					});
				}

				// Check if live video was pre-created for this game
				if (matchedGame.liveVideoId && matchedGame.rtmpUrl && matchedGame.streamKey) {
					console.log(`[PLUGIN HUDL] ✓ Using pre-created scheduled live video for game ${matchedGame.id}:`, {
						videoId: matchedGame.liveVideoId,
						opponent: matchedGame.opponentDetails?.name,
						title: matchedGame.generatedTitle
					});

					const schedule = schedules[matchedTeamId];
					const seasonYear = schedule?.seasonYear;

					// Store active recording session for tracking
					if (!global.__ACTIVE_RECORDING_SESSIONS__[snifferId]) {
						global.__ACTIVE_RECORDING_SESSIONS__[snifferId] = {};
					}
					global.__ACTIVE_RECORDING_SESSIONS__[snifferId][event.cameraId] = {
						liveVideoId: matchedGame.liveVideoId,
						teamId: matchedTeamId,
						teamName: teamMapping.teamName,
						opponent: matchedGame.opponentDetails?.name || null,
						playlistId: teamMapping.seasons?.[seasonYear]?.playlistId || null,
						seasonYear,
						startTime: event.startTime || new Date().toISOString(),
						gameId: matchedGame.id
					};

					return res.status(200).json({
						acknowledged: true,
						message: 'Using pre-created scheduled live video',
						streamId: matchedGame.liveVideoId,
						liveStream: {
							videoId: matchedGame.liveVideoId,
							rtmpUrl: matchedGame.rtmpUrl,
							streamKey: matchedGame.streamKey,
							isNew: false,
							videoTitle: matchedGame.generatedTitle
						},
						matchInfo: {
							opponent: matchedGame.opponentDetails?.name,
							gameTime: matchedGame.timeUtc || matchedGame.date,
							teamName: teamMapping.teamName
						}
					});
				}

				// Fallback: No pre-created video exists - create one on the fly
				console.warn(`[PLUGIN HUDL] No pre-created live video found for game ${matchedGame.id}, creating on-the-fly`);
				
				const { createPeerTubeLiveVideo } = require('./lib-peertube-api.js');
				const { buildVideoTags } = require('./lib-peertube-api.js');
				const schedule = schedules[matchedTeamId];
				
				const tags = buildVideoTags({
					gender: schedule?.gender,
					teamLevel: schedule?.teamLevel,
					sport: schedule?.sport,
					customTags: teamMapping.customTags || []
				});

				// Add team name tag
				const teamNameTag = teamMapping.teamName;
				if (teamNameTag && teamNameTag.length >= 2 && teamNameTag.length <= 30) {
					tags.unshift(teamNameTag);
				}

				// Validate and limit tags
				const validTags = tags
					.filter(tag => typeof tag === 'string' && tag.length >= 2 && tag.length <= 30)
					.slice(0, 5);

				const liveVideo = await createPeerTubeLiveVideo({
					channelId: teamMapping.channelId,
					name: generatedTitle,
					description: teamMapping.description || `${teamMapping.teamName} game`,
					category: teamMapping.category !== undefined ? teamMapping.category : cameraAssignment.defaultStreamCategory,
					privacy: teamMapping.privacy !== undefined ? teamMapping.privacy : cameraAssignment.privacyId,
					tags: validTags,
					language: 'en',
					licence: 1,
					commentsEnabled: teamMapping.commentsEnabled !== undefined ? teamMapping.commentsEnabled : true,
					downloadEnabled: teamMapping.downloadEnabled !== undefined ? teamMapping.downloadEnabled : true,
					oauthToken: snifferOAuthToken,
					peertubeHelpers,
					settingsManager,
					snifferId,
					storageManager,
					thumbnailPath
					// No scheduledStartTime - create as regular live video
				});

				// Store credentials in game object for future use
				matchedGame.liveVideoId = liveVideo.id;
				matchedGame.rtmpUrl = liveVideo.rtmpUrl;
				matchedGame.streamKey = liveVideo.streamKey;
				matchedGame.liveCreatedAt = new Date().toISOString();
				await storageManager.storeData('hudl-schedules', schedules);

				const seasonYear = schedule?.seasonYear;
				
			// Store active recording session for tracking
			if (!global.__ACTIVE_RECORDING_SESSIONS__[snifferId]) {
				global.__ACTIVE_RECORDING_SESSIONS__[snifferId] = {};
			}
			global.__ACTIVE_RECORDING_SESSIONS__[snifferId][event.cameraId] = {
				liveVideoId: liveVideo.id,
				teamId: matchedTeamId,
				teamName: teamMapping.teamName,
				opponent: matchedGame.opponentDetails?.name || null,
				playlistId: teamMapping.seasons?.[seasonYear]?.playlistId || null,
				seasonYear: seasonYear,
				startTime: event.startTime || new Date().toISOString(),
				gameId: matchedGame.id
			};
				return res.status(200).json({
					acknowledged: true,
					message: 'Created live video on-the-fly (matched game, no pre-created video)',
					streamId: liveVideo.id,
					liveStream: {
						videoId: liveVideo.id,
						rtmpUrl: liveVideo.rtmpUrl,
						streamKey: liveVideo.streamKey,
						isNew: true,
						videoTitle: generatedTitle
					},
					isDuplicate: false,
					hudl: true,
					permanent: false,
					thumbnailUsed: thumbnailPath || null,
					matchedGame: matchedGame,
					matchedTeamId: matchedTeamId
				});
			}

			// NO MATCH: Create temporary one-time video using camera fallback config
			else {
				const { createPeerTubeLiveVideo } = require('./lib-peertube-api.js');

				const fallbackTitle = cameraAssignment.streamTitle || `${cameraAssignment.cameraId} - Live`;
				const fallbackDescription = cameraAssignment.streamDescription || `Live stream from ${cameraAssignment.cameraId}`;

				console.log('[PLUGIN HUDL] No game matched - creating temporary video with camera fallback config');

				const liveStream = await createPeerTubeLiveVideo({
					channelId: cameraAssignment.channelId,
					name: fallbackTitle,
					description: fallbackDescription,
					category: cameraAssignment.defaultStreamCategory,
					privacy: cameraAssignment.privacyId,
					oauthToken: snifferOAuthToken,
					peertubeHelpers,
					settingsManager,
					snifferId,
					storageManager
				});

				return res.status(200).json({
					acknowledged: true,
					message: 'Using HUDL live video (fallback config - temporary)',
					streamId: liveStream.id,
					liveStream: {
						videoId: liveStream.id,
						rtmpUrl: liveStream.rtmpUrl,
						streamKey: liveStream.streamKey,
						isNew: true,
						videoTitle: liveStream.name
					},
					isDuplicate: false,
					hudl: true,
					permanent: false,
					thumbnailUsed: null,
					matchedGame: null,
					matchedTeamId: null
				});
			}
		} catch (err) {
			console.error('[PLUGIN HUDL] Error in /recording-started-hudl:', {
				message: err.message,
				stack: err.stack,
				error: err
			});
			return res.status(500).json({
				acknowledged: false,
				message: 'Failed to start live stream',
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
		const streamToken = req.headers['x-stream-token'] || req.headers['authorization'] || null;

		// Initial logging (BEFORE validation checks)
		console.log('[PLUGIN] /recording-stopped called:', {
			snifferId,
			cameraId: event.cameraId,
			videoId: event.videoId,
			token: streamToken ? (typeof streamToken === 'string' ? streamToken.substring(0, 8) + '...' : streamToken) : null,
			event
		});

		// Validate input
		if (!event || typeof event !== 'object' || Array.isArray(event) || !event.cameraId || typeof event.cameraId !== 'string') {
			console.warn('[PLUGIN] Invalid input for /recording-stopped:', event);
			return res.status(400).json({
				acknowledged: false,
				message: 'Request body must be an object with cameraId (string)',
				error: 'Invalid input'
			});
		}

		if (!storageManager) {
			console.error('[PLUGIN] storageManager not initialized');
			return res.status(500).json({ error: 'PLUGIN_STORAGE_NOT_INITIALIZED' });
		}

		// Get sniffer data for token validation
		const sniffers = (await storageManager.getData('sniffers')) || {};
		const snifferEntry = sniffers[snifferId];
		const expectedStreamToken = snifferEntry && snifferEntry.streamToken;

		// Stream token validation (double-check after requireAuth)
		if (streamToken !== expectedStreamToken) {
			console.warn('[PLUGIN] 401: Stream token mismatch', { snifferId, receivedToken: streamToken, expectedStreamToken });
			return res.status(401).json({
				acknowledged: false,
				message: 'Invalid stream token',
				error: 'Stream token mismatch'
			});
		}

		// Log the recording stopped event
		let log = (await storageManager.getData('recording-log')) || {};
		if (!log[snifferId]) log[snifferId] = [];
		log[snifferId].push({
			type: 'stopped',
			...event,
			timestamp: new Date().toISOString()
		});
		await storageManager.storeData('recording-log', log);

		// Clean up session tracking
		const session = global.__ACTIVE_RECORDING_SESSIONS__?.[snifferId]?.[event.cameraId];
		if (session && session.liveVideoId) {
			// Remove session from tracking
			delete global.__ACTIVE_RECORDING_SESSIONS__[snifferId][event.cameraId];
			console.log('[PLUGIN] Cleaned up recording session:', { snifferId, cameraId: event.cameraId, videoId: session.liveVideoId });
		}

		console.log('[PLUGIN] Recording stopped successfully:', {
			snifferId,
			cameraId: event.cameraId,
			videoId: event.videoId
		});

		return res.status(200).json({
			acknowledged: true,
			message: 'Recording stopped'
		});
	});

	return router;
};