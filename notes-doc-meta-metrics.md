# Meta Metrics: Organic & Paid Metrics Fetching

---

## 1. Nature of Meta and Its APIs

Meta (formerly Facebook) exposes its data through a unified **Graph API** platform. Every resource — users, pages, posts, ads — is a node in a graph, and edges between nodes represent relationships. Developers query this graph using HTTP GET requests against a versioned base URL:

```
https://graph.facebook.com/{version}/{node-or-edge}
```

For influencer metrics specifically, two distinct API surfaces sit on top of this graph:

### Instagram Graph API
- Targets **Instagram Business** and **Influencer accounts**
- Accessed using a token obtained through the **Instagram Login** OAuth flow
- Exposes organic post data: media objects, captions, media types, and per-post engagement metrics
- The token is scoped to an Instagram user identity, not a Facebook user identity

### Meta Marketing API (Ads API)
- Targets **Meta Ads** — campaigns, ad sets, ads, and their performance data
- Accessed using a token obtained through the **Facebook Login** OAuth flow
- Exposes paid ad data: ad creatives, campaign structures, ad-level insights (impressions, reach, spend, clicks, engagement actions)
- The token is scoped to a Facebook user identity who has access to one or more ad accounts

### Why Two Separate API Surfaces?
Meta separates organic and paid data by design:
- **Organic data** belongs to the Instagram content and is gated behind Instagram-specific permissions
- **Paid data** belongs to the advertiser who funds the boost and is gated behind ads permissions

This means a single connected token is not enough to fetch both. Two separate OAuth authorizations are required, producing two independent tokens that are used against the same Graph API base but with different permission contexts.

> **Current API Version:** `v23.0`
> Notable changes in recent versions: `impressions` was removed from organic Instagram Media insights in **v22.0+**, and `plays` was replaced with `views` for VIDEO and REELS media types.

---

## 2. Organic vs. Paid Metrics

### Organic Metrics
Organic metrics reflect how an Instagram post performs through **natural distribution** — without any paid promotion. They are fetched from the Instagram Graph API using a token that has Instagram-specific permissions.

| Metric | Description | Available For |
|---|---|---|
| `reach` | Unique accounts that saw the post | All media types |
| `likes` | Number of likes | All media types |
| `comments` | Number of comments | All media types |
| `shares` | Number of shares | All media types |
| `saved` | Number of saves | All media types |
| `views` | Video plays counted at 3 seconds or more | VIDEO, REELS |
| `total_interactions` | Rolled-up engagement count | All media types |
| `impressions` | ~~Total times the post was shown~~ | **Removed in API v22.0+** |

**API endpoint:** `GET /{ig-media-id}/insights`

---

### Paid Metrics
Paid metrics reflect how a **boosted post or ad** performs through Meta's paid distribution. They are fetched from the Marketing API using a token that has ads permissions.

**Core fields from ad insights:**

| Metric | Description |
|---|---|
| `impressions` | Total times the ad was shown — this is the metric that organic no longer exposes |
| `reach` | Unique people reached by the ad |
| `clicks` | Total clicks on the ad |
| `spend` | Total budget spent on the boost |

**Action breakdowns** — the `actions` array on the insights response breaks down engagement by type:

| Action Key | Description |
|---|---|
| `link_click` | Clicks on links within the ad |
| `post_engagement` | All interactions rolled up |
| `page_engagement` | Interactions counting toward the Facebook Page |
| `post_reaction` | Emoji reactions (overlaps with organic likes) |
| `post` | Re-shares of the post via the ad |
| `video_view` | 3-second+ video views (overlaps with organic views) |
| `comment` | Comments left via the ad placement |
| `onsite_conversion.post_save` | Saves via the ad (overlaps with organic saves) |
| `onsite_conversion.post_net_like` | Net new likes from the ad (new likes minus subsequent unlikes) |
| `onsite_conversion.post_unlike` | Unlikes following ad-driven likes |
| `post_interaction_gross` | Raw interaction count before deduplication |

**API endpoint:** `GET /{ad-id}/insights`

