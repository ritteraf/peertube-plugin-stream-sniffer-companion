
// Export a factory function for dependency injection
module.exports = function createConfigRouter({ storageManager, settingsManager, peertubeHelpers }) {
	const express = require('express');
	const router = express.Router();
	const { requireAuth } = require('./lib-auth-manager.js');

	// Async helpers for camera assignments (now using storageManager)
	async function getCameraAssignments() {
		if (!storageManager) throw new Error('storageManager not initialized');
		const assignments = (await storageManager.getData('camera-assignments')) || {};
		// ...existing code...
		return assignments;
	}
	async function setCameraAssignments(assignments) {
		if (!storageManager) throw new Error('storageManager not initialized');
		// ...existing code...
		await storageManager.storeData('camera-assignments', assignments);
	}

	// DELETE /logout
	router.delete('/logout', requireAuth, async (req, res) => {
		const snifferId = req.snifferId;
		if (!storageManager) return res.status(500).json({ error: 'PLUGIN_STORAGE_NOT_INITIALIZED' });
		let sniffers = (await storageManager.getData('sniffers')) || {};
		if (sniffers[snifferId]) {
			sniffers[snifferId].streamToken = null;
			sniffers[snifferId].tokenExpiresAt = new Date(0).toISOString();
			await storageManager.storeData('sniffers', sniffers);
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
		try {
			const cameras = await getCameraAssignments();
			const removed = cameras[snifferId] ? Object.keys(cameras[snifferId]) : [];
			const endpoints = cameras[snifferId] ? Object.values(cameras[snifferId]).map(c => c.endpointPath) : [];

			cameras[snifferId] = {};
			await setCameraAssignments(cameras);
			
			// Clean up HUDL team mappings
			const camerasToDelete = new Set(removed);
			const hudlMappings = (await storageManager.getData('hudl-mappings')) || {};
			for (const teamId in hudlMappings) {
				if (hudlMappings[teamId].cameraId && camerasToDelete.has(hudlMappings[teamId].cameraId)) {
					delete hudlMappings[teamId].cameraId;
				}
			}
			await storageManager.storeData('hudl-mappings', hudlMappings);
			
			return res.status(200).json({
				deleted: removed.length,
				camerasRemoved: removed,
				endpoints,
				authenticationPreserved: true,
				message: 'All cameras deleted'
			});
		} catch (err) {
			return res.status(500).json({ error: 'PLUGIN_CAMERA_DELETE_FAILED', message: err.message });
		}
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
		try {
			const cameras = await getCameraAssignments();
			let endpoint = null;

			if (cameras[snifferId] && cameras[snifferId][cameraId]) {
				endpoint = cameras[snifferId][cameraId].endpointPath;
				delete cameras[snifferId][cameraId];
				await setCameraAssignments(cameras);
				
				// Clean up HUDL team mapping
				const hudlMappings = (await storageManager.getData('hudl-mappings')) || {};
				for (const teamId in hudlMappings) {
					if (hudlMappings[teamId].cameraId === cameraId) {
						delete hudlMappings[teamId].cameraId;
					}
				}
				await storageManager.storeData('hudl-mappings', hudlMappings);
			}
			
			return res.status(200).json({
				deleted: true,
				cameraId,
				endpoint,
				message: 'Camera deleted'
			});
		} catch (err) {
			return res.status(500).json({ error: 'PLUGIN_CAMERA_DELETE_FAILED', message: err.message });
		}
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
		try {
			const cameras = await getCameraAssignments();
			const deletedCameras = cameras[snifferId] ? Object.keys(cameras[snifferId]).length : 0;

			// Get sniffer's OAuth token and username for clearing configuration
			if (!storageManager) throw new Error('storageManager not initialized');
			let sniffers = (await storageManager.getData('sniffers')) || {};
			const snifferEntry = sniffers[snifferId];
			const username = snifferEntry && snifferEntry.peertubeUsername;
			let hudlMappingsCleared = 0;

			// Clear team ownership and configuration for this user (but don't delete playlists/content)
			let hudlMappings = (await storageManager.getData('hudl-mappings')) || {};
			for (const [teamId, teamData] of Object.entries(hudlMappings)) {
				if (teamData.ownerUsername === username) {
					delete teamData.ownerUsername;
					delete teamData.channelId;
					delete teamData.channelHandle;
					delete teamData.playlistId;
					hudlMappingsCleared++;
				}
			}
			await storageManager.storeData('hudl-mappings', hudlMappings);

			// Clear camera assignments
			delete cameras[snifferId];
			await setCameraAssignments(cameras);
			
			// Remove sniffer credentials
			delete sniffers[snifferId];
			await storageManager.storeData('sniffers', sniffers);
			
			return res.status(200).json({
				resetComplete: true,
				deleted: {
					cameras: deletedCameras,
					oauthTokens: true,
					encryptedCredentials: true,
					registryEntry: true,
					hudlTeamMappings: hudlMappingsCleared
				},
				note: 'Playlists and replay videos were preserved',
				reauthenticationRequired: true,
				message: 'All configuration reset'
			});
		} catch (err) {
			return res.status(500).json({ error: 'PLUGIN_RESET_FAILED', message: err.message });
		}
	});

	// GET /my-channels
	router.get('/my-channels', requireAuth, async (req, res) => {
		try {
			const { getPeerTubeChannels } = require('./lib-peertube-api.js');
			const snifferId = req.snifferId;
			if (!storageManager) return res.status(500).json({ error: 'PLUGIN_STORAGE_NOT_INITIALIZED' });
			const sniffers = (await storageManager.getData('sniffers')) || {};
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
			const fetch = require('node-fetch');
			let categories = [];
			let message = '';
			try {
				// Determine PeerTube base URL
				let baseUrl = null;
				if (peertubeHelpers && peertubeHelpers.config && typeof peertubeHelpers.config.getWebserverUrl === 'function') {
					baseUrl = peertubeHelpers.config.getWebserverUrl();
				}
				baseUrl = baseUrl || process.env.PEERTUBE_BASE_URL || '';
				if (!baseUrl) throw new Error('Cannot determine PeerTube base URL');
				const resPeerTube = await fetch(`${baseUrl}/api/v1/videos/categories`);
				if (!resPeerTube.ok) throw new Error(`Failed to fetch categories: ${resPeerTube.status}`);
				const raw = await resPeerTube.json();
				categories = Object.entries(raw).map(([id, label]) => ({ id: Number(id), label }));
				message = `Found ${categories.length} categories`;
			} catch (err) {
				message = `Exception fetching categories: ${err.message}`;
				console.error('[PLUGIN] /categories exception:', err);
			}
			return res.status(200).json({
				categories,
				message
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
			const fetch = require('node-fetch');
			let privacies = [];
			let message = '';
			try {
				// Determine PeerTube base URL
				let baseUrl = null;
				if (peertubeHelpers && peertubeHelpers.config && typeof peertubeHelpers.config.getWebserverUrl === 'function') {
					baseUrl = peertubeHelpers.config.getWebserverUrl();
				}
				baseUrl = baseUrl || process.env.PEERTUBE_BASE_URL || '';
				if (!baseUrl) throw new Error('Cannot determine PeerTube base URL');
				const resPeerTube = await fetch(`${baseUrl}/api/v1/videos/privacies`);
				if (!resPeerTube.ok) throw new Error(`Failed to fetch privacy options: ${resPeerTube.status}`);
				const raw = await resPeerTube.json();
				privacies = Object.entries(raw).map(([id, name]) => ({ id: Number(id), name }));
				message = `Found ${privacies.length} privacy options`;
			} catch (err) {
				message = `Exception fetching privacy options: ${err.message}`;
				console.error('[PLUGIN] /privacy-options exception:', err);
			}
			return res.status(200).json({
				privacies,
				message
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
		const snifferId = req.snifferId;
		try {
			const cameras = await getCameraAssignments();
			const assignments = cameras[snifferId] ? Object.values(cameras[snifferId]) : [];
			// ...existing code...
			const pkg = require('./package.json');
			return res.status(200).json({
				snifferId,
				cameraAssignments: assignments,
				totalAssignments: assignments.length,
				serverInfo: {
					timestamp: new Date().toISOString(),
					pluginVersion: pkg.version
				}
			});
		} catch (err) {
			return res.status(500).json({ error: 'PLUGIN_CAMERA_FETCH_FAILED', message: err.message });
		}
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
		try {
			const cameras = await getCameraAssignments();
			// Build sets for new and deleted cameras
			const newIds = new Set(assignments.map(a => a.cameraId));
			// Delete cameras not in new list
			if (cameras[snifferId]) {
				for (const camId of Object.keys(cameras[snifferId])) {
					if (!newIds.has(camId)) {
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
			await setCameraAssignments(cameras);

			return res.status(200).json({
				success: true,
				message: 'Configuration saved successfully',
				snifferId,
				timestamp: new Date().toISOString(),
				assignmentsCreated: assignments.length
			});
		} catch (err) {
			return res.status(500).json({ error: 'PLUGIN_CAMERA_SAVE_FAILED', message: err.message });
		}
	});

	return router;
};
