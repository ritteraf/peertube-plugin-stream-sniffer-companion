
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
			const videoIdsToDelete = cameras[snifferId] ? Object.values(cameras[snifferId]).map(c => c.permanentLiveVideoId).filter(Boolean) : [];
			
			// Get sniffer's OAuth token for PeerTube API calls
			const sniffers = (await storageManager.getData('sniffers')) || {};
			const snifferEntry = sniffers[snifferId];
			const oauthToken = snifferEntry && snifferEntry.oauthToken;
			
			// Delete videos from PeerTube
			const permanentLivesDeleted = [];
			if (oauthToken && videoIdsToDelete.length > 0) {
				const { deleteVideo } = require('./lib-peertube-api.js');
				for (const videoId of videoIdsToDelete) {
					try {
						await deleteVideo(videoId, oauthToken, peertubeHelpers, settingsManager, snifferId, storageManager);
						permanentLivesDeleted.push(videoId);
						peertubeHelpers.logger.info(`[DELETE /cameras] Deleted video ${videoId} from PeerTube`);
					} catch (err) {
						peertubeHelpers.logger.error(`[DELETE /cameras] Failed to delete video ${videoId}: ${err.message}`);
					}
				}
			}
			
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
			let permanentLiveVideoId = null;
			let permanentLiveDeleted = false;
			
			if (cameras[snifferId] && cameras[snifferId][cameraId]) {
				endpoint = cameras[snifferId][cameraId].endpointPath;
				permanentLiveVideoId = cameras[snifferId][cameraId].permanentLiveVideoId;
				
				// Get sniffer's OAuth token and delete video from PeerTube
				if (permanentLiveVideoId) {
					const sniffers = (await storageManager.getData('sniffers')) || {};
					const snifferEntry = sniffers[snifferId];
					const oauthToken = snifferEntry && snifferEntry.oauthToken;
					
					if (oauthToken) {
						const { deleteVideo } = require('./lib-peertube-api.js');
						try {
							await deleteVideo(permanentLiveVideoId, oauthToken, peertubeHelpers, settingsManager, snifferId, storageManager);
							permanentLiveDeleted = true;
							peertubeHelpers.logger.info(`[DELETE /cameras/${cameraId}] Deleted video ${permanentLiveVideoId} from PeerTube`);
						} catch (err) {
							peertubeHelpers.logger.error(`[DELETE /cameras/${cameraId}] Failed to delete video ${permanentLiveVideoId}: ${err.message}`);
						}
					}
				}
				
				delete cameras[snifferId][cameraId];
				await setCameraAssignments(cameras);
			}
			return res.status(200).json({
				deleted: true,
				cameraId,
				endpoint,
				message: 'Camera deleted',
				permanentLiveDeleted,
				permanentLiveVideoId: permanentLiveDeleted ? permanentLiveVideoId : null
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
			const videoIdsToDelete = cameras[snifferId] ? Object.values(cameras[snifferId]).map(c => c.permanentLiveVideoId).filter(Boolean) : [];
			
			// Get sniffer's OAuth token for PeerTube API calls
			if (!storageManager) throw new Error('storageManager not initialized');
			let sniffers = (await storageManager.getData('sniffers')) || {};
			const snifferEntry = sniffers[snifferId];
			const oauthToken = snifferEntry && snifferEntry.oauthToken;
			
			// Delete videos from PeerTube
			const permanentLivesDeleted = [];
			if (oauthToken && videoIdsToDelete.length > 0) {
				const { deleteVideo } = require('./lib-peertube-api.js');
				for (const videoId of videoIdsToDelete) {
					try {
						await deleteVideo(videoId, oauthToken, peertubeHelpers, settingsManager, snifferId, storageManager);
						permanentLivesDeleted.push(videoId);
						peertubeHelpers.logger.info(`[POST /reset-all] Deleted video ${videoId} from PeerTube`);
					} catch (err) {
						peertubeHelpers.logger.error(`[POST /reset-all] Failed to delete video ${videoId}: ${err.message}`);
					}
				}
			}
			
			delete cameras[snifferId];
			await setCameraAssignments(cameras);
			// Remove sniffer credentials as well
			delete sniffers[snifferId];
			await storageManager.storeData('sniffers', sniffers);
			return res.status(200).json({
				resetComplete: true,
				deleted: {
					cameras: deletedCameras,
					oauthTokens: true,
					encryptedCredentials: true,
					registryEntry: true,
					permanentLiveVideos: permanentLivesDeleted.length
				},
				permanentLivesDeleted,
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
			// Build sets for new, deleted, and changed cameras
			const newIds = new Set(assignments.map(a => a.cameraId));
			const hudlPattern = /^rtmp:\/\/.*\/live\//;
			// Find deleted, renamed, or changed-to-non-HUDL cameras
			const affectedCameraIds = new Set();
			if (cameras[snifferId]) {
				for (const camId of Object.keys(cameras[snifferId])) {
					const oldAssignment = cameras[snifferId][camId];
					const newAssignment = assignments.find(a => a.cameraId === camId);
					// Deleted: not in new list
					if (!newIds.has(camId)) {
						affectedCameraIds.add(camId);
						delete cameras[snifferId][camId];
						continue;
					}
					// Renamed: cameraId changed
					if (newAssignment && oldAssignment.cameraId !== newAssignment.cameraId) {
						affectedCameraIds.add(camId);
						continue;
					}
					// Changed to non-HUDL: URL pattern no longer matches
					if (newAssignment && oldAssignment.endpointPath && newAssignment.endpointPath &&
						hudlPattern.test(oldAssignment.endpointPath) && !hudlPattern.test(newAssignment.endpointPath)) {
						affectedCameraIds.add(camId);
						continue;
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

			// Auto-cleanup HUDL team mappings for affected cameras
			if (storageManager) {
				let hudlMappings = (await storageManager.getData('hudl-mappings')) || {};
				let updated = false;
				for (const teamId in hudlMappings) {
					const mapping = hudlMappings[teamId];
					if (mapping && affectedCameraIds.has(mapping.cameraId)) {
						mapping.cameraId = '';
						updated = true;
					}
				}
				if (updated) {
					await storageManager.storeData('hudl-mappings', hudlMappings);
				}
			}
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
