const express = require('express');
const router = express.Router();
const { readJson, writeJson, requireAuth } = require('./lib-auth-manager.js');

// POST /recording-started
router.post('/recording-started', requireAuth, async (req, res) => {
	const snifferId = req.snifferId;
	const event = req.body || {};
	if (!event || typeof event !== 'object' || Array.isArray(event) || !event.cameraId || typeof event.cameraId !== 'string') {
		return res.status(400).json({
			acknowledged: false,
			message: 'Request body must be an object with cameraId (string)',
			error: 'Invalid input'
		});
	}
	const log = readJson('recording-log');
	if (!log[snifferId]) log[snifferId] = [];
	log[snifferId].push({
		type: 'started',
		...event,
		timestamp: new Date().toISOString()
	});
	writeJson('recording-log', log);
	// In production, create a new live stream via PeerTube API
	try {
		const { createLiveStream } = require('./lib-peertube-api.js');
		const sniffers = readJson('sniffers');
		const token = sniffers[snifferId] && sniffers[snifferId].oauthToken;
		if (!token) {
			return res.status(401).json({
				acknowledged: false,
				message: 'No PeerTube OAuth token found for sniffer',
				error: 'No OAuth token'
			});
		}
		const liveStream = await createLiveStream(token, event);
		return res.status(200).json({
			acknowledged: true,
			message: 'Recording started',
			streamId: liveStream.id,
			liveStream,
			isDuplicate: false,
			permanent: false
		});
	} catch (err) {
		return res.status(500).json({
			acknowledged: false,
			message: 'Failed to start recording',
			error: err.message
		});
	}
});

// POST /recording-started-permanent
router.post('/recording-started-permanent', requireAuth, async (req, res) => {
	const snifferId = req.snifferId;
	const event = req.body || {};
	if (!event || typeof event !== 'object' || Array.isArray(event) || !event.cameraId || typeof event.cameraId !== 'string') {
		return res.status(400).json({
			acknowledged: false,
			message: 'Request body must be an object with cameraId (string)',
			error: 'Invalid input'
		});
	}
	const log = readJson('recording-log');
	if (!log[snifferId]) log[snifferId] = [];
	log[snifferId].push({
		type: 'started-permanent',
		...event,
		timestamp: new Date().toISOString()
	});
	writeJson('recording-log', log);
	// In production, use or create a permanent live stream via PeerTube API
	try {
		const { getOrCreatePermanentLiveStream } = require('./lib-peertube-api.js');
		const sniffers = readJson('sniffers');
		const token = sniffers[snifferId] && sniffers[snifferId].oauthToken;
		if (!token) {
			return res.status(401).json({
				acknowledged: false,
				message: 'No PeerTube OAuth token found for sniffer',
				error: 'No OAuth token'
			});
		}
		const liveStream = await getOrCreatePermanentLiveStream(token, event);
		return res.status(200).json({
			acknowledged: true,
			message: 'Using permanent live video',
			streamId: liveStream.id,
			liveStream,
			isDuplicate: false,
			permanent: true
		});
	} catch (err) {
		return res.status(500).json({
			acknowledged: false,
			message: 'Failed to start permanent live',
			error: err.message
		});
	}
});

// POST /recording-stopped
router.post('/recording-stopped', requireAuth, async (req, res) => {
	const snifferId = req.snifferId;
	const event = req.body || {};
	if (!event || typeof event !== 'object' || Array.isArray(event) || !event.cameraId || typeof event.cameraId !== 'string') {
		return res.status(400).json({
			acknowledged: false,
			message: 'Request body must be an object with cameraId (string)',
			error: 'Invalid input'
		});
	}
	const log = readJson('recording-log');
	if (!log[snifferId]) log[snifferId] = [];
	log[snifferId].push({
		type: 'stopped',
		...event,
		timestamp: new Date().toISOString()
	});
	writeJson('recording-log', log);
	return res.status(200).json({
		acknowledged: true,
		message: 'Recording stopped'
	});
});
module.exports = router;