---

### Overlap Between Organic and Paid
When a post is boosted, both API surfaces report independently. Meta does **not** deduplicate across them at the API level — only on its own UI. Through the API:
- **Reach figures overlap** — the same person can appear in both organic reach and paid reach counts
- **Engagement metrics partially overlap** — a user who liked the post via the ad placement is counted in both `organic.likes` and `onsite_conversion.post_net_like`
- When building a combined view, totals should be treated as additive display figures and validated against the Instagram native UI

---

### How Instagram Calculates the Counts Shown on a Post
When a post is boosted, Instagram combines organic engagement with ad-driven engagement into a single visible number. The formula for each counter shown on the post is:

| Shown on Post | Organic Field | + Paid Action Field | Note |
|---|---|---|---|
| **LIKES** | `organic.likes` | `onsite_conversion.post_net_like` | Net likes = new likes minus unlikes from the ad audience |
| **COMMENTS** | `organic.comments` | `comment` | Direct comments left via the ad placement |
| **SHARES** | `organic.shares` | `post` | Re-shares of the post to feed or story via the ad |
| **SAVES** | `organic.saved` | `onsite_conversion.post_net_save` | Net saves = bookmarks minus unsaves from the ad audience |

**Example — post `ExampleShortCode1`:**
- **Likes:** 1,200 organic + 8,500 paid net likes = **9,700** → shown as *9.7K*
- **Comments:** 950 organic + 12 paid comments = **962** → shown as *962*

---

## 3. Flow of Building the Meta Developer App

A Meta developer app is the identity under which all API calls are made. It holds the credentials used in OAuth flows and defines which permissions can be requested from users.

### Step 1: Create the App
1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps/)
2. Click **"Create App"**
3. Choose **"Business"** as the app type — this type supports both the Instagram Graph API and the Marketing API under one app
4. Fill in App Name and Contact Email. Linking a Business Account is optional at this stage

### Step 2: Add Products
From the App Dashboard, add the following products to enable the required API surfaces:
- **Instagram Graph API** — unlocks Instagram media and insights endpoints
- **Facebook Login** — enables OAuth flows for both Instagram Login and Meta Ads Login
- **Marketing API** — unlocks ad account, campaign, and ad insights endpoints

### Step 3: Configure OAuth Settings
Under **Facebook Login > Settings**, register the redirect URIs that Meta will accept as valid OAuth callback destinations. These must exactly match the URIs used in the OAuth authorization request:
- One URI for the **Instagram Login** callback
- One URI for the **Meta Ads Login** callback

Enable both **"Client OAuth Login"** and **"Web OAuth Login"**.

> During OAuth, users do **not** need to be pre-logged into Facebook or Instagram. The Meta dialog handles authentication inline — if the user is not already logged in, a login form is presented before the permissions consent screen. The end result is identical whether the user was pre-logged in or logs in during the flow.

### Step 4: Request Required Permissions (Scopes)
- **Development Mode**: All permissions work immediately for App Admins and Test Users — no review needed
- **Live Mode**: Each permission that is not default must be submitted for **App Review** with a written use case description and a screencast demonstrating the feature

### Step 5: Obtain App Credentials
From **Settings > Basic**, collect:
- **App ID** — used as the `client_id` parameter in all OAuth requests
- **App Secret** — used server-side to exchange authorization codes for access tokens and to extend short-lived tokens to long-lived ones

### Step 6: App Modes
- **Development Mode** — restricts authorization to App Admins and Test Users only. Safe for building and testing
- **Live Mode** — required before real users can authorize. Advanced permissions must have passed App Review before going live

---

## 4. Required Scopes and Their Use Cases

Scopes (permissions) define what data an access token is allowed to read. Each scope directly unlocks specific Graph API endpoints or fields. Requesting a scope without a legitimate use case will be rejected during App Review.

### Instagram Login Scopes

These scopes are requested during the Instagram OAuth flow and are carried by the Instagram access token.

