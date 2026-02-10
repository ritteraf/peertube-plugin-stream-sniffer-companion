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
function findTeamsForCamera(cameraId, hudlMappings) {
	const teamIds = [];
	
	// Iterate through all team mappings to find those with matching cameraId
	for (const teamId in hudlMappings) {
		const mapping = hudlMappings[teamId];
		if (mapping && mapping.cameraId === cameraId) {
			teamIds.push(teamId);
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
		
		const hudlMappings = (await storageManager.getData('hudl-mappings')) || {};
		const schedules = (await storageManager.getData('hudl-schedules')) || {};
		
		// Find all teams using this camera
		const teamIds = findTeamsForCamera(cameraId, hudlMappings);
		
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

// Async fallback: refresh schedules and update live video if match found
async function refreshAndUpdateVideo({
	cameraId,
	snifferId,
	startTime,
	videoId,
	oauthToken,
	storageManager,
	peertubeHelpers,
	settingsManager,
	hudlOrgUrl
}) {
	try {
		console.log('[PLUGIN FALLBACK] Starting async refresh for late-added games, videoId:', videoId);
		
		const hudlMappings = (await storageManager.getData('hudl-mappings')) || {};
		const schedules = (await storageManager.getData('hudl-schedules')) || {};
		
		// Find all teams using this camera
		const teamIds = findTeamsForCamera(cameraId, hudlMappings);
		
		if (teamIds.length === 0) {
			console.log('[PLUGIN FALLBACK] No teams found for camera');
			return null;
		}
		
		console.log('[PLUGIN FALLBACK] Found teams for camera:', teamIds);
		
		// Filter teams by sport season
		const teamsInSeason = teamIds.filter(teamId => {
			const schedule = schedules[teamId];
			if (!schedule || !schedule.sport) return true;
			
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
		const eventTime = new Date(startTime).getTime();
		const earlyWindowMs = 15 * 60 * 1000;
		const maxGameDurationMs = 3 * 60 * 60 * 1000;
		const eventDate = new Date(startTime).setHours(0, 0, 0, 0);
		
		let matchedGame = null;
		let matchedTeamId = null;
		
		for (const teamId of teamsInSeason) {
			const teamData = schedules[teamId];
			if (!teamData || !teamData.games) continue;
			
			for (const game of teamData.games) {
				const gameTimeField = game.timeUtc || game.date;
				if (!gameTimeField) continue;
				
				// Only HOME games, not yet played
				if (game.scheduleEntryLocation !== undefined && game.scheduleEntryLocation !== 1) continue;
				if (game.scheduleEntryOutcome !== undefined && game.scheduleEntryOutcome !== 0) continue;
				
				const gameStartTime = new Date(gameTimeField).getTime();
				const gameDate = new Date(gameTimeField).setHours(0, 0, 0, 0);
				
				// Find next game for upper limit
				let nextGameStartTime = null;
				for (const nextGame of teamData.games) {
					if (nextGame.id === game.id) continue;
					const nextGameTime = new Date(nextGame.timeUtc || nextGame.date).getTime();
					const nextGameDate = new Date(nextGame.timeUtc || nextGame.date).setHours(0, 0, 0, 0);
					if (nextGameDate === gameDate && nextGameTime > gameStartTime) {
						if (!nextGameStartTime || nextGameTime < nextGameStartTime) {
							nextGameStartTime = nextGameTime;
						}
					}
				}
				
				const upperLimit = nextGameStartTime || (gameStartTime + maxGameDurationMs);
				const isEarlyDetection = eventTime < gameStartTime && (gameStartTime - eventTime) <= earlyWindowMs;
				const isInProgress = eventTime >= gameStartTime && eventTime < upperLimit && gameDate === eventDate;
				
				if (isEarlyDetection || isInProgress) {
					matchedGame = game;
					matchedTeamId = teamId;
					console.log('[PLUGIN FALLBACK] ✓ Match found after refresh:', {
						opponent: game.opponentDetails?.name,
						teamName: teamData.teamName,
						gameTime: gameTimeField
					});
					break;
				}
			}
			if (matchedGame) break;
		}
		
		if (!matchedGame) {
			console.log('[PLUGIN FALLBACK] Still no match after refresh');
			return null;
		}
		
		// Update the video with correct metadata
		console.log('[PLUGIN FALLBACK] Updating video', videoId, 'with game metadata...');
		
		const { updateVideoMetadata, buildVideoTags, applyThumbnailToVideo } = require('./lib-peertube-api.js');
		const teamData = schedules[matchedTeamId];
		const teamMapping = hudlMappings[matchedTeamId] || {};
		
		// Build title
		const generatedTitle = matchedGame.generatedTitle;
		
		// Build tags
		const tags = buildVideoTags({
			gender: teamData.gender,
			teamLevel: teamData.teamLevel,
			sport: teamData.sport,
			customTags: teamMapping.customTags || [],
			teamName: teamData.teamName
		});
		
		const teamNameTag = teamMapping.teamName;
		if (teamNameTag && teamNameTag.length >= 2 && teamNameTag.length <= 30) {
			tags.unshift(teamNameTag);
		}
		
		const validTags = tags
			.filter(tag => typeof tag === 'string' && tag.length >= 2 && tag.length <= 30)
			.slice(0, 5);
		
		// Update video metadata
		await updateVideoMetadata({
			videoId,
			updates: {
				name: generatedTitle,
				tags: validTags,
				description: teamMapping.description || `${teamData.teamName} vs ${matchedGame.opponentDetails?.name || 'opponent'}`
			},
			oauthToken,
			peertubeHelpers,
			settingsManager
		});
		
		console.log('[PLUGIN FALLBACK] ✓ Video metadata updated:', generatedTitle);
		
		// Generate and apply thumbnail
		const opponentSchoolId = matchedGame.opponentDetails?.schoolId;
		if (matchedTeamId && opponentSchoolId) {
			try {
				const { generateSingleThumbnail } = require('./lib-thumbnail-generator.js');
				const result = await generateSingleThumbnail({
					homeTeamId: matchedTeamId,
					homeLogo: teamData.logoURL || null,
					awayTeamId: opponentSchoolId,
					awayLogo: matchedGame.opponentDetails?.profileImageUri || null
				});
				
				if (result.path) {
					await applyThumbnailToVideo({
						videoId,
						thumbnailPath: result.path,
						oauthToken,
						peertubeHelpers,
						settingsManager
					});
					console.log('[PLUGIN FALLBACK] ✓ Thumbnail applied to video');
				}
			} catch (err) {
				console.error('[PLUGIN FALLBACK] Failed to apply thumbnail:', err.message);
			}
		}
		
		return { game: matchedGame, teamId: matchedTeamId };
		
	} catch (err) {
		console.error('[PLUGIN FALLBACK] Error in async fallback:', err);
		return null;
	}
}

module.exports = {
	refreshAndRetryMatch,
	refreshAndUpdateVideo,
	isSportInSeason
};
