
// Camera registry: camera assignment storage
const { readJson, writeJson } = require('./lib-auth-manager.js');

function getAssignments(snifferId) {
	const cameras = readJson('cameras');
	return cameras[snifferId] ? Object.values(cameras[snifferId]) : [];
}

function saveAssignments(snifferId, assignments) {
	const cameras = readJson('cameras');
	cameras[snifferId] = {};
	for (const assignment of assignments) {
		cameras[snifferId][assignment.cameraId] = assignment;
	}
	writeJson('cameras', cameras);
}

function deleteAssignment(snifferId, cameraId) {
	const cameras = readJson('cameras');
	if (cameras[snifferId]) {
		delete cameras[snifferId][cameraId];
		writeJson('cameras', cameras);
	}
}

function deleteAllAssignments(snifferId) {
	const cameras = readJson('cameras');
	delete cameras[snifferId];
	writeJson('cameras', cameras);
}

module.exports = {
	getAssignments,
	saveAssignments,
	deleteAssignment,
	deleteAllAssignments
};
