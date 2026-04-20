# Platform Metrics POC

A proof-of-concept Node.js server for fetching organic metrics across **Instagram**, **TikTok**, and **YouTube**, with full organic + paid metric merging for **Instagram** (Meta Ads).

## Overview

Influencer content metrics are split across multiple API surfaces that cannot substitute for each other. This POC connects each platform's creator-side API to retrieve organic engagement data, and additionally connects the Meta Marketing API to discover boosted ads and merge paid metrics for Instagram posts.

| Platform | Organic Metrics | Paid Metrics |
|---|---|---|
| Instagram | Instagram Graph API | Meta Marketing API (Ads Insights) |
| TikTok | TikTok Content API (Login Kit) | — |
| YouTube | YouTube Data API v3 + Analytics API v2 | — |

## Prerequisites

- Node.js 18+
- Platform developer accounts (see Environment Setup below)

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   Fill in credentials for the platforms you want to use. Each platform is independent — the server starts without any of them configured.

3. **Run the server**

   ```bash
   npm start        # production
   npm run dev      # auto-restart on file changes
   ```

   Open `http://localhost:3000/ui` for the browser UI.

## Environment Variables

### Instagram / Meta

| Variable | Required | Description |
|---|---|---|
| `META_APP_ID` | Yes | App ID from Meta App Dashboard |
| `META_APP_SECRET` | Yes | App Secret from Meta App Dashboard |
| `META_REDIRECT_URI` | Yes | Instagram OAuth callback — `http://localhost:3000/auth/callback` |
| `META_ADS_REDIRECT_URI` | Yes | Meta Ads OAuth callback — `http://localhost:3000/connections/meta-ads/callback` |

Optional: `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_OAUTH_SCOPES`, `META_GRAPH_BASE`

**Redirect URIs to register** in Meta App Dashboard → Instagram → API setup:
- `http://localhost:3000/auth/callback`
- `http://localhost:3000/connections/meta-ads/callback`

### TikTok

