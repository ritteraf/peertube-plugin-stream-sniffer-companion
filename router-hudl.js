// HUDL endpoints

// Export a factory function for dependency injection
module.exports = function createHudlRouter({ storageManager, settingsManager, peertubeHelpers }) {
	const express = require('express');
	const router = express.Router();
	const { requireAuth } = require('./lib-auth-manager.js');

	// Centralized HUDL rate limiter
	const hudlLimiter = require('./lib-hudl-rate-limiter.js');

	// GET /hudl/organization
	const hudl = require('./lib-hudl-scraper.js');
	router.get('/organization', requireAuth, async (req, res) => {
	       let hudlOrgUrl = '';
	       if (settingsManager) {
		       hudlOrgUrl = await settingsManager.getSetting('hudl-org-url');
	       }
	       if (!hudlOrgUrl && storageManager) {
		       const settings = (await storageManager.getData('settings')) || {};
		       hudlOrgUrl = settings['hudl-org-url'] || '';
	       }
	       hudlOrgUrl = hudlOrgUrl || process.env.HUDL_ORG_URL || '';
	       if (!hudlOrgUrl) {
		       return res.status(200).json({
			       configured: false,
			       message: 'HUDL organization URL not configured'
		       });
	       }
		       try {
			       const school = await hudlLimiter.enqueue(() => hudl.fetchSchoolData(hudlOrgUrl, req.snifferId));
		       const org = {
			       name: school.fullName,
			       id: school.id,
			       orgURL: hudlOrgUrl
		       };
		       const teams = (school.teamHeaders || []).map(team => ({
			       teamId: team.id,
			       teamName: team.name,
			       sport: team.sport,
			       gender: team.gender,
			       level: team.teamLevel,
			       logoURL: team.logo,
			       currentSeason: team.currentSeasonYear,
			       mapped: false,
			       channelId: null,
			       permanentLiveVideoId: null,
			       rtmpUrl: null,
			       streamKey: null
		       }));
		       return res.status(200).json({
			       configured: true,
			       organization: org,
			       teams,
			       message: `Found ${teams.length} teams`
		       });
	       } catch (err) {
		       return res.status(500).json({
			       configured: false,
			       message: 'Failed to fetch HUDL organization info',
			       error: err.message
		       });
	       }
	});

	// POST /hudl/teams
	router.post('/teams', requireAuth, async (req, res) => {
		const { teams } = req.body || {};
		if (!Array.isArray(teams) || teams.length === 0) {
			return res.status(400).json({
				success: false,
				message: 'No teams provided',
				results: []
			});
		}
		for (const team of teams) {
			if (!team.teamId || typeof team.teamId !== 'string' || !team.teamName || typeof team.teamName !== 'string' || typeof team.channelId !== 'number') {
				return res.status(400).json({
					success: false,
					message: 'Each team must have teamId (string), teamName (string), and channelId (number)',
					results: []
				});
			}
		}
		// Save mapping to persistent storage
		if (!storageManager) return res.status(500).json({ error: 'PLUGIN_STORAGE_NOT_INITIALIZED' });
		let hudlMappings = (await storageManager.getData('hudl-mappings')) || {};
		const results = [];
		for (const team of teams) {
			// Save mapping
			hudlMappings[team.teamId] = {
				teamId: team.teamId,
				teamName: team.teamName,
				channelId: team.channelId
			};
			results.push({
				teamName: team.teamName,
				success: true,
				channelId: team.channelId,
				gamesFound: null,
				error: null
			});
		}
		await storageManager.storeData('hudl-mappings', hudlMappings);
		return res.status(200).json({
			success: true,
			message: 'Teams mapped successfully',
			results
		});
	});

	// POST /hudl/match-game
	router.post('/match-game', requireAuth, async (req, res) => {
	       if (!checkHudlRateLimit(req.snifferId, res)) return;
	       const { timestamp, windowMinutes } = req.body || {};
	       if (!timestamp || typeof timestamp !== 'string' || typeof windowMinutes !== 'number') {
		       return res.status(400).json({
			       found: false,
			       message: 'timestamp (string) and windowMinutes (number) are required'
		       });
	       }
	       try {
		       // Use HUDL API to find the game
		       let hudlOrgUrl = '';
		       if (settingsManager) {
			       hudlOrgUrl = await settingsManager.getSetting('hudl-org-url');
		       }
		       if (!hudlOrgUrl && storageManager) {
			       const settings = (await storageManager.getData('settings')) || {};
			       hudlOrgUrl = settings['hudl-org-url'] || '';
		       }
		       hudlOrgUrl = hudlOrgUrl || process.env.HUDL_ORG_URL || '';
		       if (!hudlOrgUrl) {
			       return res.status(400).json({ found: false, message: 'HUDL organization URL not configured' });
		       }
			   const school = await hudlLimiter.enqueue(() => hudl.fetchSchoolData(hudlOrgUrl, req.snifferId));
		       let foundGame = null;
		       let foundTeam = null;
		       for (const team of (school.teamHeaders || [])) {
				   const games = await hudlLimiter.enqueue(() => hudl.fetchTeamSchedule(team.id, req.snifferId));
			       for (const g of games) {
				       const gameTime = new Date(g.timeUtc).getTime();
				       const reqTime = new Date(timestamp).getTime();
				       if (Math.abs(gameTime - reqTime) <= windowMinutes * 60 * 1000) {
					       foundGame = g;
					       foundTeam = team;
					       break;
				       }
			       }
			       if (foundGame) break;
		       }
		       if (!foundGame) {
			       return res.status(200).json({ found: false, message: 'No matching game found' });
		       }
		       // Lookup channel mapping
		       const hudlMappings = (await storageManager.getData('hudl-mappings')) || {};
		       const mapping = hudlMappings[foundTeam.id] || {};
		       return res.status(200).json({
			       found: true,
			       game: foundGame,
			       channelId: mapping.channelId || null,
			       permanentLiveVideoId: mapping.permanentLiveVideoId || null,
			       permanentLiveRtmpUrl: mapping.permanentLiveRtmpUrl || null,
			       permanentLiveStreamKey: mapping.permanentLiveStreamKey || null,
			       message: 'Game matched'
		       });
	       } catch (err) {
		       return res.status(500).json({ found: false, message: 'Failed to match game', error: err.message });
	       }
	});

	// GET /hudl/schedules
	router.get('/schedules', requireAuth, async (req, res) => {
	       let hudlOrgUrl = '';
	       if (settingsManager) {
		       hudlOrgUrl = await settingsManager.getSetting('hudl-org-url');
	       }
	       if (!hudlOrgUrl && storageManager) {
		       const settings = (await storageManager.getData('settings')) || {};
		       hudlOrgUrl = settings['hudl-org-url'] || '';
	       }
	       hudlOrgUrl = hudlOrgUrl || process.env.HUDL_ORG_URL || '';
	       const { teamId } = req.query;
	       if (!hudlOrgUrl) {
		       return res.status(400).json({
			       success: false,
			       message: 'HUDL organization URL not configured',
			       teams: [],
			       totalTeams: 0
		       });
	       }
	       if (teamId && typeof teamId !== 'string') {
		       return res.status(400).json({
			       success: false,
			       message: 'teamId query parameter must be a string',
			       teams: [],
			       totalTeams: 0
		       });
	       }
	       try {
			   const school = await hudlLimiter.enqueue(() => hudl.fetchSchoolData(hudlOrgUrl, req.snifferId));
		       let teams = (school.teamHeaders || []);
		       if (teamId) teams = teams.filter(t => t.id === teamId);
		       const result = [];
		       for (const team of teams) {
			       let games = [];
			       try {
					   games = await hudlLimiter.enqueue(() => hudl.fetchTeamSchedule(team.id, req.snifferId));
			       } catch (e) {}
			       result.push({
				       teamId: team.id,
				       teamName: team.name,
				       channelId: null,
				       sport: team.sport,
				       logoURL: team.logo,
				       upcomingGames: (games || []).map(g => ({
					       id: g.id,
					       date: g.timeUtc,
					       opponent: g.opponentDetails && g.opponentDetails.name,
					       opponentMascot: g.opponentDetails && g.opponentDetails.mascot,
					       opponentLogoURL: g.opponentDetails && g.opponentDetails.profileImageUri,
					       isHome: g.scheduleEntryLocation === 1,
					       broadcastStatus: g.broadcastStatus
				       })),
				       lastScraped: new Date().toISOString()
			       });
		       }
		       return res.status(200).json({
			       teams: result,
			       totalTeams: result.length
		       });
	       } catch (err) {
		       return res.status(500).json({
			       teams: [],
			       totalTeams: 0,
			       message: 'Failed to fetch HUDL schedules',
			       error: err.message
		       });
	       }
	});

	// POST /hudl/schedules/refresh
	router.post('/schedules/refresh', requireAuth, async (req, res) => {
	       let hudlOrgUrl = '';
	       if (settingsManager) {
		       hudlOrgUrl = await settingsManager.getSetting('hudl-org-url');
	       }
	       if (!hudlOrgUrl && storageManager) {
		       const settings = (await storageManager.getData('settings')) || {};
		       hudlOrgUrl = settings['hudl-org-url'] || '';
	       }
	       hudlOrgUrl = hudlOrgUrl || process.env.HUDL_ORG_URL || '';
	       const { teams } = req.body || {};
	       if (!hudlOrgUrl) {
		       return res.status(400).json({
			       success: false,
			       message: 'HUDL organization URL not configured',
			       results: []
		       });
	       }
	       if (teams && (!Array.isArray(teams) || teams.length === 0)) {
		       return res.status(400).json({
			       success: false,
			       message: 'If provided, teams must be a non-empty array',
			       results: []
		       });
	       }
	       try {
			   const school = await hudlLimiter.enqueue(() => hudl.fetchSchoolData(hudlOrgUrl, req.snifferId));
		       let teamHeaders = (school.teamHeaders || []);
		       if (teams) {
			       const teamIds = teams.map(t => t.teamId);
			       teamHeaders = teamHeaders.filter(t => teamIds.includes(t.id));
		       }
		       let schedules = (await storageManager.getData('hudl-schedules')) || {};
		       const results = [];
		       for (const team of teamHeaders) {
			       let games = [];
			       let error = null;
			       try {
					   games = await hudlLimiter.enqueue(() => hudl.fetchTeamSchedule(team.id, req.snifferId));
			       } catch (e) { error = e.message; }
			       schedules[team.id] = {
				       teamId: team.id,
				       teamName: team.name,
				       sport: team.sport,
				       logoURL: team.logo,
				       games,
				       lastScraped: new Date().toISOString()
			       };
			       results.push({
				       teamName: team.name,
				       refreshed: !error,
				       cached: false,
				       gamesCount: games.length,
				       error
			       });
		       }
		       await storageManager.storeData('hudl-schedules', schedules);
		       return res.status(200).json({
			       success: true,
			       message: 'Schedules refreshed',
			       results
		       });
	       } catch (err) {
		       return res.status(500).json({
			       success: false,
			       message: 'Failed to refresh schedules',
			       results: [],
			       error: err.message
		       });
	       }
	});

	// POST /hudl/schedules/refresh/:teamId
	router.post('/schedules/refresh/:teamId', requireAuth, async (req, res) => {
	       let hudlOrgUrl = '';
	       if (settingsManager) {
		       hudlOrgUrl = await settingsManager.getSetting('hudl-org-url');
	       }
	       if (!hudlOrgUrl && storageManager) {
		       const settings = (await storageManager.getData('settings')) || {};
		       hudlOrgUrl = settings['hudl-org-url'] || '';
	       }
	       hudlOrgUrl = hudlOrgUrl || process.env.HUDL_ORG_URL || '';
	       const { teamId } = req.params;
	       if (!hudlOrgUrl) {
		       return res.status(400).json({
			       success: false,
			       message: 'HUDL organization URL not configured',
			       error: 'Not configured'
		       });
	       }
	       if (!teamId || typeof teamId !== 'string') {
		       return res.status(400).json({
			       success: false,
			       message: 'teamId (string) is required in URL',
			       error: 'Invalid teamId'
		       });
	       }
	       try {
			   const school = await hudlLimiter.enqueue(() => hudl.fetchSchoolData(hudlOrgUrl, req.snifferId));
		       const team = (school.teamHeaders || []).find(t => t.id === teamId);
		       if (!team) {
			       return res.status(404).json({
				       success: false,
				       message: 'Team not found',
				       error: 'Not found'
			       });
		       }
		       let games = [];
		       let error = null;
		       try {
				   games = await hudlLimiter.enqueue(() => hudl.fetchTeamSchedule(team.id, req.snifferId));
		       } catch (e) { error = e.message; }
		       let schedules = (await storageManager.getData('hudl-schedules')) || {};
		       schedules[team.id] = {
			       teamId: team.id,
			       teamName: team.name,
			       sport: team.sport,
			       logoURL: team.logo,
			       games,
			       lastScraped: new Date().toISOString()
		       };
		       await storageManager.storeData('hudl-schedules', schedules);
		       return res.status(200).json({
			       teamName: team.name,
			       refreshed: !error,
			       cached: false,
			       gamesCount: games.length,
			       error
		       });
	       } catch (err) {
		       return res.status(500).json({
			       success: false,
			       message: 'Failed to refresh team schedule',
			       error: err.message
		       });
	       }
	});

	return router;
};