| Scope | What It Unlocks | Required? |
|---|---|---|
| `instagram_basic` | `GET /me`, `GET /me/accounts` — resolves the authenticated user to their linked Instagram Business Account and retrieves basic profile info and media list | **Required** |
| `instagram_manage_insights` | `GET /{media-id}/insights` — access per-post metric breakdowns (reach, likes, comments, shares, saves, views) | **Required** |
| `pages_show_list` | `GET /me/accounts` — lists the Facebook Pages the user manages, which is the bridge to finding the linked Instagram Business Account | **Required** |
| `pages_read_engagement` | `GET /{page-id}` fields and Page-level engagement data linked to the Instagram account | **Required** |
| `ads_read` | `GET /me/adaccounts`, `GET /{ad-account-id}/ads`, `GET /{ad-id}/insights` — read ad accounts and fetch paid metrics without any write access | Recommended |
| `business_management` | `GET /me/businesses` — access Business Manager to enumerate business-owned Instagram accounts, useful when an account is managed through a Business portfolio | Optional |

### Meta Ads Login Scopes

These scopes are requested during the Meta Ads OAuth flow and are carried by the Facebook/Ads access token.

| Scope | What It Unlocks | Required? |
|---|---|---|
| `ads_read` | `GET /me/adaccounts`, `GET /{ad-account-id}/campaigns`, `GET /{ad-account-id}/ads`, `GET /{ad-id}/insights` — the minimum permission needed to read any paid data | **Required** |
| `business_management` | `GET /me/businesses` and Business Manager-level ad account access — needed when ad accounts are owned by a Business portfolio rather than directly by the user | Optional |

> Without `ads_read` on the token being used, any call to the Marketing API will return an OAuth permissions error. It is the single gating permission for all paid metrics.

---

## 5. APIs Related to the Implementation and Their Endpoints

The two API surfaces share the same Graph API base URL but use different tokens and resolve different node types. Below is a complete reference of all endpoints involved in fetching organic and paid metrics.

---

### Instagram Graph API

#### Resolving the Instagram Business Account

Before any media or insights can be fetched, the Instagram Business Account ID (`ig-user-id`) must be resolved from the authenticated Facebook user.

```
GET /me
  Token: Instagram access token
  Fields: id, name
  → Returns the Facebook user identity tied to the token

GET /me/accounts
  Token: Instagram access token (requires pages_show_list)
  Fields: id, name, instagram_business_account { id, username }
  → Returns the Facebook Pages managed by the user, each with a linked
    Instagram Business Account. The ig-user-id lives here.

GET /me/businesses
  Token: Instagram access token (requires business_management)
  Fields: id, name, instagram_business_accounts { id, username }
  → Alternative path when Instagram accounts are managed through
    a Business Manager portfolio rather than directly via a Page
```

The `ig-user-id` obtained here is the root identifier for all subsequent Instagram API calls.

---

#### Resolving a Media ID from an Instagram URL

> **All Instagram Graph API endpoints that operate on a post require the numeric `media_id`.** The shortcode visible in an Instagram URL is not accepted as an identifier in any API call — passing a shortcode where a `media_id` is expected will result in an error. The shortcode must always be resolved to a `media_id` before making any API call.

An Instagram post URL contains a **shortcode**, not a `media_id`:

```
https://www.instagram.com/p/ExampleShortCode2/
                                └─ shortcode: ExampleShortCode2
```

The shortcode and the `media_id` are entirely different identifiers. The `media_id` is the numeric identifier used internally by the Graph API and is **not** derivable from the shortcode in a way that the Graph API will accept. There are three known approaches to resolve a shortcode to a `media_id`, each with significant trade-offs:

---

**Method 1 — Mathematical Decoding *(not production-safe)***

Instagram shortcodes are encoded using a custom Base64 alphabet:
```
ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_
```

Decoding the shortcode character by character produces a numeric value that appears to match the shortcode encoding:

