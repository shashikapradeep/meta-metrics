const axios = require('axios')

const FB_GRAPH_BASE = process.env.META_GRAPH_BASE || 'https://graph.facebook.com/v23.0'
const FB_DIALOG_BASE = 'https://www.facebook.com/v23.0/dialog/oauth'

function normalizeAdAccountId(adAccountId) {
  if (!adAccountId) return adAccountId
  return adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`
}

function parseStoryObjectId(storyId) {
  if (!storyId) return null
  const parts = String(storyId).split('_')
  return parts.length > 1 ? parts[parts.length - 1] : storyId
}

class MetaAdsClient {
  constructor(accessToken) {
    this.token = accessToken
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

  static buildAuthUrl(state, scope = 'ads_read,business_management') {
    const params = new URLSearchParams({
      client_id: process.env.META_APP_ID,
      redirect_uri: process.env.META_ADS_REDIRECT_URI,
      response_type: 'code',
      scope,
      state,
    })
    return `${FB_DIALOG_BASE}?${params.toString()}`
  }

  static async exchangeCode(code) {
    const { data } = await axios.get(`${FB_GRAPH_BASE}/oauth/access_token`, {
      params: {
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: process.env.META_ADS_REDIRECT_URI,
        code,
      },
    })
    return data
  }

  static async exchangeLongLived(shortToken) {
    const { data } = await axios.get(`${FB_GRAPH_BASE}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        fb_exchange_token: shortToken,
      },
    })
    return data
  }

  getMe() {
    return this.graphGet('/me', { fields: 'id,name' })
  }

  listAdAccounts() {
    return this.graphGet('/me/adaccounts', {
      fields: 'id,account_id,name,account_status,currency,timezone_name',
      limit: 100,
    })
  }

  getPermissions() {
    return this.graphGet('/me/permissions')
  }

  listCampaigns(adAccountId) {
    const normalizedId = normalizeAdAccountId(adAccountId)
    return this.graphGet(`/${normalizedId}/campaigns`, {
      fields: 'id,name,status,effective_status,objective,created_time,daily_budget,lifetime_budget,ads{id,name,effective_status,creative{id,instagram_permalink_url,effective_object_story_id}}',
      limit: 10,
    })
  }

  async listAds(adAccountId) {
    const normalizedId = normalizeAdAccountId(adAccountId)
    return this.graphGet(`/${normalizedId}/ads`, {
      fields: 'id,name,adset_id,campaign_id,effective_status,creative{id,effective_object_story_id,object_story_id,instagram_actor_id,instagram_permalink_url}',
      limit: 500,
    })
  }

  // Fetches the ad and its creative fields that link back to the organic Instagram post.
  // source_instagram_media_id  → the original organic media used as the ad source
  // effective_instagram_media_id → the actual media object served on the ad side
  // instagram_permalink_url     → the ad-side Instagram permalink
  getAdWithCreative(adId) {
    return this.graphGet(`/${adId}`, {
      fields: 'id,name,effective_status,creative{id,source_instagram_media_id,effective_instagram_media_id,instagram_permalink_url,effective_object_story_id}',
    })
  }

  getAdInsights(adId, { datePreset = 'maximum' } = {}) {
    return this.graphGet(`/${adId}/insights`, {
      level: 'ad',
      fields: 'ad_id,impressions,reach,clicks,spend,actions',
      date_preset: datePreset,
    })
  }

  // Scans all ads in the account (across all pages) and returns the first ad whose
  // creative matches the given Instagram post. Two strategies are tried per ad:
  //   1. Shortcode match via instagram_permalink_url — works for posts boosted from
  //      the Instagram app and posts promoted through Meta Ads Manager.
  //   2. Media ID match against effective_object_story_id / object_story_id leaf —
  //      fallback for cases where the permalink field is absent.
  async findAdForInstagramMedia(adAccountId, instagramMediaId, permalink = null) {
    const normalizedId = normalizeAdAccountId(adAccountId)
    const mediaId = String(instagramMediaId)
    const shortcode = permalink
      ? String(permalink).match(/instagram\.com\/(?:p|reel)\/([A-Za-z0-9_-]+)/)?.[1]
      : null

    const fields = 'id,name,adset_id,campaign_id,effective_status,creative{id,effective_object_story_id,object_story_id,instagram_actor_id,instagram_permalink_url}'
    let after = null

    do {
      const params = { fields, limit: 500 }
      if (after) params.after = after

      const adsData = await this.graphGet(`/${normalizedId}/ads`, params)
      const ads = adsData.data || []

      for (const ad of ads) {
        const creative = ad.creative || {}
        const effectiveStory = creative.effective_object_story_id
        const objectStory = creative.object_story_id
        const igPermalinkUrl = creative.instagram_permalink_url

        // Strategy 1: shortcode match via instagram_permalink_url
        if (shortcode && igPermalinkUrl && String(igPermalinkUrl).includes(shortcode)) {
          return {
            ad_id: ad.id,
            adset_id: ad.adset_id || null,
            campaign_id: ad.campaign_id || null,
            creative_id: creative.id || null,
            effective_object_story_id: effectiveStory || null,
            object_story_id: objectStory || null,
            instagram_permalink_url: igPermalinkUrl,
            match_confidence: 'high',
          }
        }

        // Strategy 2: media ID against story ID leaf (fallback, only when a real ID is given)
        if (!mediaId) continue
        const effectiveStoryLeaf = parseStoryObjectId(effectiveStory)
        const objectStoryLeaf = parseStoryObjectId(objectStory)
        const highConfidence = [effectiveStoryLeaf, objectStoryLeaf].includes(mediaId)
        const mediumConfidence = [effectiveStory, objectStory].some((v) => String(v || '').includes(mediaId))

        if (highConfidence || mediumConfidence) {
          return {
            ad_id: ad.id,
            adset_id: ad.adset_id || null,
            campaign_id: ad.campaign_id || null,
            creative_id: creative.id || null,
            effective_object_story_id: effectiveStory || null,
            object_story_id: objectStory || null,
            instagram_permalink_url: igPermalinkUrl || null,
            match_confidence: highConfidence ? 'high' : 'medium',
          }
        }
      }

      // Follow the next page cursor if there are more ads
      after = adsData.paging?.next ? adsData.paging.cursors?.after : null
    } while (after)

    return null
  }
}

module.exports = MetaAdsClient
