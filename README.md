# PeerTube Stream Sniffer Companion Plugin

A PeerTube plugin that automatically scrapes HUDL game schedules and matches incoming stream recordings to scheduled games, providing rich metadata and thumbnails.

## Architecture Overview

This plugin consists of two main subsystems working together:

### 1. HUDL Schedule Scraper (Adaptive Refresh)
### 2. Game Matching Engine (Recording-to-Game Association)

---

## HUDL Schedule Scraper

**Purpose:** Keep cached game schedule data fresh by intelligently polling HUDL based on game schedule patterns.

### Adaptive Refresh Logic

The scraper uses **dynamic scheduling** instead of fixed intervals:

#### **Non-Game Days (99% of the time)**
- Refresh at **12:00 PM (noon)**
- Refresh at **12:00 AM (midnight)**
- **Total: 2 refreshes/day**

#### **Game Days**
- **Before game window:** Refresh **2 hours before first game**
- **During game window:** Refresh **every 30 minutes** (from 2hrs before first game → 3hrs after last game)
- **After game window:** Refresh at **midnight**
- **Total: ~10-15 refreshes/day on game days**

### Schedule Detection
- Analyzes cached schedules to determine if HOME games are scheduled today
- Filters: `scheduleEntryLocation === 1` (HOME only), `scheduleEntryOutcome === 0` (not yet played)
- Calculates game window boundaries dynamically
- Automatically adjusts polling frequency based on schedule

### Why 2 Hours Early?
- Catches **coach schedule updates** (e.g., game moved from 7:00 PM → 7:30 PM at 6:45 PM)
- Ensures fresh data available when recordings start
- 30-minute polling intervals during window guarantee updates are caught quickly

### Rate Limiting
- **10-second delay** between all HUDL API requests (global queue)
- **300 requests/day hard cap** (auto-resets at midnight)
- All HUDL calls (manual + automatic) go through centralized `hudlLimiter.enqueue()`
- **Result:** ~95% reduction in API load compared to hourly polling (2 calls/day vs 24 calls/day on non-game days)

---

## Game Matching Engine

**Purpose:** Associate incoming stream recordings with scheduled games using intelligent time-window matching.

### Matching Algorithm

When a sniffer starts a recording, the plugin attempts to match it to a scheduled game:

```javascript
// Match criteria (must satisfy ALL):
1. Recording event time matches ONE of these windows:
   - EARLY DETECTION: Within 15 minutes BEFORE game start
   - IN-PROGRESS DETECTION: Between game start and upper limit
   
2. Upper limit calculated as:
   - Next scheduled game start time for same team (tournament-safe)
   - OR game start + 3 hours (single-game fallback)
   
3. HOME games only (scheduleEntryLocation === 1)
4. Unplayed games only (scheduleEntryOutcome === 0)
5. Same calendar day (prevents midnight rollovers)
```

### Matching Windows Explained

#### **Early Detection (15 minutes before)**
- Handles typical coach setup scenarios
- Camera powered on early for testing/warmups
- Example: 2:30 PM game, recording starts 2:20 PM → **MATCH**

#### **In-Progress Detection (game start → upper limit)**
- Handles late starts (coach arrives late)
- Handles mid-game restarts (network blip, equipment failure)
- Handles schedule updates caught by scraper
- Example: 2:30 PM game, recording starts 2:50 PM (20min late) → **MATCH**

#### **Tournament Safety (next-game boundary)**
- In tournaments, multiple games happen same day for same team
- Upper limit = start time of NEXT game (prevents matching wrong game)
- Example: Games at 2:00 PM and 5:00 PM → recordings after 5:00 PM match 5:00 PM game, not 2:00 PM

#### **3-Hour Fallback**
- If no next game exists, assumes game ends 3 hours after start
- Covers typical high school game durations
- Example: Single 7:00 PM game → matches recordings from 6:45 PM to 10:00 PM

### Camera Assignment Filtering
- If `cameraId` is assigned to specific team(s) in HUDL mappings, only those teams are checked
- Falls back to checking all teams if no assignments exist
- Reduces false positives in multi-team environments

