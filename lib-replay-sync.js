// Shared replay-to-playlist sync logic

async function syncReplaysToPlaylists({ storageManager, peertubeHelpers, settingsManager }) {
	try {
		console.log('[PLUGIN] Starting replay-to-playlist sync...');

		const hudlMappings = (await storageManager.getData('hudl-mappings')) || {};
		const hudlSchedules = (await storageManager.getData('hudl-schedules')) || {};
		const sniffers = (await storageManager.getData('sniffers')) || {};
		const { addVideoToPlaylist } = require('./lib-peertube-api.js');

		let teamsChecked = 0;
		let replaysAdded = 0;
		const results = [];

		for (const teamId in hudlMappings) {
			const teamData = hudlMappings[teamId];

			// Skip if no permanent live or no seasons
			if (!teamData.permanentLiveVideoId || !teamData.seasons) {
				continue;
			}

			teamsChecked++;

			// Get current season's playlist using the team's season year from schedules (not calendar year)
			// This handles multi-year seasons like Basketball 2025-2026
			const schedule = hudlSchedules[teamId];
			const seasonYear = schedule?.seasonYear || new Date().getFullYear();

			// Find OAuth token for the team owner's username (needed for both playlist creation and sync)
			let snifferOAuthToken = null;
			const ownerUsername = teamData.ownerUsername;

			if (!ownerUsername) {
				results.push({
					team: teamData.teamName,
					status: 'error',
					reason: 'No owner username stored for this team'
				});
				console.log(`[PLUGIN] No owner username for team ${teamData.teamName}`);
				continue;
			}

			// Find any sniffer authenticated as this user
			for (const snifferId in sniffers) {
				if (sniffers[snifferId]?.peertubeUsername === ownerUsername) {
					snifferOAuthToken = sniffers[snifferId]?.oauthToken;
					break;
				}
			}

			if (!snifferOAuthToken) {
				results.push({
					team: teamData.teamName,
					status: 'error',
					reason: `No active sniffer found with user ${ownerUsername}`
				});
				console.log(`[PLUGIN] No OAuth token found for user ${ownerUsername} (team ${teamData.teamName})`);
				continue;
			}

			// Auto-create playlist for this season if it doesn't exist yet
			let seasonData = teamData.seasons?.[seasonYear];
			if (!seasonData || !seasonData.playlistId) {
				if (!seasonYear || !teamData.channelId) {
					results.push({
						team: teamData.teamName,
						status: 'skipped',
						reason: `No playlist for season ${seasonYear} and cannot auto-create (missing seasonYear or channelId)`
					});
					continue;
				}

				try {
					console.log(`[PLUGIN] Auto-creating playlist for ${teamData.teamName} season ${seasonYear}`);
					const { createPlaylist } = require('./lib-peertube-api.js');
					const { generatePlaylistTitle } = require('./lib-game-title.js');

					// Get school name for consistent naming
					const orgData = (await storageManager.getData('hudl-organization')) || {};
					const schoolName = orgData.name || 'School';

					// Generate consistent playlist title using team metadata
					const scheduleData = hudlSchedules[teamId];
					const playlistDisplayName = generatePlaylistTitle(
						{ gender: scheduleData?.gender, teamLevel: scheduleData?.level, sport: scheduleData?.sport },
						schoolName,
						seasonYear
					) || `${teamData.teamName} ${seasonYear}-${parseInt(seasonYear) + 1}`;

					const nextYear = parseInt(seasonYear) + 1;
					const newPlaylist = await createPlaylist({
						channelId: teamData.channelId,
						displayName: playlistDisplayName,
						description: `${schoolName} ${scheduleData?.sport || 'team'} season ${seasonYear}-${nextYear}`,
						privacy: teamData.privacy !== undefined ? teamData.privacy : 1,
						oauthToken: snifferOAuthToken,
						peertubeHelpers,
						settingsManager
					});

					// Initialize seasons object if needed
					if (!teamData.seasons) {
						teamData.seasons = {};
					}

					teamData.seasons[seasonYear] = {
						seasonYear: seasonYear,
						playlistId: newPlaylist.playlistId,
						playlistName: newPlaylist.displayName,
						createdByUser: ownerUsername
					};

					// Update storage
					hudlMappings[teamId] = teamData;
					await storageManager.storeData('hudl-mappings', hudlMappings);

					seasonData = teamData.seasons[seasonYear];
					console.log(`[PLUGIN] Created playlist ${newPlaylist.displayName} (ID: ${newPlaylist.playlistId})`);

				} catch (playlistErr) {
					results.push({
						team: teamData.teamName,
						status: 'error',
						reason: `Failed to auto-create playlist: ${playlistErr.message}`
					});
					console.error(`[PLUGIN] Failed to create playlist for ${teamData.teamName}:`, playlistErr);
					continue;
				}
			}

			// Fetch videos from channel
			const baseUrl = await peertubeHelpers.config.getWebserverUrl();
			const channelHandle = teamData.channelHandle;

			if (!channelHandle) {
				results.push({
					team: teamData.teamName,
					status: 'error',
					reason: 'No channel handle stored for this team'
				});
				console.log(`[PLUGIN] No channel handle for team ${teamData.teamName}`);
				continue;
			}

			try {
				const res = await fetch(`${baseUrl}/api/v1/video-channels/${encodeURIComponent(channelHandle)}/videos?count=50&sort=-publishedAt`, {
					headers: { 'Authorization': `Bearer ${snifferOAuthToken}` }
				});

				if (!res.ok) {
					results.push({
						team: teamData.teamName,
						status: 'error',
						reason: `Failed to fetch videos: ${res.status}`
					});
					console.log(`[PLUGIN] Failed to fetch videos for ${teamData.teamName}: ${res.status}`);
					continue;
				}

				const { data: videos } = await res.json();

				// Filter videos by team name tag (primary) or title metadata (fallback)
				const scheduleData = hudlSchedules[teamId];
			
			// Build gender variants (we use "Mens"/"Womens" but tags use "Boys"/"Girls")
			const genderVariants = [];
			if (scheduleData?.gender === 'MENS') {
				genderVariants.push('Mens', 'Boys', 'Men');
			} else if (scheduleData?.gender === 'WOMENS') {
				genderVariants.push('Womens', 'Girls', 'Women');
			} else if (scheduleData?.gender === 'COED') {
				genderVariants.push('Coed');
			}
			
			// Build level variants
			const levelVariants = [];
			if (scheduleData?.level === 'VARSITY') {
				levelVariants.push('Varsity', 'Var');
			} else if (scheduleData?.level === 'JUNIOR_VARSITY') {
				levelVariants.push('JV', 'Junior Varsity', 'J.V.');
			} else if (scheduleData?.level === 'FRESHMAN') {
				levelVariants.push('Freshman', 'Fresh', 'Frosh');
			}
			
			// Sport name (handle multi-word sports)
			const sport = scheduleData?.sport ? scheduleData.sport.charAt(0) + scheduleData.sport.slice(1).toLowerCase().replace(/_/g, ' ') : '';
			
			const teamVideos = videos.filter(v => {
				// Primary: Check if video has team name tag
				if (v.tags && v.tags.includes(teamData.teamName)) {
					return true;
				}
				
				// Fallback: Check if video title contains team metadata
				if (!v.name) return false;
				
				// Must match gender (at least one variant)
				const hasGender = genderVariants.length === 0 || genderVariants.some(g => v.name.includes(g));
				if (!hasGender) return false;
				
				// Must match sport
				const hasSport = !sport || v.name.includes(sport);
				if (!hasSport) return false;
				
				// Level matching with HS/JH distinction
				const teamNameUpper = teamData.teamName.toUpperCase();
				
				if (teamNameUpper.startsWith('HS ') || teamNameUpper.includes(' HS ')) {
					// HS team - must have a level marker if team has one
					if (levelVariants.length > 0) {
						return levelVariants.some(l => v.name.includes(l));
					}
					return true;
				} else if (teamNameUpper.startsWith('JH ') || teamNameUpper.includes(' JH ') || 
				           teamNameUpper.startsWith('MS ') || teamNameUpper.includes(' MS ')) {
					// JH/MS team - exclude videos with HS-specific level markers
					const hsLevelMarkers = ['JV', 'J.V.', 'Junior Varsity', 'Varsity', 'Var'];
					const hasHSLevel = hsLevelMarkers.some(marker => v.name.includes(marker));
					return !hasHSLevel;
				}
				
				// For teams without HS/JH designation, match level if specified
				if (levelVariants.length > 0) {
					return levelVariants.some(l => v.name.includes(l));
				}
				
				return true;
			});

			console.log(`[PLUGIN] Filtered ${videos.length} videos to ${teamVideos.length} for team ${teamData.teamName} (gender: ${genderVariants.join('/')}, level: ${levelVariants.join('/')}, sport: ${sport})`);
				const playlistRes = await fetch(`${baseUrl}/api/v1/video-playlists/${seasonData.playlistId}/videos?count=500`, {
					headers: { 'Authorization': `Bearer ${snifferOAuthToken}` }
				});


				// If playlist doesn't exist (404), clear the reference and auto-recreate
				if (playlistRes.status === 404) {
					console.log(`[PLUGIN] Playlist ${seasonData.playlistId} no longer exists for ${teamData.teamName}, recreating...`);

					// Clear the stale reference
					delete seasonData.playlistId;
					delete seasonData.playlistName;

					// Auto-create new playlist
					try {
						const { createPlaylist } = require('./lib-peertube-api.js');
						const { generatePlaylistTitle } = require('./lib-game-title.js');

						const orgData = (await storageManager.getData('hudl-organization')) || {};
						const schoolName = orgData.name || 'School';
						const scheduleData = hudlSchedules[teamId];

						const playlistDisplayName = generatePlaylistTitle(
							{ gender: scheduleData?.gender, teamLevel: scheduleData?.level, sport: scheduleData?.sport },
							schoolName,
							seasonYear
						) || `${teamData.teamName} ${seasonYear}-${parseInt(seasonYear) + 1}`;

						const nextYear = parseInt(seasonYear) + 1;
						const newPlaylist = await createPlaylist({
							channelId: teamData.channelId,
							displayName: playlistDisplayName,
							description: `${schoolName} ${scheduleData?.sport || 'team'} season ${seasonYear}-${nextYear}`,
							privacy: teamData.privacy !== undefined ? teamData.privacy : 1,
							oauthToken: snifferOAuthToken,
							peertubeHelpers,
							settingsManager
						});

						seasonData.playlistId = newPlaylist.playlistId;
						seasonData.playlistName = newPlaylist.displayName;
						hudlMappings[teamId] = teamData;
						await storageManager.storeData('hudl-mappings', hudlMappings);

						console.log(`[PLUGIN] Recreated playlist: ${newPlaylist.displayName} (ID: ${newPlaylist.playlistId})`);
					} catch (recreateErr) {
						results.push({
							team: teamData.teamName,
							status: 'error',
							reason: `Playlist deleted and failed to recreate: ${recreateErr.message}`
						});
						console.error(`[PLUGIN] Failed to recreate playlist for ${teamData.teamName}:`, recreateErr);
						continue;
					}
				}

				const playlistVideos = playlistRes.ok ? (await playlistRes.json()).data : [];
				const playlistVideoIds = new Set(playlistVideos.map(v => v.video.id));

				// Find replays not in playlist
				// Replays: not live, not the permanent live video itself, created this season
				// Use July 1st of season year as cutoff (e.g., July 1 2025 for 2025-2026 season)
				const seasonStart = new Date(seasonYear, 6, 1); // Month 6 = July (0-indexed)
				const replays = teamVideos.filter(v =>
					!v.isLive &&
					v.id !== teamData.permanentLiveVideoId &&
					new Date(v.createdAt) >= seasonStart &&
					!playlistVideoIds.has(v.id)
				);

				const addedReplays = [];

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
						addedReplays.push(replay.name);
						console.log(`[PLUGIN] Added replay to playlist: ${replay.name} → ${teamData.teamName} ${seasonYear}`);
					} catch (err) {
						console.error(`[PLUGIN] Failed to add replay ${replay.id} to playlist:`, err.message);
					}
				}

				results.push({
					team: teamData.teamName,
					status: 'success',
					replaysFound: replays.length,
					replaysAdded: addedReplays.length,
					addedVideos: addedReplays
				});

			} catch (err) {
				results.push({
					team: teamData.teamName,
					status: 'error',
					reason: err.message
				});
				console.error(`[PLUGIN] Error syncing replays for ${teamData.teamName}:`, err);
			}
		}

		console.log(`[PLUGIN] Replay sync complete: checked ${teamsChecked} teams, added ${replaysAdded} replays to playlists`);

		return {
			teamsChecked,
			replaysAdded,
			results
		};

	} catch (err) {
		console.error('[PLUGIN] Error in syncReplaysToPlaylists:', err);
		throw err;
	}
}

