// Shared replay-to-playlist sync logic

async function syncReplaysToPlaylists({ storageManager, peertubeHelpers, settingsManager }) {
	try {
		console.log('[PLUGIN] Starting replay-to-playlist sync...');
		
		const hudlMappings = (await storageManager.getData('hudl-mappings')) || {};
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
			
			// Get current season's playlist using the team's season year (not calendar year)
			// This handles multi-year seasons like Basketball 2025-2026
			const seasonYear = teamData.currentSeasonYear || new Date().getFullYear();
			const seasonData = teamData.seasons[seasonYear];
			
			if (!seasonData || !seasonData.playlistId) {
				results.push({
					team: teamData.teamName,
					status: 'skipped',
					reason: `No playlist for season ${seasonYear}`
				});
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
				results.push({
					team: teamData.teamName,
					status: 'error',
					reason: 'No OAuth token found'
				});
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
					results.push({
						team: teamData.teamName,
						status: 'error',
						reason: `Failed to fetch videos: ${res.status}`
					});
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
				// Use July 1st of season year as cutoff (e.g., July 1 2025 for 2025-2026 season)
				const seasonStart = new Date(seasonYear, 6, 1); // Month 6 = July (0-indexed)
				const replays = videos.filter(v => 
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
