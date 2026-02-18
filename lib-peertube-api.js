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
function parseTeamTags(gender, teamLevel, sport, teamName) {
	const tags = [];

	// Gender tags: use HUDL values, but capitalize for tags
	if (gender === 'MENS') tags.push('Mens');
	else if (gender === 'WOMENS') tags.push('Womens');
	else if (gender === 'COED') tags.push('Coed');

	// Level tags (match sniffer's displayLevel conversion)
	if (teamLevel === 'VARSITY') tags.push('Varsity');
	else if (teamLevel === 'JUNIOR_VARSITY') tags.push('Junior Varsity');
	else if (teamLevel === 'FRESHMAN') tags.push('Freshman');
	else if (teamLevel === 'OTHER') {
		// Parse team name for level designation
		const parsedLevel = parseLevelFromTeamName(teamName);
		if (parsedLevel) {
			tags.push(parsedLevel);
		} else {
			tags.push('Other');
		}
	}

	// Add sport as a tag (capitalize first letter, rest lowercase)
	if (sport && typeof sport === 'string') {
		// Convert e.g. "BASKETBALL" to "Basketball"
		tags.push(sport.charAt(0).toUpperCase() + sport.slice(1).toLowerCase());
	}

	return tags;
}

// Helper: Parse level from team name when teamLevel is OTHER
function parseLevelFromTeamName(teamName) {
	if (!teamName || typeof teamName !== 'string') return null;
	
	const name = teamName.trim();
	
	// Check for various level indicators
	if (/\bJH\b|\bJ\.H\.|Junior High/i.test(name)) {
		return 'Junior High';
	}
	if (/\bMS\b|\bM\.S\.|Middle School/i.test(name)) {
		return 'Middle School';
	}
	if (/\b8th Grade\b|Eighth Grade/i.test(name)) {
		return '8th Grade';
	}
	if (/\b7th Grade\b|Seventh Grade/i.test(name)) {
		return '7th Grade';
	}
	if (/\b6th Grade\b|Sixth Grade/i.test(name)) {
		return '6th Grade';
	}
	
	return null; // No level found, will use 'Other'
}

