const axios = require('axios')

const TIKTOK_ADS_BASE = process.env.TIKTOK_ADS_BASE || 'https://business-api.tiktok.com/open_api/v1.3'
const TIKTOK_ADS_AUTHORIZE_URL = 'https://ads.tiktok.com/marketing_api/auth'
const TIKTOK_ADS_TOKEN_URL = `${TIKTOK_ADS_BASE}/oauth2/access_token/`

function normalizeEnv(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function isNumericString(value) {
  return /^\d+$/.test(String(value))
}

function getAppId() {
  return normalizeEnv(process.env.TIKTOK_APP_ID)
}

function getAppSecret() {
  return normalizeEnv(process.env.TIKTOK_CLIENT_SECRET)
}

function getAdsConfigError() {
  const appId = getAppId()

  if (!appId || appId === 'undefined' || appId.includes('${')) {
    return {
      error: 'TikTok Ads is not configured: missing TIKTOK_APP_ID',
      required_env: ['TIKTOK_APP_ID'],
      hint: 'Set TIKTOK_APP_ID to your numeric TikTok for Business App ID (not TIKTOK_CLIENT_KEY).',
    }
  }

  if (!isNumericString(appId)) {
    return {
      error: 'TikTok Ads is not configured: invalid TIKTOK_APP_ID',
      required_env: ['TIKTOK_APP_ID'],
      hint: `TIKTOK_APP_ID must be numeric. Received "${appId}".`,
    }
  }

  return null
}

function assertAdsConfig() {
  const configError = getAdsConfigError()
  if (configError) {
    const err = new Error(configError.error)
    err.meta = configError
    throw err
  }
}

class TikTokAdsClient {
  constructor(accessToken) {
    this.token = accessToken
  }

  // Builds the TikTok for Business authorization URL.
  // The resulting auth code is exchanged for an access token that grants
  // access to the advertiser accounts the user manages.
  static buildAuthUrl(state) {
    assertAdsConfig()
    const params = new URLSearchParams({
      app_id: getAppId(),
      redirect_uri: process.env.TIKTOK_ADS_REDIRECT_URI,
      state,
    })
    return `${TIKTOK_ADS_AUTHORIZE_URL}?${params.toString()}`
  }

  // Exchanges the auth_code returned from the Business API OAuth callback.
  // TikTok Business API uses JSON body (not form-encoded) for token exchange.
  // Returns: { access_token, advertiser_ids, ... } under data.
  static async exchangeCode(authCode) {
    assertAdsConfig()
    const { data } = await axios.post(
      TIKTOK_ADS_TOKEN_URL,
      { app_id: getAppId(), secret: getAppSecret(), auth_code: authCode },
      { headers: { 'Content-Type': 'application/json' } }
    )
    if (data.code !== 0) {
      throw Object.assign(new Error(data.message || 'TikTok Ads token exchange failed'), { meta: data })
    }
    return data.data
  }

  // TikTok Business API uses Access-Token header (not Bearer).
  async adsGet(path, params = {}) {
    try {
      const { data } = await axios.get(`${TIKTOK_ADS_BASE}${path}`, {
        params,
        headers: { 'Access-Token': this.token },
      })
      if (data.code !== 0) {
        throw Object.assign(new Error(data.message || 'TikTok Ads API error'), { meta: data })
      }
      return data.data
    } catch (err) {
      const meta = err.response?.data || err.meta
      throw Object.assign(new Error(meta?.message || err.message), { meta })
    }
  }

  async adsPost(path, body = {}) {
    try {
      const { data } = await axios.post(`${TIKTOK_ADS_BASE}${path}`, body, {
        headers: { 'Access-Token': this.token, 'Content-Type': 'application/json' },
      })
      if (data.code !== 0) {
        throw Object.assign(new Error(data.message || 'TikTok Ads API error'), { meta: data })
      }
      return data.data
    } catch (err) {
      const meta = err.response?.data || err.meta
      throw Object.assign(new Error(meta?.message || err.message), { meta })
    }
  }

  // Lists the advertiser accounts accessible with this access token.
  // app_id and secret are sent as query params alongside the Access-Token header.
  listAdvertisers() {
    assertAdsConfig()
    return this.adsGet('/oauth2/advertiser/get/', {
      app_id: getAppId(),
      secret: getAppSecret(),
    })
  }

  // Returns ad details for the given ad IDs including creative fields
  // (video_id / tiktok_item_id links a Spark Ad back to the organic video).
  getAds(advertiserId, adIds) {
    return this.adsGet('/ad/get/', {
      advertiser_id: advertiserId,
      fields: JSON.stringify([
        'ad_id', 'ad_name', 'status', 'secondary_status',
        'campaign_id', 'adgroup_id',
        'creative_material_mode',   // SPARK_ADS when boosted from organic
        'video_id',                 // ad-side video asset ID
        'tiktok_item_id',           // organic video ID used as Spark Ad source
      ]),
      filtering: JSON.stringify({ ad_ids: adIds }),
      page_size: 100,
      page: 1,
    })
  }

  // Scans all ads in the advertiser account and returns the first one whose
  // tiktok_item_id matches the given organic video ID.
  // tiktok_item_id is set when a creator's organic post is used as a Spark Ad.
  async findAdForVideo(advertiserId, videoId) {
    const vid = String(videoId)
    let page = 1

    do {
      const result = await this.adsGet('/ad/get/', {
        advertiser_id: advertiserId,
        fields: JSON.stringify([
          'ad_id', 'ad_name', 'status', 'secondary_status',
          'campaign_id', 'adgroup_id',
          'creative_material_mode',
          'video_id',
          'tiktok_item_id',
        ]),
        page_size: 100,
        page,
      })

      const ads = result?.list || []
      for (const ad of ads) {
        // tiktok_item_id is the organic video ID used as the Spark Ad creative
        if (String(ad.tiktok_item_id || '') === vid) {
          return {
            ad_id: String(ad.ad_id),
            ad_name: ad.ad_name || null,
            adgroup_id: String(ad.adgroup_id || ''),
            campaign_id: String(ad.campaign_id || ''),
            creative_material_mode: ad.creative_material_mode || null,
            match_confidence: 'high',
          }
        }
        // Fallback: video_id (ad-side asset) may also equal the organic ID in some configurations
        if (String(ad.video_id || '') === vid) {
          return {
            ad_id: String(ad.ad_id),
            ad_name: ad.ad_name || null,
            adgroup_id: String(ad.adgroup_id || ''),
            campaign_id: String(ad.campaign_id || ''),
            creative_material_mode: ad.creative_material_mode || null,
            match_confidence: 'medium',
          }
        }
      }

      const pageInfo = result?.page_info || {}
      if (page * 100 >= (pageInfo.total_number || 0)) break
      page++
    } while (true)

    return null
  }

  // Fetches lifetime paid metrics for a specific ad.
  // TikTok uses a reporting endpoint (not per-entity insights like Meta).
  getAdInsights(advertiserId, adId) {
    return this.adsPost('/report/integrated/get/', {
      advertiser_id: advertiserId,
      report_type: 'BASIC',
      data_level: 'AUCTION_AD',
      dimensions: ['ad_id'],
      metrics: [
        'impressions',
        'reach',
        'clicks',
        'spend',
        'video_play_actions',
        'video_watched_2s',
        'video_watched_6s',
        'video_views_p25',
        'video_views_p50',
        'video_views_p75',
        'video_views_p100',
      ],
      lifetime: true,
      filtering: [{ field_name: 'ad_ids', filter_type: 'IN', filter_value: JSON.stringify([String(adId)]) }],
    })
  }
}

TikTokAdsClient.getConfigError = getAdsConfigError

module.exports = TikTokAdsClient
