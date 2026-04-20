# TikTok Setup Guide

This guide walks through creating a TikTok developer app and obtaining all required environment variables to run organic TikTok video metrics.

---

## Required Environment Variables

```
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
TIKTOK_REDIRECT_URI=http://localhost:3000/tiktok/auth/callback
```

---

## Prerequisites

Before starting you need:

- A **TikTok account** (personal or business) to log into the TikTok developer portal
- The TikTok account whose videos you want to fetch must be the same account you authorize via OAuth (or a test account)

---

## Step 1 — Create a TikTok Developer App

1. Go to [developers.tiktok.com](https://developers.tiktok.com)
2. Click **Login** and sign in with your TikTok account
3. Go to **Manage apps → Create app**
4. Fill in:
   - **App name**: anything (e.g. "Creator Metrics")
   - **App category**: select the most appropriate option
   - **Description**: brief description of what the app does
5. Click **Submit for review** — but first, continue to configure the app below

---

## Step 2 — Get Client Key and Client Secret

1. After creating the app, go to **App details → Basic information**
2. Copy **Client key** → this is `TIKTOK_CLIENT_KEY`
3. Click the eye icon next to **Client secret** to reveal it → copy it → this is `TIKTOK_CLIENT_SECRET`

---

## Step 3 — Add the Login Kit Product

1. From the app page, go to **Add products**
2. Find **Login Kit** → click **Add**
3. Under **Redirect domain**, click **Add** and enter:
   ```
   localhost
   ```
4. Under **Redirect URI allowlist**, click **Add** and enter:
   ```
   http://localhost:3000/tiktok/auth/callback
   ```
5. Click **Save changes**

---

## Step 4 — Configure Required Scopes

1. Go to **Login Kit → Scopes**
2. Enable the following scopes:
   - `user.info.basic` — read the user's `open_id`, `display_name`, and `avatar_url`
   - `video.list` — list the user's own videos with engagement counters
3. Save changes

> These scopes are required for the app to work. Without `video.list` the video metrics endpoints will fail.

---

## Step 5 — Enable Sandbox Mode (for testing without app review)

TikTok requires app review before production use, but **Sandbox mode lets you test without review**.

1. From your app page, toggle the switch next to your app name to **Sandbox**
2. Click **Create Sandbox** and give it a name
3. Go to **Sandbox → Target users**
4. Add up to 10 TikTok accounts that you want to use for testing
5. Click **Apply changes**

The sandbox uses a different base URL. Add this to your `.env`:
```
TIKTOK_CONTENT_BASE=https://open.tiktokapis.com/v2
```
This is also the default, so it can be omitted unless you're switching between environments.

> Sandbox accounts are isolated from production data. The TikTok accounts you add as target users must authenticate against the sandbox app.

---

## Step 6 — Update `.env`

```
TIKTOK_CLIENT_KEY=aw6xxxxxxxxxxxxxxx
TIKTOK_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TIKTOK_REDIRECT_URI=http://localhost:3000/tiktok/auth/callback
```

---

## Verification

Start the server and visit:
```
http://localhost:3000/tiktok/auth/connect
```
You should be redirected to TikTok's OAuth consent screen.

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `App has been blocked or app is not exist` | Wrong credentials or app blocked | Verify `TIKTOK_CLIENT_KEY` is correct. Check app status in developer portal |
| `redirect_uri not match` | Redirect URI mismatch | Ensure the URI in Login Kit allowlist matches `TIKTOK_REDIRECT_URI` exactly |
| `embed_url are invalid field(s)` | Field removed from Content API | Already fixed — `embed_url` has been removed from the fields list |
| `Scope not authorized` | Missing scope | Add `user.info.basic` and `video.list` under Login Kit → Scopes |
| Token expired (24h) | TikTok access tokens expire in 24 hours | Use `POST /tiktok/auth/refresh-tokens` — refresh tokens last 365 days |

---

## Notes

- TikTok access tokens expire every **24 hours**. The server refreshes them automatically. Refresh tokens are valid for **365 days** — after that the creator must re-authenticate.
- `view_count` from the TikTok Content API **includes promoted (boosted) views** — it is not organic-only. There is no way to separate organic views from promoted views via this API.
- TikTok uses `client_key` in OAuth URLs (not `client_id` — this is a TikTok-specific naming convention).
