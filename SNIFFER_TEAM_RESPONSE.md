# Response to Sniffer Dev Team - Enhanced Health Reporting (v3.8.0)

**Date:** January 13, 2026  
**Plugin Version:** v0.2.86  
**Status:** ✅ IMPLEMENTED AND READY

---

## Summary

All requested features for enhanced health reporting are now **implemented and ready for integration**. The plugin fully supports per-camera health tracking while maintaining backward compatibility with existing sniffers.

---

## Answers to Your Questions

### 1. ✅ Does per-sniffer storage already work correctly?

**YES - Confirmed working perfectly.**

**How it works:**
- Each sniffer authenticates via `POST /auth` and receives a unique `snifferId` and `X-Stream-Token`
- When posting to `/status`, the `requireAuth` middleware extracts `snifferId` from the token
- Status is stored as: `statusLog[snifferId] = {...data}`
- Multiple sniffers **never** overwrite each other - each has its own key

**Storage structure:**
```javascript
{
  "gym-server": { health: "error", activeStreams: [...], lastUpdate: "..." },
  "field-server": { health: "healthy", activeStreams: [...], lastUpdate: "..." },
  "pool-server": { health: "warning", activeStreams: [...], lastUpdate: "..." }
}
```

**FalconCast can query:**
- All sniffers: `GET /status`
- Specific sniffer: `GET /status/gym-server`

### 2. ✅ Do you need TypeScript interfaces?

**YES - Already provided in `SNIFFER_STATUS_API.md`**

Key interfaces:
- `SnifferStatusReport` - Overall status payload
- `ActiveStreamInfo` - Per-camera health data
- `CameraIssue` - Individual camera issues

Copy these directly into your TypeScript codebase.

### 3. ✅ Timeline: Can you support this in next plugin release?

**READY NOW - v0.2.86**

No waiting required. Deploy this version immediately and start sending enhanced status reports.

### 4. ✅ Breaking changes: Should we version this as `/status/v2`?

**NO - No breaking changes needed**

The existing `/status` endpoint now accepts enhanced fields gracefully:
- ✅ Old sniffers (v3.7.x) can still POST without new fields
- ✅ New sniffers (v3.8.0+) can POST with full per-camera health
- ✅ Plugin provides sensible defaults for missing fields
- ✅ No API versioning required

### 5. ✅ FalconCast query: Do you need `GET /status/:snifferId` endpoint?

**ALREADY EXISTS**

```bash
# Get all sniffers
GET /plugins/stream-sniffer-companion/router/status

# Get specific sniffer  
GET /plugins/stream-sniffer-companion/router/status/gym-server
```

Both endpoints return the same enhanced structure with per-camera health details.

---

## What's New in v0.2.86

### Enhanced Status Processing

The `sanitizeSnifferStatus()` function now properly handles all new v3.8.0 fields:

**New fields per camera:**
- `cameraHealth` - "healthy" | "warning" | "error" | "critical"
- `currentIssues[]` - Array of active camera issues
- `lastHealthyTime` - ISO8601 timestamp
- `isRelayActive` - Boolean relay status
- `lastRelayFailure` - ISO8601 timestamp
- `consecutiveFailures` - Retry attempt counter

### Example Response

When FalconCast queries `GET /status/gym-server`:

```json
{
  "snifferId": "gym-server",
  "health": "error",
  "uptimeSeconds": 86400,
  "activeStreams": [
    {
      "cameraId": "Tactical",
      "status": "streaming",
      "cameraHealth": "error",
      "isRelayActive": false,
      "consecutiveFailures": 3,
      "lastHealthyTime": "2026-01-13T09:30:00Z",
      "lastRelayFailure": "2026-01-13T09:32:17Z",
      "currentIssues": [
        {
          "type": "relay_crashed",
          "severity": "HIGH",
          "message": "FFmpeg relay crashed (exit 224 - broken pipe)",
          "recoveryAttempt": 3,
          "maxAttempts": 10,
          "firstOccurred": "2026-01-13T09:32:17Z",
          "autoRecovering": true
        }
      ]
    },
    {
      "cameraId": "Panoramic",
      "status": "idle",
      "cameraHealth": "healthy",
      "isRelayActive": false,
      "consecutiveFailures": 0,
      "currentIssues": []
    }
  ],
  "isStale": false,
  "lastUpdateTimestamp": "2026-01-13T09:32:30Z"
}
```

---

## FalconCast UI Recommendations

### Sniffer List View
```
📡 Sniffers (3 active)
├─ ✅ Field Server - All cameras healthy
├─ ⚠️  Pool Server - 1 camera warning
└─ ❌ Gym Server - 1 camera error
```

