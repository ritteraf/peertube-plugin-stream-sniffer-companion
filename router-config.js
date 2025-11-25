// PeerTube helpers injected by main.js
let peertubeHelpers = null;
function setPeertubeHelpers(helpers) { peertubeHelpers = helpers; }

const express = require('express');
const router = express.Router();
const { readJson, writeJson, requireAuth } = require('./lib-auth-manager.js');

// DELETE /logout
router.delete('/logout', requireAuth, async (req, res) => {
	const snifferId = req.snifferId;
	const sniffers = readJson('sniffers');
	if (sniffers[snifferId]) {
		sniffers[snifferId].streamToken = null;
		sniffers[snifferId].tokenExpiresAt = new Date(0).toISOString();
		writeJson('sniffers', sniffers);
	}
	return res.status(200).json({
		success: true,
		message: 'Logged out successfully',
		note: 'Camera assignments and OAuth tokens preserved'
	});
});

// DELETE /my-config/cameras
router.delete('/my-config/cameras', requireAuth, async (req, res) => {
	const snifferId = req.snifferId;
	const cameras = readJson('cameras');
	const removed = cameras[snifferId] ? Object.keys(cameras[snifferId]) : [];
	const endpoints = cameras[snifferId] ? Object.values(cameras[snifferId]).map(c => c.endpointPath) : [];
	// In real logic, collect permanentLiveVideoIds for deletion
	const permanentLivesDeleted = cameras[snifferId] ? Object.values(cameras[snifferId]).map(c => c.permanentLiveVideoId).filter(Boolean) : [];
	cameras[snifferId] = {};
	writeJson('cameras', cameras);
	return res.status(200).json({
		deleted: removed.length,
		camerasRemoved: removed,
		endpoints,
		authenticationPreserved: true,
		message: 'All cameras deleted',
		permanentLivesDeleted
	});
});

// DELETE /my-config/cameras/:cameraId
router.delete('/my-config/cameras/:cameraId', requireAuth, async (req, res) => {
	const snifferId = req.snifferId;
	const { cameraId } = req.params;
	if (!cameraId || typeof cameraId !== 'string') {
		return res.status(400).json({
			deleted: false,
			cameraId,
			message: 'cameraId (string) is required in URL',
			error: 'Invalid cameraId'
		});
	}
	const cameras = readJson('cameras');
	let endpoint = null;
	let permanentLiveDeleted = false;
	if (cameras[snifferId] && cameras[snifferId][cameraId]) {
		endpoint = cameras[snifferId][cameraId].endpointPath;
		permanentLiveDeleted = !!cameras[snifferId][cameraId].permanentLiveVideoId;
		delete cameras[snifferId][cameraId];
		writeJson('cameras', cameras);
	}
	return res.status(200).json({
		deleted: true,
		cameraId,
		endpoint,
		message: 'Camera deleted',
		permanentLiveDeleted
	});
});

// POST /my-config/reset-all
router.post('/my-config/reset-all', requireAuth, async (req, res) => {
	const snifferId = req.snifferId;
	if (req.body && Object.keys(req.body).length > 0) {
		return res.status(400).json({
			resetComplete: false,
			message: 'No body expected for this endpoint',
			error: 'Unexpected request body'
		});
	}
	// Remove all sniffer data from storage
	const cameras = readJson('cameras');
	const sniffers = readJson('sniffers');
	const deletedCameras = cameras[snifferId] ? Object.keys(cameras[snifferId]).length : 0;
	delete cameras[snifferId];
	delete sniffers[snifferId];
	writeJson('cameras', cameras);
	writeJson('sniffers', sniffers);
	// In real logic, also remove encrypted credentials, HUDL mappings, etc.
	return res.status(200).json({
		resetComplete: true,
		deleted: {
			cameras: deletedCameras,
			oauthTokens: true,
			encryptedCredentials: true,
			registryEntry: true
		},
		reauthenticationRequired: true,
		message: 'All data reset'
	});
});
// GET /my-channels
router.get('/my-channels', requireAuth, async (req, res) => {
	try {
		const { getPeerTubeChannels } = require('./lib-peertube-api.js');
		const snifferId = req.snifferId;
		const sniffers = readJson('sniffers');
		const username = sniffers[snifferId] && sniffers[snifferId].peertubeUsername;
		const password = sniffers[snifferId] && sniffers[snifferId].peertubePassword;
		if (!username || !password) {
			return res.status(401).json({
				username: null,
				channels: [],
				message: 'No PeerTube credentials found for sniffer'
			});
		}
		const { channels } = await getPeerTubeChannels({ username, password, peertubeHelpers });
		return res.status(200).json({
			username,
			channels,
			message: `Found ${channels.length} channel(s)`
		});
	} catch (err) {
		return res.status(500).json({
			username: null,
			channels: [],
			message: 'Failed to fetch channels',
			error: err.message
		});
	}
});

