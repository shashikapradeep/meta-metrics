const axios = require('axios')
const db = require('../../db')

const YT_DATA_BASE = 'https://www.googleapis.com/youtube/v3'
const YT_ANALYTICS_BASE = 'https://youtubeanalytics.googleapis.com/v2'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

// Scopes for organic YouTube data. Both are needed:
//   youtube.readonly   → Data API v3 (video stats, channel info)
//   yt-analytics.readonly → Analytics API v2 (shares, watch time — not in Data API)
const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
].join(' ')

function getClientId() {
  return process.env.GOOGLE_CLIENT_ID
}

function getClientSecret() {
  return process.env.GOOGLE_CLIENT_SECRET
}

// YouTube access tokens expire in 1 hour. This threshold triggers a proactive
// refresh before making any API call, avoiding mid-request 401s.
const EXPIRY_BUFFER_SECONDS = 300 // 5 minutes

class YoutubeClient {
  constructor(accessToken, channelId = null) {
    this.token = accessToken
    this.channelId = channelId
  }

  // Builds the Google OAuth authorization URL for YouTube scopes.
  // access_type=offline → returns a refresh_token.
  // prompt=consent → always shows consent screen so refresh_token is returned
  //   even for previously-authorized users.
  static buildAuthUrl(state, scope = YOUTUBE_SCOPES) {
    const params = new URLSearchParams({
      client_id: getClientId(),
      redirect_uri: process.env.YOUTUBE_REDIRECT_URI,
      response_type: 'code',
      scope,
      state,
      access_type: 'offline',
      prompt: 'consent',
    })
    return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`
  }

  // Exchanges the authorization code for access + refresh tokens.
  // Google returns: { access_token, refresh_token, expires_in, token_type, scope }
  static async exchangeCode(code) {
    const { data } = await axios.post(
      GOOGLE_TOKEN_URL,
      new URLSearchParams({
        code,
        client_id: getClientId(),
        client_secret: getClientSecret(),
        redirect_uri: process.env.YOUTUBE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    )
    if (data.error) {
      throw Object.assign(new Error(data.error_description || data.error), { meta: data })
    }
    return data
  }

  // Refreshes a Google access token. Refresh tokens never expire unless revoked.
  // Returns: { access_token, expires_in, token_type, scope }
  static async refreshToken(refreshToken) {
    const { data } = await axios.post(
      GOOGLE_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: getClientId(),
        client_secret: getClientSecret(),
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    )
    if (data.error) {
      throw Object.assign(new Error(data.error_description || data.error), { meta: data })
    }
    return data
  }

  // Checks whether the stored access token is expired or within the expiry buffer.
  // If so, refreshes it and updates the DB row.
  // Returns the (possibly refreshed) access token to use for the next call.
  static async getValidToken(channelId) {
    const row = db.prepare('SELECT * FROM youtube_channels WHERE channel_id = ?').get(channelId)
    if (!row) throw new Error(`No YouTube channel found for channel_id=${channelId}`)

    const now = Math.floor(Date.now() / 1000)
    if (row.expires_at && row.expires_at > now + EXPIRY_BUFFER_SECONDS) {
      return row.access_token
    }

    // Token expired or expiring soon — refresh it
    if (!row.refresh_token) {
      throw Object.assign(
        new Error('YouTube access token expired and no refresh_token is stored. Re-authenticate.'),
        { meta: { code: 'token_expired' } }
      )
    }

    const refreshed = await YoutubeClient.refreshToken(row.refresh_token)
    const newExpiresAt = now + (refreshed.expires_in || 3600)

    db.prepare(`
      UPDATE youtube_channels
      SET access_token = ?, expires_at = ?, updated_at = unixepoch()
      WHERE channel_id = ?
    `).run(refreshed.access_token, newExpiresAt, channelId)

    return refreshed.access_token
  }

  async dataGet(path, params = {}) {
    try {
      const { data } = await axios.get(`${YT_DATA_BASE}${path}`, {
        params,
        headers: { Authorization: `Bearer ${this.token}` },
      })
      return data
    } catch (err) {
      const meta = err.response?.data?.error
      throw Object.assign(new Error(meta?.message || err.message), { meta })
    }
  }

  async analyticsGet(params = {}) {
    try {
      const { data } = await axios.get(`${YT_ANALYTICS_BASE}/reports`, {
        params,
        headers: { Authorization: `Bearer ${this.token}` },
      })
      return data
    } catch (err) {
      const meta = err.response?.data?.error
      throw Object.assign(new Error(meta?.message || err.message), { meta })
    }
  }

  // GET /channels?part=snippet,contentDetails&mine=true
  // Returns the authenticated user's channel id, title, and uploads playlist id.
  async getChannel() {
    const res = await this.dataGet('/channels', {
      part: 'snippet,contentDetails',
      mine: true,
    })
    const item = (res.items || [])[0]
    if (!item) throw new Error('No YouTube channel found for this Google account.')
    this.channelId = item.id
    return {
      channel_id: item.id,
      channel_title: item.snippet?.title || item.id,
      uploads_playlist_id: item.contentDetails?.relatedPlaylists?.uploads || null,
    }
  }

  // Lists video IDs from the channel's uploads playlist (max 50 per page).
  async listUploadedVideoIds(uploadsPlaylistId, { maxResults = 50 } = {}) {
    const res = await this.dataGet('/playlistItems', {
      part: 'contentDetails',
      playlistId: uploadsPlaylistId,
      maxResults,
    })
    return (res.items || []).map((item) => item.contentDetails?.videoId).filter(Boolean)
  }

  // Fetches video stats for up to 50 video IDs in one batch call (Data API v3).
  // Returns an array of { video_id, title, published_at, thumbnail_url, view_count,
  //   like_count, comment_count } objects.
  async getVideoStats(videoIds) {
    if (!videoIds.length) return []
    const res = await this.dataGet('/videos', {
      part: 'snippet,statistics',
      id: videoIds.join(','),
    })
    return (res.items || []).map((item) => ({
      video_id: item.id,
      title: item.snippet?.title || null,
      published_at: item.snippet?.publishedAt || null,
      thumbnail_url: item.snippet?.thumbnails?.medium?.url || null,
      view_count: Number(item.statistics?.viewCount ?? null) || null,
      like_count: Number(item.statistics?.likeCount ?? null) || null,
      comment_count: Number(item.statistics?.commentCount ?? null) || null,
    }))
  }

  // Fetches per-video analytics from YouTube Analytics API v2.
  // share_count and estimated_minutes_watched are only available here (not in Data API).
  // Requires a wide date range — Analytics API has no "all time" preset.
  // startDate defaults to 2015-01-01 to capture the full history for most channels.
  async getVideoAnalytics(channelId, videoId, {
    startDate = '2015-01-01',
    endDate = new Date().toISOString().slice(0, 10),
  } = {}) {
    const res = await this.analyticsGet({
      ids: `channel==${channelId}`,
      startDate,
      endDate,
      metrics: 'views,likes,shares,comments,estimatedMinutesWatched',
      dimensions: 'video',
      filters: `video==${videoId}`,
    })

    // Response shape: { columnHeaders: [{name}...], rows: [[dim, m1, m2...]...] }
    const headers = (res.columnHeaders || []).map((h) => h.name)
    const row = (res.rows || [])[0]
    if (!row) return null

    const out = {}
    headers.forEach((name, i) => { out[name] = row[i] })

    return {
      video_id: out.video || videoId,
      views: out.views ?? null,
      likes: out.likes ?? null,
      shares: out.shares ?? null,
      comments: out.comments ?? null,
      estimated_minutes_watched: out.estimatedMinutesWatched ?? null,
    }
  }
}

module.exports = YoutubeClient
module.exports.YOUTUBE_SCOPES = YOUTUBE_SCOPES
