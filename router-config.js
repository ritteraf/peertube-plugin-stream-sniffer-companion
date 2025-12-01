
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
			const permanentLivesDeleted = cameras[snifferId] ? Object.values(cameras[snifferId]).map(c => c.permanentLiveVideoId).filter(Boolean) : [];
			cameras[snifferId] = {};
					   await setCameraAssignments(cameras);
			return res.status(200).json({
				deleted: removed.length,
				camerasRemoved: removed,
				endpoints,
				authenticationPreserved: true,
				message: 'All cameras deleted',
				permanentLivesDeleted
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
			let permanentLiveDeleted = false;
			if (cameras[snifferId] && cameras[snifferId][cameraId]) {
				endpoint = cameras[snifferId][cameraId].endpointPath;
				permanentLiveDeleted = !!cameras[snifferId][cameraId].permanentLiveVideoId;
				delete cameras[snifferId][cameraId];
				await setCameraAssignments(cameras);
			}
			return res.status(200).json({
				deleted: true,
				cameraId,
				endpoint,
				message: 'Camera deleted',
				permanentLiveDeleted
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
			   delete cameras[snifferId];
			   await setCameraAssignments(cameras);
			   // Remove sniffer credentials as well
			   if (!storageManager) throw new Error('storageManager not initialized');
			   let sniffers = (await storageManager.getData('sniffers')) || {};
			   delete sniffers[snifferId];
			   await storageManager.storeData('sniffers', sniffers);
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
			const { getPeerTubeCategories } = require('./lib-peertube-api.js');
			const categories = await getPeerTubeCategories({ peertubeHelpers });
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
			const privacies = await getPeerTubePrivacyOptions({ peertubeHelpers });
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
		const snifferId = req.snifferId;
		try {
			   const cameras = await getCameraAssignments();
			const assignments = cameras[snifferId] ? Object.values(cameras[snifferId]) : [];
					   // ...existing code...
			return res.status(200).json({
				snifferId,
				cameraAssignments: assignments,
				totalAssignments: assignments.length,
				serverInfo: {
					timestamp: new Date().toISOString(),
					pluginVersion: '3.7.0'
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
			await setCameraAssignments(cameras);
					   // ...existing code...
			return res.status(200).json({
				success: true,
				message: 'Configuration saved successfully',
				snifferId,
				timestamp: new Date().toISOString(),
				assignmentsCreated: assignments.length,
				permanentLivesDeleted: deleted
			});
		} catch (err) {
			return res.status(500).json({ error: 'PLUGIN_CAMERA_SAVE_FAILED', message: err.message });
		}
	});

	return router;
};
