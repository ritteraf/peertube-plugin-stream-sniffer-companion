

// Camera registry: camera assignment storage using PeerTube's storageManager
let storageManager = null;
function setStorageManager(sm) { storageManager = sm; }

// Async: get all assignments for a sniffer
async function getAssignments(snifferId) {
	if (!storageManager) throw new Error('storageManager not initialized');
	const cameras = (await storageManager.getData('camera-assignments')) || {};
	return cameras[snifferId] ? Object.values(cameras[snifferId]) : [];
}

// Async: save all assignments for a sniffer
async function saveAssignments(snifferId, assignments) {
	if (!storageManager) throw new Error('storageManager not initialized');
	const cameras = (await storageManager.getData('camera-assignments')) || {};
	cameras[snifferId] = {};
	for (const assignment of assignments) {
		cameras[snifferId][assignment.cameraId] = assignment;
	}
	await storageManager.storeData('camera-assignments', cameras);
}

// Async: delete a single assignment for a sniffer
async function deleteAssignment(snifferId, cameraId) {
	if (!storageManager) throw new Error('storageManager not initialized');
	const cameras = (await storageManager.getData('camera-assignments')) || {};
	if (cameras[snifferId]) {
		delete cameras[snifferId][cameraId];
		await storageManager.storeData('camera-assignments', cameras);
	}
}

// Async: delete all assignments for a sniffer
async function deleteAllAssignments(snifferId) {
	if (!storageManager) throw new Error('storageManager not initialized');
	const cameras = (await storageManager.getData('camera-assignments')) || {};
	delete cameras[snifferId];
	await storageManager.storeData('camera-assignments', cameras);
}

module.exports = {
	setStorageManager,
	getAssignments,
	saveAssignments,
	deleteAssignment,
	deleteAllAssignments
};
