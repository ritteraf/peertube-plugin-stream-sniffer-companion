# Sniffer Status API Documentation (v3.8.0)

## Overview
This document describes the enhanced health reporting API for sniffers communicating with the PeerTube Stream Sniffer Companion plugin.

---

## Authentication
All authenticated endpoints require the `X-Stream-Token` header obtained from `POST /auth`.

---

## Endpoints

### POST /status (Authenticated)
Sniffers use this endpoint to report their current status, including per-camera health information.

**Headers:**
- `X-Stream-Token`: Required - Your authentication token
- `Content-Type`: application/json

**Request Body:**
```typescript
interface SnifferStatusReport {
  // Overall sniffer health
  health: "healthy" | "warning" | "error" | "critical" | "offline";
  
  // System metrics
  uptimeSeconds: number;
  memoryGrowthRate: number;  // MB/hour
  totalRecoveryAttempts: number;
  lastRestartTime?: string;  // ISO8601 timestamp
  lastRestartReason?: string;
  
  // Active failures (legacy - still supported)
  activeFailures: Array<{
    timestamp: string;
    message: string;
    severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  }>;
  
  // Enhanced per-camera health tracking (NEW in v3.8.0)
  activeStreams: ActiveStreamInfo[];
  
  // System metrics
  systemMetrics: {
    cpuUsage: number;     // Percentage 0-100
    memoryUsage: number;  // MB
    diskSpace: number;    // GB available
  };
  
  // Last activity timestamp
  lastActivity?: string;  // ISO8601 timestamp
}

interface ActiveStreamInfo {
  // Camera identification
  cameraId: string;  // e.g., "Tactical", "Panoramic"
  
  // Stream status
  status: "streaming" | "idle";
  streamUrl?: string;  // RTMP URL if streaming
  
  // Per-camera health tracking (NEW in v3.8.0)
  cameraHealth: "healthy" | "warning" | "error" | "critical";
  isRelayActive: boolean;
  consecutiveFailures: number;
  lastHealthyTime?: string;     // ISO8601 - Last time camera was fully healthy
  lastRelayFailure?: string;    // ISO8601 - Last relay crash/failure
  
  // Current issues affecting this camera
  currentIssues: CameraIssue[];
}

interface CameraIssue {
  type: "relay_crashed" | "rtmp_disconnected" | "zombie_state" | "ffmpeg_hanging" | "authentication_failed";
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  message: string;              // Human-readable description
  recoveryAttempt: number;      // Current attempt number
  maxAttempts: number;          // Max attempts before giving up
  firstOccurred: string;        // ISO8601 - When issue first appeared
  autoRecovering: boolean;      // Is auto-recovery in progress?
}
```

**Example Request:**
```json
{
  "health": "error",
  "uptimeSeconds": 86400,
  "memoryGrowthRate": 1.2,
  "totalRecoveryAttempts": 15,
  "activeFailures": [],
  "activeStreams": [
    {
      "cameraId": "Tactical",
      "status": "streaming",
      "streamUrl": "rtmp://peertube.example.com/live/abc123",
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
  "systemMetrics": {
    "cpuUsage": 45.2,
    "memoryUsage": 512,
    "diskSpace": 128.5
  },
  "lastActivity": "2026-01-13T09:32:30Z"
}
```

**Response:**
```json
{
  "acknowledged": true
}
```

**Error Responses:**
- `400 Bad Request` - Invalid request body
- `401 Unauthorized` - Missing or invalid X-Stream-Token
- `500 Internal Server Error` - Plugin storage error

---

### GET /status (Public)
Returns status information for all registered sniffers.

**Response:**
```json
{
  "timestamp": "2026-01-13T10:00:00Z",
  "pluginVersion": "0.2.85",
  "totalSniffers": 3,
  "activeSniffers": 2,
  "streamingSniffers": 1,
  "sniffers": [
    {
      "snifferId": "gym-server",
      "health": "error",
      "uptimeSeconds": 86400,
      "memoryGrowthRate": 1.2,
      "totalRecoveryAttempts": 15,
      "lastRestartTime": null,
      "lastRestartReason": null,
      "activeFailures": [],
      "activeStreams": [
        {
          "cameraId": "Tactical",
          "status": "streaming",
          "streamUrl": "rtmp://...",
          "cameraHealth": "error",
          "currentIssues": [...],
          "lastHealthyTime": "2026-01-13T09:30:00Z",
          "isRelayActive": false,
          "lastRelayFailure": "2026-01-13T09:32:17Z",
          "consecutiveFailures": 3
        },
        {
          "cameraId": "Panoramic",
          "status": "idle",
          "cameraHealth": "healthy",
          "currentIssues": [],
          "lastHealthyTime": null,
          "isRelayActive": false,
          "lastRelayFailure": null,
          "consecutiveFailures": 0
        }
      ],
      "systemMetrics": {
        "cpuUsage": 45.2,
        "memoryUsage": 512,
        "diskSpace": 128.5
      },
      "lastActivity": "2026-01-13T09:32:30Z",
      "lastUpdateTimestamp": "2026-01-13T09:32:30Z",
      "isStale": false,
      "staleSinceSeconds": null
    }
  ]
}
```

---

### GET /status/:snifferId (Public)
Returns status information for a specific sniffer by ID.

**Parameters:**
- `snifferId` (path) - The unique identifier of the sniffer

