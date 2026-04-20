const axios = require('axios')
const db = require('../../db')

const TIKTOK_CONTENT_BASE = process.env.TIKTOK_CONTENT_BASE || 'https://open.tiktokapis.com/v2'
const TIKTOK_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/'
const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/'

function getClientKey() {
  return process.env.TIKTOK_CLIENT_KEY
}

function getClientSecret() {
  return process.env.TIKTOK_CLIENT_SECRET
}

class TikTokClient {
  constructor(accessToken, openId = null) {
    this.token = accessToken
    this.openId = openId
  }

  // Builds the TikTok Login Kit authorization URL.
  // TikTok uses client_key (not client_id).
  static buildAuthUrl(state, scope) {
    const params = new URLSearchParams({
      client_key: getClientKey(),
      redirect_uri: process.env.TIKTOK_REDIRECT_URI,
      response_type: 'code',
      scope,
      state,
    })
    return `${TIKTOK_AUTHORIZE_URL}?${params.toString()}`
  }

  // Exchanges the authorization code for access + refresh tokens.
  // TikTok returns: { access_token, refresh_token, open_id, scope, expires_in, refresh_expires_in }
  static async exchangeCode(code) {
    const { data } = await axios.post(
      TIKTOK_TOKEN_URL,
      new URLSearchParams({
        client_key: getClientKey(),
        client_secret: getClientSecret(),
        code,
        grant_type: 'authorization_code',
        redirect_uri: process.env.TIKTOK_REDIRECT_URI,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    )
    if (data.error) {
      throw Object.assign(new Error(data.error_description || data.error), { meta: data })
    }
    return data
  }

  // Refreshes an access token using the refresh_token.
  // TikTok refresh tokens are valid for 365 days.
  // Returns: { access_token, refresh_token, open_id, expires_in, refresh_expires_in }
  static async refreshToken(refreshToken) {
    const { data } = await axios.post(
      TIKTOK_TOKEN_URL,
      new URLSearchParams({
        client_key: getClientKey(),
        client_secret: getClientSecret(),
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    )
    if (data.error) {
      throw Object.assign(new Error(data.error_description || data.error), { meta: data })
    }
    return data
  }

  // TikTok Content API uses Bearer token in Authorization header (not query param).
  async apiGet(path, params = {}) {
    try {
      const { data } = await axios.get(`${TIKTOK_CONTENT_BASE}${path}`, {
        params,
        headers: { Authorization: `Bearer ${this.token}` },
      })
      if (data.error?.code && data.error.code !== 'ok') {
        throw Object.assign(new Error(data.error.message || data.error.code), { meta: data.error })
      }
      return data
    } catch (err) {
      const meta = err.response?.data?.error || err.meta
      throw Object.assign(new Error(meta?.message || err.message), { meta })
    }
  }

  // TikTok Content API uses POST for video list (with JSON body + fields as query param).
  async apiPost(path, body = {}, params = {}) {
    try {
      const { data } = await axios.post(`${TIKTOK_CONTENT_BASE}${path}`, body, {
        params,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
      })
      if (data.error?.code && data.error.code !== 'ok') {
        throw Object.assign(new Error(data.error.message || data.error.code), { meta: data.error })
      }
      return data
    } catch (err) {
      const meta = err.response?.data?.error || err.meta
      throw Object.assign(new Error(meta?.message || err.message), { meta })
    }
  }

  // GET /v2/user/info/ — returns the connected TikTok user's identity.
  // open_id is the stable per-app user identifier (analogous to ig_user_id).
  async getMe() {
    const res = await this.apiGet('/user/info/', {
      fields: 'open_id,union_id,avatar_url,display_name',
    })
    return res.data?.user || res.data || {}
  }

  // POST /v2/video/list/ — lists the authenticated user's videos.
  // Fields requested include organic engagement counters.
  // TikTok paginates via cursor; set cursor=0 for the first page.
  async getVideos({ maxCount = 20, cursor = 0 } = {}) {
    const FIELDS = [
      'id', 'title', 'video_description', 'duration',
      'cover_image_url', 'share_url',
      'like_count', 'comment_count', 'share_count', 'view_count',
      'create_time',
    ].join(',')

    const res = await this.apiPost(
      '/video/list/',
      { max_count: maxCount, cursor },
      { fields: FIELDS }
    )
    return res.data || { videos: [], cursor: 0, has_more: false }
  }

  // Paginates getVideos until a video with the given share_url/video_id is found,
  // up to maxPages pages. Falls back to DB cache first.
  async findVideoById(videoId, { maxPages = 10 } = {}) {
    const cached = db.prepare(
      'SELECT video_id AS id, title, share_url, create_time, view_count, like_count, comment_count, share_count FROM tiktok_video_insights WHERE open_id = ? AND video_id = ?'
    ).get(this.openId, videoId)
    if (cached) return cached

    let cursor = 0
    let page = 0
    do {
      const result = await this.getVideos({ maxCount: 20, cursor })
      const videos = result.videos || []
      const match = videos.find((v) => v.id === videoId)
      if (match) return match
      if (!result.has_more) break
      cursor = result.cursor
      page++
    } while (page < maxPages)

    return null
  }
}

module.exports = TikTokClient
