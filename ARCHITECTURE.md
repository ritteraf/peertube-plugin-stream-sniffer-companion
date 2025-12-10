# PeerTube Plugin Stream Sniffer Companion - Architecture Documentation

## System Overview

This plugin acts as a companion to a physical camera sniffer system that detects and streams live sports events from HUDL cameras installed in gymnasiums.

---

## Physical Camera Architecture

### HUDL Camera Hardware

**One Physical Camera Per Gymnasium:**
- Each gymnasium has ONE physical HUDL camera installed
- This single camera broadcasts TWO simultaneous RTMP endpoints:
  - `/panoramic` - Wide-angle view (both sides of court/net visible)
  - `/tactical` - Focused view (follows active play area)

**Important Constraints:**
- Only ONE endpoint can have an active recording at any given time
- `/tactical` and `/panoramic` will NEVER both be live simultaneously
- The camera automatically selects the correct endpoint based on HUDL's pre-scheduled game configuration

### Sniffer Detection

**How the Sniffer Works:**
- The sniffer software treats `/panoramic` and `/tactical` as TWO distinct `cameraId`s
- Example: `camera-panoramic` and `camera-tactical`
- When the sniffer detects activity on an endpoint, it sends a signal to this plugin with:
  - `cameraId` (e.g., "camera-tactical")
  - `startTime` (timestamp of detected activity)
  - `snifferId` (identifies which physical sniffer/gym)

---

## Sport-to-Angle Mapping

### Recording Angle Preferences

**Each sport uses ONE preferred recording angle:**

| Sport | Preferred Angle | Reason |
|-------|----------------|--------|
| Basketball | Tactical | Only need to see the active side of the court |
| Volleyball | Panoramic | Need to see both sides of the net simultaneously |
| Wrestling | Panoramic | Need full mat view |
| Other sports | Varies | Configured per sport |

**Team-to-Camera Mapping:**
- Each team is mapped to their sport's preferred recording angle
- Example mappings in `hudl-mappings` storage:
  - `Boys Basketball → camera-tactical`
  - `Girls Basketball → camera-tactical`
  - `Boys Volleyball → camera-panoramic`
  - `Girls Volleyball → camera-panoramic`

---

## HUDL Pre-Scheduling System

### How HUDL Games Are Configured

**Manual Setup in HUDL:**
1. User logs into HUDL and schedules a game
2. User specifies:
   - Team/sport playing
   - Game date and time
   - **Recording angle** (tactical or panoramic)
   - Home vs Away designation
3. HUDL saves this configuration

**Automatic Recording:**
- At the scheduled game time, the HUDL camera automatically:
  - Starts recording on the pre-configured endpoint (tactical or panoramic)
  - Continues recording until stopped

---

## Game Matching Logic

### How the Plugin Matches Games

**Step 1: Camera Detection**
- Sniffer detects activity on endpoint (e.g., `camera-tactical`)
- Sniffer sends `POST /recording-started-hudl` with `cameraId` and `startTime`

**Step 2: Team Filtering**
- Plugin loads `hudl-mappings` storage
- Filters teams to only those mapped to the reporting `cameraId`
- Example: If `camera-tactical` reports, only check basketball teams

**Step 3: Time-Based Matching**
- For filtered teams, load their game schedules from `hudl-schedules`
- Search for games where:
  - `Math.abs(game.timeUtc - event.startTime) <= 15 minutes`
  - **`game.scheduleEntryLocation === "HOME"`** (v0.2.54+)

**Step 4: HOME Game Filter (Critical)**
- Only HOME games can be matched
- AWAY games are skipped (team is at opponent's gym, not this camera's gym)
- If no HOME game matches, the detected activity is likely practice or another event

### Why HOME/AWAY Filtering Matters

