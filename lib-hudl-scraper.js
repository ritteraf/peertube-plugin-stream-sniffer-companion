
// HUDL scraper: GraphQL client with rate limiting and full query support
const fetch = require('node-fetch');

const HUDL_GRAPHQL_URL = 'https://www.hudl.com/api/public/graphql/query';

async function hudlGraphQL({ query, variables, operationName, snifferId }) {
	const res = await fetch(HUDL_GRAPHQL_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Origin': 'https://fan.hudl.com',
			'Referer': 'https://fan.hudl.com/'
		},
		body: JSON.stringify({ query, variables, operationName })
	});
	if (!res.ok) throw new Error(`HUDL GraphQL external error: ${res.status}`);
	const json = await res.json();
	if (json.errors) throw new Error('HUDL GraphQL external: ' + json.errors.map(e => e.message).join(', '));
	return json.data;
}

// Extract org ID from HUDL org URL
function extractOrgId(orgUrl) {
	const m = orgUrl.match(/organization\/(\d+)/);
	return m ? m[1] : null;
}

// Validate HUDL org URL
function validateOrgUrl(url) {
	return /^https?:\/\/fan\.hudl\.com\/[^/]+\/[^/]+\/[^/]+\/organization\/\d+\/.+/.test(url);
}

// Fetch school/org info and teams
async function fetchSchoolData(orgUrl, snifferId) {
	const orgId = extractOrgId(orgUrl);
	if (!orgId) throw new Error('Invalid HUDL org URL');
	const query = `
		query Web_Fan_GetSchool_r1($internalSchoolId: String) {
			school(internalSchoolId: $internalSchoolId) {
				fullName
				id
				internalId
				teamHeaders {
					id
					internalId
					name
					sport
					gender
					teamLevel
					currentSeasonYear
					logo
					__typename
				}
				__typename
			}
		}
	`;
	const variables = { internalSchoolId: orgId };
	const data = await hudlGraphQL({ query, variables, operationName: 'Web_Fan_GetSchool_r1', snifferId });
	if (!data.school) throw new Error('HUDL: School not found');
	return data.school;
}


// Fetch all seasons for a team (returns array of { seasonId, year, seasonRecord })
async function fetchTeamSeasons(teamId, snifferId) {
	const query = `
		query Web_Fan_GetTeamSeasonAndHistory_r1($teamId: ID, $internalTeamId: String) {
			teamHeader(teamId: $teamId, internalTeamId: $internalTeamId) {
				currentSeason {
					seasonId
					year
					seasonRecord {
						wins
						losses
						draws
						__typename
					}
					__typename
				}
				seasons {
					seasonId
					year
					seasonRecord {
						wins
						losses
						draws
						__typename
					}
					__typename
				}
				__typename
			}
		}
	`;
	const variables = { teamId };
	const data = await hudlGraphQL({ query, variables, operationName: 'Web_Fan_GetTeamSeasonAndHistory_r1', snifferId });
	if (!data.teamHeader || !data.teamHeader.seasons) throw new Error('HUDL: No seasons for team');
	return data.teamHeader.seasons;
}

// Fetch current season for a team (legacy, returns just the current season)
async function fetchTeamSeason(teamId, snifferId) {
	const seasons = await fetchTeamSeasons(teamId, snifferId);
	// Find the most recent season (highest year)
	if (!seasons || !seasons.length) throw new Error('HUDL: No seasons for team');
	return seasons.reduce((a, b) => (a.year > b.year ? a : b));
}

// Fetch schedule for a team (returns array of games)
async function fetchTeamSchedule(teamId, snifferId) {
	const season = await fetchTeamSeason(teamId, snifferId);
	const query = `
		query Web_Fan_GetScheduleEntrySummaries_r1($input: GetScheduleEntryPublicSummariesInput!) {
			scheduleEntryPublicSummaries(input: $input) {
				items {
					id
					scheduleEntryId
					timeUtc
					opponentDetails {
						name
						schoolId
						mascot
						profileImageUri
						__typename
					}
					scheduleEntryLocation
					scheduleEntryOutcome
					broadcastStatus
					__typename
				}
				__typename
			}
		}
	`;
	const variables = {
		input: {
			teamIds: [teamId],
			seasonIds: [season.seasonId],
			sortType: 'SCHEDULE_ENTRY_DATE',
			sortByAscending: true
		}
	};
	const data = await hudlGraphQL({ query, variables, operationName: 'Web_Fan_GetScheduleEntrySummaries_r1', snifferId });
	if (!data.scheduleEntryPublicSummaries || !data.scheduleEntryPublicSummaries.items) return [];
	return data.scheduleEntryPublicSummaries.items;
}

// Fetch broadcast details by scheduleEntryId (for custom titles and metadata)
async function fetchBroadcast(scheduleEntryId, snifferId) {
	if (!scheduleEntryId) return null;
	const query = `
		query Web_Fan_GetBroadcastByScheduleEntryId_r1($scheduleEntryId: ID!) {
			getBroadcastByScheduleEntryId(scheduleEntryId: $scheduleEntryId) {
				accessPassIds
				available
				broadcastDateUtc
				broadcastId
				bsonId
				dateModified
				description
				domainBlocking
				downloadUrl
				duration
				embedCode
				embedCodeSrc
				hidden
				id
				internalId
				largeThumbnail
				liveDuration
				mediumThumbnail
				regionBlocking
				requireLogin
				scheduleEntryId
				schoolId
				seasonId
				sectionId
				sectionTitle
				shared
				sharedSites
				siteId
				siteSlug
				siteTitle
				smallThumbnail
				sourceBroadcastId
				status
				teamId
				timezone
				title
				uploadSource
				__typename
			}
		}
	`;
	const variables = { scheduleEntryId };
	try {
		const data = await hudlGraphQL({ query, variables, operationName: 'Web_Fan_GetBroadcastByScheduleEntryId_r1', snifferId });
		return data.getBroadcastByScheduleEntryId || null;
	} catch (err) {
		console.warn('[HUDL] Failed to fetch broadcast:', err.message);
		return null;
	}
}

module.exports = {
	hudlGraphQL,
	fetchSchoolData,
	fetchTeamSeason,
	fetchTeamSeasons,
	fetchTeamSchedule,
	fetchBroadcast,
	extractOrgId,
	validateOrgUrl
};
