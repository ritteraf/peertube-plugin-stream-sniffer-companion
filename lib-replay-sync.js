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

			       // Skip if no seasons
			       if (!teamData.seasons) {
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
					{ gender: scheduleData?.gender, teamLevel: scheduleData?.teamLevel, sport: scheduleData?.sport },
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

				// STRICT: Require all three HUDL metadata fields
				if (!scheduleData?.gender || !scheduleData?.teamLevel || !scheduleData?.sport) {
					results.push({
						team: teamData.teamName,
						status: 'error',
						reason: `Missing HUDL metadata (gender: ${scheduleData?.gender}, level: ${scheduleData?.teamLevel}, sport: ${scheduleData?.sport})`
					});
					console.error(`[PLUGIN] Missing HUDL metadata for team ${teamData.teamName}, skipping playlist sync`);
					continue;
				}

				// Build gender variants (we use "Mens"/"Womens" but tags use "Boys"/"Girls")
				const genderVariants = [];
				if (scheduleData.gender === 'MENS') {
					genderVariants.push('Mens', 'Boys', 'Men');
				} else if (scheduleData.gender === 'WOMENS') {
					genderVariants.push('Womens', 'Girls', 'Women');
				} else if (scheduleData.gender === 'COED') {
					genderVariants.push('Coed');
				}

				// Build level variants
				const levelVariants = [];
				if (scheduleData.teamLevel === 'VARSITY') {
					levelVariants.push('Varsity', 'Var');
				} else if (scheduleData.teamLevel === 'JUNIOR_VARSITY') {
					levelVariants.push('JV', 'Junior Varsity', 'J.V.');
				} else if (scheduleData.teamLevel === 'FRESHMAN') {
					levelVariants.push('Freshman', 'Fresh', 'Frosh');
				}

				// Sport name (handle multi-word sports)
				const sport = scheduleData.sport.charAt(0) + scheduleData.sport.slice(1).toLowerCase().replace(/_/g, ' ');

				const teamVideos = videos.filter(v => {
					// Primary: Check if video has team name tag
					if (v.tags && v.tags.includes(teamData.teamName)) {
						return true;
					}

					// Fallback: Check if video title OR tags contain HUDL metadata (gender + level + sport)
					if (!v.name) return false;

					const videoText = v.name + ' ' + (v.tags ? v.tags.join(' ') : '');

					// Helper: Match with word boundaries to avoid false positives (e.g., "Varsity" shouldn't match "Junior Varsity")
					const matchesVariant = (text, variants) => {
						return variants.some(variant => {
							// Escape special regex characters and use word boundaries
							const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
							const regex = new RegExp(`\\b${escaped}\\b`, 'i');
							return regex.test(text);
						});
					};

					// STRICT: Must match gender (at least one variant with word boundaries)
					const hasGender = matchesVariant(videoText, genderVariants);
					if (!hasGender) return false;

					// STRICT: Must match level (at least one variant with word boundaries)
					const hasLevel = matchesVariant(videoText, levelVariants);
					if (!hasLevel) return false;

					// STRICT: Must match sport (with word boundaries)
					const hasSport = matchesVariant(videoText, [sport]);
					if (!hasSport) return false;

					return true;
				});


				console.log(`[PLUGIN] Filtered ${videos.length} videos to ${teamVideos.length} for team ${teamData.teamName} (gender: ${genderVariants.join('/')}, level: ${levelVariants.join('/')}, sport: ${sport})`);
				// Fetch all videos in the playlist using pagination (count=100, start=offset)
				let playlistVideos = [];
				let start = 0;
				const count = 100;
				let playlistFetchOk = true;
				while (playlistFetchOk) {
					const playlistRes = await fetch(`${baseUrl}/api/v1/video-playlists/${seasonData.playlistId}/videos?count=${count}&start=${start}`, {
						headers: { 'Authorization': `Bearer ${snifferOAuthToken}` }
					});
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
								{ gender: scheduleData?.gender, teamLevel: scheduleData?.teamLevel, sport: scheduleData?.sport },
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
							playlistFetchOk = false;
							break;
						}
						playlistFetchOk = false;
						break;
					}
					if (!playlistRes.ok) {
						playlistFetchOk = false;
						break;
					}
					const json = await playlistRes.json();
					const batch = json.data || [];
					playlistVideos = playlistVideos.concat(batch);
					if (batch.length < count) {
						playlistFetchOk = false;
						break;
					}
					start += count;
				}
				const playlistVideoIds = new Set(playlistVideos.map(v => v.video.id));

				// Find replays not in playlist
				// Replays: not live, not the permanent live video itself, created this season
				// Use July 1st of season year as cutoff (e.g., July 1 2025 for 2025-2026 season)
				const seasonStart = new Date(seasonYear, 6, 1); // Month 6 = July (0-indexed)
				const replays = teamVideos.filter(v => {
					// Use originallyPublishedAt if present, else publishedAt
					const dateStr = v.originallyPublishedAt || v.publishedAt;
					if (!dateStr) return false;
					const publishedDate = new Date(dateStr);
					if (isNaN(publishedDate.getTime())) return false;
					return (
						!v.isLive &&
						v.id !== teamData.permanentLiveVideoId &&
						publishedDate >= seasonStart &&
						!playlistVideoIds.has(v.id)
					);
				});

				// Scrimmage logic: If a video is a scrimmage, add to both Varsity and JV playlists for same sport/gender
				const isScrimmage = (video) => {
					const text = (video.name || '') + ' ' + (video.tags ? video.tags.join(' ') : '');
					return /\b(scrim|scrimmage)\b/i.test(text);
				};

				const sameSportGenderTeams = Object.entries(hudlMappings)
					.filter(([otherId, otherData]) =>
						otherData.sport === teamData.sport &&
						otherData.gender === teamData.gender &&
						['VARSITY', 'JUNIOR_VARSITY'].includes(otherData.teamLevel)
					)
					.map(([otherId]) => otherId);

				// For scrimmage videos, add to both Varsity and JV playlists for same sport/gender
				for (const replay of replays) {
					if (isScrimmage(replay)) {
						for (const otherTeamId of sameSportGenderTeams) {
							const otherTeamData = hudlMappings[otherTeamId];
							const otherSeasonData = otherTeamData.seasons?.[seasonYear];
							if (otherSeasonData && otherSeasonData.playlistId) {
								try {
									await addVideoToPlaylist({
										playlistId: otherSeasonData.playlistId,
										videoId: replay.id,
										oauthToken: snifferOAuthToken,
										peertubeHelpers,
										settingsManager
									});
									console.log(`[PLUGIN] Added scrimmage replay to playlist: ${replay.name} → ${otherTeamData.teamName} ${seasonYear}`);
								} catch (err) {
									console.error(`[PLUGIN] Failed to add scrimmage replay ${replay.id} to playlist for ${otherTeamData.teamName}:`, err.message);
								}
							}
						}
					}
				}

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


