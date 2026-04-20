const Database = require('better-sqlite3')
const path = require('path')

const db = new Database(path.join(__dirname, '..', 'data.db'))

db.exec(`
  -- One row per connected influencer Instagram account
  CREATE TABLE IF NOT EXISTS connected_accounts (
    ig_user_id   TEXT PRIMARY KEY,
    username     TEXT,
    access_token TEXT NOT NULL,
    expires_at   INTEGER,
    created_at   INTEGER DEFAULT (unixepoch()),
    updated_at   INTEGER DEFAULT (unixepoch())
  );

  -- Cached Instagram-side insights per media object.
  -- These are NOT a paid breakdown and should not replace ads reporting.
  CREATE TABLE IF NOT EXISTS media_insights (
    media_id     TEXT PRIMARY KEY,
    ig_user_id   TEXT NOT NULL,
    username     TEXT,
    media_type   TEXT,   -- IMAGE | VIDEO | CAROUSEL_ALBUM | REELS
    permalink    TEXT,
    caption      TEXT,
    posted_at    TEXT,
    impressions  INTEGER,
    reach        INTEGER,
    likes        INTEGER,
    comments     INTEGER,
    shares       INTEGER,
    saved        INTEGER,
    plays        INTEGER,
    fetched_at   INTEGER DEFAULT (unixepoch())
  );

  -- One ads-layer connection per influencer account for POC use.
  CREATE TABLE IF NOT EXISTS ad_connections (
    ig_user_id      TEXT PRIMARY KEY,
    meta_user_id    TEXT,
    meta_user_name  TEXT,
    ad_account_id   TEXT,
    access_token    TEXT NOT NULL,
    scopes          TEXT,
    expires_at      INTEGER,
    created_at      INTEGER DEFAULT (unixepoch()),
    updated_at      INTEGER DEFAULT (unixepoch())
  );

  -- Organic metrics from Phyllo (or injected from upstream pipeline in this POC app).
  CREATE TABLE IF NOT EXISTS organic_metrics (
    instagram_media_id  TEXT PRIMARY KEY,
    ig_user_id          TEXT,
    phyllo_content_id   TEXT,
    reach               INTEGER,
    impressions         INTEGER,
    likes               INTEGER,
    comments            INTEGER,
    shares              INTEGER,
    saves               INTEGER,
    video_views         INTEGER,
    metrics_json        TEXT,
    fetched_at          INTEGER DEFAULT (unixepoch())
  );

  -- Mapping between Instagram content and ad object discovered through Marketing API entities.
  CREATE TABLE IF NOT EXISTS content_paid_mapping (
    instagram_media_id         TEXT PRIMARY KEY,
    ig_user_id                 TEXT,
    ad_account_id              TEXT,
    ad_id                      TEXT,
    adset_id                   TEXT,
    campaign_id                TEXT,
    creative_id                TEXT,
    effective_object_story_id  TEXT,
    object_story_id            TEXT,
    match_confidence           TEXT,
    matched_at                 INTEGER DEFAULT (unixepoch())
  );

  -- Paid metrics fetched from Ads Insights.
  CREATE TABLE IF NOT EXISTS paid_metrics (
    instagram_media_id  TEXT PRIMARY KEY,
    ig_user_id          TEXT,
    ad_account_id       TEXT,
    ad_id               TEXT,
    impressions         INTEGER,
    reach               INTEGER,
    clicks              INTEGER,
    spend               REAL,
    actions_json        TEXT,
    fetched_at          INTEGER DEFAULT (unixepoch())
  );

  -- ── TikTok ──────────────────────────────────────────────────────────────────

  -- One row per connected TikTok creator account (Login Kit).
  -- open_id is stable per app-user pair (analogous to ig_user_id).
  -- access_token expires in 24 h; refresh_token is valid for 365 days.
  CREATE TABLE IF NOT EXISTS tiktok_accounts (
    open_id            TEXT PRIMARY KEY,
    display_name       TEXT,
    avatar_url         TEXT,
    access_token       TEXT NOT NULL,
    refresh_token      TEXT,
    expires_at         INTEGER,
    refresh_expires_at INTEGER,
    created_at         INTEGER DEFAULT (unixepoch()),
    updated_at         INTEGER DEFAULT (unixepoch())
  );

  -- Cached organic engagement counters per TikTok video.
  -- These come from the Content API video list (not paid reporting).
  -- Note: TikTok's view_count includes promoted views — it is NOT organic-only.
  CREATE TABLE IF NOT EXISTS tiktok_video_insights (
    video_id      TEXT PRIMARY KEY,
    open_id       TEXT NOT NULL,
    title         TEXT,
    cover_url     TEXT,
    share_url     TEXT,
    duration      INTEGER,
    create_time   INTEGER,
    view_count    INTEGER,
    like_count    INTEGER,
    comment_count INTEGER,
    share_count   INTEGER,
    fetched_at    INTEGER DEFAULT (unixepoch())
  );

  -- TikTok for Business (Ads) connection — one per creator account for POC use.
  -- advertiser_id is the TikTok Ads Manager account ID used for Spark Ads.
  CREATE TABLE IF NOT EXISTS tiktok_ad_connections (
    open_id         TEXT PRIMARY KEY,
    advertiser_id   TEXT,
    advertiser_name TEXT,
    access_token    TEXT NOT NULL,
    expires_at      INTEGER,
    created_at      INTEGER DEFAULT (unixepoch()),
    updated_at      INTEGER DEFAULT (unixepoch())
  );

  -- Mapping between a TikTok organic video and the Spark Ad that promoted it.
  -- tiktok_item_id on the ad creative is the link back to the creator's video.
  CREATE TABLE IF NOT EXISTS tiktok_content_paid_mapping (
    video_id               TEXT PRIMARY KEY,
    open_id                TEXT,
    advertiser_id          TEXT,
    ad_id                  TEXT,
    adgroup_id             TEXT,
    campaign_id            TEXT,
    creative_material_mode TEXT,   -- SPARK_ADS when boosted from organic post
    match_confidence       TEXT,
    matched_at             INTEGER DEFAULT (unixepoch())
  );

  -- Paid metrics fetched from TikTok Business API reporting endpoint.
  CREATE TABLE IF NOT EXISTS tiktok_paid_metrics (
    video_id           TEXT PRIMARY KEY,
    open_id            TEXT,
    advertiser_id      TEXT,
    ad_id              TEXT,
    impressions        INTEGER,
    reach              INTEGER,
    clicks             INTEGER,
    spend              REAL,
    video_play_actions INTEGER,
    video_watched_2s   INTEGER,
    video_watched_6s   INTEGER,
    metrics_json       TEXT,
    fetched_at         INTEGER DEFAULT (unixepoch())
  );

  -- ── YouTube ─────────────────────────────────────────────────────────────────

  -- One row per connected YouTube channel (Google OAuth, youtube.readonly scope).
  -- channel_id is the UCxxxxxxx identifier.
  -- access_token expires in 1 hour; refresh_token never expires unless revoked.
  CREATE TABLE IF NOT EXISTS youtube_channels (
    channel_id    TEXT PRIMARY KEY,
    channel_title TEXT,
    access_token  TEXT NOT NULL,
    refresh_token TEXT,
    expires_at    INTEGER,
    created_at    INTEGER DEFAULT (unixepoch()),
    updated_at    INTEGER DEFAULT (unixepoch())
  );

  -- Cached organic video metrics.
  -- view_count/like_count/comment_count come from YouTube Data API v3 (videos.list).
  -- share_count and estimated_minutes_watched come from YouTube Analytics API v2
  -- (not available in the Data API).
  -- Note: view_count includes ALL views, including those driven by paid ads.
  CREATE TABLE IF NOT EXISTS youtube_video_insights (
    video_id                  TEXT PRIMARY KEY,
    channel_id                TEXT NOT NULL,
    title                     TEXT,
    published_at              TEXT,
    thumbnail_url             TEXT,
    view_count                INTEGER,
    like_count                INTEGER,
    comment_count             INTEGER,
    share_count               INTEGER,
    estimated_minutes_watched INTEGER,
    fetched_at                INTEGER DEFAULT (unixepoch())
  );

  -- Google Ads connection — one per channel for POC use.
  -- customer_id is the 10-digit Google Ads customer ID (no hyphens).
  CREATE TABLE IF NOT EXISTS google_ads_connections (
    channel_id    TEXT PRIMARY KEY,
    customer_id   TEXT,
    customer_name TEXT,
    access_token  TEXT NOT NULL,
    refresh_token TEXT,
    expires_at    INTEGER,
    created_at    INTEGER DEFAULT (unixepoch()),
    updated_at    INTEGER DEFAULT (unixepoch())
  );

  -- Mapping between a YouTube video and the Google Ads campaign asset that uses it.
  -- The link is asset.youtube_video_asset.youtube_video_id in GAQL.
  CREATE TABLE IF NOT EXISTS youtube_content_paid_mapping (
    video_id         TEXT PRIMARY KEY,
    channel_id       TEXT,
    customer_id      TEXT,
    asset_id         TEXT,
    campaign_id      TEXT,
    ad_group_id      TEXT,
    match_confidence TEXT,
    matched_at       INTEGER DEFAULT (unixepoch())
  );

  -- Paid video metrics from Google Ads API (GAQL on campaign_asset).
  -- cost_micros is in millionths of the account currency (divide by 1_000_000).
  -- video_views = TrueView paid views (NOT addable to organic view_count).
  -- Quartile rates are percentages (0.0–1.0) averaged across campaign rows.
  CREATE TABLE IF NOT EXISTS youtube_paid_metrics (
    video_id                 TEXT PRIMARY KEY,
    channel_id               TEXT,
    customer_id              TEXT,
    asset_id                 TEXT,
    impressions              INTEGER,
    video_views              INTEGER,
    clicks                   INTEGER,
    cost_micros              INTEGER,
    video_quartile_p25_rate  REAL,
    video_quartile_p50_rate  REAL,
    video_quartile_p75_rate  REAL,
    video_quartile_p100_rate REAL,
    metrics_json             TEXT,
    fetched_at               INTEGER DEFAULT (unixepoch())
  );
`)

module.exports = db