**Problem Scenario (Without Filtering):**
- Boys Basketball has an AWAY game scheduled at 7pm (team at opponent's gym)
- Some other activity happens in this gym at 7pm (practice, different sport, etc.)
- Camera detects activity on `camera-tactical` at 7pm
- Plugin would incorrectly match Boys Basketball's AWAY game ❌

**Solution (With HOME Filtering - v0.2.54+):**
- Plugin checks Boys Basketball schedule
- Finds AWAY game at 7pm
- **Skips it** because `scheduleEntryLocation !== "HOME"`
- No match found (correct - the activity isn't the scheduled game) ✅

---

## Data Flow

### Complete Recording Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. PHYSICAL REALITY                                             │
├─────────────────────────────────────────────────────────────────┤
│ - Gymnasium has ONE HUDL camera                                 │
│ - Camera has TWO RTMP endpoints: /panoramic and /tactical       │
│ - Game starts → Camera auto-records on pre-configured endpoint  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. SNIFFER DETECTION                                            │
├─────────────────────────────────────────────────────────────────┤
│ - Sniffer monitors both endpoints                               │
│ - Detects activity on /tactical (for example)                   │
│ - Treats it as cameraId: "camera-tactical"                      │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. PLUGIN NOTIFICATION                                          │
├─────────────────────────────────────────────────────────────────┤
│ POST /recording-started-hudl                                    │
│ {                                                               │
│   cameraId: "camera-tactical",                                  │
│   startTime: "2025-12-10T19:00:00Z",                           │
│   snifferId: "gym-main-sniffer"                                │
│ }                                                               │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. TEAM FILTERING (by cameraId)                                │
├─────────────────────────────────────────────────────────────────┤
│ - Load hudl-mappings                                            │
│ - Filter to teams with cameraId === "camera-tactical"          │
│ - Result: [Boys Basketball, Girls Basketball]                  │
│ - (Volleyball teams excluded - they use panoramic)             │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. GAME MATCHING (by time + location)                          │
├─────────────────────────────────────────────────────────────────┤
│ - Load schedules for Boys Basketball, Girls Basketball         │
│ - Search games within ±15 min of 19:00                         │
│ - Filter: scheduleEntryLocation === "HOME"                      │
│ - Match found: Boys Basketball HOME game vs Rival High         │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 6. STREAM CREATION                                              │
├─────────────────────────────────────────────────────────────────┤
│ - Get/create permanent live video on PeerTube                  │
│ - Return RTMP credentials to sniffer                            │
│ - Sniffer restreams HUDL camera → PeerTube                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key Storage Data Structures

### hudl-mappings
Maps teams to cameras and PeerTube channels:
```javascript
{
  "team-12345": {
    "cameraId": "camera-tactical",
    "channelId": 42,
    "channelHandle": "boys-basketball@peertube.example.com",
    "permanentLiveVideoId": "video-uuid",
    "permanentLiveRtmpUrl": "rtmp://...",
    "permanentLiveStreamKey": "stream-key"
  }
}
```

### hudl-schedules
Cached game schedules from HUDL API:
```javascript
{
  "team-12345": {
    "teamId": "team-12345",
    "teamName": "High School Boys Basketball",
    "sport": "Basketball",
    "logoURL": "https://...",
    "games": [
      {
        "id": "game-67890",
        "timeUtc": "2025-12-10T19:00:00Z",
        "scheduleEntryLocation": 1,  // ← Critical field (1=HOME, 2=AWAY, 0=NEUTRAL)
        "opponentDetails": {
          "name": "Rival High School",
          "schoolId": "school-456"
        },
        "scheduleEntryOutcome": 0,  // 0=not played, 1=WIN, 2=LOSS
        "broadcastStatus": "Upcoming"  // "Archived", "Upcoming", or null
      }
    ],
    "lastScraped": "2025-12-10T10:00:00Z"
  }
}
```

---

## Critical Implementation Details

### scheduleEntryLocation Field

**Source:** HUDL GraphQL API (`lib-hudl-scraper.js`)
```graphql
query Web_Fan_GetScheduleEntrySummaries_r1 {
  scheduleEntryPublicSummaries {
    items {
      scheduleEntryLocation  # ← Numeric enum: 1 = HOME, 2 = AWAY, 0/3 = NEUTRAL
    }
  }
}
```

**Values (Numeric Enum):**
- `1` - HOME - Game at team's home location (THIS camera's gym)
- `2` - AWAY - Game at opponent's location (different gym)
- `0` or `3` - NEUTRAL - Game at neutral location (conference center, etc.)

**Important:** HUDL returns this as a **number**, not a string!

**Filtering (v0.2.56+):**
```javascript
// Only match HOME games - camera cannot detect away games
// scheduleEntryLocation: 1 = HOME, 2 = AWAY, 0/3 = NEUTRAL (numeric enum from HUDL API)
if (game.scheduleEntryLocation !== undefined && game.scheduleEntryLocation !== 1) {
    continue;
}

// Skip games that have already been played (v0.2.57+)
// scheduleEntryOutcome: 0 = not played, 1 = WIN, 2 = LOSS
if (game.scheduleEntryOutcome !== undefined && game.scheduleEntryOutcome !== 0) {
    continue;
}
```

### Why This Matters

**Without HOME filtering:**
- Plugin could match away games that are physically impossible to detect
- Incorrect game metadata applied to streams
- User confusion (stream shows "Boys vs Rival" but it's actually a different event)

**With HOME filtering:**
- Only games physically happening at the camera's location can be matched
- Accurate game metadata on streams
- Graceful handling of unscheduled events (practices, scrimmages, etc.)

---

## Common Scenarios

### Scenario 1: Scheduled HOME Game
- **Reality:** Boys Basketball HOME game at 7pm
- **HUDL Config:** Team, tactical angle, HOME location
- **Detection:** Camera records on `/tactical` at 7pm
- **Result:** ✅ Game matched correctly, stream created with game metadata

### Scenario 2: Scheduled AWAY Game (No Activity)
- **Reality:** Boys Basketball AWAY game at 7pm (team at opponent's gym)
- **HUDL Config:** Team, tactical angle, AWAY location
- **Detection:** No activity detected (camera dormant)
- **Result:** ✅ No stream created (correct)

### Scenario 3: Scheduled AWAY Game + Practice
- **Reality:** Boys Basketball AWAY game at 7pm, but Girls Basketball has practice at same time
- **HUDL Config:** Boys away, no girls game scheduled
- **Detection:** Camera records on `/tactical` at 7pm (girls practice)
- **Result:** ✅ No match (boys game is AWAY, girls have no scheduled HOME game)

### Scenario 4: Multiple Teams, One Gym
- **Reality:** Boys Basketball HOME at 6pm (tactical), Girls Volleyball HOME at 8pm (panoramic)
- **HUDL Config:** Both configured correctly
- **Detection:** 
  - 6pm: `/tactical` active → matches Boys Basketball ✅
  - 8pm: `/panoramic` active → matches Girls Volleyball ✅
- **Result:** ✅ Both games matched correctly based on camera angle

---

## Version History

### v0.2.56 (Current)
- **Fixed:** HOME game filtering now uses numeric comparison (`=== 1`) instead of string comparison
- **Critical:** v0.2.54-0.2.55 HOME filter was broken (HUDL returns numbers, not strings)

### v0.2.55
- **Added:** `cameraId` field to GET `/hudl/schedules` response
- **Note:** HOME game filter broken (string vs number comparison)

### v0.2.54
- **Added:** HOME game filtering in `/recording-started-hudl` matching logic
- **Fixed:** Prevents matching AWAY games that cannot be physically detected
- **Added:** Support for both `timeUtc` and `date` fields for backwards compatibility
- **Note:** HOME game filter broken (string vs number comparison)

### v0.2.53
- **Fixed:** Double-encryption bug in `/auth` endpoint
- **Added:** REAUTH_REQUIRED error handling for credential decryption failures
- **Added:** Try-catch around password decryption in OAuth token refresh

### v0.2.51
- **Changed:** Stream token lifetime from 1 hour to 1 year
- **Added:** Automatic OAuth token refresh in all PeerTube API functions
- **Added:** Video deletion functionality

---

## Future Considerations

### Potential Enhancements

1. **NEUTRAL Location Support:**
   - Some games are at neutral venues (tournament sites)
   - Could add configuration to specify which neutral venues this camera covers

2. **Multi-Camera Sniffers:**
   - Currently assumes one sniffer per gym
   - Could support multiple cameras in larger facilities

3. **Confidence Scoring:**
   - Weight matches by multiple factors (time proximity, sport, location)
   - Prevent false matches in edge cases

4. **Manual Override:**
   - Allow admins to manually assign games to streams
   - Useful for misscheduled games or HUDL data errors

---

## Troubleshooting

### Common Issues

**Problem:** Camera detects activity but no game matches
- **Check:** Are there any HOME games scheduled within ±15 minutes?
- **Check:** Is the team mapped to the correct cameraId (tactical vs panoramic)?
- **Likely:** Unscheduled practice, scrimmage, or other event

**Problem:** Wrong game metadata on stream
- **Check:** Are multiple teams scheduled at the same time?
- **Check:** Is the HOME/AWAY designation correct in HUDL?
- **Fix:** Correct the game schedule in HUDL, refresh schedules in plugin

**Problem:** AWAY game being matched
- **Check:** Plugin version (v0.2.54+ has HOME filtering)
- **Fix:** Upgrade to v0.2.54 or later

---

## References

- HUDL GraphQL API: `https://www.hudl.com/api/public/graphql/query`
- Game Matching: `router-recording.js` line 195+
- HUDL Scraper: `lib-hudl-scraper.js`
- Team Mappings: `router-hudl.js` POST `/hudl/map-teams`