**Response:**
```json
{
  "snifferId": "gym-server",
  "health": "error",
  "uptimeSeconds": 86400,
  "activeStreams": [...],
  "lastUpdateTimestamp": "2026-01-13T09:32:30Z",
  "isStale": false,
  "staleSinceSeconds": null
}
```

**Error Responses:**
- `404 Not Found` - Sniffer not found
- `500 Internal Server Error` - Plugin storage error

---

## Per-Sniffer Storage

### How It Works
✅ **Confirmed Working:**
1. Each sniffer authenticates via `POST /auth` with unique credentials
2. Plugin generates unique `snifferId` and `X-Stream-Token`
3. When sniffer posts to `/status`, the token identifies which sniffer it is
4. Status data is stored per-sniffer in a keyed object: `statusLog[snifferId] = {...}`
5. Multiple sniffers **DO NOT** overwrite each other

**Storage Structure:**
```javascript
{
  "gym-server": { 
    health: "error",
    activeStreams: [...],
    lastUpdate: "2026-01-13T09:32:30Z"
  },
  "field-server": {
    health: "healthy",
    activeStreams: [...],
    lastUpdate: "2026-01-13T09:35:00Z"
  }
}
```

---

## Migration Notes

### Backward Compatibility
- ✅ Old sniffer versions can still send status without new fields
- ✅ Plugin will default missing fields (cameraHealth: "healthy", currentIssues: [], etc.)
- ✅ No breaking changes to existing API

### Recommended Upgrade Path
1. **Plugin side:** Deploy this version (supports both old and new formats)
2. **Sniffer side:** Update to v3.8.0+ with enhanced health reporting
3. **FalconCast side:** Update UI to display per-camera health

---

## Health Status Calculation Guidelines

### For Sniffers Implementing v3.8.0

**Overall `health` field:**
- `healthy` - All cameras healthy, no active issues
- `warning` - Minor issues or 1-2 failed recovery attempts
- `error` - Camera relay crashed, active recovery in progress (< 5 failures)
- `critical` - Multiple cameras failed OR recovery attempts > 5
- `offline` - Sniffer shutting down or catastrophic failure

**Per-camera `cameraHealth` field:**
- `healthy` - Relay active (if streaming) or no issues (if idle)
- `warning` - 1-2 consecutive failures, auto-recovering
- `error` - 3-5 consecutive failures, recovery ongoing
- `critical` - 6+ consecutive failures or stuck in zombie state

**Issue Severity Levels:**
- `LOW` - Temporary disconnection, auto-recovered
- `MEDIUM` - 1-3 retry attempts in progress
- `HIGH` - 4-7 retry attempts, relay keeps crashing
- `CRITICAL` - 8+ attempts, may need manual intervention

---

## FalconCast Integration

The FalconCast iOS app can query sniffer status using:

```swift
// Get all sniffers
GET https://peertube.example.com/plugins/stream-sniffer-companion/router/status

// Get specific sniffer
GET https://peertube.example.com/plugins/stream-sniffer-companion/router/status/gym-server
```

Example UI display:
```
📡 Sniffer: Gym Server
├─ ✅ Panoramic: Healthy
└─ ❌ Tactical: ERROR - Relay crashed (recovering 3/10)
   └─ Issue: FFmpeg relay crashed (exit 224 - broken pipe)
   └─ Auto-recovering: Yes
   └─ First occurred: 2 minutes ago
```

---

## Questions Answered

### 1. Does per-sniffer storage already work correctly?
✅ **YES** - Each sniffer has a unique `snifferId` derived from authentication. Status is stored in `statusLog[snifferId]`, so multiple sniffers never overwrite each other.

### 2. Do you need TypeScript interfaces?
✅ **PROVIDED** - See type definitions above. You can copy these directly into your TypeScript codebase.

### 3. Timeline for support?
✅ **READY NOW** - This version (v0.2.85+) fully supports the enhanced health reporting. Deploy anytime.

### 4. Breaking changes? Version the endpoint?
✅ **NO BREAKING CHANGES** - The existing `/status` endpoint now accepts the new fields. Old sniffers still work, new sniffers get enhanced features. No need for `/status/v2`.

### 5. FalconCast query endpoint?
✅ **ALREADY EXISTS** - `GET /status/:snifferId` returns status for a specific sniffer. FalconCast can query this anytime.

---

## Testing Recommendations

1. **Test backward compatibility:**
   ```bash
   # Old-style status (should still work)
   curl -X POST https://peertube.example.com/plugins/stream-sniffer-companion/router/status \
     -H "X-Stream-Token: your-token" \
     -H "Content-Type: application/json" \
     -d '{"health": "healthy", "uptimeSeconds": 100, "activeStreams": []}'
   ```

2. **Test enhanced status:**
   ```bash
   # New-style status with per-camera health
   curl -X POST https://peertube.example.com/plugins/stream-sniffer-companion/router/status \
     -H "X-Stream-Token: your-token" \
     -H "Content-Type: application/json" \
     -d @enhanced-status.json
   ```

3. **Verify FalconCast queries:**
   ```bash
   # Get all sniffers
   curl https://peertube.example.com/plugins/stream-sniffer-companion/router/status
   
   # Get specific sniffer
   curl https://peertube.example.com/plugins/stream-sniffer-companion/router/status/gym-server
   ```

---

## Support

For questions or issues, contact the plugin maintainer or open an issue in the project repository.
