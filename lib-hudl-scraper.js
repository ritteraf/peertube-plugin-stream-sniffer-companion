
// HUDL scraper: GraphQL client with rate limiting and full query support
const fetch = require('node-fetch');

const HUDL_GRAPHQL_URL = 'https://www.hudl.com/api/public/graphql/query';
const RATE_LIMIT = 15;
const WINDOW_MS = 60 * 1000;
const rateLimitMap = {};

function checkRateLimit(snifferId) {
	const now = Date.now();
	if (!rateLimitMap[snifferId]) rateLimitMap[snifferId] = [];
	rateLimitMap[snifferId] = rateLimitMap[snifferId].filter(ts => now - ts < WINDOW_MS);
	if (rateLimitMap[snifferId].length >= RATE_LIMIT) return false;
	rateLimitMap[snifferId].push(now);
	return true;
}

async function hudlGraphQL({ query, variables, operationName, snifferId }) {
		       if (!checkRateLimit(snifferId)) {
			       console.warn(`[PLUGIN HUDL] Per-sniffer internal rate limit exceeded for snifferId: ${snifferId}`);
			       throw new Error('HUDL internal rate limit exceeded');
		       }
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

// Fetch current season for a team
async function fetchTeamSeason(teamId, snifferId) {
	const query = `
		query Web_Fan_GetTeamSeasonAndHistory_r1($teamId: ID) {
			teamHeader(teamId: $teamId) {
				currentSeason {
					seasonId
					year
					__typename
				}
				__typename
			}
		}
	`;
	const variables = { teamId };
	const data = await hudlGraphQL({ query, variables, operationName: 'Web_Fan_GetTeamSeasonAndHistory_r1', snifferId });
	if (!data.teamHeader || !data.teamHeader.currentSeason) throw new Error('HUDL: No current season for team');
	return data.teamHeader.currentSeason;
}

// Fetch schedule for a team (returns array of games)
async function fetchTeamSchedule(teamId, snifferId) {
	const season = await fetchTeamSeason(teamId, snifferId);
	const query = `
		query Web_Fan_GetScheduleEntrySummaries_r1($input: GetScheduleEntryPublicSummariesInput!) {
			scheduleEntryPublicSummaries(input: $input) {
				items {
					id
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

module.exports = {
	hudlGraphQL,
	fetchSchoolData,
	fetchTeamSeason,
	fetchTeamSchedule,
	extractOrgId,
	validateOrgUrl
};
