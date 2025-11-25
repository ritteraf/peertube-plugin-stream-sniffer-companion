

// PeerTube API wrapper
const fetch = require('node-fetch');

// Helper to get the PeerTube base URL dynamically
function getBaseUrl(peertubeHelpers) {
	if (peertubeHelpers && peertubeHelpers.config && typeof peertubeHelpers.config.getWebserverUrl === 'function') {
		return peertubeHelpers.config.getWebserverUrl();
	}
	return process.env.PEERTUBE_BASE_URL || 'https://peertube.example.com';
}


// Authenticate user using PeerTube's internal helpers (no OAuth dance)
// This is a stub: actual authentication should be handled in the router using peertubeHelpers
async function authenticateWithPassword({ username, password, peertubeHelpers }) {
	// This function is now a stub. Use peertubeHelpers in your router for authentication.
	throw new Error('Use peertubeHelpers for authentication in your router.');
}


// Create a permanent live video using peertubeHelpers (stub)
async function createPermanentLive({ channelId, name, description, peertubeHelpers }) {
	// Implement using peertubeHelpers.videos or other helpers as needed
	throw new Error('Implement createPermanentLive using peertubeHelpers.');
}


// Delete a video by ID using peertubeHelpers (stub)
async function deleteVideo(videoId, peertubeHelpers) {
	// Implement using peertubeHelpers.videos.removeVideo or similar
	throw new Error('Implement deleteVideo using peertubeHelpers.');
}

module.exports = {
	authenticateWithPassword,
	createPermanentLive,
	deleteVideo
};
