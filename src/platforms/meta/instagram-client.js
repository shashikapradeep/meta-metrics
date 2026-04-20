const axios = require('axios')
const db = require('../../db')

const FB_GRAPH_BASE = process.env.META_GRAPH_BASE || 'https://graph.facebook.com/v23.0'
const IG_AUTHORIZE_URL = process.env.INSTAGRAM_OAUTH_AUTHORIZE_URL || 'https://www.facebook.com/v23.0/dialog/oauth'

function getInstagramClientId() {
  return process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID
}

function getInstagramClientSecret() {
  return process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET
}

// Instagram shortcodes are base64url-encoded numeric media IDs using this alphabet.
// Decoding gives the numeric ID that can be fetched directly via GET /{mediaId}.
const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function shortcodeToMediaId(shortcode) {
  let n = BigInt(0)
  for (const c of shortcode) {
    n = n * BigInt(64) + BigInt(SHORTCODE_ALPHABET.indexOf(c))
  }
  return n.toString()
}

// impressions was removed from IG Media insights in API v22.0+.
// plays was replaced by views for VIDEO and REELS in v22.0+.
const METRICS_BY_TYPE = {
  IMAGE:          'reach,likes,comments,shares,saved,total_interactions',
  VIDEO:          'reach,likes,comments,shares,saved,views,total_interactions',
  CAROUSEL_ALBUM: 'reach,likes,comments,shares,saved,total_interactions',
  REELS:          'reach,likes,comments,shares,saved,views,total_interactions',
  DEFAULT:        'reach,likes,comments,shares,saved,total_interactions',
}

class InstagramClient {
  constructor(accessToken, igUserId = null) {
    this.token = accessToken
    this.igUserId = igUserId
  }

  static buildAuthUrl(state, scope) {
    const params = new URLSearchParams({
      client_id: getInstagramClientId(),
      redirect_uri: process.env.META_REDIRECT_URI,
      response_type: 'code',
      scope,
      state,
    })
    return `${IG_AUTHORIZE_URL}?${params.toString()}`
  }

  static async exchangeCode(code) {
    const { data } = await axios.get(`${FB_GRAPH_BASE}/oauth/access_token`, {
      params: {
        client_id: getInstagramClientId(),
        client_secret: getInstagramClientSecret(),
        redirect_uri: process.env.META_REDIRECT_URI,
        code,
      },
    })
    return data
  }