// Reset all permanent live titles to generic format
async function resetPermanentLiveTitles({ storageManager, peertubeHelpers, settingsManager }) {
	try {
		console.log('[PLUGIN] Starting permanent live title reset...');

		const hudlMappings = (await storageManager.getData('hudl-mappings')) || {};
		const sniffers = (await storageManager.getData('sniffers')) || {};
		const { updateVideoMetadata } = require('./lib-peertube-api.js');

		let titlesReset = 0;

		for (const teamId in hudlMappings) {
			const teamData = hudlMappings[teamId];

			// Skip if no permanent live
			if (!teamData.permanentLiveVideoId || !teamData.teamName) {
				continue;
			}

			// Find OAuth token for the team owner's username
			let snifferOAuthToken = null;
			const ownerUsername = teamData.ownerUsername;

			if (!ownerUsername) {
				console.log(`[PLUGIN] No owner username for team ${teamData.teamName}`);
				continue;
			}

			// Find any sniffer authenticated as this user
			for (const snifferId in sniffers) {
				if (sniffers[snifferId]?.peertubeUsername === ownerUsername) {
					snifferOAuthToken = sniffers[snifferId]?.oauthToken;
					break;
				}
			}

			if (!snifferOAuthToken) {
				console.log(`[PLUGIN] No OAuth token found for user ${ownerUsername} (team ${teamData.teamName})`);
				continue;
			}

			try {
				const genericTitle = `${teamData.teamName} - Wait Live`;
				await updateVideoMetadata({
					videoId: teamData.permanentLiveVideoId,
					updates: { name: genericTitle },
					oauthToken: snifferOAuthToken,
					peertubeHelpers,
					settingsManager
				});

				titlesReset++;
				console.log(`[PLUGIN] Reset permanent live title: ${teamData.teamName}`);
			} catch (err) {
				console.error(`[PLUGIN] Failed to reset title for ${teamData.teamName}:`, err.message);
			}
		}

		console.log(`[PLUGIN] Permanent live title reset complete: ${titlesReset} titles reset`);

		return {
			titlesReset
		};

	} catch (err) {
		console.error('[PLUGIN] Error in resetPermanentLiveTitles:', err);
		throw err;
	}
}

module.exports = {
	syncReplaysToPlaylists,
	resetPermanentLiveTitles
};
