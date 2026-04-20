# Meta / Instagram Setup Guide

This guide walks through creating a Meta developer app and obtaining all required environment variables to run organic Instagram metrics and Meta Ads paid metrics.

---

## Required Environment Variables

```
META_APP_ID=
META_APP_SECRET=
META_REDIRECT_URI=http://localhost:3000/auth/callback
META_ADS_REDIRECT_URI=http://localhost:3000/connections/meta-ads/callback
```

---

## Prerequisites

Before starting you need:

- A **Facebook account** (personal account used to log into Meta for Developers)
- An **Instagram Business or Creator account** connected to a Facebook Page
  - In Instagram app: Settings → Account → Switch to Professional Account
  - In Facebook: Settings → Linked Accounts → connect your Instagram

---

## Step 1 — Create a Meta Developer App

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps)
2. Click **Create App**
3. Select **Other** as the use case → click **Next**
4. Select **Business** as the app type → click **Next**
5. Fill in:
   - **App name**: anything (e.g. "Creator Metrics")
   - **App contact email**: your email
   - **Business portfolio**: select one if you have it, or skip
6. Click **Create App**

---

## Step 2 — Get App ID and App Secret

1. From the app dashboard, go to **App Settings → Basic**
2. Copy **App ID** → this is `META_APP_ID`
3. Click **Show** next to App Secret, enter your password → copy it → this is `META_APP_SECRET`

---

## Step 3 — Add the Instagram Product

1. From the app dashboard, go to **Add Product**
2. Find **Instagram** → click **Set up**
3. Go to **Instagram → API setup with Instagram login**
4. Under **Valid OAuth Redirect URIs**, click **Add** and enter:
   ```
   http://localhost:3000/auth/callback
   ```
5. Click **Save changes**

---

## Step 4 — Add the Marketing API Product

1. From the app dashboard, go to **Add Product**
2. Find **Marketing API** → click **Set up**
3. Go to **Marketing API → Quickstart**
4. Under **Valid OAuth Redirect URIs**, click **Add** and enter:
   ```
   http://localhost:3000/connections/meta-ads/callback
   ```
5. Click **Save changes**

---

## Step 5 — Configure OAuth Scopes

1. Go to **Instagram → API setup with Instagram login → Permissions**
2. Add the following permissions:
   - `instagram_business_basic`
   - `instagram_business_manage_insights`
3. Go to **App Review** for each permission and submit for review if required (in Development mode these work for your own accounts without review)

---

## Step 6 — Switch App to Development Mode (for testing)

By default, new apps are in **Development** mode. This is fine for testing:

- Development mode allows access for **app administrators, developers, and testers** only
- Add test accounts: go to **Roles → Test Users** or **Roles → Testers**
- To use your own Instagram account, make sure the Facebook account that owns the Instagram Business account has a role on the app

---

## Step 7 — Update `.env`

```
META_APP_ID=your_app_id_here
META_APP_SECRET=your_app_secret_here
META_REDIRECT_URI=http://localhost:3000/auth/callback
META_ADS_REDIRECT_URI=http://localhost:3000/connections/meta-ads/callback
```

---

## Verification

Start the server and visit:
```
http://localhost:3000/auth/connect
```
You should be redirected to Facebook's OAuth consent screen.

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `redirect_uri_mismatch` | The redirect URI in the request doesn't match what's registered | Double-check the URI in App Dashboard matches `.env` exactly, including `http://` vs `https://` |
| `Invalid OAuth access token` | Token has expired (60-day lifetime) | Use `POST /auth/refresh-tokens` or re-authenticate |
| `Unsupported get request` on media insights | Instagram account is not a Business or Creator account | Switch the account type in Instagram settings |
| `(#10) Not enough permission` | Missing scope | Confirm `instagram_business_manage_insights` was added and authorized |

---

## Notes

- Instagram access tokens from this flow are **long-lived tokens** valid for 60 days. The server refreshes them automatically when they have fewer than 30 days remaining.
- Meta Ads tokens do not expire on a fixed schedule but can be revoked. Reconnect via the UI if the ads connection stops working.
- `impressions` is no longer returned from the Instagram Graph API (removed in v22.0+). Impression counts for boosted posts are only available through the Marketing API.
