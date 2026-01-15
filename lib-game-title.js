// Shared utility for generating consistent game titles from HUDL metadata
// Used by: main.js (during refresh), router-recording.js (during recording start)

function generateGameTitle(game, teamData, schoolName) {
  if (!game || !teamData) return null;

  // Strip school suffixes for cleaner titles (aesthetic only - not used for matching)
  const stripSchoolSuffix = (name) => {
    if (!name) return name;
    return name
      .replace(/\s+High School$/i, '')
      .replace(/\s+Junior High$/i, '')
      .replace(/\s+Middle School$/i, '')
      .replace(/\s+HS$/i, '')
      .replace(/\s+JH$/i, '')
      .replace(/\s+MS$/i, '')
      .trim();
  };

  const homeTeam = stripSchoolSuffix(schoolName) || 'Home Team';
  const opponent = stripSchoolSuffix(game.opponentDetails?.name) || 'Opponent';
  const eventTitle = game.title || game.name || '';

  // Detect Triangular or Quad event in the event title
  let eventType = '';
  if (/\b(tri|triangular)\b/i.test(eventTitle)) {
    eventType = 'Triangular';
  } else if (/\b(quad|quad meet)\b/i.test(eventTitle)) {
    eventType = 'Quad';
  }

  // Format gender: MENS → Mens, WOMENS → Womens, COED → Coed
  const genderMap = { MENS: 'Mens', WOMENS: 'Womens', COED: 'Coed' };
  const gender = genderMap[teamData.gender] || '';

  // Format team level: VARSITY → Varsity, JUNIOR_VARSITY → JV, etc.
  const levelMap = { VARSITY: 'Varsity', JUNIOR_VARSITY: 'JV', FRESHMAN: 'Freshman', OTHER: '' };
  const level = levelMap[teamData.teamLevel] || '';

  // Format sport: BASKETBALL → Basketball
  const sport = teamData.sport ? teamData.sport.charAt(0) + teamData.sport.slice(1).toLowerCase() : '';

  // Build metadata from HUDL fields only: "Mens Varsity Basketball"
  const metadata = [gender, level, sport].filter(p => p).join(' ');

  // If Triangular or Quad, omit opponent and vs/at, and append event type
  if (eventType) {
    // "Elkhorn Valley Mens Varsity Wrestling Triangular"
    return [homeTeam, metadata, eventType].filter(p => p).join(' ');
  }

  // Home vs Away
  const vsOrAt = game.scheduleEntryLocation === 2 ? 'at' : 'vs';
  // Build title: "Elkhorn Valley vs Pierce Mens Varsity Basketball"
  const titleParts = [homeTeam, vsOrAt, opponent, metadata].filter(p => p);
  return titleParts.join(' ');
}

// Generate consistent playlist title from team metadata
function generatePlaylistTitle(teamData, schoolName, seasonYear) {
  if (!teamData || !seasonYear) return null;

  // Strip school suffixes for cleaner titles (aesthetic only - not used for matching)
  const stripSchoolSuffix = (name) => {
    if (!name) return name;
    return name
      .replace(/\s+High School$/i, '')
      .replace(/\s+Junior High$/i, '')
      .replace(/\s+Middle School$/i, '')
      .replace(/\s+HS$/i, '')
      .replace(/\s+JH$/i, '')
      .replace(/\s+MS$/i, '')
      .trim();
  };

  const school = stripSchoolSuffix(schoolName) || 'School';

  // Format gender: MENS → Mens, WOMENS → Womens, COED → Coed
  const genderMap = { MENS: 'Mens', WOMENS: 'Womens', COED: 'Coed' };
  const gender = genderMap[teamData.gender] || '';

  // Format team level: VARSITY → Varsity, JUNIOR_VARSITY → JV, etc.
  const levelMap = { VARSITY: 'Varsity', JUNIOR_VARSITY: 'JV', FRESHMAN: 'Freshman', OTHER: '' };
  const level = levelMap[teamData.teamLevel] || '';

  // Format sport: BASKETBALL → Basketball
  const sport = teamData.sport ? teamData.sport.charAt(0) + teamData.sport.slice(1).toLowerCase() : '';

  // Build metadata from HUDL fields only: "Mens JV Basketball"
  const metadata = [gender, level, sport].filter(p => p).join(' ');

  // Season years: "2025-2026"
  const nextYear = parseInt(seasonYear) + 1;
  const seasonYears = `${seasonYear}-${nextYear}`;

  // Build title: "Elkhorn Valley Mens JV Basketball 2025-2026 Season"
  const titleParts = [school, metadata, seasonYears, 'Season'].filter(p => p);

  return titleParts.join(' ');
}

module.exports = {
  generateGameTitle,
  generatePlaylistTitle
};
