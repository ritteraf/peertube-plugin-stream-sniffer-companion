


const fetch = require('node-fetch');

// Helper to get the PeerTube base URL dynamically
// Accepts peertubeHelpers, settingsManager (optional), and fallback env
async function getBaseUrl(peertubeHelpers, settingsManager) {
	       if (peertubeHelpers && peertubeHelpers.config && typeof peertubeHelpers.config.getWebserverUrl === 'function') {
		       try {
			       const url = peertubeHelpers.config.getWebserverUrl();
					   // ...existing code...
			       if (url) return url;
		       } catch (e) {
					   // ...existing code...
		       }
	       } else {
			   // ...existing code...
	       }

	       // Fallback: try plugin setting
	       if (settingsManager && typeof settingsManager.getSetting === 'function') {
		       try {
			       const url = await settingsManager.getSetting('peertube-base-url');
					   // ...existing code...
			       if (url) return url;
		       } catch (e) {
					   // ...existing code...
		       }
	       } else {
			   // ...existing code...
	       }

	       // Fallback: environment variable
	       if (process.env.PEERTUBE_BASE_URL) {
			   // ...existing code...
		       return process.env.PEERTUBE_BASE_URL;
	       }
		// ...existing code...
	       throw new Error('Cannot determine PeerTube base URL: no helper, setting, or env PEERTUBE_BASE_URL');
}

// Authenticate with PeerTube and get an access token
async function getPeerTubeToken({ username, password, peertubeHelpers, settingsManager }) {
       const baseUrl = await getBaseUrl(peertubeHelpers, settingsManager);
       const params = new URLSearchParams();
       params.append('client_id', 'peertube');
       params.append('client_secret', 'peertube');
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
async function checkVideoExists(videoId, oauthToken, peertubeHelpers, settingsManager) {
	const baseUrl = await getBaseUrl(peertubeHelpers, settingsManager);
	const res = await fetch(`${baseUrl}/api/v1/videos/${videoId}`, {
		headers: { 'Authorization': `Bearer ${oauthToken}` }
	});
	return res.status === 200;
}

// Helper: Get video title
async function getVideoTitle(videoId, oauthToken, peertubeHelpers, settingsManager) {
	const baseUrl = await getBaseUrl(peertubeHelpers, settingsManager);
	const res = await fetch(`${baseUrl}/api/v1/videos/${videoId}`, {
		headers: { 'Authorization': `Bearer ${oauthToken}` }
	});
	if (!res.ok) throw new Error(`Failed to fetch video title: ${res.status}`);
	const data = await res.json();
	return data.name;
}

// Helper: Create PeerTube live video
async function createPeerTubeLiveVideo({ channelId, name, description, category, privacy, oauthToken, peertubeHelpers, settingsManager }) {
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
	const res = await fetch(`${baseUrl}/api/v1/videos/live`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${oauthToken}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body)
	});
	if (!res.ok) throw new Error(`Failed to create permanent live: ${res.status} ${await res.text()}`);
	const data = await res.json();
	return {
		id: data.video.id,
		name: data.video.name,
		rtmpUrl: data.rtmp.url,
		streamKey: data.rtmp.streamKey
	};
}

// Helper: Update camera assignment in storage
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
			const exists = await checkVideoExists(cameraAssignment.permanentLiveVideoId, peertubeOAuthToken, peertubeHelpers);
			if (exists) {
				// Get current title
				const videoTitle = await getVideoTitle(cameraAssignment.permanentLiveVideoId, peertubeOAuthToken, peertubeHelpers);
				return {
					videoId: cameraAssignment.permanentLiveVideoId,
					rtmpUrl: cameraAssignment.permanentLiveRtmpUrl,
					streamKey: cameraAssignment.permanentLiveStreamKey,
					isNew: false,
					videoTitle
				};
			} else {
				// Clean up deleted video reference
				await updateCameraAssignment(snifferId, cameraId, {
					permanentLiveVideoId: null,
					permanentLiveRtmpUrl: null,
					permanentLiveStreamKey: null
				}, storageManager);
			}
		}
		// STEP 2: Create new permanent live video
		const name = cameraAssignment.streamTitle || `${cameraId} - Live`;
		const description = cameraAssignment.streamDescription || `Live stream from ${cameraId}`;
		const channelId = cameraAssignment.channelId;
		const category = cameraAssignment.defaultStreamCategory;
		const privacy = cameraAssignment.privacyId;
		const newVideo = await createPeerTubeLiveVideo({
			channelId,
			name,
			description,
			category,
			privacy,
			oauthToken: peertubeOAuthToken,
			peertubeHelpers
		});
		// STEP 3: Store credentials in camera assignment
		await updateCameraAssignment(snifferId, cameraId, {
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

module.exports = {
	getPeerTubeChannels,
	getPeerTubeCategories,
	getPeerTubePrivacyOptions,
			 getOrCreatePermanentLiveStream,
			 createPeerTubeLiveVideo,
			 checkVideoExists,
			 getVideoTitle,
			 updateCameraAssignment
};
