/**
 * Shared thumbnail generation functions
 */

const fs = require('fs');
const path = require('path');
const { generateMatchupThumbnail, getMatchupKey, THUMBNAIL_DIR } = require('./lib-matchup-thumbnail.js');

/**
 * Generate thumbnails for all matchups in team schedules
 * @param {Object} schedules - Team schedules object from storage
 * @returns {Promise<{generated: number, cached: number}>}
 */
async function generateThumbnailsFromSchedules(schedules) {
	let imageCacheHits = 0;
	let imageGenerated = 0;
	const promises = [];

	for (const teamId in schedules) {
		const team = schedules[teamId];
		const games = team.games || [];
		
		for (const game of games) {
			const homeId = teamId || 'no_logo';
			const homeLogo = team.logoURL || null;
			const awayId = (game.opponentDetails && game.opponentDetails.schoolId) || 'no_logo';
			const awayLogo = (game.opponentDetails && game.opponentDetails.profileImageUri) || null;
			
			const matchupKey = getMatchupKey(homeId, awayId);
			const thumbnailPath = path.join(THUMBNAIL_DIR, matchupKey);
			
			if (fs.existsSync(thumbnailPath)) {
				imageCacheHits++;
			} else {
				const promise = generateMatchupThumbnail(homeLogo, awayLogo, homeId, awayId)
					.then(() => { imageGenerated++; })
					.catch(thumbErr => {
						console.warn(`[PLUGIN HUDL] Failed to generate matchup thumbnail for ${homeId} vs ${awayId}:`, thumbErr.message);
					});
				promises.push(promise);
			}
		}
	}

	await Promise.all(promises);
	
	return {
		generated: imageGenerated,
		cached: imageCacheHits
	};
}

/**
 * Generate a single matchup thumbnail if it doesn't exist
 * @param {Object} params
 * @param {string} params.homeTeamId - Home team ID
 * @param {string} params.homeLogo - Home team logo URL
 * @param {string} params.awayTeamId - Away team ID (opponentDetails.schoolId)
 * @param {string} params.awayLogo - Away team logo URL
 * @returns {Promise<{generated: boolean, path: string|null}>}
 */
async function generateSingleThumbnail({ homeTeamId, homeLogo, awayTeamId, awayLogo }) {
	const homeId = homeTeamId || 'no_logo';
	const awayId = awayTeamId || 'no_logo';
	const matchupKey = getMatchupKey(homeId, awayId);
	const thumbnailPath = path.join(THUMBNAIL_DIR, matchupKey);

	if (fs.existsSync(thumbnailPath)) {
		return {
			generated: false,
			path: thumbnailPath
		};
	}

	try {
		await generateMatchupThumbnail(homeLogo, awayLogo, homeId, awayId);
		return {
			generated: true,
			path: thumbnailPath
		};
	} catch (err) {
		console.warn(`[PLUGIN HUDL] Failed to generate thumbnail for ${homeId} vs ${awayId}:`, err.message);
		return {
			generated: false,
			path: null
		};
	}
}

module.exports = {
	generateThumbnailsFromSchedules,
	generateSingleThumbnail
};