### Sniffer Detail View
```
📡 Sniffer: Gym Server
Status: ERROR | Uptime: 1d 0h 0m

Cameras:
├─ ✅ Panoramic
│  └─ Status: Idle | Health: Healthy
│
└─ ❌ Tactical
   ├─ Status: Streaming | Health: ERROR
   ├─ Relay: Crashed (not active)
   ├─ Last healthy: 2 minutes ago
   ├─ Consecutive failures: 3/10
   └─ 🔄 Auto-recovering
      └─ FFmpeg relay crashed (exit 224 - broken pipe)
         Started: 2 minutes ago
```

### Quick Actions
- Tap camera → View logs
- Pull to refresh → Force status update
- Long press → Manual recovery options

---

## Integration Timeline

### ✅ Phase 1: Plugin Side (COMPLETE)
- [x] Update `/status` endpoint to accept enhanced fields
- [x] Add per-camera health processing
- [x] Maintain backward compatibility
- [x] Document TypeScript interfaces
- [x] Version bump to v0.2.86

### 🔄 Phase 2: Sniffer Side (YOUR WORK - 2-3 days)
- [ ] Implement per-camera health tracking
- [ ] Add `CameraIssue` detection and reporting
- [ ] Calculate `cameraHealth` status
- [ ] Send enhanced status to plugin
- [ ] Test with existing plugin

### 📱 Phase 3: FalconCast Side (FUTURE)
- [ ] Add "Sniffer Health" view
- [ ] Display per-camera status
- [ ] Show active issues and recovery progress
- [ ] Add push notifications for critical issues
- [ ] Implement manual recovery triggers

---

## Testing Checklist

### Before Deploying Sniffer v3.8.0

- [ ] Verify plugin is running v0.2.86+
- [ ] Test POST with old-style status (should still work)
- [ ] Test POST with enhanced status (new fields)
- [ ] Verify per-sniffer storage (multiple sniffers don't conflict)
- [ ] Test FalconCast queries for specific sniffers
- [ ] Confirm default values for missing fields

### After Deploying Sniffer v3.8.0

- [ ] Monitor `currentIssues` array during relay crashes
- [ ] Verify `consecutiveFailures` increments correctly
- [ ] Check `lastHealthyTime` updates appropriately
- [ ] Confirm `cameraHealth` reflects actual state
- [ ] Test auto-recovery status reporting

---

## Additional Notes

### No Database Schema Changes Required
All new fields are stored as JSON. No migrations needed.

### Performance Impact
Minimal - just additional JSON fields. Storage size increase: ~1-2 KB per sniffer.

### Rate Limiting
Status updates are not rate-limited. Send updates as frequently as needed (recommended: every 10-30 seconds, or immediately on health changes).

### Staleness Detection
Plugin marks sniffers "stale" if no update received in 10 minutes. The `isStale` field helps FalconCast identify offline sniffers.

---

## Example Implementation (Sniffer Side)

```javascript
// Calculate camera health
function calculateCameraHealth(camera) {
  const failures = camera.consecutiveFailures || 0;
  if (failures === 0 && camera.isRelayActive) return "healthy";
  if (failures <= 2) return "warning";
  if (failures <= 5) return "error";
  return "critical";
}

// Build status report
async function reportStatus() {
  const activeStreams = cameras.map(camera => ({
    cameraId: camera.id,
    status: camera.streaming ? "streaming" : "idle",
    streamUrl: camera.rtmpUrl,
    cameraHealth: calculateCameraHealth(camera),
    isRelayActive: camera.relay?.isRunning || false,
    consecutiveFailures: camera.failureCount || 0,
    lastHealthyTime: camera.lastHealthyAt?.toISOString(),
    lastRelayFailure: camera.lastFailureAt?.toISOString(),
    currentIssues: camera.activeIssues || []
  }));

  await fetch(`${pluginUrl}/status`, {
    method: "POST",
    headers: {
      "X-Stream-Token": token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      health: calculateOverallHealth(),
      uptimeSeconds: process.uptime(),
      memoryGrowthRate: getMemoryGrowthRate(),
      totalRecoveryAttempts: getTotalRecoveryAttempts(),
      activeFailures: [],
      activeStreams,
      systemMetrics: getSystemMetrics()
    })
  });
}
```

---

## Documentation Files

1. **`SNIFFER_STATUS_API.md`** - Complete API reference with TypeScript interfaces
2. **`ARCHITECTURE.md`** - System architecture (check if this needs updating)
3. **`README.md`** - May need update to mention v3.8.0 support

---

## Contact

If you have any questions during integration, please reach out. We're ready to support your v3.8.0 rollout!

---

**Plugin Team**  
✅ Ready to receive enhanced health reports  
✅ All endpoints tested and working  
✅ Documentation complete
