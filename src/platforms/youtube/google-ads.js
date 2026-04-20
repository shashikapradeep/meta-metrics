const axios = require('axios')

// Google Ads REST API. GAQL (Google Ads Query Language) queries go to the
// googleAds:search endpoint. The developer-token header is required on every request.
const GOOGLE_ADS_BASE = process.env.GOOGLE_ADS_BASE || 'https://googleads.googleapis.com/v18'
const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

// Scope for Google Ads API access.
const ADS_SCOPE = 'https://www.googleapis.com/auth/adwords'

function getClientId() {
  return process.env.GOOGLE_CLIENT_ID
}

function getClientSecret() {
  return process.env.GOOGLE_CLIENT_SECRET
}

function getDeveloperToken() {
  return process.env.GOOGLE_ADS_DEVELOPER_TOKEN
}

// Customer IDs in Google Ads are plain 10-digit numbers (no hyphens) when used
// in API paths and headers, even though the UI shows them as 123-456-7890.
function normalizeCustomerId(id) {
  return String(id || '').replace(/-/g, '')
}

class GoogleAdsClient {
  constructor(accessToken, loginCustomerId = null) {
    this.token = accessToken
    // loginCustomerId is required only when calling as a Manager (MCC) account.
    this.loginCustomerId = loginCustomerId
      ? normalizeCustomerId(loginCustomerId)
      : (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
          ? normalizeCustomerId(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID)
          : null)
  }

  // Builds request headers. developer-token is always required.
  // login-customer-id is added only when a Manager account is configured.
  _headers() {
    const headers = {
      Authorization: `Bearer ${this.token}`,
      'developer-token': getDeveloperToken(),
      'Content-Type': 'application/json',
    }
    if (this.loginCustomerId) {
      headers['login-customer-id'] = this.loginCustomerId
    }
    return headers
  }