```javascript
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function shortcodeToMediaId(shortcode) {
  let mediaId = BigInt(0)
  for (const char of shortcode) {
    const index = ALPHABET.indexOf(char)
    if (index === -1) throw new Error(`Invalid shortcode character: ${char}`)
    mediaId = mediaId * BigInt(64) + BigInt(index)
  }
  return mediaId.toString()
}
// shortcodeToMediaId('ExampleShortCode1') → "1000000000000000000"
```

> `BigInt` is required because Instagram `media_id` values exceed JavaScript's `Number.MAX_SAFE_INTEGER` (2⁵³ − 1).

**Why this is not production-safe:** Although the decoded value is mathematically correct for the shortcode encoding, the Graph API does **not** accept it as a valid `media_id`. The Graph API uses its own internal scoped IDs that exist in a different ID space from what the shortcode encodes. Calling `GET /{decoded-id}` will return error code `100/33`: *"Unsupported get request. Object does not exist or cannot be loaded."* This method cannot be relied upon for production use.

---

**Method 2 — Paginated Media List Lookup *(production-ready with caching)***

The only reliable way to resolve a shortcode to a Graph API `media_id` without a special approved permission is to fetch posts from the account and match by permalink shortcode.

**Flow:**
```
1. Check local cache (previously fetched media_ids stored against their shortcodes)
   → If found: return cached media_id immediately, no API call needed

2. If not cached, paginate GET /{ig-user-id}/media (50 posts per page)
   → For each page, check if any post's permalink contains the shortcode
   → On match: return media_id and cache it for future lookups
   → Apply a page cap (e.g. 10 pages = 500 posts) to prevent runaway API calls
```

**Why caching is essential:** Without a cache, every request for the same post would scan through pages of media. With a cache, the cost is paid once — subsequent lookups are instant with zero API calls.

**Rate limiting risk:** If the target post is old and the cache is cold, resolving it requires multiple paginated API calls. Meta enforces rate limits per token — sustained high-volume scanning across many accounts can trigger throttling or temporary blocks. The page cap mitigates this but means posts older than the cap limit cannot be found until the oEmbed permission is available.

---

**Method 3 — Instagram oEmbed API *(requires Meta App Review)***

Meta provides a dedicated endpoint that resolves any Instagram URL directly to a `media_id` in a single call:

```
GET https://graph.facebook.com/v23.0/instagram_oembed
  ?url=https://www.instagram.com/p/ExampleShortCode2/
  &access_token={token}

Response:
{
  "media_id": "1000000000000000001",
  "author_name": "...",
  "thumbnail_url": "...",
  ...
}
```

This is the most direct and efficient solution — no scanning, no pagination, no rate limiting risk, works for any post regardless of age.

**Why it is not immediately usable:** The `instagram_oembed` endpoint requires the **`Meta oEmbed Read`** permission, which must be submitted for App Review and approved by Meta before it can be used — even in a live app. Attempting to call this endpoint without the approved permission returns:
```json
{ "error": { "code": 10, "message": "(#10) To use 'Meta oEmbed Read', your use of this endpoint must be reviewed and approved by Facebook." } }
```

**Recommendation:** Submit `Meta oEmbed Read` for App Review as part of the production app setup. Until it is approved, Method 2 with caching is the fallback.

---

#### Fetching Media (Posts)

```
GET /{ig-user-id}/media
  Token: Instagram access token (requires instagram_basic)
  Fields: id, caption, media_type, permalink, thumbnail_url, timestamp, boost_ads_list
  Limit: up to 50 per page
  → Returns the influencer's recent posts. The boost_ads_list field, when
    present, directly links the post to any active Meta Ads boosting it —
    this is the preferred path for discovering the associated ad_id
    without scanning all ads.
```

If the `media_id` is already known, the full media list does not need to be fetched. The media node can be queried directly to retrieve only the `boost_ads_list` for that specific post:

```
GET /{media-id}
  Token: Instagram access token (requires instagram_basic)
  Fields: id, boost_ads_list
  → Returns boost_ads_list for a single known post without fetching
    the entire media list
```

**Key field — `boost_ads_list`:** When Meta Ads boosts a post, it may populate this field on the media object with the `ad_id` of the active boost. This creates a direct bridge from the organic media object to the paid ad — avoiding the need to scan all ads in the account.

