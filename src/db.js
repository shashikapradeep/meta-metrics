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
`)

module.exports = db