  // Builds the Google OAuth URL for the Ads scope.
  static buildAuthUrl(state) {
    const params = new URLSearchParams({
      client_id: getClientId(),
      redirect_uri: process.env.GOOGLE_ADS_REDIRECT_URI,
      response_type: 'code',
      scope: ADS_SCOPE,
      state,
      access_type: 'offline',
      prompt: 'consent',
    })
    return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`
  }

  static async exchangeCode(code) {
    const { data } = await axios.post(
      GOOGLE_TOKEN_URL,
      new URLSearchParams({
        code,
        client_id: getClientId(),
        client_secret: getClientSecret(),
        redirect_uri: process.env.GOOGLE_ADS_REDIRECT_URI,
        grant_type: 'authorization_code',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    )
    if (data.error) {
      throw Object.assign(new Error(data.error_description || data.error), { meta: data })
    }
    return data
  }

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

  // Executes a GAQL query against a specific customer's account.
  // POST /customers/{customerId}/googleAds:search
  // Returns the raw `results` array from the Google Ads API response.
  async gaqlSearch(customerId, query, { pageSize = 100 } = {}) {
    const cid = normalizeCustomerId(customerId)
    try {
      const { data } = await axios.post(
        `${GOOGLE_ADS_BASE}/customers/${cid}/googleAds:search`,
        { query, pageSize },
        { headers: this._headers() }
      )
      return data.results || []
    } catch (err) {
      const meta = err.response?.data
      const msg = meta?.error?.message || meta?.details?.[0]?.errors?.[0]?.message || err.message
      throw Object.assign(new Error(msg), { meta })
    }
  }

  // GET /customers:listAccessibleCustomers
  // Returns the list of customer resource names this token can access.
  // Used after the Ads OAuth callback to discover which accounts are available.
  async listAccessibleCustomers() {
    try {
      const { data } = await axios.get(
        `${GOOGLE_ADS_BASE}/customers:listAccessibleCustomers`,
        { headers: this._headers() }
      )
      // Response: { resourceNames: ["customers/1234567890", ...] }
      return (data.resourceNames || []).map((r) => r.replace('customers/', ''))
    } catch (err) {
      const meta = err.response?.data
      throw Object.assign(new Error(meta?.error?.message || err.message), { meta })
    }
  }

  // GET /customers/{customerId}
  // Returns descriptive info for a single customer account.
  async getCustomer(customerId) {
    const cid = normalizeCustomerId(customerId)
    try {
      const { data } = await axios.get(
        `${GOOGLE_ADS_BASE}/customers/${cid}`,
        { headers: this._headers() }
      )
      return data
    } catch (err) {
      const meta = err.response?.data
      throw Object.assign(new Error(meta?.error?.message || err.message), { meta })
    }
  }

  // Lists all accessible customers with their descriptive names.
  // Makes one getCustomer call per ID — suitable for POC scale.
  async listCustomersWithDetails() {
    const ids = await this.listAccessibleCustomers()
    const results = []
    for (const id of ids) {
      try {
        const customer = await this.getCustomer(id)
        results.push({
          customer_id: id,
          name: customer.descriptiveName || id,
          currency_code: customer.currencyCode || null,
          time_zone: customer.timeZone || null,
        })
      } catch {
        results.push({ customer_id: id, name: id })
      }
    }
    return results
  }

  // Scans campaign_asset rows across the given customer account for any ad using
  // the specified YouTube video as its creative asset.
  //
  // The GAQL link between a YouTube organic video and its paid ad is:
  //   asset.youtube_video_asset.youtube_video_id == '{videoId}'
  //
  // Returns the first matching { asset_id, campaign_id, ad_group_id, match_confidence }
  // or null if no ad is found.
  async findAdForVideo(customerId, videoId) {
    const query = `
      SELECT
        asset.id,
        asset.resource_name,
        asset.youtube_video_asset.youtube_video_id,
        campaign.id,
        campaign.name,
        ad_group.id,
        ad_group.name,
        campaign_asset.status
      FROM campaign_asset
      WHERE asset.type = 'YOUTUBE_VIDEO'
        AND asset.youtube_video_asset.youtube_video_id = '${String(videoId).replace(/'/g, '')}'
        AND campaign_asset.status != 'REMOVED'
      LIMIT 10
    `

    const results = await this.gaqlSearch(customerId, query)
    if (!results.length) return null

    const first = results[0]
    return {
      asset_id: String(first.asset?.id || ''),
      asset_resource_name: first.asset?.resourceName || null,
      campaign_id: String(first.campaign?.id || ''),
      campaign_name: first.campaign?.name || null,
      ad_group_id: String(first.adGroup?.id || ''),
      ad_group_name: first.adGroup?.name || null,
      match_confidence: 'high',
    }
  }

  // Fetches lifetime paid metrics for a specific YouTube video asset.
  // Uses campaign_asset as the FROM resource to join asset metadata with metrics.
  // cost_micros is in millionths of the account currency (divide by 1_000_000 for dollars).
  async getAdMetrics(customerId, videoId) {
    const query = `
      SELECT
        asset.id,
        asset.youtube_video_asset.youtube_video_id,
        campaign.id,
        campaign.name,
        metrics.impressions,
        metrics.video_views,
        metrics.clicks,
        metrics.cost_micros,
        metrics.video_quartile_p25_rate,
        metrics.video_quartile_p50_rate,
        metrics.video_quartile_p75_rate,
        metrics.video_quartile_p100_rate,
        metrics.engagements
      FROM campaign_asset
      WHERE asset.type = 'YOUTUBE_VIDEO'
        AND asset.youtube_video_asset.youtube_video_id = '${String(videoId).replace(/'/g, '')}'
        AND campaign_asset.status != 'REMOVED'
      LIMIT 10
    `

    const results = await this.gaqlSearch(customerId, query)
    if (!results.length) return null

    // Aggregate across multiple campaign_asset rows (same video in multiple campaigns)
    let impressions = 0, videoViews = 0, clicks = 0, costMicros = 0
    let q25 = 0, q50 = 0, q75 = 0, q100 = 0, engagements = 0
    let rowCount = 0

    for (const r of results) {
      const m = r.metrics || {}
      impressions  += Number(m.impressions  || 0)
      videoViews   += Number(m.videoViews   || 0)
      clicks       += Number(m.clicks       || 0)
      costMicros   += Number(m.costMicros   || 0)
      engagements  += Number(m.engagements  || 0)
      // Quartile rates: average across campaign rows (they're percentages)
      q25  += Number(m.videoQuartileP25Rate  || 0)
      q50  += Number(m.videoQuartileP50Rate  || 0)
      q75  += Number(m.videoQuartileP75Rate  || 0)
      q100 += Number(m.videoQuartileP100Rate || 0)
      rowCount++
    }

    return {
      impressions,
      video_views: videoViews,
      clicks,
      cost_micros: costMicros,
      spend: costMicros / 1_000_000,
      engagements,
      video_quartile_p25_rate: rowCount ? q25  / rowCount : null,
      video_quartile_p50_rate: rowCount ? q50  / rowCount : null,
      video_quartile_p75_rate: rowCount ? q75  / rowCount : null,
      video_quartile_p100_rate: rowCount ? q100 / rowCount : null,
      campaign_count: rowCount,
    }
  }
}

module.exports = GoogleAdsClient
module.exports.ADS_SCOPE = ADS_SCOPE
module.exports.normalizeCustomerId = normalizeCustomerId