### Match Result
When a match is found:
- Video title includes opponent name and game details
- Matchup thumbnail generated (home logo vs away logo)
- Game metadata attached to PeerTube video
- Recording log updated with game association

When no match is found:
- Generic video title used (`Camera [ID] - [Timestamp]`)
- Recording still created and saved
- Can be manually associated with game later

---

## Real-World Scenarios

### Scenario 1: Coach Updates Game Time 15 Minutes Before Start
**Problem:** Game originally scheduled 7:00 PM, coach changes to 7:30 PM at 6:45 PM

**How it works:**
1. Adaptive scraper polling every 30min during game window
2. Last refresh at 6:30 PM (showed 7:00 PM)
3. Refresh at 7:00 PM catches update (now shows 7:30 PM)
4. Sniffer starts recording at 7:15 PM (15min before new time)
5. Game matcher sees fresh 7:30 PM data → **MATCH**

### Scenario 2: Sniffer Crashes Mid-Game
**Problem:** Game starts 2:30 PM, sniffer crashes at 2:50 PM (20 minutes late)

**How it works:**
1. Game matching uses in-progress detection
2. Recording starts at 2:50 PM (after game start)
3. Upper limit = next game start OR 5:30 PM (2:30 + 3hr)
4. 2:50 PM is within window → **MATCH**

### Scenario 3: Tournament Day (Multiple Games)
**Problem:** Team has games at 2:00 PM, 5:00 PM, and 8:00 PM

**How it works:**
1. Adaptive scraper in game-day mode (30min polling)
2. Recording at 5:15 PM checks all three games
3. 2:00 PM game: upper limit = 5:00 PM (next game) → NO MATCH (5:15 > 5:00)
4. 5:00 PM game: upper limit = 8:00 PM (next game) → **MATCH** (5:15 < 8:00)
5. 8:00 PM game: hasn't started yet → NO MATCH

---

## Configuration

### Plugin Settings
- `sniffer-auth-secret`: Shared secret for stream sniffer authentication
- `hudl-org-url`: Your school's HUDL fan page URL
- `schedule-cache-minutes`: *(Deprecated - adaptive scheduling ignores this)*
- `hudl_cache_staleness_threshold`: Cache age (seconds) before manual refresh triggers

### HUDL Mappings
Assign cameras to specific teams via `/hudl/mappings` endpoint:
```json
{
  "teamId": "123456",
  "cameraId": "CAM-001",
  "channelId": "channel-uuid"
}
```

---

## API Rate Limiting

### HUDL API Safeguards
- **Centralized queue:** All HUDL requests serialized through `lib-hudl-rate-limiter.js`
- **10-second minimum delay** between consecutive requests
- **300 requests/day hard cap** (sufficient for 3x peak usage)
- **Daily reset:** Counter resets at midnight
- **Failure mode:** If limit exceeded, all queued requests rejected with error

### Typical Usage Patterns
- **Non-game day:** ~14 API calls (1 school + 6 teams × 2 refreshes)
- **Peak game day:** ~70 API calls (7 calls × 10 refreshes)
- **Manual refreshes:** ~5-10 additional calls/day from coaches/admins
- **Tournament day:** ~150 calls (extended game window, multiple refreshes)

---

## Technical Details

### Global State Management
- Timer IDs stored in Node.js `global` object for cleanup across hot-reloads
- `global.__HUDL_AUTO_REFRESH_TIMEOUT_ID__`: Current scheduled refresh timeout
- `global.__HUDL_AUTO_REFRESH_INTERVAL_ID__`: Legacy interval (cleared on startup)
- `global.__HUDL_RATE_LIMITER__`: Singleton rate limiter instance

### Storage Keys
- `hudl-schedules`: Cached game schedules by team ID
- `hudl-mappings`: Camera-to-team assignments
- `hudl-organization`: School/organization metadata
- `recording-log`: History of all recording events and game matches

### Plugin Reload Behavior
- All timers cleared on plugin reload (no stacking)
- Fresh adaptive schedule calculated on startup
- 5-minute delay before first auto-refresh (allows PeerTube stabilization)
- Rate limiter singleton persists across module reloads within same Node.js process

---

## Development

See https://docs.joinpeertube.org/#/contribute-plugins?id=write-a-plugintheme