> ⚠️ **Critical limitation — `boost_ads_list` is unreliable and should never be the sole method for discovering a linked ad.**
>
> This field is **only** populated when **all** of the following conditions are true:
> - The boost was created using the **"Boost Post" button directly inside the Instagram app**
> - The boost is currently **active** at the time of the API call
>
> It will **not** be populated in these common real-world scenarios:
> - The campaign was created or managed through **Meta Ads Manager** — the standard tool used by advertisers, agencies, and any serious advertising workflow
> - The boost has **ended or completed**, even if it was originally created from the Instagram app
> - The ad was created using the post as a creative source rather than via "Boost Post"
>
> In practice, **most production boosts go through Ads Manager**, meaning `boost_ads_list` will be empty for the majority of boosted posts. The ad scan (Path B) is the only reliable method for discovering linked ads across all boosting scenarios.

---

#### Fetching Organic Post Metrics

```
GET /{media-id}/insights
  Token: Instagram access token (requires instagram_manage_insights)
  Parameter — metric: (varies by media_type)
    IMAGE:          reach, likes, comments, shares, saved, total_interactions
    VIDEO:          reach, likes, comments, shares, saved, views, total_interactions
    CAROUSEL_ALBUM: reach, likes, comments, shares, saved, total_interactions
    REELS:          reach, likes, comments, shares, saved, views, total_interactions
  → Returns the organic performance metrics for a specific post
```

> `impressions` is no longer available for organic media insights as of API v22.0+. The only way to obtain impression counts for a boosted post is through the Marketing API.

---

### Meta Marketing API

#### Resolving Ad Account Access

```
GET /me
  Token: Facebook (Ads) access token
  Fields: id, name
  → Returns the Facebook user identity tied to the ads token.
    This is a different identity context from the Instagram token /me call.

GET /me/adaccounts
  Token: Facebook access token (requires ads_read)
  Fields: id, account_id, name, account_status, currency, timezone_name
  Limit: up to 100
  → Returns all ad accounts the authenticated user has access to.
    The ad-account-id (prefixed act_) from this response is required
    for all subsequent ad and campaign queries.

GET /me/permissions
  Token: Facebook access token
  → Returns the list of OAuth permissions granted to this token and
    their approval status. Use this to verify ads_read is present
    before attempting any Marketing API calls.
```

---

#### Navigating the Campaign Hierarchy

Meta Ads are structured in a three-level hierarchy: **Campaign → Ad Set → Ad**. Campaigns define the objective and budget. Ad Sets define targeting and scheduling. Ads contain the actual creative tied to the Instagram post.

```
GET /{ad-account-id}/campaigns
  Token: Facebook access token (requires ads_read)
  Fields: id, name, status, effective_status, objective,
          created_time, daily_budget, lifetime_budget,
          ads { id, name, effective_status,
                creative { id, instagram_permalink_url, effective_object_story_id } }
  → Returns campaigns in the account with a nested preview of their ads
    and creative identifiers. Useful for browsing the campaign structure
    and identifying which campaigns contain boosted Instagram posts.

GET /{ad-account-id}/ads
  Token: Facebook access token (requires ads_read)
  Fields: id, name, adset_id, campaign_id, effective_status,
          creative { id, effective_object_story_id, object_story_id,
                     instagram_actor_id, instagram_permalink_url }
  Limit: 500 per page (cursor-paginated)
  → Returns all ads in the account. The creative fields on each ad
    are what link the ad back to a specific Instagram post — either
    through the instagram_permalink_url or the object_story_id.
```

---

#### Confirming the Ad Creative

Once a candidate `ad_id` is identified, its creative is fetched to confirm the link to the Instagram post before pulling metrics.

