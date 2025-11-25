


const fetch = require('node-fetch');

// Helper to get the PeerTube base URL dynamically
function getBaseUrl(peertubeHelpers) {
  if (peertubeHelpers && peertubeHelpers.config && typeof peertubeHelpers.config.getWebserverUrl === 'function') {
    return peertubeHelpers.config.getWebserverUrl();
  }
  throw new Error('peertubeHelpers.config.getWebserverUrl is not available. Cannot determine PeerTube base URL.');
}

// Authenticate with PeerTube and get an access token
async function getPeerTubeToken({ username, password, peertubeHelpers }) {
	const baseUrl = getBaseUrl(peertubeHelpers);
	const res = await fetch(`${baseUrl}/api/v1/users/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ client_id: 'peertube', client_secret: 'peertube', grant_type: 'password', response_type: 'code', username, password })
	});
	if (!res.ok) throw new Error(`Failed to authenticate with PeerTube: ${res.status} ${await res.text()}`);
	const data = await res.json();
	return data.access_token;
}

// Fetch user's channels
async function getPeerTubeChannels({ username, password, peertubeHelpers }) {
	const token = await getPeerTubeToken({ username, password, peertubeHelpers });
	const baseUrl = getBaseUrl(peertubeHelpers);
	// Get user info
	const userRes = await fetch(`${baseUrl}/api/v1/users/me`, {
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!userRes.ok) throw new Error(`Failed to fetch user info: ${userRes.status} ${await userRes.text()}`);
	const user = await userRes.json();
	// Get channels
	const channelsRes = await fetch(`${baseUrl}/api/v1/users/me/video-channels`, {
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!channelsRes.ok) throw new Error(`Failed to fetch channels: ${channelsRes.status} ${await channelsRes.text()}`);
	const channelsData = await channelsRes.json();
	return { username: user.username, channels: channelsData.data || [] };
}

// Fetch categories
async function getPeerTubeCategories({ username, password, peertubeHelpers }) {
	const token = await getPeerTubeToken({ username, password, peertubeHelpers });
	const baseUrl = getBaseUrl(peertubeHelpers);
	const res = await fetch(`${baseUrl}/api/v1/video-categories`, {
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) throw new Error(`Failed to fetch categories: ${res.status} ${await res.text()}`);
	const data = await res.json();
	return data.data || [];
}

// Fetch privacy options
async function getPeerTubePrivacyOptions({ username, password, peertubeHelpers }) {
	const token = await getPeerTubeToken({ username, password, peertubeHelpers });
	const baseUrl = getBaseUrl(peertubeHelpers);
	const res = await fetch(`${baseUrl}/api/v1/videos/privacy`, {
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) throw new Error(`Failed to fetch privacy options: ${res.status} ${await res.text()}`);
	const data = await res.json();
	return data.data || [];
}

// Stubs for future expansion
async function createPermanentLive({ channelId, name, description, peertubeHelpers }) {
	throw new Error('Implement createPermanentLive using peertubeHelpers.');
}
async function deleteVideo(videoId, peertubeHelpers) {
	throw new Error('Implement deleteVideo using peertubeHelpers.');
}

module.exports = {
	getPeerTubeChannels,
	getPeerTubeCategories,
	getPeerTubePrivacyOptions,
	createPermanentLive,
	deleteVideo
};