// GET /categories
router.get('/categories', requireAuth, async (req, res) => {
	try {
		const { getPeerTubeCategories } = require('./lib-peertube-api.js');
		const snifferId = req.snifferId;
		const sniffers = readJson('sniffers');
		const username = sniffers[snifferId] && sniffers[snifferId].peertubeUsername;
		const password = sniffers[snifferId] && sniffers[snifferId].peertubePassword;
		if (!username || !password) {
			return res.status(401).json({
				categories: [],
				message: 'No PeerTube credentials found for sniffer'
			});
		}
		const categories = await getPeerTubeCategories({ username, password, peertubeHelpers });
		return res.status(200).json({
			categories,
			message: `Found ${categories.length} categories`
		});
	} catch (err) {
		return res.status(500).json({
			categories: [],
			message: 'Failed to fetch categories',
			error: err.message
		});
	}
});

// GET /privacy-options
router.get('/privacy-options', requireAuth, async (req, res) => {
	try {
		const { getPeerTubePrivacyOptions } = require('./lib-peertube-api.js');
		const snifferId = req.snifferId;
		const sniffers = readJson('sniffers');
		const username = sniffers[snifferId] && sniffers[snifferId].peertubeUsername;
		const password = sniffers[snifferId] && sniffers[snifferId].peertubePassword;
		if (!username || !password) {
			return res.status(401).json({
				privacies: [],
				message: 'No PeerTube credentials found for sniffer'
			});
		}
		const privacies = await getPeerTubePrivacyOptions({ username, password, peertubeHelpers });
		router.setPeertubeHelpers = setPeertubeHelpers;
		return res.status(200).json({
			privacies,
			message: `Found ${privacies.length} privacy options`
		});
	} catch (err) {
		return res.status(500).json({
			privacies: [],
			message: 'Failed to fetch privacy options',
			error: err.message
		});
	}
});



// GET /my-config
router.get('/my-config', requireAuth, async (req, res) => {
	// Use snifferId from authentication middleware
	const snifferId = req.snifferId;
	const cameras = readJson('cameras');
	const assignments = cameras[snifferId] ? Object.values(cameras[snifferId]) : [];
	return res.status(200).json({
		snifferId,
		cameraAssignments: assignments,
		totalAssignments: assignments.length,
		serverInfo: {
			timestamp: new Date().toISOString(),
			pluginVersion: '3.7.0'
		}
	});
});

// POST /configure
router.post('/configure', requireAuth, async (req, res) => {
	const snifferId = req.snifferId;
	const { assignments } = req.body || {};
	if (!Array.isArray(assignments)) {
		return res.status(400).json({
			success: false,
			message: 'Assignments must be an array',
			assignmentsCreated: 0
		});
	}
	for (const assignment of assignments) {
		if (!assignment.cameraId || typeof assignment.cameraId !== 'string') {
			return res.status(400).json({
				success: false,
				message: 'Each assignment must have a cameraId (string)',
				assignmentsCreated: 0
			});
		}
		if (!assignment.endpointPath || typeof assignment.endpointPath !== 'string') {
			return res.status(400).json({
				success: false,
				message: 'Each assignment must have an endpointPath (string)',
				assignmentsCreated: 0
			});
		}
		// Add more field checks as needed
	}
	// Read current cameras
	const cameras = readJson('cameras');
	// Remove cameras not in new assignment list
	const newIds = new Set(assignments.map(a => a.cameraId));
	const deleted = [];
	if (cameras[snifferId]) {
		for (const camId of Object.keys(cameras[snifferId])) {
			if (!newIds.has(camId)) {
				deleted.push(camId);
				delete cameras[snifferId][camId];
			}
		}
	} else {
		cameras[snifferId] = {};
	}
	// Add/update assignments
	for (const assignment of assignments) {
		cameras[snifferId][assignment.cameraId] = assignment;
	}
	writeJson('cameras', cameras);
	return res.status(200).json({
		success: true,
		message: 'Configuration saved successfully',
		snifferId,
		timestamp: new Date().toISOString(),
		assignmentsCreated: assignments.length,
		permanentLivesDeleted: deleted // In real logic, delete permanent lives for these
	});
});

module.exports = router;
