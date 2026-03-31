# Meta Metrics POC

A proof-of-concept Node.js server for fetching and merging **organic** (Instagram Graph API) and **paid** (Meta Marketing API) metrics for boosted Instagram posts.

## Overview

When an Instagram post is boosted, its performance data is split across two separate Meta API surfaces — organic engagement lives in the Instagram Graph API, while paid ad metrics live in the Marketing API. This POC connects both, discovers the ad linked to a given post, and merges the two metric sets into a single combined view.

## Prerequisites

- Node.js 18+
- A Meta developer app with the following products added:
  - Instagram Graph API
  - Facebook Login
  - Marketing API
- An Instagram Business account connected to a Facebook Page

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment**

   Copy `.env.example` to `.env` and fill in your credentials:

   ```bash
   cp .env.example .env
   ```

   | Variable | Description |
   |---|---|
   | `META_APP_ID` | App ID from Meta App Dashboard |
   | `META_APP_SECRET` | App Secret from Meta App Dashboard |
   | `META_REDIRECT_URI` | Instagram OAuth callback — must be registered in App Dashboard |
   | `META_ADS_REDIRECT_URI` | Meta Ads OAuth callback — must be registered in App Dashboard |
   | `PORT` | Server port (default: `3000`) |

   Optional overrides:
   | Variable | Description |
   |---|---|
   | `INSTAGRAM_APP_ID` | Separate App ID for Instagram Login product (falls back to `META_APP_ID`) |
   | `INSTAGRAM_APP_SECRET` | Separate App Secret for Instagram Login product |
   | `INSTAGRAM_OAUTH_SCOPES` | Override default Instagram OAuth scopes |
   | `META_GRAPH_BASE` | Override Graph API base URL (default: `https://graph.facebook.com/v23.0`) |

3. **Register redirect URIs** in Meta App Dashboard

   - `http://localhost:3000/auth/callback` → Instagram Login callback
   - `http://localhost:3000/connections/meta-ads/callback` → Meta Ads callback

## Running

```bash
# Production
npm start

# Development (auto-restart on file changes)
npm run dev
```

Server starts at `http://localhost:3000`. Open `http://localhost:3000/ui` to use the POC UI.

## Usage Flow

1. **Connect Instagram** — authorize an Instagram Business account via the UI (`GET /auth/connect`)
2. **Connect Meta Ads** — authorize the ad account that ran the boost (`POST /connections/meta-ads/init`)
3. **Select the ad account** — choose which ad account to use for a given influencer (`POST /connections/meta-ads/select-ad-account`)
4. **Sync boosted metrics** — provide an Instagram post URL or media ID to discover the linked ad and pull paid insights
5. **View merged metrics** — compare the combined organic + paid output against Instagram's native UI totals

## API Endpoints

### Auth

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/auth/connect` | Start Instagram Login OAuth flow |
| `GET` | `/auth/callback` | OAuth redirect handler (auto) |
| `GET` | `/auth/status` | List connected influencer accounts |
| `DELETE` | `/auth/disconnect/:igUserId` | Remove a stored token |
| `POST` | `/auth/refresh-tokens` | Refresh tokens expiring within 30 days |

### Meta Ads Connections

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/connections/meta-ads/init` | Build Meta Ads OAuth URL |
| `GET` | `/connections/meta-ads/callback` | Meta Ads OAuth callback |
| `POST` | `/connections/meta-ads/select-ad-account` | Set the active ad account for an influencer |
| `GET` | `/connections/meta-ads/status` | Check Meta Ads connection status (`?ig_user_id=`) |
| `GET` | `/connections/meta-ads/permissions` | Check granted/missing ads permissions (`?ig_user_id=`) |
| `GET` | `/connections/meta-ads/ad-accounts` | List accessible ad accounts (`?ig_user_id=`) |

### Metrics

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/media` | List influencer posts (`?ig_user_id=`) |
| `GET` | `/api/media/insights` | All posts with organic insights (`?ig_user_id=`) |
| `GET` | `/api/media/:mediaId/insights` | Single post organic insights (`?ig_user_id=`) |
| `GET` | `/api/saved-metrics` | View SQLite metric cache |
| `POST` | `/api/organic-metrics/upsert` | Push organic metrics from an external source (e.g. Phyllo) |
| `POST` | `/api/campaign-content/:instagramMediaId/boosted-metrics/sync` | Discover linked ad, pull paid insights, merge (`?ig_user_id=`) |
| `GET` | `/api/campaign-content/:instagramMediaId/metrics` | Get latest organic + paid + merged view (`?ig_user_id=`) |

## Architecture

```
src/
├── index.js                          # Express server, route mounting, token refresh scheduler
├── db.js                             # SQLite database (better-sqlite3)
└── platforms/meta/
    ├── index.js                      # Re-exports routes and utilities
    ├── instagram-client.js           # Instagram Graph API client
    ├── meta-ads.js                   # Meta Marketing API client
    └── routes/
        ├── auth.js                   # Instagram OAuth and token management
        ├── connections.js            # Meta Ads OAuth and connection management
        └── metrics.js                # Organic + paid metrics endpoints
```

**Storage:** Tokens and metrics are persisted locally in a SQLite database via `better-sqlite3`.

**Token refresh:** On startup (after 30s) and every 24 hours, the server automatically refreshes any Instagram access tokens expiring within 30 days.

## How Paid Metric Discovery Works

Meta provides no direct mapping from a post's `media_id` to its ad. Discovery follows two paths:

1. **Path A — `boost_ads_list`** (preferred): If the post was boosted via the Instagram app and the boost is still active, the `boost_ads_list` field on the media object contains the `ad_id` directly.

2. **Path B — Ad scan** (fallback): Paginate all ads in the connected ad account and match by shortcode in `creative.instagram_permalink_url` or by `media_id` in `creative.effective_object_story_id`. The first match is confirmed by fetching the full ad creative before pulling insights.

See [notion-doc-meta-metrics.md](notion-doc-meta-metrics.md) for full API documentation, metric definitions, and overlap behavior between organic and paid counts.

## Key Notes

- Two separate OAuth authorizations are required — Instagram Login (organic data) and Meta Ads Login (paid data). Neither token can substitute for the other.
- `impressions` was removed from organic Instagram Media insights in API v22.0+. Impression counts for boosted posts are only available through the Marketing API.
- Organic and paid reach/engagement figures overlap — Meta does not deduplicate them at the API level. Merged totals should be validated against the Instagram native UI.
- Current API version: `v23.0`