  static async exchangeLongLived(shortToken) {
    const { data } = await axios.get(`${FB_GRAPH_BASE}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: getInstagramClientId(),
        client_secret: getInstagramClientSecret(),
        fb_exchange_token: shortToken,
      },
    })
    return data
  }

  // Refreshes a long-lived token. Can only be called on tokens that are at
  // least 24 hours old and not yet expired. Returns { access_token, expires_in }.
  static async refreshToken(token) {
    const { data } = await axios.get(`${FB_GRAPH_BASE}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: getInstagramClientId(),
        client_secret: getInstagramClientSecret(),
        fb_exchange_token: token,
      },
    })
    return data
  }

  async graphGet(path, params = {}) {
    try {
      const { data } = await axios.get(`${FB_GRAPH_BASE}${path}`, {
        params: { access_token: this.token, ...params },
      })
      return data
    } catch (err) {
      const meta = err.response?.data?.error
      throw Object.assign(new Error(meta?.message || err.message), { meta })
    }
  }

  // With Facebook Login (Business app), the user is a Facebook User.
  // Instagram Business Accounts are linked to Facebook Pages, not directly to the user.
  // We must go through /me/accounts to find the linked Instagram Business Account.
  async getMe() {
    try {
      // Log basic token identity first
      const meRes = await axios.get(`${FB_GRAPH_BASE}/me`, {
        params: { fields: 'id,name', access_token: this.token },
      })
      console.log('[getMe] /me:', JSON.stringify(meRes.data))

      // Fetch pages with name+id visible so we can see if pages exist at all
      const { data } = await axios.get(`${FB_GRAPH_BASE}/me/accounts`, {
        params: {
          fields: 'name,id,instagram_business_account{id,username}',
          access_token: this.token,
        },
      })
      console.log('[getMe] /me/accounts:', JSON.stringify(data, null, 2))

      const pages = data.data || []
      const pageWithIG = pages.find((p) => p.instagram_business_account)
      if (pageWithIG) {
        const igAccount = pageWithIG.instagram_business_account
        this.igUserId = igAccount.id
        return { id: igAccount.id, username: igAccount.username }
      }

      // Fallback: page is under Business Manager, not direct ownership.
      console.log('[getMe] /me/accounts empty — trying Business Manager path...')
      const bizRes = await axios.get(`${FB_GRAPH_BASE}/me/businesses`, {
        params: {
          fields: 'id,name,instagram_business_accounts{id,username}',
          access_token: this.token,
        },
      })
      console.log('[getMe] /me/businesses:', JSON.stringify(bizRes.data, null, 2))

      const businesses = bizRes.data.data || []
      for (const biz of businesses) {
        const igAccounts = biz.instagram_business_accounts?.data || []
        if (igAccounts.length > 0) {
          const igAccount = igAccounts[0]
          this.igUserId = igAccount.id
          return { id: igAccount.id, username: igAccount.username }
        }
      }

      throw Object.assign(
        new Error('No Instagram Business Account found'),
        { meta: { message: 'No Instagram Business Account found via pages or Business Manager. Make sure your Instagram account is set to Business or Influencer and is linked to a Facebook Page or Business Manager.' } }
      )
    } catch (err) {
      const meta = err.response?.data?.error
      if (meta) throw Object.assign(new Error(meta.message || err.message), { meta })
      throw err
    }
  }

  getMedia() {
    if (!this.igUserId) throw new Error('igUserId not set on InstagramClient')
    return this.graphGet(`/${this.igUserId}/media`, {
      fields: 'id,caption,media_type,permalink,thumbnail_url,timestamp,boost_ads_list',
      limit: 50,
    })
  }

  async findMediaByShortcode(shortcode, { maxPages = 10 } = {}) {
    if (!this.igUserId) throw new Error('igUserId not set on InstagramClient')

    // Check DB cache before hitting the API
    const cached = db.prepare(
      `SELECT media_id AS id, media_type, permalink, caption, posted_at AS timestamp
       FROM media_insights WHERE ig_user_id = ? AND permalink LIKE ?`
    ).get(this.igUserId, `%/${shortcode}/%`)
    if (cached) return cached

    // Try direct lookup by numeric media ID — faster and works for posts of any age
    try {
      const mediaId = shortcodeToMediaId(shortcode)
      const media = await this.graphGet(`/${mediaId}`, {
        fields: 'id,caption,media_type,permalink,thumbnail_url,timestamp,boost_ads_list',
      })
      if (media?.id) return media
    } catch {
      // Post not accessible via direct ID — fall through to paginated scan
    }

    // Fall back to paginating the account's media list
    let after = null
    let page = 0
    do {
      const params = {
        fields: 'id,caption,media_type,permalink,thumbnail_url,timestamp,boost_ads_list',
        limit: 50,
      }
      if (after) params.after = after
      const result = await this.graphGet(`/${this.igUserId}/media`, params)
      const match = (result.data || []).find((m) => m.permalink?.includes(shortcode))
      if (match) return match
      after = result.paging?.next ? result.paging.cursors?.after : null
      page++
    } while (after && page < maxPages)

    return null
  }

  getMediaInsights(mediaId, mediaType = 'DEFAULT') {
    const metric = METRICS_BY_TYPE[mediaType] || METRICS_BY_TYPE.DEFAULT
    return this.graphGet(`/${mediaId}/insights`, { metric })
  }
}

module.exports = InstagramClient
