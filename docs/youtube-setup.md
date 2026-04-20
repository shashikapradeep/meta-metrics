# YouTube / Google Setup Guide

This guide walks through creating a Google Cloud OAuth app and obtaining all required environment variables to run organic YouTube video metrics.

---

## Required Environment Variables

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
YOUTUBE_REDIRECT_URI=http://localhost:3000/youtube/auth/callback
```

---

## Prerequisites

Before starting you need:

- A **Google account** to create the Google Cloud project
- A **YouTube channel** associated with that account (or a test channel)
- The channel should have at least some published videos to see metrics

---

## Step 1 — Create a Google Cloud Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Click the project dropdown at the top left → **New Project**
3. Fill in:
   - **Project name**: anything (e.g. "Creator Metrics")
   - **Location**: leave as default
4. Click **Create**
5. Make sure the new project is selected in the dropdown before continuing

---

## Step 2 — Enable Required APIs

1. Go to **APIs & Services → Library**
2. Search for and enable each of the following:

   **YouTube Data API v3**
   - Search "YouTube Data API v3" → click it → click **Enable**

   **YouTube Analytics API**
   - Search "YouTube Analytics API" → click it → click **Enable**

> Both APIs are required. The Data API provides view/like/comment counts; the Analytics API provides share count and watch time (not available in the Data API).

---

## Step 3 — Configure the OAuth Consent Screen

1. Go to **APIs & Services → OAuth consent screen**
2. Select **External** → click **Create**
3. Fill in the required fields:
   - **App name**: anything (e.g. "Creator Metrics")
   - **User support email**: your email address
   - **Developer contact information**: your email address
4. Click **Save and Continue**
5. On the **Scopes** screen, click **Save and Continue** (scopes are set in the OAuth client, not here)
6. On the **Test users** screen:
   - Click **+ Add Users**
   - Enter the Google account email that owns the YouTube channel you want to connect
   - Click **Add** → **Save and Continue**
7. Click **Back to Dashboard**

> While the app is in **Testing** status, only accounts listed as test users can authorize. You must add your own account here.

---

## Step 4 — Create OAuth Credentials

1. Go to **APIs & Services → Credentials**
2. Click **+ Create Credentials → OAuth client ID**
3. Fill in:
   - **Application type**: Web application
   - **Name**: anything (e.g. "Creator Metrics Web Client")
4. Under **Authorized redirect URIs**, click **+ Add URI** and enter:
   ```
   http://localhost:3000/youtube/auth/callback
   ```
5. Click **Create**
6. A dialog shows your credentials:
   - Copy **Your Client ID** → this is `GOOGLE_CLIENT_ID`
   - Copy **Your Client Secret** → this is `GOOGLE_CLIENT_SECRET`

---

## Step 5 — Update `.env`

```
GOOGLE_CLIENT_ID=xxxxxxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxxxx
YOUTUBE_REDIRECT_URI=http://localhost:3000/youtube/auth/callback
```

---

## Verification

Start the server and visit:
```
http://localhost:3000/youtube/auth/connect
```
You should be redirected to Google's OAuth consent screen.

On the consent screen you may see **"Google hasn't verified this app"** — this is expected for apps in Testing mode. Click **Advanced → Go to Creator Metrics (unsafe)** to proceed.

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `Access blocked: has not completed the Google verification process` | Your account is not in the test users list | Go to OAuth consent screen → Test users → add your email |
| `redirect_uri_mismatch` | Redirect URI doesn't match what's registered | Ensure the URI in Google Cloud Console matches `YOUTUBE_REDIRECT_URI` exactly |
| `Error 403: access_denied` | Account not added as a test user | Same as above — add the account to test users |
| `invalid_grant` on token refresh | Refresh token revoked or expired | Re-authenticate via `/youtube/auth/connect` |
| Analytics API returns null for share_count | Channel too small or video too new | Small channels (under ~1,000 views) may not have Analytics data. This is not an error — `share_count` will be `null` |

---

## Notes

- Google OAuth access tokens expire every **1 hour**. The server does a lazy refresh before every API call (if the token expires within 5 minutes). The token refresh scheduler also runs every 24 hours as a safety net.
- `refresh_token` is only returned by Google when the user grants consent for the **first time**. The OAuth URL includes `access_type=offline` and `prompt=consent` to force a new refresh token on every authorization — this is intentional and required.
- `view_count` from the YouTube Data API **includes all views** (organic and ad-driven). There is no way to separate them via this API.
- `share_count` and `estimated_minutes_watched` are only available from the YouTube Analytics API, not the Data API. The sync endpoint calls both APIs automatically.
- If using an ngrok or other public URL instead of `localhost`, add that URL to the **Authorized redirect URIs** in Google Cloud Console and update `YOUTUBE_REDIRECT_URI` in `.env`. Note that free ngrok URLs change on every restart.
