// Fallback matching logic for late-added HUDL games
// Only used when /recording-started-hudl finds no match in cached schedules

// Sport season date ranges (month-day format)
const SPORT_SEASONS = {
	'Football': { start: [8, 1], end: [11, 30] },
	'Volleyball': { start: [8, 1], end: [11, 30] },
	'Cross Country': { start: [8, 1], end: [11, 30] },
	'Basketball': { start: [11, 1], end: [3, 15] },
	'Wrestling': { start: [11, 1], end: [2, 28] },
	'Soccer': { start: [8, 1], end: [11, 30] }, // Fall soccer (adjust for spring if needed)
	'Baseball': { start: [3, 1], end: [6, 30] },
	'Softball': { start: [3, 1], end: [6, 30] },
	'Track': { start: [3, 1], end: [6, 30] },
	'Golf': { start: [8, 1], end: [10, 31] },
	'Tennis': { start: [8, 1], end: [10, 31] },
	'Swimming': { start: [11, 1], end: [2, 28] }
};

// Check if a sport is currently in season
function isSportInSeason(sport, checkDate = new Date()) {
	const season = SPORT_SEASONS[sport];
	if (!season) {
		// Unknown sport - assume in season to be safe
		return true;
	}

	const month = checkDate.getMonth() + 1; // 1-12
	const day = checkDate.getDate();
	const [startMonth, startDay] = season.start;
	const [endMonth, endDay] = season.end;

	// Handle season that wraps across year (e.g., Wrestling: Nov-Feb)
	if (startMonth > endMonth) {
		// Either after start OR before end
		return (month > startMonth || (month === startMonth && day >= startDay)) ||
		       (month < endMonth || (month === endMonth && day <= endDay));
	} else {
		// Normal season within same year
		return (month > startMonth || (month === startMonth && day >= startDay)) &&
		       (month < endMonth || (month === endMonth && day <= endDay));
	}
}

// Find all teams that use a specific camera
function findTeamsForCamera(cameraId, snifferId, cameraAssignments) {
	const teamIds = [];
	
	// Check assignments for this sniffer
	if (cameraAssignments[snifferId] && cameraAssignments[snifferId][cameraId]) {
		const assignment = cameraAssignments[snifferId][cameraId];
		if (assignment.teamId) {
			teamIds.push(assignment.teamId);
		}
	}
	
	// Also check other sniffers in case camera is shared
	for (const sid in cameraAssignments) {
		if (sid === snifferId) continue; // Already checked
		
		if (cameraAssignments[sid] && cameraAssignments[sid][cameraId]) {
			const assignment = cameraAssignments[sid][cameraId];
			if (assignment.teamId && !teamIds.includes(assignment.teamId)) {
				teamIds.push(assignment.teamId);
			}
		}
	}
	
	return teamIds;
}

// Fallback: refresh teams for a camera and retry matching
async function refreshAndRetryMatch({ 
	cameraId, 
	snifferId, 
	startTime,
	storageManager, 
	hudlOrgUrl 
}) {
	try {
		console.log('[PLUGIN FALLBACK] No game match found - attempting fallback refresh for camera:', cameraId);
		
		const cameraAssignments = (await storageManager.getData('camera-assignments')) || {};
		const schedules = (await storageManager.getData('hudl-schedules')) || {};
		
		// Find all teams using this camera
		const teamIds = findTeamsForCamera(cameraId, snifferId, cameraAssignments);
		
		if (teamIds.length === 0) {
			console.log('[PLUGIN FALLBACK] No teams found for camera');
			return null;
		}
		
		console.log('[PLUGIN FALLBACK] Found teams for camera:', teamIds);
		
		// Filter teams by sport season
		const teamsInSeason = teamIds.filter(teamId => {
			const schedule = schedules[teamId];
			if (!schedule || !schedule.sport) return true; // Include if unknown
			
			const inSeason = isSportInSeason(schedule.sport);
			console.log(`[PLUGIN FALLBACK] Team ${schedule.teamName} (${schedule.sport}): ${inSeason ? 'IN SEASON' : 'OUT OF SEASON'}`);
			return inSeason;
		});
		
		if (teamsInSeason.length === 0) {
			console.log('[PLUGIN FALLBACK] No teams currently in season - skipping refresh');
			return null;
		}
		
		console.log('[PLUGIN FALLBACK] Refreshing schedules for', teamsInSeason.length, 'teams in season');
		
		// Refresh HUDL schedules for teams in season
		const hudl = require('./lib-hudl-scraper.js');
		const hudlLimiter = require('./lib-hudl-rate-limiter.js');
		const { generateGameTitle } = require('./lib-game-title.js');
		
		const school = await hudlLimiter.enqueue(() => hudl.fetchSchoolData(hudlOrgUrl, snifferId));
		
		for (const teamId of teamsInSeason) {
			const team = (school.teamHeaders || []).find(t => t.id === teamId);
			if (!team) continue;
			
			try {
				const games = await hudlLimiter.enqueue(() => hudl.fetchTeamSchedule(team.id, snifferId));
				
				// Add generated titles
				const teamData = {
					sport: team.sport,
					gender: team.gender,
					teamLevel: team.teamLevel
				};
				const gamesWithTitles = games.map(game => ({
					...game,
					generatedTitle: generateGameTitle(game, teamData, school.fullName)
				}));
				
				// Update schedule in storage
				schedules[team.id] = {
					teamId: team.id,
					teamName: team.name,
					sport: team.sport,
					gender: team.gender,
					teamLevel: team.teamLevel,
					seasonYear: team.currentSeasonYear || null,
					logoURL: team.logo,
					games: gamesWithTitles,
					lastScraped: new Date().toISOString()
				};
				
				console.log(`[PLUGIN FALLBACK] Refreshed ${team.name}: ${gamesWithTitles.length} games`);
			} catch (err) {
				console.error(`[PLUGIN FALLBACK] Failed to refresh team ${team.name}:`, err.message);
			}
		}
		
		await storageManager.storeData('hudl-schedules', schedules);
		
		// Re-run matching logic with updated schedules
		const { matchGameToSchedule } = require('./lib-game-title.js');
		const matchedGame = matchGameToSchedule(schedules, startTime);
		
		if (matchedGame) {
			console.log('[PLUGIN FALLBACK] Match found after refresh:', matchedGame.teamId, matchedGame.game.generatedTitle);
			return matchedGame;
		}
		
		console.log('[PLUGIN FALLBACK] Still no match after refresh');
		return null;
		
	} catch (err) {
		console.error('[PLUGIN FALLBACK] Error in fallback matching:', err);
		return null;
	}
}

module.exports = {
	refreshAndRetryMatch,
	isSportInSeason
};