| Variable | Required | Description |
|---|---|---|
| `TIKTOK_CLIENT_KEY` | Yes | Client Key from [developers.tiktok.com](https://developers.tiktok.com) → My Apps → Basic Info |
| `TIKTOK_CLIENT_SECRET` | Yes | Client Secret from the same page |
| `TIKTOK_REDIRECT_URI` | Yes | OAuth callback — `http://localhost:3000/tiktok/auth/callback` |

**Redirect URI to register** in TikTok Developer Portal → your app → Login Kit → Redirect URI allowlist:
- `http://localhost:3000/tiktok/auth/callback`

Optional: `TIKTOK_SCOPES`, `TIKTOK_CONTENT_BASE`

### YouTube / Google

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Yes | OAuth Client ID from [console.cloud.google.com](https://console.cloud.google.com) |
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth Client Secret from the same page |
| `YOUTUBE_REDIRECT_URI` | Yes | OAuth callback — `http://localhost:3000/youtube/auth/callback` |

**APIs to enable** in Google Cloud Console → APIs & Services → Library:
- YouTube Data API v3
- YouTube Analytics API

**Redirect URI to register** in Google Cloud Console → Credentials → your OAuth client → Authorized redirect URIs:
- `http://localhost:3000/youtube/auth/callback`

> The OAuth consent screen must be in **Testing** mode with your account added as a test user, or published for production use.

Optional: `GOOGLE_ADS_BASE`

## Usage Flow

### Instagram

1. Connect an Instagram Business account via the UI
2. Connect the Meta Ads account that ran the boost
3. Select the ad account for the influencer
4. Paste an Instagram post URL to sync organic + paid metrics
5. View the merged output

### TikTok

1. Connect a TikTok creator account via the UI
2. Load recent videos
3. Select a video to fetch its organic metrics

### YouTube

1. Connect a YouTube channel via Google OAuth
2. Load recent videos with organic stats
3. Select a video to sync its metrics (views, likes, comments, shares, watch time)

## API Endpoints

### Instagram Auth

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/auth/connect` | Start Instagram Login OAuth |
| `GET` | `/auth/callback` | OAuth redirect handler |
| `GET` | `/auth/status` | List connected accounts |
| `DELETE` | `/auth/disconnect/:igUserId` | Remove a stored token |
| `POST` | `/auth/refresh-tokens` | Refresh expiring tokens |

### Instagram Ads Connection

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/connections/meta-ads/init` | Build Meta Ads OAuth URL |
| `GET` | `/connections/meta-ads/callback` | Meta Ads OAuth callback |
| `POST` | `/connections/meta-ads/select-ad-account` | Set the active ad account |
| `GET` | `/connections/meta-ads/status` | Check connection status (`?ig_user_id=`) |
| `GET` | `/connections/meta-ads/permissions` | Check granted/missing permissions (`?ig_user_id=`) |
| `GET` | `/connections/meta-ads/ad-accounts` | List accessible ad accounts (`?ig_user_id=`) |

### Instagram Metrics

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/media` | List influencer posts (`?ig_user_id=`) |
| `GET` | `/api/media/insights` | All posts with organic insights (`?ig_user_id=`) |
| `GET` | `/api/media/:mediaId/insights` | Single post organic insights (`?ig_user_id=`) |
| `GET` | `/api/saved-metrics` | View SQLite metric cache |
| `POST` | `/api/organic-metrics/upsert` | Push organic metrics from external source |
| `POST` | `/api/campaign-content/:mediaId/boosted-metrics/sync` | Discover linked ad, pull paid insights, merge (`?ig_user_id=`) |
| `GET` | `/api/campaign-content/:mediaId/metrics` | Latest organic + paid + merged view (`?ig_user_id=`) |

### TikTok Auth

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/tiktok/auth/connect` | Start TikTok Login Kit OAuth |
| `GET` | `/tiktok/auth/callback` | OAuth redirect handler |
| `GET` | `/tiktok/auth/status` | List connected creators |
| `DELETE` | `/tiktok/auth/disconnect/:openId` | Remove a stored token |
| `POST` | `/tiktok/auth/refresh-tokens` | Refresh expiring tokens |

### TikTok Metrics

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/tiktok/api/videos` | List creator videos (`?open_id=`) |
| `GET` | `/tiktok/api/videos/insights` | Fetch and cache organic metrics for recent videos (`?open_id=`) |
| `GET` | `/tiktok/api/saved-metrics` | View SQLite metric cache |
| `POST` | `/tiktok/api/campaign-content/:videoId/spark-metrics/sync` | Fetch and store fresh organic metrics (`?open_id=`) |
| `GET` | `/tiktok/api/campaign-content/:videoId/metrics` | Latest cached metrics (`?open_id=`) |

### YouTube Auth

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/youtube/auth/connect` | Start Google OAuth |
| `GET` | `/youtube/auth/callback` | OAuth redirect handler |
| `GET` | `/youtube/auth/status` | List connected channels |
| `DELETE` | `/youtube/auth/disconnect/:channelId` | Remove a stored token |
| `POST` | `/youtube/auth/refresh-tokens` | Refresh expiring tokens |

### YouTube Metrics

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/youtube/api/videos` | List channel videos (`?channel_id=`) |
| `GET` | `/youtube/api/videos/insights` | Fetch and cache organic metrics for recent videos (`?channel_id=`) |
| `GET` | `/youtube/api/saved-metrics` | View SQLite metric cache |
| `POST` | `/youtube/api/campaign-content/:videoId/ad-metrics/sync` | Fetch and store fresh organic metrics (`?channel_id=`) |
| `GET` | `/youtube/api/campaign-content/:videoId/metrics` | Latest cached metrics (`?channel_id=`) |

## Architecture

```
src/
├── index.js                        # Express entry point, route mounting, token refresh scheduler
├── db.js                           # SQLite schema (better-sqlite3)
├── public/                         # Tabbed browser UI (Instagram / TikTok / YouTube)
└── platforms/
    ├── meta/
    │   ├── instagram-client.js     # Instagram Graph API wrapper
    │   ├── meta-ads.js             # Meta Marketing API wrapper
    │   └── routes/
    │       ├── auth.js             # Instagram OAuth + token refresh
    │       ├── connections.js      # Meta Ads OAuth + ad account selection
    │       └── metrics.js          # Organic + paid fetch, ad discovery, merge
    ├── tiktok/
    │   ├── tiktok-client.js        # TikTok Content API wrapper (Login Kit)
    │   └── routes/
    │       ├── auth.js             # TikTok Login OAuth + token refresh
    │       └── metrics.js          # Organic metrics fetch and cache
    └── youtube/
        ├── youtube-client.js       # YouTube Data API v3 + Analytics API v2 wrapper
        └── routes/
            ├── auth.js             # Google OAuth + token refresh
            └── metrics.js          # Organic metrics fetch and cache
```

**Storage:** All tokens and metrics are persisted in a local SQLite database (`data.db`, gitignored).

**Token refresh:** The scheduler runs 30 seconds after startup and every 24 hours. It refreshes Instagram tokens expiring within 30 days, TikTok tokens expiring within 24 hours, and YouTube tokens expiring within 10 minutes. YouTube also does lazy refresh before each API call.

## Key Notes

### Instagram

- Two separate OAuth flows are required: Instagram Login (organic) and Meta Ads Login (paid). Neither token substitutes for the other.
- `impressions` was removed from organic Instagram media insights in API v22.0+. Impression counts are only available through the Marketing API.
- Paid metric discovery follows two paths: `boost_ads_list` on the media object (preferred), then a full ad account scan matching by shortcode or `media_id` (fallback).
- Organic and paid reach/engagement overlap — Meta does not deduplicate them. Validate merged totals against the Instagram native UI.

### TikTok

- `view_count` from the Content API includes promoted views — it is not organic-only.
- TikTok access tokens expire every 24 hours; refresh tokens are valid for 365 days.

### YouTube

- `view_count` from the YouTube Data API includes all views (organic + ad-driven). Do not add paid views to it.
- `share_count` and `estimated_minutes_watched` are only available from the Analytics API, not the Data API.
- Google access tokens expire every hour — lazy refresh runs before each API call.
