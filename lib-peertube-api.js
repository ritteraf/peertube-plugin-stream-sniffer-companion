


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
async function getPeerTubeChannels({ username, peertubeHelpers }) {
	const baseUrl = getBaseUrl(peertubeHelpers);
	const channelsRes = await fetch(`${baseUrl}/api/v1/accounts/${username}/video-channels`);
	if (!channelsRes.ok) {
		throw new Error(`Failed to fetch channels: ${channelsRes.status}`);
	}
	const channelsData = await channelsRes.json();
	return { username, channels: channelsData.data || [] };
}


// Fetch categories (no OAuth needed)
async function getPeerTubeCategories({ peertubeHelpers }) {
	const baseUrl = getBaseUrl(peertubeHelpers);
	const res = await fetch(`${baseUrl}/api/v1/videos/categories`);
	if (!res.ok) throw new Error(`Failed to fetch categories: ${res.status}`);
	const data = await res.json();
	return data.data || [];
}

// Fetch privacy options (no OAuth needed)
async function getPeerTubePrivacyOptions({ peertubeHelpers }) {
	const baseUrl = getBaseUrl(peertubeHelpers);
	const res = await fetch(`${baseUrl}/api/v1/videos/privacies`);
	if (!res.ok) throw new Error(`Failed to fetch privacy options: ${res.status}`);
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
