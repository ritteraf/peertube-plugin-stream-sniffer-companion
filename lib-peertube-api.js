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

// Helper: Create PeerTube live video
async function createPeerTubeLiveVideo({ channelId, name, description, category, privacy, oauthToken, peertubeHelpers, settingsManager, snifferId = null, storageManager = null }) {
		       const baseUrl = await getBaseUrl(peertubeHelpers, settingsManager);
		       const body = {
			       channelId,
			       name,
			       description,
			       category,
			       privacy,
			       permanentLive: true,
		       saveReplay: false
	       };
		       let res = await fetch(`${baseUrl}/api/v1/videos/live`, {
			       method: 'POST',
			       headers: {
				       'Authorization': `Bearer ${oauthToken}`,
				       'Content-Type': 'application/json'
			       },
			       body: JSON.stringify(body)
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
					       // Retry with new token
					       res = await fetch(`${baseUrl}/api/v1/videos/live`, {
						       method: 'POST',
						       headers: {
							       'Authorization': `Bearer ${newToken}`,
							       'Content-Type': 'application/json'
						       },
						       body: JSON.stringify(body)
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

	   // If a thumbnailPath is provided and is a non-empty string, upload it as the video thumbnail
	   if (typeof thumbnailPath === 'string' && thumbnailPath.length > 0) {
		   const fs = require('fs');
		   const FormData = require('form-data');
		   const form = new FormData();
		   form.append('thumbnailfile', fs.createReadStream(thumbnailPath));
		   const patchRes = await fetch(`${baseUrl}/api/v1/videos/${data.video.id}/thumbnail`, {
			   method: 'POST',
			   headers: {
				   'Authorization': `Bearer ${currentToken}`,
				   ...form.getHeaders()
			   },
			   body: form
		   });
		   if (!patchRes.ok) {
			   // Log but do not throw, so stream creation still succeeds
			   console.warn(`[PLUGIN] Failed to upload thumbnail for video ${data.video.id}: ${patchRes.status} ${await patchRes.text()}`);
		   }
	   }

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

// Main function: getOrCreatePermanentLiveStream
async function getOrCreatePermanentLiveStream(snifferId, cameraId, cameraAssignment, peertubeOAuthToken, peertubeHelpers, storageManager) {
	try {
	// STEP 1: Check if permanent live already exists
	       if (cameraAssignment.permanentLiveVideoId) {
		       const exists = await checkVideoExists(cameraAssignment.permanentLiveVideoId, peertubeOAuthToken, peertubeHelpers, settingsManager, snifferId, storageManager);
		       if (exists) {
			       // Get current title
			       const videoTitle = await getVideoTitle(cameraAssignment.permanentLiveVideoId, peertubeOAuthToken, peertubeHelpers, settingsManager, snifferId, storageManager);
				       return {
					       videoId: cameraAssignment.permanentLiveVideoId,
					       rtmpUrl: cameraAssignment.permanentLiveRtmpUrl,
					       streamKey: cameraAssignment.permanentLiveStreamKey,
					       isNew: false,
					       videoTitle
				       };
			       } else {
				// Clean up deleted video reference
				await updateCameraAssignment(snifferId, cameraAssignment.cameraId, {
					permanentLiveVideoId: null,
					permanentLiveRtmpUrl: null,
					permanentLiveStreamKey: null
				}, storageManager);
			}
		}
	// STEP 2: Create new permanent live video
	const name = cameraAssignment.streamTitle || `${cameraAssignment.cameraId} - Live`;
	const description = cameraAssignment.streamDescription || `Live stream from ${cameraAssignment.cameraId}`;
	const channelId = cameraAssignment.channelId;
	const category = cameraAssignment.defaultStreamCategory;
	const privacy = cameraAssignment.privacyId;
	// Ensure thumbnailPath is always defined
	const thumbnailPath = typeof cameraAssignment.thumbnailPath !== 'undefined' ? cameraAssignment.thumbnailPath : undefined;
		const newVideo = await createPeerTubeLiveVideo({
			channelId,
			name,
			description,
			category,
			privacy,
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
		// STEP 3: Store credentials in camera assignment
		await updateCameraAssignment(snifferId, cameraAssignment.cameraId, {
			permanentLiveVideoId: newVideo.id,
			permanentLiveRtmpUrl: newVideo.rtmpUrl,
			permanentLiveStreamKey: newVideo.streamKey,
			permanentLiveCreatedAt: new Date().toISOString()
		}, storageManager);
		// STEP 4: Return new credentials
		return {
			videoId: newVideo.id,
			rtmpUrl: newVideo.rtmpUrl,
			streamKey: newVideo.streamKey,
			isNew: true,
			videoTitle: newVideo.name
		};
	} catch (err) {
		throw new Error(`Failed to get or create permanent live stream: ${err.message}`);
	}
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

module.exports = {
	getPeerTubeToken,
	getPeerTubeChannels,
	getPeerTubeCategories,
	getPeerTubePrivacyOptions,

	getOrCreatePermanentLiveStream,
	createPeerTubeLiveVideo,
	checkVideoExists,
	getVideoTitle,
	deleteVideo,
	updateCameraAssignment
};
