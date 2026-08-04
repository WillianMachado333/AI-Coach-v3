# Guest Preparation Caching Plan

## Current State

- **Client-side cache** (`app.js`): 60s TTL, per-user Map, only prevents refetch during reconnects
- **Server-side** (`agentEricaRoutes.js`, `server.js`): No caching - every request proxies to Wix backend
- **Guest requests**: Empty payload `{}` → all identical responses
- **Performance issue**: Every guest user hits the Wix API, causing slow responses

## Solution: Server-Side Cache

Add in-memory cache on the server to store guest preparation responses, eliminating the network round-trip for most requests.

## Implementation Details

### Cache Strategy

**Guest Users** (no userId/email):
- **Cache key**: `"__guest__"`
- **TTL**: 1 day (24 hours, configurable via `ERICA_PREP_GUEST_TTL_MS` env var)
- **Rationale**: Guest responses are identical, rarely change, safe to cache aggressively

**Authenticated Users** (optional, for future):
- **Cache key**: `userId` or `email`
- **TTL**: 2 minutes (shorter, may have personalization)
- **Rationale**: May have user-specific data, cache conservatively

### Storage

- **In-memory Map**: `Map<string, { ts: number, data: string, statusCode: number, headers: object }>`
- **Simple, fast**: No external dependencies
- **Future-proof**: Can migrate to Redis later if needed

### Cache Invalidation

1. **TTL-based**: Automatic expiration
2. **Manual**: Admin endpoint `/api/admin/clear-prep-cache?key=__guest__` (optional)
3. **On error**: Don't cache error responses (only cache 200 OK)

### Files to Modify

**`agentEricaRoutes.js`**

1. Add cache Map and TTL constants at module level (after `ERICA_API_ORIGIN`)
2. Create `getCacheKey(userId, email)` helper → returns `"__guest__"` or `userId/email`
3. In `/erica-preparation` handler:
   - Check cache before proxying
   - If cache hit and valid: return cached response immediately
   - If cache miss: proxy to Wix, cache successful responses (200 OK only)
   - Add cache hit/miss logging

**`server.js`**

Same pattern as `agentEricaRoutes.js`:
1. Add cache Map and TTL constants
2. Add cache check/update logic in `/api/erica-preparation` handler
3. Match the same cache key strategy

### Configuration

**Environment Variables**:
- `ERICA_PREP_GUEST_TTL_MS` (default: `86400000` = 24 hours / 1 day)
- `ERICA_PREP_AUTH_TTL_MS` (default: `120000` = 2 minutes, optional for authenticated users)

### HTTP Cache Headers (Bonus)

Add `Cache-Control` headers to responses:
- Guest: `Cache-Control: public, max-age=86400` (24 hours)
- Authenticated: `Cache-Control: private, max-age=120` (2 min)

This allows browser/CDN caching too.

## Expected Impact

- **Speed**: Guest requests return instantly (no network round-trip)
- **Load reduction**: ~90%+ reduction in Wix API calls for guests
- **User experience**: Faster initial load, especially on slow connections
- **Cost**: Reduced API usage

## Testing Considerations

1. **Cache hit**: Verify guest requests return cached data
2. **Cache expiration**: Wait TTL, verify fresh fetch
3. **Error handling**: Ensure errors aren't cached
4. **Concurrent requests**: Multiple guests should share same cache entry
5. **Memory**: Monitor cache size (should be minimal - 1 entry for guests)

## Rollout Strategy

1. Deploy with logging enabled
2. Monitor cache hit rate
3. Adjust TTL if needed based on real-world usage
4. Consider adding authenticated user caching if guest caching proves successful