```
GET /{ad-id}
  Token: Facebook access token (requires ads_read)
  Fields: id, name, effective_status,
          creative {
            id,
            source_instagram_media_id,       ← the original organic media used as the ad source
            effective_instagram_media_id,    ← the actual media object served in the ad placement
            instagram_permalink_url,         ← the Instagram post URL being promoted
            effective_object_story_id        ← page_id_media_id composite used for story matching
          }
  → Confirms which Instagram media object this ad is promoting.
    source_instagram_media_id maps directly to the organic media_id.
```

**How the creative fields relate:**

| Creative Field | What It Represents |
|---|---|
| `source_instagram_media_id` | The `media_id` of the original Instagram post that was used as the ad's creative source |
| `effective_instagram_media_id` | The `media_id` of the media actually served — may differ from the source if the creative was adapted |
| `instagram_permalink_url` | The full permalink URL of the Instagram post being promoted |
| `effective_object_story_id` | A composite ID in the format `{page_id}_{media_id}` — the leaf segment after the last `_` is the `media_id` |

---

#### Fetching Paid Metrics (Ad Insights)

```
GET /{ad-id}/insights
  Token: Facebook access token (requires ads_read)
  Parameters:
    level: ad
    fields: ad_id, impressions, reach, clicks, spend, actions
    date_preset: maximum          ← aggregates all-time performance data
  → Returns the paid performance metrics for the ad
```

**Response shape:**
```json
{
  "data": [{
    "ad_id": "...",
    "impressions": "14200",
    "reach": "11800",
    "clicks": "340",
    "spend": "52.18",
    "actions": [
      { "action_type": "link_click",                        "value": "210"  },
      { "action_type": "post_engagement",                   "value": "9260" },
      { "action_type": "onsite_conversion.post_net_like",   "value": "9247" },
      { "action_type": "onsite_conversion.post_save",       "value": "183"  },
      { "action_type": "comment",                           "value": "15"   },
      { "action_type": "video_view",                        "value": "6100" }
    ]
  }]
}
```

The `actions` array is a flat list of `{ action_type, value }` pairs. It should be converted to a key-value map keyed by `action_type` to align with organic metric field names for merging.

---

## 6. Flow of Fetching Paid Metrics for a Known Instagram Media ID

### The Core Problem
Meta does not provide a direct API call that takes an `instagram_media_id` and returns its associated `ad_id`. The link between an organic post and its paid boost must be **discovered** by examining ad creative fields. Two discovery paths exist depending on what data is available.

---

### Path A — Direct Link via `boost_ads_list` *(Preferred)*

If the `media_id` is already known, the `boost_ads_list` field can be fetched directly from that media node without loading the full media list:

```
GET /{media-id}
  Token: Instagram access token (requires instagram_basic)
  Fields: id, boost_ads_list
  → Response: "boost_ads_list": { "data": [{ "ad_id": "120212345678" }] }
```

Alternatively, `boost_ads_list` is also returned when fetching the full media list:

```
GET /{ig-user-id}/media
  Fields: ..., boost_ads_list
  → Response includes boost_ads_list on each media object in the list
```

If `boost_ads_list` is populated, the `ad_id` is known immediately. Proceed directly to confirming the creative and fetching insights — no scanning required.

**Why this doesn't always work:** `boost_ads_list` is only populated for **active** boosts and is not always present for completed campaigns or boosts initiated through Meta Ads Manager rather than the Instagram app.

---

### Path B — Ad Scan with Creative Matching *(Fallback)*

When `boost_ads_list` is absent, the ad account must be scanned to find the ad that promoted the post.

#### Step 1 — Fetch All Ads with Creative Fields
```
GET /{ad-account-id}/ads
  Fields: id, name, adset_id, campaign_id, effective_status,
          creative { id, effective_object_story_id, object_story_id,
                     instagram_actor_id, instagram_permalink_url }
  Limit: 500 per page, paginate via cursor until exhausted
```

#### Step 2 — Match Against the Known Media ID

For each ad returned, two matching strategies are applied in order:

**Strategy A — Shortcode match** *(high confidence)*
Extract the shortcode from the known post permalink (e.g. `ExampleCode` from `https://www.instagram.com/reel/ExampleCode/`) and check if `creative.instagram_permalink_url` contains it:
```
creative.instagram_permalink_url contains shortcode  →  match
```
This works for posts boosted from both the Instagram app and Meta Ads Manager.