// Utility: Normalize gender, team level, and school names for imported YouTube videos
function normalizeImportedMetadata({ gender, teamLevel, schoolName }) {
	// Gender normalization
	let normGender = gender;
	if (/girls?/i.test(gender)) normGender = 'WOMENS';
	else if (/boys?/i.test(gender)) normGender = 'MENS';
	else if (/womens?/i.test(gender)) normGender = 'WOMENS';
	else if (/mens?/i.test(gender)) normGender = 'MENS';

	// Team level normalization
	let normLevel = teamLevel;
	if (/freshmen/i.test(teamLevel)) normLevel = 'JV';
	else if (/varsity/i.test(teamLevel)) normLevel = 'VARSITY';
	else if (/jv/i.test(teamLevel)) normLevel = 'JV';

	// School name normalization
	let normSchool = schoolName;
	if (/elkhorn valley|evs|ev/i.test(schoolName)) normSchool = 'Elkhorn Valley';

	return { gender: normGender, teamLevel: normLevel, schoolName: normSchool };
}

/**
 * Back-create playlists for all historical seasons for each team, and attempt to assign imported videos.
 * @param {Object} opts - { storageManager, peertubeHelpers, settingsManager }
 */
async function backCreateHistoricalPlaylists({ storageManager, peertubeHelpers, settingsManager }) {
	console.log('[PLUGIN] Starting back-creation of historical playlists...');
	const hudlMappings = (await storageManager.getData('hudl-mappings')) || {};
	const hudlSchedules = (await storageManager.getData('hudl-schedules')) || {};
	const sniffers = (await storageManager.getData('sniffers')) || {};
	const { createPlaylist, addVideoToPlaylist } = require('./lib-peertube-api.js');
	const { generatePlaylistTitle } = require('./lib-game-title.js');

	let playlistsCreated = 0;
	let videosAssigned = 0;
	const results = [];

	const { updateVideoMetadata } = require('./lib-peertube-api.js');
	const { generateGameTitle } = require('./lib-game-title.js');
	const hudl = require('./lib-hudl-scraper.js');
	for (const teamId in hudlMappings) {
		const teamData = hudlMappings[teamId];
		const ownerUsername = teamData.ownerUsername;
		if (!ownerUsername) continue;
		let snifferOAuthToken = null;
		for (const snifferId in sniffers) {
			if (sniffers[snifferId]?.peertubeUsername === ownerUsername) {
				snifferOAuthToken = sniffers[snifferId]?.oauthToken;
				break;
			}
		}
		if (!snifferOAuthToken) continue;

		// Find all historical seasons for this team (from HUDL data)
		const teamSeasons = teamData.seasons ? Object.keys(teamData.seasons) : [];
		for (const seasonYear of teamSeasons) {
			let seasonData = teamData.seasons[seasonYear];
			// Fetch HUDL schedule for this team/season
			let games = [];
			try {
				games = await hudl.fetchTeamSchedule(teamId, null, seasonData?.seasonId || null);
			} catch (err) {
				console.error(`[PLUGIN] Failed to fetch HUDL schedule for team ${teamData.teamName} season ${seasonYear}:`, err.message);
				continue;
			}
			// Fetch all videos for the channel using pagination (count=100, start=offset)
			const baseUrl = await peertubeHelpers.config.getWebserverUrl();
			const channelHandle = teamData.channelHandle;
			if (!channelHandle) continue;
			let videos = [];
			let start = 0;
			const count = 100;
			try {
				while (true) {
					const res = await fetch(`${baseUrl}/api/v1/video-channels/${encodeURIComponent(channelHandle)}/videos?count=${count}&start=${start}`, {
						headers: { 'Authorization': `Bearer ${snifferOAuthToken}` }
					});
					if (!res.ok) break;
					const json = await res.json();
					const batch = json.data || [];
					videos = videos.concat(batch);
					if (batch.length < count) break; // last page
					start += count;
				}
			} catch (err) {
				console.error(`[PLUGIN] Failed to fetch videos for channel ${channelHandle}:`, err.message);
				continue;
			}
			// For each HUDL game, match videos by date
			let foundMatch = false;
			for (const game of games) {
				const gameDate = game.timeUtc ? new Date(game.timeUtc).toISOString().slice(0, 10) : null;
				if (!gameDate) continue;
				// Find all videos with originalPublicationDate matching game date
				const matchedVideos = videos.filter(v => {
					if (!v.originalPublicationDate) return false;
					const videoDate = new Date(v.originalPublicationDate).toISOString().slice(0, 10);
					return videoDate === gameDate;
				});
				if (matchedVideos.length === 0) continue;
				foundMatch = true;
				// Helper to parse level from video title
				const parseLevelFromTitle = (title) => {
					if (!title) return null;
					const lower = title.toLowerCase();
					if (/\bjv\b|junior varsity|j\.v\./i.test(lower)) return 'JUNIOR_VARSITY';
					if (/\bvarsity\b|var\b/i.test(lower)) return 'VARSITY';
					if (/\bfreshman\b|fresh\b|frosh\b/i.test(lower)) return 'FRESHMAN';
					return null;
				};
				let part = 1;
				for (const video of matchedVideos) {
					const parsedLevel = parseLevelFromTitle(video.name);
					// If level is parsed, only add to matching team; if not, add to both (handled by running for each team)
					if (parsedLevel && parsedLevel !== teamData.teamLevel) {
						continue; // skip, this video is for another level
					}
					try {
						// Create playlist if not already created
						if (!seasonData || !seasonData.playlistId) {
							const orgData = (await storageManager.getData('hudl-organization')) || {};
							const schoolName = orgData.name || 'School';
							const scheduleData = hudlSchedules[teamId] || {};
							const playlistDisplayName = generatePlaylistTitle(
								{ gender: scheduleData.gender || teamData.gender || '', teamLevel: scheduleData.teamLevel || teamData.teamLevel || '', sport: scheduleData.sport || teamData.sport },
								schoolName,
								seasonYear
							) || `${teamData.teamName} ${seasonYear}-${parseInt(seasonYear) + 1}`;
							const nextYear = parseInt(seasonYear) + 1;
							const newPlaylist = await createPlaylist({
								channelId: teamData.channelId,
								displayName: playlistDisplayName,
								description: `${schoolName} ${scheduleData.sport || teamData.sport || 'team'} season ${seasonYear}-${nextYear}`,
								privacy: teamData.privacy !== undefined ? teamData.privacy : 1,
								oauthToken: snifferOAuthToken,
								peertubeHelpers,
								settingsManager
							});
							if (!teamData.seasons) teamData.seasons = {};
							teamData.seasons[seasonYear] = {
								seasonYear: seasonYear,
								playlistId: newPlaylist.playlistId,
								playlistName: newPlaylist.displayName,
								createdByUser: ownerUsername
							};
							hudlMappings[teamId] = teamData;
							await storageManager.storeData('hudl-mappings', hudlMappings);
							playlistsCreated++;
							seasonData = teamData.seasons[seasonYear];
							console.log(`[PLUGIN] Back-created playlist ${newPlaylist.displayName} (ID: ${newPlaylist.playlistId})`);
						}
						await addVideoToPlaylist({
							playlistId: seasonData.playlistId,
							videoId: video.id,
							oauthToken: snifferOAuthToken,
							peertubeHelpers,
							settingsManager
						});
						videosAssigned++;
						// Generate standardized title
						let newTitle = generateGameTitle(game, teamData, (hudlSchedules[teamId]?.schoolName || ''));
						if (matchedVideos.length > 1) newTitle += ` (Part ${part})`;
						// Update video title if needed
						if (video.name !== newTitle) {
							// Add old name to description if not already present
							let newDescription = video.description || '';
							const oldNameTag = `\n[Original title: ${video.name}]`;
							if (!newDescription.includes(`[Original title:`)) {
								newDescription += oldNameTag;
							}
							await updateVideoMetadata({
								videoId: video.id,
								updates: { name: newTitle, description: newDescription },
								oauthToken: snifferOAuthToken,
								peertubeHelpers,
								settingsManager
							});
							console.log(`[PLUGIN] Updated video title: ${video.name} → ${newTitle} (old name preserved in description)`);
						}
						part++;
					} catch (err) {
						console.error(`[PLUGIN] Failed to add/update video ${video.id} for game on ${gameDate}:`, err.message);
					}
				}
			}
			// If no match was found, do not create a playlist
		}
	}
	console.log(`[PLUGIN] Back-creation complete: ${playlistsCreated} playlists created, ${videosAssigned} videos assigned/updated`);
	return { playlistsCreated, videosAssigned };
}

module.exports = {
	syncReplaysToPlaylists,
	resetPermanentLiveTitles,
	backCreateHistoricalPlaylists
};
