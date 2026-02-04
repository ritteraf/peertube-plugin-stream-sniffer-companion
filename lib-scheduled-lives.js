/**
 * Scheduled Live Video Management
 * Creates and manages scheduled PeerTube live videos for upcoming HUDL games
 */

const path = require('path');
const fs = require('fs');

/**
 * Create scheduled live videos for all upcoming home games
 * @param {Object} params
 * @param {Object} params.storageManager - Plugin storage manager
 * @param {Object} params.peertubeHelpers - PeerTube helpers
 * @param {Object} params.settingsManager - Settings manager
 * @returns {Promise<{created: number, existing: number, skipped: number}>}
 */
async function createScheduledLivesForGames({ storageManager, peertubeHelpers, settingsManager }) {
	try {
		console.log('[PLUGIN] Starting scheduled live video creation...');

		const hudlSchedules = (await storageManager.getData('hudl-schedules')) || {};
		const hudlMappings = (await storageManager.getData('hudl-mappings')) || {};
		const sniffers = (await storageManager.getData('sniffers')) || {};
		const { createPeerTubeLiveVideo } = require('./lib-peertube-api.js');
		const { getMatchupKey, THUMBNAIL_DIR } = require('./lib-matchup-thumbnail.js');

		let created = 0;
		let existing = 0;
		let skipped = 0;
		const now = Date.now();
		
		let totalGames = 0;
		let awayGames = 0;
		let pastGames = 0;
		let playedGames = 0;

		for (const teamId in hudlSchedules) {
			const teamData = hudlSchedules[teamId];
			const teamMapping = hudlMappings[teamId];

			if (!teamMapping) {
				console.log(`[PLUGIN] No mapping found for team ${teamData.teamName}, skipping scheduled live creation`);
				continue;
			}

			// Find OAuth token for the team owner
			const ownerUsername = teamMapping.ownerUsername;
			if (!ownerUsername) {
				console.log(`[PLUGIN] No owner username for team ${teamData.teamName}, skipping`);
				continue;
			}

			let snifferOAuthToken = null;
			let snifferId = null;
			for (const sid in sniffers) {
				if (sniffers[sid]?.peertubeUsername === ownerUsername) {
					snifferOAuthToken = sniffers[sid]?.oauthToken;
					snifferId = sid;
					break;
				}
			}

			if (!snifferOAuthToken) {
				console.log(`[PLUGIN] No OAuth token found for user ${ownerUsername} (team ${teamData.teamName}), skipping`);
				continue;
			}

			const games = teamData.games || [];
			for (const game of games) {
				totalGames++;
				
				// Skip if not a home game (scheduleEntryLocation: 1 = HOME)
				if (game.scheduleEntryLocation !== 1) {
					awayGames++;
					skipped++;
					continue;
				}

				// Skip if game already played (scheduleEntryOutcome: 0 = not played)
				if (game.scheduleEntryOutcome !== undefined && game.scheduleEntryOutcome !== 0) {
					playedGames++;
					skipped++;
					continue;
				}

				// Skip if game is in the past
				const gameTime = new Date(game.timeUtc || game.date).getTime();
				if (gameTime < now) {
					pastGames++;
					skipped++;
					continue;
				}

				// Check if live video already exists for this game
				if (game.liveVideoId) {
					// Verify video still exists on PeerTube (user may have deleted it)
					const { checkVideoExists } = require('./lib-peertube-api.js');
					try {
						const exists = await checkVideoExists(game.liveVideoId, snifferOAuthToken, peertubeHelpers, settingsManager, snifferId, storageManager);
						if (exists) {
							existing++;
							continue;
						} else {
							// Video was deleted, clear the stored ID and recreate
							console.log(`[PLUGIN] Scheduled live video ${game.liveVideoId} was deleted, will recreate for ${teamData.teamName} vs ${game.opponentDetails?.name}`);
							game.liveVideoId = null;
							game.rtmpUrl = null;
							game.streamKey = null;
						}
					} catch (err) {
						// Error checking video (possibly deleted), clear and recreate
						console.warn(`[PLUGIN] Could not verify video ${game.liveVideoId}, will recreate: ${err.message}`);
						game.liveVideoId = null;
						game.rtmpUrl = null;
						game.streamKey = null;
					}
				}

				// Find matchup thumbnail
				const opponentSchoolId = game.opponentDetails?.schoolId;
				let thumbnailPath = null;
				if (teamId && opponentSchoolId) {
					const matchupKey = getMatchupKey(teamId, opponentSchoolId);
					const possiblePath = path.join(THUMBNAIL_DIR, matchupKey);
					if (fs.existsSync(possiblePath)) {
						thumbnailPath = possiblePath;
					}
				}

				// Build tags for this game
				const { buildVideoTags } = require('./lib-peertube-api.js');
				const tags = buildVideoTags({
					gender: teamData.gender,
					teamLevel: teamData.teamLevel,
					sport: teamData.sport,
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

				// Create scheduled live video
				try {
					const liveVideo = await createPeerTubeLiveVideo({
						channelId: teamMapping.channelId,
						name: game.generatedTitle || `${teamData.teamName} vs ${game.opponentDetails?.name || 'Opponent'}`,
						description: teamMapping.description || `${teamData.teamName} game`,
						category: teamMapping.category,
						privacy: teamMapping.privacy !== undefined ? teamMapping.privacy : 1,
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
				thumbnailPath,
				scheduledStartTime: new Date(game.timeUtc || game.date).toISOString()
		});

		// Store video credentials in the game object
		game.liveVideoId = liveVideo.id;
		game.rtmpUrl = liveVideo.rtmpUrl;
		game.streamKey = liveVideo.streamKey;
		game.scheduledLiveCreatedAt = new Date().toISOString();

			created++;
			console.log(`[PLUGIN] ✓ Created scheduled live for ${teamData.teamName} vs ${game.opponentDetails?.name || 'Opponent'} (videoId: ${liveVideo.id})`);
		} catch (err) {
			console.error(`[PLUGIN] Failed to create scheduled live for game ${game.id}:`, err.message);
			skipped++;
		}
	}
}

// Save updated schedules with live video credentials
await storageManager.storeData('hudl-schedules', hudlSchedules);

	console.log(`[PLUGIN] Scheduled live creation complete: ${created} created, ${existing} existing, ${skipped} skipped`);
	console.log(`[PLUGIN] Game stats: ${totalGames} total, ${awayGames} away, ${pastGames} past, ${playedGames} played`);

	return { created, existing, skipped };
} catch (err) {
	console.error('[PLUGIN] Error in createScheduledLivesForGames:', err);
	throw err;
}
}

module.exports = {
	createScheduledLivesForGames
};