**Strategy B — Media ID match against story object ID** *(fallback)*
The `effective_object_story_id` field is a composite of `{page_id}_{media_id}`. Split it by `_` and compare the last segment against the known `media_id`:
```
effective_object_story_id = "111222333_<media_id>"
last segment == media_id  →  high confidence match
full string contains media_id  →  medium confidence match
```

The first ad that satisfies either strategy is used. Iteration stops immediately on the first match.

---

### Step 3 — Confirm the Creative
```
GET /{ad-id}
  Fields: id, name, effective_status,
          creative { id, source_instagram_media_id, effective_instagram_media_id,
                     instagram_permalink_url, effective_object_story_id }
```
Verify that `source_instagram_media_id` or `effective_instagram_media_id` matches the known `media_id` before pulling metrics. This guards against false-positive matches from the scan.

---

### Step 4 — Fetch Paid Metrics
```
GET /{ad-id}/insights
  level: ad
  fields: ad_id, impressions, reach, clicks, spend, actions
  date_preset: maximum
```

---

### Full API Call Sequence

> **Precondition:** `media_id` is already known. URL-to-media_id resolution is a separate concern covered in Section 5.

```
Known: media_id
         │
         ├─────────────────────────────────────────────────────┐
         ▼                                                     ▼
Instagram Graph API                                    Instagram Graph API
───────────────────                                    ───────────────────
GET /{media-id}                                        GET /{media-id}/insights
  fields: boost_ads_list                                 → organic metrics:
  → boost_ads_list populated?                              reach, likes, comments,
      │                                                    shares, saved, views
      ├─ YES: ad_id known ─────────────────┐
      │                                   │
      └─ NO: scan ads                     │
           │                              │
           ▼                              │
    Marketing API                         │
    ────────────                          │
    GET /{ad-account-id}/ads (paginated)  │
      → match creative fields             │
          ├─ shortcode in permalink  →  high confidence
          └─ media_id in story_id    →  high/medium confidence
      → first match: ad_id found          │
           │                              │
           ▼                              │
    GET /{ad-id}                          │
      → confirm creative links            │
        to the known media_id             │
           │                              │
           ▼                              │
    GET /{ad-id}/insights ◄───────────────┘
      → impressions, reach,
        clicks, spend, actions[]
      → flatten actions[] into
        { action_type: value } map
         │
         ▼
    Merge organic + paid into combined view
```

---

### Why Both Tokens Are Needed

| Data | Token Required | Scope Required |
|---|---|---|
| `media_id`, `permalink`, `boost_ads_list` | Instagram token | `instagram_basic` |
| Organic insights (reach, likes, etc.) | Instagram token | `instagram_manage_insights` |
| Ad account list | Facebook token | `ads_read` |
| Ad creative fields | Facebook token | `ads_read` |
| Ad insights (impressions, spend, actions) | Facebook token | `ads_read` |

The two tokens are independent. Neither can substitute for the other — the Instagram token cannot call Marketing API endpoints, and the Facebook Ads token cannot call Instagram media insights endpoints.

---

## 7. External Resource Links for Further Reading

| Resource | Link |
|---|---|
| Instagram Graph API Overview | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api |
| Instagram Media Insights Reference | https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights |
| Instagram Login & OAuth | https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login |
| Meta Marketing API Overview | https://developers.facebook.com/docs/marketing-apis |
| Ads Insights API Reference | https://developers.facebook.com/docs/marketing-api/reference/adgroup/insights |
| Ad Creative Reference | https://developers.facebook.com/docs/marketing-api/reference/ad-creative |
| Permissions Reference | https://developers.facebook.com/docs/permissions |
| Long-Lived Tokens | https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived |
| Graph API Explorer | https://developers.facebook.com/tools/explorer/ |
| Access Token Debugger | https://developers.facebook.com/tools/debug/accesstoken/ |

---

*Last updated: March 2026 — API version: v23.0*
