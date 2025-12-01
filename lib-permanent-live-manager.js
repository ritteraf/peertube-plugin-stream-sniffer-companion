
// Permanent live manager for per-team permanent live videos
let storageManager = null;
function setStorageManager(sm) { storageManager = sm; }

const peertubeApi = require('./lib-peertube-api.js');

// PeerTube helpers injected by main.js
let peertubeHelpers = null;
function setPeertubeHelpers(helpers) { peertubeHelpers = helpers; }

// Get permanent live info for a team
async function getPermanentLive(teamId) {
       if (!storageManager) throw new Error('storageManager not initialized');
       const schedules = (await storageManager.getData('hudl-schedules')) || {};
       return schedules[teamId] && schedules[teamId].permanentLiveVideoId
	       ? {
			       permanentLiveVideoId: schedules[teamId].permanentLiveVideoId,
			       permanentLiveRtmpUrl: schedules[teamId].permanentLiveRtmpUrl,
			       permanentLiveStreamKey: schedules[teamId].permanentLiveStreamKey,
			       permanentLiveCreatedAt: schedules[teamId].permanentLiveCreatedAt
		       }
	       : null;
}

// Create a permanent live video for a team (calls PeerTube API, stores in hudl-schedules)

async function createPermanentLive(teamId, teamName, channelId, oauthToken) {
	// Call PeerTube API to create a permanent live video
	const live = await peertubeApi.createPermanentLive({
	       channelId,
	       name: `${teamName} - Permanent Live`,
	       description: `Permanent live stream for ${teamName}`,
	       oauthToken,
	       peertubeHelpers
	});
	if (!live || !live.id || !live.rtmpUrl || !live.streamKey) throw new Error('Failed to create permanent live');
	// Store in hudl-schedules
	if (!storageManager) throw new Error('storageManager not initialized');
	let schedules = (await storageManager.getData('hudl-schedules')) || {};
	if (!schedules[teamId]) schedules[teamId] = { teamId, teamName, channelId };
	schedules[teamId].permanentLiveVideoId = live.id;
	schedules[teamId].permanentLiveRtmpUrl = live.rtmpUrl;
	schedules[teamId].permanentLiveStreamKey = live.streamKey;
	schedules[teamId].permanentLiveCreatedAt = new Date().toISOString();
	await storageManager.storeData('hudl-schedules', schedules);
	return {
	       permanentLiveVideoId: live.id,
	       permanentLiveRtmpUrl: live.rtmpUrl,
	       permanentLiveStreamKey: live.streamKey,
	       permanentLiveCreatedAt: schedules[teamId].permanentLiveCreatedAt
	};
}

// Delete a permanent live video for a team (calls PeerTube API, removes from hudl-schedules)

async function deletePermanentLive(teamId, oauthToken) {
	if (!storageManager) throw new Error('storageManager not initialized');
	let schedules = (await storageManager.getData('hudl-schedules')) || {};
	if (!schedules[teamId] || !schedules[teamId].permanentLiveVideoId) return false;
	const videoId = schedules[teamId].permanentLiveVideoId;
	await peertubeApi.deleteVideo(videoId, oauthToken, peertubeHelpers);
	delete schedules[teamId].permanentLiveVideoId;
	delete schedules[teamId].permanentLiveRtmpUrl;
	delete schedules[teamId].permanentLiveStreamKey;
	delete schedules[teamId].permanentLiveCreatedAt;
	await storageManager.storeData('hudl-schedules', schedules);
	return true;
}

module.exports = {
	setStorageManager,
	getPermanentLive,
	createPermanentLive,
	deletePermanentLive,
	setPeertubeHelpers
};