// Helper: Combine system tags and user tags, enforcing PeerTube's 5-tag limit (system tags first)
function buildVideoTags({ gender, teamLevel, sport, customTags, teamName }) {
	const systemTags = parseTeamTags(gender, teamLevel, sport, teamName);
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
async function createPeerTubeLiveVideo({ channelId, name, description, category, privacy, tags, language, licence, commentsEnabled, downloadEnabled, oauthToken, peertubeHelpers, settingsManager, snifferId = null, storageManager = null, thumbnailPath = null, scheduledStartTime = null }) {
	const fs = require('fs');
	const FormData = require('form-data');
	const baseUrl = await getBaseUrl(peertubeHelpers, settingsManager);
	const form = new FormData();

	// Required fields
	form.append('channelId', channelId);
	form.append('name', name);
	
	// If scheduledStartTime is provided, create a scheduled live
	// Otherwise, create a regular live video
	if (scheduledStartTime) {
		// Scheduled live video
		form.append('permanentLive', 'false');
		
		// Set when the live stream is scheduled to air (array of schedule objects)
		form.append('schedules[0][startAt]', scheduledStartTime);
		
		// Video is visible immediately with configured privacy so users can see it in upcoming schedule
		if (privacy !== undefined) form.append('privacy', String(privacy));
	} else {
		// Regular live video
		form.append('permanentLive', 'true');
	}
	
	// IMPORTANT: PeerTube automatically appends a date/time suffix to replay video titles
	// when saveReplay is enabled (e.g., "Title - 2/2/2026, 3:56:19 PM")
	// This is PeerTube's built-in behavior and cannot be disabled via API.
	// See lib-replay-sync.js for cleanup logic (TODO: implement replay title cleanup)
	form.append('saveReplay', 'true');

	// Set replay privacy to match the live video privacy (or default to public if not specified)
	const replayPrivacy = privacy !== undefined ? privacy : 1; // 1 = Public
	form.append('replaySettings[privacy]', String(replayPrivacy));

	// Optional metadata fields
	if (description) form.append('description', description);
	if (category !== undefined) form.append('category', String(category));
	if (!scheduledStartTime && privacy !== undefined) form.append('privacy', String(privacy)); // Only set if not scheduled
	if (tags && Array.isArray(tags) && tags.length > 0) {
		tags.forEach(tag => form.append('tags[]', tag));
	}
	if (language) form.append('language', language);
	if (licence !== undefined) form.append('licence', String(licence));
	if (commentsEnabled !== undefined) form.append('commentsEnabled', String(commentsEnabled));
	if (downloadEnabled !== undefined) form.append('downloadEnabled', String(downloadEnabled));

	// Add thumbnail if provided
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
	if (!res.ok) throw new Error(`Failed to create live video: ${res.status} ${await res.text()}`);
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

/**
 * Apply a thumbnail to an existing video
 * Separate from creation to avoid nginx 413 errors with large multipart requests
 * @param {Object} params
 * @param {string} params.videoId - PeerTube video ID
 * @param {string} params.thumbnailPath - Absolute path to thumbnail file
 * @param {string} params.oauthToken - PeerTube OAuth token
 * @param {Object} params.peertubeHelpers - PeerTube helpers object
 * @param {Object} params.settingsManager - Settings manager
 * @returns {Promise<boolean>}
 */
async function applyThumbnailToVideo({ videoId, thumbnailPath, oauthToken, peertubeHelpers, settingsManager }) {
	const FormData = require('form-data');
	const fs = require('fs');
	const baseUrl = await getBaseUrl(peertubeHelpers, settingsManager);

	if (!thumbnailPath || !fs.existsSync(thumbnailPath)) {
		console.warn(`[PLUGIN] Thumbnail file not found at path: ${thumbnailPath}`);
		return false;
	}

	// Fetch current video data to get existing metadata
	const videoRes = await fetch(`${baseUrl}/api/v1/videos/${videoId}`, {
		headers: { 'Authorization': `Bearer ${oauthToken}` }
	});
	
	if (!videoRes.ok) {
		console.error(`[PLUGIN] Failed to fetch video ${videoId}: ${videoRes.status}`);
		return false;
	}
	
	const videoData = await videoRes.json();

	// Build complete FormData with all current metadata
	const form = new FormData();
	
	// Required metadata fields (send current values)
	form.append('name', videoData.name);
	form.append('channelId', String(videoData.channel.id));
	form.append('privacy', String(videoData.privacy.id));
	form.append('category', String(videoData.category?.id || 1));
	
	// Optional metadata fields
	if (videoData.description) form.append('description', videoData.description);
	if (videoData.language?.id) form.append('language', videoData.language.id);
	if (videoData.licence?.id) form.append('licence', String(videoData.licence.id));
	form.append('downloadEnabled', videoData.downloadEnabled ? 'true' : 'false');
	form.append('commentsEnabled', videoData.commentsEnabled ? 'true' : 'false');
	
	// Tags (if present)
	if (videoData.tags && videoData.tags.length > 0) {
		videoData.tags.forEach(tag => form.append('tags[]', tag));
	}
	
	// Finally, add the thumbnail file
	form.append('thumbnailfile', fs.createReadStream(thumbnailPath));

	const res = await fetch(`${baseUrl}/api/v1/videos/${videoId}`, {
		method: 'PUT',
		headers: {
			'Authorization': `Bearer ${oauthToken}`,
			...form.getHeaders()
		},
		body: form
	});

	if (!res.ok) {
		const errorText = await res.text();
		console.error(`[PLUGIN] Failed to apply thumbnail to video ${videoId}: ${res.status} ${errorText}`);
		return false;
	}

	console.log(`[PLUGIN] ✓ Thumbnail applied to video ${videoId}: ${thumbnailPath}`);
	return true;
}

module.exports = {
	getPeerTubeToken,
	getPeerTubeChannels,
	getPeerTubeCategories,
	getPeerTubePrivacyOptions,
	getBaseUrl,

	createPeerTubeLiveVideo,
	parseTeamTags,
	buildVideoTags,
	createPlaylist,
	addVideoToPlaylist,
	updateVideoMetadata,
	applyThumbnailToVideo,
	checkVideoExists,
	getVideoTitle,
	deleteVideo,
	updateCameraAssignment
};
