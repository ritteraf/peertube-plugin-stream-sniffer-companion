// Authenticate with PeerTube and get an access token
let cachedClientCreds = null;
async function getPeerTubeClientCreds(baseUrl) {
	if (cachedClientCreds) return cachedClientCreds;
	const res = await fetch(`${baseUrl}/api/v1/oauth-clients/local`);
	if (!res.ok) throw new Error(`Failed to fetch OAuth client credentials: ${res.status} ${await res.text()}`);
	const data = await res.json();
	if (!data.client_id || !data.client_secret) throw new Error('OAuth client_id or client_secret missing in response');
	cachedClientCreds = { client_id: data.client_id, client_secret: data.client_secret };
	return cachedClientCreds;
}

async function getPeerTubeToken({ username, password, peertubeHelpers, settingsManager }) {
	const baseUrl = await getBaseUrl(peertubeHelpers, settingsManager);
	const { client_id, client_secret } = await getPeerTubeClientCreds(baseUrl);
	const params = new URLSearchParams();
	params.append('client_id', client_id);
	params.append('client_secret', client_secret);
	params.append('grant_type', 'password');
	params.append('response_type', 'code');
	params.append('username', username);
	params.append('password', password);
	const res = await fetch(`${baseUrl}/api/v1/users/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: params.toString()
	});
	if (!res.ok) throw new Error(`Failed to authenticate with PeerTube: ${res.status} ${await res.text()}`);
	const data = await res.json();
	return data.access_token;
}




const fetch = require('node-fetch');

// Helper to get the PeerTube base URL dynamically
// Accepts peertubeHelpers, settingsManager (optional), and fallback env
async function getBaseUrl(peertubeHelpers, settingsManager) {
	if (peertubeHelpers && peertubeHelpers.config && typeof peertubeHelpers.config.getWebserverUrl === 'function') {
		try {
			const url = peertubeHelpers.config.getWebserverUrl();
			if (!url) {
				console.warn('[PLUGIN] getWebserverUrl returned empty value');
			}
			if (url) return url;
		} catch (e) {
			console.error('[PLUGIN] Error in getWebserverUrl:', e);
		}
	} else {
		console.warn('[PLUGIN] peertubeHelpers.config.getWebserverUrl not available');
	}

	// Fallback: try plugin setting
	if (settingsManager && typeof settingsManager.getSetting === 'function') {
		try {
			const url = await settingsManager.getSetting('peertube-base-url');
			if (!url) {
				console.warn('[PLUGIN] settingsManager.getSetting("peertube-base-url") returned empty value');
			}
			if (url) return url;
		} catch (e) {
			console.error('[PLUGIN] Error in settingsManager.getSetting("peertube-base-url"):', e);
		}
	} else {
		console.warn('[PLUGIN] settingsManager.getSetting not available');
	}

	// Fallback: environment variable
	if (process.env.PEERTUBE_BASE_URL) {
		if (!process.env.PEERTUBE_BASE_URL) {
			console.warn('[PLUGIN] process.env.PEERTUBE_BASE_URL is empty');
		}
		return process.env.PEERTUBE_BASE_URL;
	}
	console.error('[PLUGIN] Cannot determine PeerTube base URL: no helper, setting, or env PEERTUBE_BASE_URL');
	throw new Error('Cannot determine PeerTube base URL: no helper, setting, or env PEERTUBE_BASE_URL');
}



// Fetch user's channels using server privileges (no OAuth needed)
async function getPeerTubeChannels({ username, peertubeHelpers, settingsManager }) {
	const baseUrl = await getBaseUrl(peertubeHelpers, settingsManager);
	const channelsRes = await fetch(`${baseUrl}/api/v1/accounts/${username}/video-channels`);
	if (!channelsRes.ok) {
		throw new Error(`Failed to fetch channels: ${channelsRes.status}`);
	}
	const channelsData = await channelsRes.json();
	return { username, channels: channelsData.data || [] };
}


// Fetch categories (no OAuth needed)
async function getPeerTubeCategories({ peertubeHelpers, settingsManager }) {
	const baseUrl = await getBaseUrl(peertubeHelpers, settingsManager);
	const res = await fetch(`${baseUrl}/api/v1/videos/categories`);
	if (!res.ok) throw new Error(`Failed to fetch categories: ${res.status}`);
	const data = await res.json();
	return data.data || [];
}

// Fetch privacy options (no OAuth needed)
async function getPeerTubePrivacyOptions({ peertubeHelpers, settingsManager }) {
	const baseUrl = await getBaseUrl(peertubeHelpers, settingsManager);
	const res = await fetch(`${baseUrl}/api/v1/videos/privacies`);
	if (!res.ok) throw new Error(`Failed to fetch privacy options: ${res.status}`);
	const data = await res.json();
	return data.data || [];
}


// Helper: Check if a video exists
async function checkVideoExists(videoId, oauthToken, peertubeHelpers, settingsManager, snifferId = null, storageManager = null) {
	const baseUrl = await getBaseUrl(peertubeHelpers, settingsManager);
	let res = await fetch(`${baseUrl}/api/v1/videos/${videoId}`, {
		headers: { 'Authorization': `Bearer ${oauthToken}` }
	});
	if (res.status === 401 && snifferId && storageManager) {
		// Automatically refresh PeerTube OAuth token
		peertubeHelpers.logger.info(`[checkVideoExists] PeerTube OAuth token expired for sniffer ${snifferId}, refreshing automatically...`);
		const sniffers = (await storageManager.getData('sniffers')) || {};
		const snifferEntry = sniffers[snifferId];
		if (snifferEntry && snifferEntry.peertubeUsername && snifferEntry.peertubePassword) {
			try {
				const { decrypt } = require('./lib/secure-store.js');
				const password = typeof snifferEntry.peertubePassword === 'string' ? snifferEntry.peertubePassword : '';
				const decryptedPassword = decrypt(password);
				const newToken = await getPeerTubeToken({
					username: snifferEntry.peertubeUsername,
					password: decryptedPassword,
					peertubeHelpers,
					settingsManager
				});
				snifferEntry.oauthToken = newToken;
				sniffers[snifferId] = snifferEntry;
				await storageManager.storeData('sniffers', sniffers);
				peertubeHelpers.logger.info(`[checkVideoExists] PeerTube OAuth token refreshed successfully for sniffer ${snifferId}`);
				// Retry with new token
				res = await fetch(`${baseUrl}/api/v1/videos/${videoId}`, {
					headers: { 'Authorization': `Bearer ${newToken}` }
				});
			} catch (decryptErr) {
				peertubeHelpers.logger.error(`[checkVideoExists] Failed to decrypt stored credentials for sniffer ${snifferId}: ${decryptErr.message}`);
				const error = new Error('REAUTH_REQUIRED: Stored credentials cannot be decrypted');
				error.code = 'REAUTH_REQUIRED';
				throw error;
			}
		}
	}
	return res.status === 200;
}

// Helper: Get video title
async function getVideoTitle(videoId, oauthToken, peertubeHelpers, settingsManager, snifferId = null, storageManager = null) {
	const baseUrl = await getBaseUrl(peertubeHelpers, settingsManager);
	let res = await fetch(`${baseUrl}/api/v1/videos/${videoId}`, {
		headers: { 'Authorization': `Bearer ${oauthToken}` }
	});
	if (res.status === 401 && snifferId && storageManager) {
		// Automatically refresh PeerTube OAuth token
		peertubeHelpers.logger.info(`[getVideoTitle] PeerTube OAuth token expired for sniffer ${snifferId}, refreshing automatically...`);
		const sniffers = (await storageManager.getData('sniffers')) || {};
		const snifferEntry = sniffers[snifferId];
		if (snifferEntry && snifferEntry.peertubeUsername && snifferEntry.peertubePassword) {
			try {
				const { decrypt } = require('./lib/secure-store.js');
				const password = typeof snifferEntry.peertubePassword === 'string' ? snifferEntry.peertubePassword : '';
				const decryptedPassword = decrypt(password);
				const newToken = await getPeerTubeToken({
					username: snifferEntry.peertubeUsername,
					password: decryptedPassword,
					peertubeHelpers,
					settingsManager
				});
				snifferEntry.oauthToken = newToken;
				sniffers[snifferId] = snifferEntry;
				await storageManager.storeData('sniffers', sniffers);
				peertubeHelpers.logger.info(`[getVideoTitle] PeerTube OAuth token refreshed successfully for sniffer ${snifferId}`);
				// Retry with new token
				res = await fetch(`${baseUrl}/api/v1/videos/${videoId}`, {
					headers: { 'Authorization': `Bearer ${newToken}` }
				});
			} catch (decryptErr) {
				peertubeHelpers.logger.error(`[getVideoTitle] Failed to decrypt stored credentials for sniffer ${snifferId}: ${decryptErr.message}`);
				const error = new Error('REAUTH_REQUIRED: Stored credentials cannot be decrypted');
				error.code = 'REAUTH_REQUIRED';
				throw error;
			}
		}
	}
	if (!res.ok) throw new Error(`Failed to fetch video title: ${res.status}`);
	const data = await res.json();
	return data.name;
}

// Helper: Parse tags from HUDL team data
// gender: "MENS", "WOMENS", "COED", or null
// teamLevel: "VARSITY", "JUNIOR_VARSITY", "FRESHMAN", "OTHER", or null
function parseTeamTags(gender, teamLevel, sport) {
	const tags = [];

	// Gender tags: use HUDL values, but capitalize for tags
	if (gender === 'MENS') tags.push('Mens');
	else if (gender === 'WOMENS') tags.push('Womens');
	else if (gender === 'COED') tags.push('Coed');

	// Level tags (match sniffer's displayLevel conversion)
	if (teamLevel === 'VARSITY') tags.push('Varsity');
	else if (teamLevel === 'JUNIOR_VARSITY') tags.push('Junior Varsity');
	else if (teamLevel === 'FRESHMAN') tags.push('Freshman');
	// Skip "OTHER" - team name usually contains level

	// Add sport as a tag (capitalize first letter, rest lowercase)
	if (sport && typeof sport === 'string') {
		// Convert e.g. "BASKETBALL" to "Basketball"
		tags.push(sport.charAt(0).toUpperCase() + sport.slice(1).toLowerCase());
	}

	return tags;
}

// Helper: Combine system tags and user tags, enforcing PeerTube's 5-tag limit (system tags first)
function buildVideoTags({ gender, teamLevel, sport, customTags }) {
	const systemTags = parseTeamTags(gender, teamLevel, sport);
	let tags = [...systemTags];
	if (Array.isArray(customTags) && customTags.length > 0) {
		// Only add as many custom tags as will fit (max 5 total)
		tags = tags.concat(customTags.slice(0, 5 - tags.length));
	}
	return tags.slice(0, 5);
}

// Helper: Create PeerTube live video
// Note: PeerTube licence IDs: 1=Attribution, 2=Attribution-ShareAlike, 3=Attribution-NoDerivs,
//       4=Attribution-NonCommercial, 5=Attribution-NonCommercial-ShareAlike,
//       6=Attribution-NonCommercial-NoDerivs, 7=Public Domain Dedication
async function createPeerTubeLiveVideo({ channelId, name, description, category, privacy, tags, language, licence, commentsEnabled, downloadEnabled, oauthToken, peertubeHelpers, settingsManager, snifferId = null, storageManager = null, thumbnailPath = null }) {
	const fs = require('fs');
	const FormData = require('form-data');
	const baseUrl = await getBaseUrl(peertubeHelpers, settingsManager);
	const form = new FormData();

	// Required fields
	form.append('channelId', channelId);
	form.append('name', name);
	form.append('permanentLive', 'true');
	form.append('saveReplay', 'true');

	// Set replay privacy to match the live video privacy (or default to public if not specified)
	const replayPrivacy = privacy !== undefined ? privacy : 1; // 1 = Public
	form.append('replaySettings[privacy]', replayPrivacy);

	// Optional metadata fields
	if (description) form.append('description', description);
	if (category !== undefined) form.append('category', category);
	if (privacy !== undefined) form.append('privacy', privacy);
	if (tags && Array.isArray(tags) && tags.length > 0) {
		tags.forEach(tag => form.append('tags[]', tag));
	}
	if (language) form.append('language', language);
	if (licence !== undefined) form.append('licence', licence);
	if (commentsEnabled !== undefined) form.append('commentsEnabled', commentsEnabled);
	if (downloadEnabled !== undefined) form.append('downloadEnabled', downloadEnabled);

	// Add thumbnail if provided and exists
	if (thumbnailPath && typeof thumbnailPath === 'string' && thumbnailPath.length > 0) {
		if (fs.existsSync(thumbnailPath)) {
			form.append('thumbnailfile', fs.createReadStream(thumbnailPath));
			console.log(`[PLUGIN] Including thumbnail in live video creation: ${thumbnailPath}`);
		} else {
			console.warn(`[PLUGIN] Thumbnail file not found at path: ${thumbnailPath}`);
		}
	}

	let res = await fetch(`${baseUrl}/api/v1/videos/live`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${oauthToken}`,
			...form.getHeaders()
		},
		body: form
	});
	if (res.status === 401 && snifferId && storageManager) {
		// Automatically refresh PeerTube OAuth token
		peertubeHelpers.logger.info(`[createPeerTubeLiveVideo] PeerTube OAuth token expired for sniffer ${snifferId}, refreshing automatically...`);
		const sniffers = (await storageManager.getData('sniffers')) || {};
		const snifferEntry = sniffers[snifferId];
		if (snifferEntry && snifferEntry.peertubeUsername && snifferEntry.peertubePassword) {
			try {
				const { decrypt } = require('./lib/secure-store.js');
				const password = typeof snifferEntry.peertubePassword === 'string' ? snifferEntry.peertubePassword : '';
				const decryptedPassword = decrypt(password);
				const newToken = await getPeerTubeToken({
					username: snifferEntry.peertubeUsername,
					password: decryptedPassword,
					peertubeHelpers,
					settingsManager
				});
				snifferEntry.oauthToken = newToken;
				sniffers[snifferId] = snifferEntry;
				await storageManager.storeData('sniffers', sniffers);
				peertubeHelpers.logger.info(`[createPeerTubeLiveVideo] PeerTube OAuth token refreshed successfully for sniffer ${snifferId}`);
				// Retry with new token - rebuild FormData with new token
				const retryForm = new FormData();
				retryForm.append('name', body.name);
				retryForm.append('channelId', body.channelId);
				retryForm.append('privacy', body.privacy);
				retryForm.append('category', body.category);
				if (body.language) retryForm.append('language', body.language);
				if (body.description) retryForm.append('description', body.description);
				if (body.tags && Array.isArray(body.tags)) {
					body.tags.forEach(tag => retryForm.append('tags[]', tag));
				}
				retryForm.append('permanentLive', body.permanentLive);
				retryForm.append('saveReplay', body.saveReplay); const replayPrivacy = privacy !== undefined ? privacy : 1;
				retryForm.append('replaySettings[privacy]', replayPrivacy); if (thumbnailPath) {
					const fs = require('fs');
					if (fs.existsSync(thumbnailPath)) {
						retryForm.append('thumbnailfile', fs.createReadStream(thumbnailPath));
					}
				}
				res = await fetch(`${baseUrl}/api/v1/videos/live`, {
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${newToken}`,
						...retryForm.getHeaders()
					},
					body: retryForm
				});
			} catch (decryptErr) {
				peertubeHelpers.logger.error(`[createPeerTubeLiveVideo] Failed to decrypt stored credentials for sniffer ${snifferId}: ${decryptErr.message}`);
				const error = new Error('REAUTH_REQUIRED: Stored credentials cannot be decrypted');
				error.code = 'REAUTH_REQUIRED';
				throw error;
			}
		}
	}
	if (!res.ok) throw new Error(`Failed to create permanent live: ${res.status} ${await res.text()}`);
	const data = await res.json();

	// If token was refreshed, use the new one for subsequent calls
	let currentToken = oauthToken;
	if (res.status === 200 && snifferId && storageManager) {
		const sniffers = (await storageManager.getData('sniffers')) || {};
		const snifferEntry = sniffers[snifferId];
		if (snifferEntry && snifferEntry.oauthToken) {
			currentToken = snifferEntry.oauthToken;
		}
	}

	// Fetch live stream details to get RTMP credentials
	const liveDetailsRes = await fetch(`${baseUrl}/api/v1/videos/live/${data.video.id}`, {
		headers: { 'Authorization': `Bearer ${currentToken}` }
	});
	if (!liveDetailsRes.ok) throw new Error(`Failed to fetch live stream details: ${liveDetailsRes.status} ${await liveDetailsRes.text()}`);
	const liveDetails = await liveDetailsRes.json();

	// Fetch video details to get the video name/title
	const videoDetailsRes = await fetch(`${baseUrl}/api/v1/videos/${data.video.id}`, {
		headers: { 'Authorization': `Bearer ${currentToken}` }
	});
	let videoName = 'Live Stream';
	if (videoDetailsRes.ok) {
		const videoDetails = await videoDetailsRes.json();
		videoName = videoDetails.name || videoName;
	}

	return {
		id: data.video.id,
		name: videoName,
		rtmpUrl: liveDetails.rtmpUrl,
		streamKey: liveDetails.streamKey
	};
}// Helper: Update camera assignment in storage
async function updateCameraAssignment(snifferId, cameraId, updates, storageManager) {
	if (!storageManager) throw new Error('storageManager not initialized');
	const cameras = (await storageManager.getData('camera-assignments')) || {};
	if (!cameras[snifferId] || !cameras[snifferId][cameraId]) throw new Error('Camera assignment not found');
	cameras[snifferId][cameraId] = {
		...cameras[snifferId][cameraId],
		...updates
	};
	await storageManager.storeData('camera-assignments', cameras);
}

// Main function: getOrCreatePermanentLiveStream (now team-based)
async function getOrCreatePermanentLiveStream(snifferId, teamId, teamSettings, peertubeOAuthToken, peertubeHelpers, settingsManager, storageManager) {
	try {
		// STEP 1: Check if permanent live already exists for this team
		if (teamSettings.permanentLiveVideoId) {
			const exists = await checkVideoExists(teamSettings.permanentLiveVideoId, peertubeOAuthToken, peertubeHelpers, settingsManager, snifferId, storageManager);
			if (exists) {
				// Get current title
				const videoTitle = await getVideoTitle(teamSettings.permanentLiveVideoId, peertubeOAuthToken, peertubeHelpers, settingsManager, snifferId, storageManager);

				// Update video metadata and thumbnail using multipart/form-data
				const thumbnailPath = teamSettings.thumbnailPath;
				const hasThumbnail = typeof thumbnailPath === 'string' && thumbnailPath.length > 0;
				const hasMetadata = teamSettings.streamTitle ||
					teamSettings.streamDescription !== undefined ||
					teamSettings.category !== undefined ||
					teamSettings.privacy !== undefined ||
					(teamSettings.tags && Array.isArray(teamSettings.tags) && teamSettings.tags.length > 0) ||
					teamSettings.language ||
					teamSettings.licence !== undefined;

				if (hasMetadata || hasThumbnail) {
					const fs = require('fs');
					const FormData = require('form-data');
					const form = new FormData();
					const baseUrl = await getBaseUrl(peertubeHelpers, settingsManager);

					// Add metadata fields
					if (teamSettings.streamTitle) form.append('name', teamSettings.streamTitle);
					if (teamSettings.streamDescription !== undefined) form.append('description', teamSettings.streamDescription);
					if (teamSettings.category !== undefined) form.append('category', teamSettings.category);
					if (teamSettings.privacy !== undefined) form.append('privacy', teamSettings.privacy);
					if (teamSettings.tags && Array.isArray(teamSettings.tags) && teamSettings.tags.length > 0) {
						teamSettings.tags.forEach(tag => form.append('tags[]', tag));
					}
					if (teamSettings.language) form.append('language', teamSettings.language);
					if (teamSettings.licence !== undefined) form.append('licence', teamSettings.licence);

					// Add thumbnail file if provided and exists
					if (hasThumbnail && fs.existsSync(thumbnailPath)) {
						form.append('thumbnailfile', fs.createReadStream(thumbnailPath));
						console.log(`[PLUGIN] Including thumbnail in video update: ${thumbnailPath}`);
					} else if (hasThumbnail) {
						console.warn(`[PLUGIN] Thumbnail file not found at path: ${thumbnailPath}`);
					}

					const updateRes = await fetch(`${baseUrl}/api/v1/videos/${teamSettings.permanentLiveVideoId}`, {
						method: 'PUT',
						headers: {
							'Authorization': `Bearer ${peertubeOAuthToken}`,
							...form.getHeaders()
						},
						body: form
					});

					if (!updateRes.ok) {
						const errorText = await updateRes.text();
						console.warn(`[PLUGIN] Failed to update video ${teamSettings.permanentLiveVideoId}: ${updateRes.status} ${errorText}`);
					} else {
						console.log(`[PLUGIN] Successfully updated video ${teamSettings.permanentLiveVideoId}`);
					}
				}
				// Check if playlist exists for this season
				if (teamSettings.seasonYear) {
					console.log(`[PLUGIN] Checking playlist for team ${teamSettings.teamName}, season ${teamSettings.seasonYear}`);
					if (!teamSettings.seasons) {
						teamSettings.seasons = {};
					}
					const seasonData = teamSettings.seasons[teamSettings.seasonYear];
					if (!seasonData || !seasonData.playlistId) {
						// Create new playlist for this season
						const { generatePlaylistTitle } = require('./lib-game-title.js');
						const orgData = (await storageManager.getData('hudl-organization')) || {};
						const schoolName = orgData.name || 'School';
						
						const playlistDisplayName = generatePlaylistTitle(
							{ gender: teamSettings.gender, teamLevel: teamSettings.teamLevel, sport: teamSettings.sport },
							schoolName,
							teamSettings.seasonYear
						) || `${teamSettings.teamName} ${teamSettings.seasonYear}-${parseInt(teamSettings.seasonYear) + 1}`;
						
						const nextYear = parseInt(teamSettings.seasonYear) + 1;
						console.log(`[PLUGIN] Creating new playlist: ${playlistDisplayName}`);
						const newPlaylist = await createPlaylist({
							channelId: teamSettings.channelId,
							displayName: playlistDisplayName,
							description: `${schoolName} season ${teamSettings.seasonYear}-${nextYear}`,
							privacy: teamSettings.privacy,
							oauthToken: peertubeOAuthToken,
							peertubeHelpers,
							settingsManager
						});
						teamSettings.seasons[teamSettings.seasonYear] = {
							seasonYear: teamSettings.seasonYear,
							playlistId: newPlaylist.playlistId,
							playlistName: newPlaylist.displayName,
							createdByUser: teamSettings.ownerUsername
						};
						console.log(`[PLUGIN] Playlist created successfully: ${newPlaylist.displayName} (ID: ${newPlaylist.playlistId})`);
						await updateTeamPermanentLive(snifferId, teamId, {
							seasons: teamSettings.seasons
						}, storageManager);
					} else {
						console.log(`[PLUGIN] Playlist already exists for season ${teamSettings.seasonYear}: ${seasonData.playlistName} (ID: ${seasonData.playlistId})`);
					}
				} else {
					console.log('[PLUGIN] No seasonYear provided, skipping playlist creation');
				}
				return {
					videoId: teamSettings.permanentLiveVideoId,
					rtmpUrl: teamSettings.permanentLiveRtmpUrl,
					streamKey: teamSettings.permanentLiveStreamKey,
					isNew: false,
					videoTitle: teamSettings.streamTitle || videoTitle
				};
			} else {
				// Clean up deleted video reference
				await updateTeamPermanentLive(snifferId, teamId, {
					permanentLiveVideoId: null,
					permanentLiveRtmpUrl: null,
					permanentLiveStreamKey: null
				}, storageManager);
			}
		}
		// STEP 2: Create new permanent live video for this team
		const name = teamSettings.streamTitle || `${teamSettings.teamName} - Live`;
		const description = teamSettings.streamDescription || `Live stream for ${teamSettings.teamName}`;
		const channelId = teamSettings.channelId;
		const category = teamSettings.category;
		const privacy = teamSettings.privacy;
				// Build tags with system tags first, then custom tags, max 5
				const tags = buildVideoTags({
					gender: teamSettings.gender,
					teamLevel: teamSettings.teamLevel,
					sport: teamSettings.sport,
					customTags: teamSettings.customTags || teamSettings.tags // fallback for legacy
				});
		const language = teamSettings.language;
		const licence = teamSettings.licence;
		const thumbnailPath = typeof teamSettings.thumbnailPath !== 'undefined' ? teamSettings.thumbnailPath : undefined;
		const newVideo = await createPeerTubeLiveVideo({
			channelId,
			name,
			description,
			category,
			privacy,
			tags,
			language,
			licence,
			oauthToken: peertubeOAuthToken,
			peertubeHelpers,
			settingsManager,
			snifferId,
			storageManager,
			thumbnailPath
		});
		if (!newVideo) {
			console.error('[PLUGIN] PeerTube live video API returned undefined!');
			throw new Error('PeerTube live video API returned undefined');
		}
		if (!newVideo.rtmpUrl || !newVideo.streamKey) {
			console.error('[PLUGIN] PeerTube live video API response missing rtmpUrl or streamKey:', newVideo);
			throw new Error('PeerTube live video API response missing rtmpUrl or streamKey');
		}
		// STEP 3: Store credentials in team mapping
		await updateTeamPermanentLive(snifferId, teamId, {
			permanentLiveVideoId: newVideo.id,
			permanentLiveRtmpUrl: newVideo.rtmpUrl,
			permanentLiveStreamKey: newVideo.streamKey,
			permanentLiveCreatedAt: new Date().toISOString()
		}, storageManager);
		// Check if playlist exists for this season
		if (teamSettings.seasonYear) {
			console.log(`[PLUGIN] Checking playlist for team ${teamSettings.teamName}, season ${teamSettings.seasonYear}`);
			if (!teamSettings.seasons) {
				teamSettings.seasons = {};
			}
			const seasonData = teamSettings.seasons[teamSettings.seasonYear];
			if (!seasonData || !seasonData.playlistId) {
				// Create new playlist for this season
			const { generatePlaylistTitle } = require('./lib-game-title.js');
			const orgData = (await storageManager.getData('hudl-organization')) || {};
			const schoolName = orgData.name || 'School';
			
			const playlistDisplayName = generatePlaylistTitle(
				{ gender: teamSettings.gender, teamLevel: teamSettings.teamLevel, sport: teamSettings.sport },
				schoolName,
				teamSettings.seasonYear
			) || `${teamSettings.teamName} ${teamSettings.seasonYear}-${parseInt(teamSettings.seasonYear) + 1}`;
			
			const nextYear = parseInt(teamSettings.seasonYear) + 1;
			console.log(`[PLUGIN] Creating new playlist: ${playlistDisplayName}`);
			const newPlaylist = await createPlaylist({
				channelId: teamSettings.channelId,
				displayName: playlistDisplayName,
				description: `${schoolName} season ${teamSettings.seasonYear}-${nextYear}`,
					privacy: teamSettings.privacy,
					oauthToken: peertubeOAuthToken,
					peertubeHelpers,
					settingsManager
				});
				teamSettings.seasons[teamSettings.seasonYear] = {
					seasonYear: teamSettings.seasonYear,
					playlistId: newPlaylist.playlistId,
					playlistName: newPlaylist.displayName
				};
				console.log(`[PLUGIN] Playlist created successfully: ${newPlaylist.displayName} (ID: ${newPlaylist.playlistId})`);
				await updateTeamPermanentLive(snifferId, teamId, {
					seasons: teamSettings.seasons
				}, storageManager);
			} else {
				console.log(`[PLUGIN] Playlist already exists for season ${teamSettings.seasonYear}: ${seasonData.playlistName} (ID: ${seasonData.playlistId})`);
			}
		} else {
			console.log('[PLUGIN] No seasonYear provided, skipping playlist creation');
		}
		// STEP 4: Return new credentials
		return {
			videoId: newVideo.id,
			rtmpUrl: newVideo.rtmpUrl,
			streamKey: newVideo.streamKey,
			isNew: true,
			videoTitle: newVideo.name
		};
	} catch (err) {
		throw new Error(`Failed to get or create permanent live stream for team: ${err.message}`);
	}
}

// Helper: Update team's permanent live video credentials in hudl-mappings
async function updateTeamPermanentLive(snifferId, teamId, updates, storageManager) {
	const hudlMappings = (await storageManager.getData('hudl-mappings')) || {};
	if (!hudlMappings[teamId]) {
		throw new Error(`Team ${teamId} not found in hudl-mappings`);
	}
	Object.assign(hudlMappings[teamId], updates);
	await storageManager.storeData('hudl-mappings', hudlMappings);
}

// Helper: Delete a video from PeerTube
async function deleteVideo(videoId, oauthToken, peertubeHelpers, settingsManager, snifferId = null, storageManager = null) {
	const baseUrl = await getBaseUrl(peertubeHelpers, settingsManager);
	let res = await fetch(`${baseUrl}/api/v1/videos/${videoId}`, {
		method: 'DELETE',
		headers: { 'Authorization': `Bearer ${oauthToken}` }
	});
	if (res.status === 401 && snifferId && storageManager) {
		// Automatically refresh PeerTube OAuth token
		peertubeHelpers.logger.info(`[deleteVideo] PeerTube OAuth token expired for sniffer ${snifferId}, refreshing automatically...`);
		const sniffers = (await storageManager.getData('sniffers')) || {};
		const snifferEntry = sniffers[snifferId];
		if (snifferEntry && snifferEntry.peertubeUsername && snifferEntry.peertubePassword) {
			try {
				const { decrypt } = require('./lib/secure-store.js');
				const password = typeof snifferEntry.peertubePassword === 'string' ? snifferEntry.peertubePassword : '';
				const decryptedPassword = decrypt(password);
				const newToken = await getPeerTubeToken({
					username: snifferEntry.peertubeUsername,
					password: decryptedPassword,
					peertubeHelpers,
					settingsManager
				});
				snifferEntry.oauthToken = newToken;
				sniffers[snifferId] = snifferEntry;
				await storageManager.storeData('sniffers', sniffers);
				peertubeHelpers.logger.info(`[deleteVideo] PeerTube OAuth token refreshed successfully for sniffer ${snifferId}`);
				// Retry with new token
				res = await fetch(`${baseUrl}/api/v1/videos/${videoId}`, {
					method: 'DELETE',
					headers: { 'Authorization': `Bearer ${newToken}` }
				});
			} catch (decryptErr) {
				peertubeHelpers.logger.error(`[deleteVideo] Failed to decrypt stored credentials for sniffer ${snifferId}: ${decryptErr.message}`);
				const error = new Error('REAUTH_REQUIRED: Stored credentials cannot be decrypted');
				error.code = 'REAUTH_REQUIRED';
				throw error;
			}
		}
	}
	if (res.status === 204 || res.status === 404) {
		// 204 = successfully deleted, 404 = already gone (both are success cases)
		return true;
	}
	if (!res.ok) {
		throw new Error(`Failed to delete video ${videoId}: ${res.status} ${await res.text()}`);
	}
	return true;
}

// Helper: Create a PeerTube playlist
async function createPlaylist({ channelId, displayName, description, privacy, oauthToken, peertubeHelpers, settingsManager }) {
	const baseUrl = await getBaseUrl(peertubeHelpers, settingsManager);
	const body = {
		displayName,
		privacy: privacy || 1, // Default to public
		videoChannelId: channelId
	};
	if (description) body.description = description;

	const res = await fetch(`${baseUrl}/api/v1/video-playlists`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${oauthToken}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body)
	});

	if (!res.ok) {
		throw new Error(`Failed to create playlist: ${res.status} ${await res.text()}`);
	}

	const data = await res.json();
	return {
		playlistId: data.videoPlaylist.id,
		displayName: data.videoPlaylist.displayName || displayName // Fallback to input if API doesn't return it
	};
}

// Helper: Add video to playlist
async function addVideoToPlaylist({ playlistId, videoId, oauthToken, peertubeHelpers, settingsManager }) {
	const baseUrl = await getBaseUrl(peertubeHelpers, settingsManager);
	const body = { videoId };

	const res = await fetch(`${baseUrl}/api/v1/video-playlists/${playlistId}/videos`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${oauthToken}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body)
	});

	if (!res.ok) {
		throw new Error(`Failed to add video to playlist: ${res.status} ${await res.text()}`);
	}

	return true;
}

// Update video metadata (name, description, etc.)
async function updateVideoMetadata({ videoId, updates, oauthToken, peertubeHelpers, settingsManager }) {
	const baseUrl = await getBaseUrl(peertubeHelpers, settingsManager);
	
	const res = await fetch(`${baseUrl}/api/v1/videos/${videoId}`, {
		method: 'PUT',
		headers: {
			'Authorization': `Bearer ${oauthToken}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(updates)
	});
	
	if (!res.ok) {
		throw new Error(`Failed to update video metadata: ${res.status} ${await res.text()}`);
	}
	
	return true;
}

module.exports = {
	getPeerTubeToken,
	getPeerTubeChannels,
	getPeerTubeCategories,
	getPeerTubePrivacyOptions,

	getOrCreatePermanentLiveStream,
	createPeerTubeLiveVideo,
	parseTeamTags,
	createPlaylist,
	addVideoToPlaylist,
	updateVideoMetadata,
	checkVideoExists,
	getVideoTitle,
	deleteVideo,
	updateCameraAssignment
};
