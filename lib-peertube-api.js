
// PeerTube API wrapper
const fetch = require('node-fetch');

// Set your PeerTube instance base URL here or from env
const PEERTUBE_BASE_URL = process.env.PEERTUBE_BASE_URL || 'https://peertube.example.com';


// Authenticate with PeerTube using username/password (OAuth password grant)
async function authenticateWithPassword({ username, password, clientId, clientSecret }) {
	const url = `${PEERTUBE_BASE_URL}/api/v1/users/token`;
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			grant_type: 'password',
			client_id: clientId,
			client_secret: clientSecret,
			username,
			password
		})
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error(err.error_description || `PeerTube OAuth failed: ${res.status}`);
	}
	const data = await res.json();
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString(),
		tokenType: data.token_type
	};
}

// Create a permanent live video
async function createPermanentLive({ channelId, name, description, oauthToken }) {
	const url = `${PEERTUBE_BASE_URL}/api/v1/videos/live`;
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${oauthToken}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			channelId,
			name,
			description,
			permanentLive: true
		})
	});
	if (!res.ok) throw new Error(`PeerTube create live failed: ${res.status}`);
	const data = await res.json();
	return {
		id: data.id,
		rtmpUrl: data.streamingPlaylists && data.streamingPlaylists[0] && data.streamingPlaylists[0].rtmpUrl,
		streamKey: data.streamingPlaylists && data.streamingPlaylists[0] && data.streamingPlaylists[0].streamKey
	};
}

// Delete a video by ID
async function deleteVideo(videoId, oauthToken) {
	const url = `${PEERTUBE_BASE_URL}/api/v1/videos/${videoId}`;
	const res = await fetch(url, {
		method: 'DELETE',
		headers: {
			'Authorization': `Bearer ${oauthToken}`
		}
	});
	if (!res.ok && res.status !== 404) throw new Error(`PeerTube delete video failed: ${res.status}`);
	return true;
}

module.exports = {
	authenticateWithPassword,
	createPermanentLive,
	deleteVideo
};
