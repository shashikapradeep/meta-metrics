const express = require('express')
const db = require('../../../db')
const InstagramClient = require('../instagram-client')
const MetaAdsClient = require('../meta-ads')

const router = express.Router()
const REQUIRED_ADS_PERMISSIONS = ['ads_read']

function toInt(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? null : parsed
}

function toFloat(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number.parseFloat(value)
  return Number.isNaN(parsed) ? null : parsed
}

function flattenActions(actions) {
  const out = {}
  for (const item of actions || []) {
    if (!item?.action_type) continue
    out[item.action_type] = toInt(item.value) ?? item.value ?? null
  }
  return out
}

function parseGrantedPermissions(scopesText) {
  return String(scopesText || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function mergeMetrics(organic = {}, paid = {}) {
  const organicReach = toInt(organic.reach)
  const paidReach = toInt(paid.reach)
  const organicImpressions = toInt(organic.impressions)
  const paidImpressions = toInt(paid.impressions)

  return {
    organic_reach: organicReach,
    paid_reach: paidReach,
    total_reach_display:
      organicReach === null && paidReach === null
        ? null
        : (organicReach || 0) + (paidReach || 0),

    organic_impressions: organicImpressions,
    paid_impressions: paidImpressions,
    total_impressions_display:
      organicImpressions === null && paidImpressions === null
        ? null
        : (organicImpressions || 0) + (paidImpressions || 0),

    organic_likes: toInt(organic.likes),
    organic_comments: toInt(organic.comments),
    organic_shares: toInt(organic.shares),
    organic_saves: toInt(organic.saves),
    organic_video_views: toInt(organic.video_views),

    paid_clicks: toInt(paid.clicks),
    paid_spend: toFloat(paid.spend),

    validation_note:
      'Totals are additive display metrics for POC. Validate against Instagram UI because metric semantics may differ by surface.',
  }
}

function requireInstagramAuth(req, res, next) {
  const igUserId = req.query.ig_user_id
  if (!igUserId) {
    return res.status(400).json({ error: 'Missing required query param: ig_user_id' })
  }

  const account = db.prepare('SELECT * FROM connected_accounts WHERE ig_user_id = ?').get(igUserId)

  if (!account) {
    return res.status(401).json({
      error: 'Account not connected. Influencer must authenticate first.',
      auth_url: '/auth/connect',
    })
  }

  if (account.expires_at < Math.floor(Date.now() / 1000)) {
    return res.status(401).json({
      error: 'Token expired. Re-authenticate.',
      auth_url: '/auth/connect',
    })
  }

  req.igClient = new InstagramClient(account.access_token, igUserId)
  req.igUserId = igUserId
  req.igUsername = account.username
  next()
}

// GET /api/media?ig_user_id=
// List the influencer's recent Instagram posts
router.get('/media', requireInstagramAuth, async (req, res) => {
  try {
    const result = await req.igClient.getMedia()
    res.json({
      ig_user_id: req.igUserId,
      username: req.igUsername,
      media: result.data || [],
      next: `/api/media/insights?ig_user_id=${req.igUserId}`,
    })
  } catch (err) {
    console.error('media error:', err.meta || err.message)
    res.status(500).json({ error: 'Failed to fetch media', details: err.meta || err.message })
  }
})

// GET /api/media/insights?ig_user_id=
// Fetches Instagram media-side insights for all recent posts of a connected influencer.
// Note: this endpoint is not a paid breakdown from Marketing API.
router.get('/media/insights', requireInstagramAuth, async (req, res) => {
  try {
    const mediaResult = await req.igClient.getMedia()
    const mediaList = mediaResult.data || []

    if (!mediaList.length) {
      return res.json({ ig_user_id: req.igUserId, username: req.igUsername, posts: [] })
    }

    const results = []
    const CONCURRENCY = 10

    for (let i = 0; i < mediaList.length; i += CONCURRENCY) {
      const batch = mediaList.slice(i, i + CONCURRENCY)
      const settled = await Promise.allSettled(
        batch.map(async (media) => {
          try {
            const insightsData = await req.igClient.getMediaInsights(media.id, media.media_type)
            const metrics = {}
            for (const item of insightsData.data || []) {
              metrics[item.name] = item.values?.[0]?.value ?? item.value ?? null
            }

            const row = {
              media_id: media.id,
              ig_user_id: req.igUserId,
              username: req.igUsername,
              media_type: media.media_type,
              permalink: media.permalink,
              caption: media.caption ? media.caption.substring(0, 120) : null,
              posted_at: media.timestamp,
              impressions: metrics.impressions ?? null,
              reach: metrics.reach ?? null,
              likes: metrics.likes ?? null,
              comments: metrics.comments ?? null,
              shares: metrics.shares ?? null,
              saved: metrics.saved ?? null,
              plays: metrics.plays ?? null,
            }

            db.prepare(`
              INSERT INTO media_insights
                (media_id, ig_user_id, username, media_type, permalink, caption, posted_at,
                 impressions, reach, likes, comments, shares, saved, plays)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(media_id) DO UPDATE SET
                impressions = excluded.impressions,
                reach = excluded.reach,
                likes = excluded.likes,
                comments = excluded.comments,
                shares = excluded.shares,
                saved = excluded.saved,
                plays = excluded.plays,
                fetched_at = unixepoch()
            `).run(
              row.media_id,
              row.ig_user_id,
              row.username,
              row.media_type,
              row.permalink,
              row.caption,
              row.posted_at,
              row.impressions,
              row.reach,
              row.likes,
              row.comments,
              row.shares,
              row.saved,
              row.plays
            )

            return row
          } catch (insightErr) {
            return {
              media_id: media.id,
              media_type: media.media_type,
              permalink: media.permalink,
              posted_at: media.timestamp,
              error: insightErr.meta?.message || 'Insights unavailable (personal account or old post)',
            }
          }
        })
      )

      for (const s of settled) {
        if (s.status === 'fulfilled') results.push(s.value)
      }
    }

    res.json({
      ig_user_id: req.igUserId,
      username: req.igUsername,
      total_posts: results.length,
      note: 'Instagram media insights are preserved for compatibility, but paid/non-organic metrics should come from Meta Ads Insights.',
      posts: results,
    })
  } catch (err) {
    console.error('insights error:', err.meta || err.message)
    res.status(500).json({ error: 'Failed to fetch insights', details: err.meta || err.message })
  }
})

// GET /api/media/:mediaId/insights?ig_user_id=
// Insights for a single post
router.get('/media/:mediaId/insights', requireInstagramAuth, async (req, res) => {
  try {
    const mediaList = await req.igClient.getMedia()
    const media = (mediaList.data || []).find((m) => m.id === req.params.mediaId)
    const mediaType = media?.media_type || 'DEFAULT'

    const insightsData = await req.igClient.getMediaInsights(req.params.mediaId, mediaType)
    const metrics = {}
    for (const item of insightsData.data || []) {
      metrics[item.name] = item.values?.[0]?.value ?? item.value ?? null
    }

    res.json({
      media_id: req.params.mediaId,
      media_type: mediaType,
      permalink: media?.permalink,
      posted_at: media?.timestamp,
      metrics,
      note: 'This endpoint is media-side insights. Use boosted-metrics sync for paid metrics from Marketing API.',
    })
  } catch (err) {
    console.error('single insight error:', err.meta || err.message)
    res.status(500).json({ error: 'Failed to fetch insights', details: err.meta || err.message })
  }
})

// GET /api/media/insights-by-url?ig_user_id=&post_url=
// Extracts the shortcode from an Instagram post URL, finds the matching media ID,
// fetches insights, and returns everything in one call.
router.get('/media/insights-by-url', requireInstagramAuth, async (req, res) => {
  const postUrl = req.query.post_url
  if (!postUrl) {
    return res.status(400).json({ error: 'Missing required query param: post_url' })
  }

  const shortcodeMatch = String(postUrl).match(/instagram\.com\/(?:p|reel)\/([A-Za-z0-9_-]+)/)
  if (!shortcodeMatch) {
    return res.status(400).json({ error: 'Could not extract shortcode from post_url. Expected format: https://www.instagram.com/p/SHORTCODE/' })
  }
  const shortcode = shortcodeMatch[1]

  try {
    const mediaResult = await req.igClient.getMedia()
    const mediaList = mediaResult.data || []

    const matched = mediaList.find((m) => m.permalink && m.permalink.includes(shortcode))
    if (!matched) {
      return res.status(404).json({
        error: 'Post not found in this account\'s recent media',
        shortcode,
        note: 'Only the most recent 50 posts are searched. The post must belong to the connected account.',
      })
    }

    const insightsData = await req.igClient.getMediaInsights(matched.id, matched.media_type)
    const metrics = {}
    for (const item of insightsData.data || []) {
      metrics[item.name] = item.values?.[0]?.value ?? item.value ?? null
    }

    return res.json({
      ig_user_id: req.igUserId,
      username: req.igUsername,
      media_id: matched.id,
      media_type: matched.media_type,
      permalink: matched.permalink,
      caption: matched.caption ? matched.caption.substring(0, 200) : null,
      posted_at: matched.timestamp,
      metrics,
    })
  } catch (err) {
    console.error('insights-by-url error:', err.meta || err.message)
    return res.status(500).json({ error: 'Failed to fetch metrics', details: err.meta || err.message })
  }
})

// GET /api/media/full-metrics-by-url?ig_user_id=&post_url=
//
// Flow:
//  1. Decode shortcode from URL to media_id mathematically (no API call needed).
//  2. Fetch media object directly via GET /{media_id}.
//  3. Read organic metrics from the IG media insights endpoint (organic-only, no ad interactions).
//  4. Check boost_ads_list on the media object — Meta directly links active boosts here.
//  5. If a linked ad exists, fetch the ad creative to get source/effective media IDs + ad-side URL.
//  6. Fetch paid metrics from Marketing API ad insights.
//  7. Return organic and paid as separate, clearly labelled objects.
router.get('/media/full-metrics-by-url', requireInstagramAuth, async (req, res) => {
  const postUrl = req.query.post_url
  if (!postUrl) {
    return res.status(400).json({ error: 'Missing required query param: post_url' })
  }

  const shortcodeMatch = String(postUrl).match(/instagram\.com\/(?:p|reel)\/([A-Za-z0-9_-]+)/)
  if (!shortcodeMatch) {
    return res.status(400).json({ error: 'Could not extract shortcode from post_url. Expected format: https://www.instagram.com/p/SHORTCODE/' })
  }
  const shortcode = shortcodeMatch[1]

  try {
    // Step 1: paginate through account media until the post matching the shortcode is found
    const matched = await req.igClient.findMediaByShortcode(shortcode)

    if (!matched) {
      return res.status(404).json({
        error: 'Post not found in this account\'s media.',
        shortcode,
        note: 'The URL must be an original post on the connected account, not the ad-side URL.',
      })
    }

    // Step 2: organic metrics — IG media insights are organic-only
    const insightsData = await req.igClient.getMediaInsights(matched.id, matched.media_type)
    const organicMetrics = {}
    for (const item of insightsData.data || []) {
      organicMetrics[item.name] = item.values?.[0]?.value ?? item.value ?? null
    }

    // Step 3: check boost_ads_list — Meta links active boosts directly on the media object
    const boostAds = matched.boost_ads_list?.data || []

    let paid = null
    let adMapping = null
    let paidStatus = 'not_boosted'

    const adConnection = db.prepare('SELECT * FROM ad_connections WHERE ig_user_id = ?').get(req.igUserId)

    if (boostAds.length > 0) {
      if (!adConnection) {
        paidStatus = 'no_ad_account_connected'
      } else if (adConnection.expires_at && adConnection.expires_at < Math.floor(Date.now() / 1000)) {
        paidStatus = 'ad_token_expired'
      } else {
        try {
          const adsClient = new MetaAdsClient(adConnection.access_token)

          // Use the first linked ad (boost_ads_list gives us the direct link — no scanning needed)
          const linkedAdId = boostAds[0].ad_id || boostAds[0].id

          // Step 4: fetch ad with creative to get source/effective media IDs
          const adData = await adsClient.getAdWithCreative(linkedAdId)
          const creative = adData.creative || {}

          adMapping = {
            ad_id: linkedAdId,
            ad_name: adData.name || null,
            ad_status: adData.effective_status || null,
            creative_id: creative.id || null,
            source_instagram_media_id: creative.source_instagram_media_id || null,
            effective_instagram_media_id: creative.effective_instagram_media_id || null,
            effective_instagram_permalink_url: creative.instagram_permalink_url || null,
            effective_object_story_id: creative.effective_object_story_id || null,
          }

          // Step 5: paid metrics from Marketing API ad insights
          const insightsRes = await adsClient.getAdInsights(linkedAdId)
          const first = (insightsRes.data || [])[0] || {}
          paid = {
            ad_id: linkedAdId,
            impressions: toInt(first.impressions),
            reach: toInt(first.reach),
            clicks: toInt(first.clicks),
            spend: toFloat(first.spend),
            actions: flattenActions(first.actions),
          }
          paidStatus = 'ok'
        } catch (adsErr) {
          paidStatus = 'ads_fetch_failed'
          paid = { error: adsErr.meta?.message || adsErr.message }
        }
      }
    } else if (!adConnection) {
      paidStatus = 'no_ad_account_connected'
    }

    return res.json({
      ig_user_id: req.igUserId,
      username: req.igUsername,
      organic_media_id: matched.id,
      media_type: matched.media_type,
      organic_permalink: matched.permalink,
      caption: matched.caption ? matched.caption.substring(0, 200) : null,
      posted_at: matched.timestamp,
      organic: organicMetrics,
      paid,
      paid_status: paidStatus,
      ad_mapping: adMapping,
    })
  } catch (err) {
    console.error('full-metrics-by-url error:', err.meta || err.message)
    return res.status(500).json({ error: 'Failed to fetch metrics', details: err.meta || err.message })
  }
})

// GET /api/saved-metrics — view all locally cached insights
router.get('/saved-metrics', (req, res) => {
  const rows = db.prepare('SELECT * FROM media_insights ORDER BY fetched_at DESC').all()
  res.json({ count: rows.length, metrics: rows })
})

// POST /api/campaign-content/:instagramMediaId/boosted-metrics/sync?ig_user_id=
// Core POC endpoint: map boosted content to ad, fetch paid metrics, merge with organic.
router.post('/campaign-content/:instagramMediaId/boosted-metrics/sync', async (req, res) => {
  const igUserId = req.query.ig_user_id
  const instagramMediaId = req.params.instagramMediaId

  if (!igUserId) {
    return res.status(400).json({ error: 'Missing required query param: ig_user_id' })
  }

  const account = db.prepare('SELECT * FROM connected_accounts WHERE ig_user_id = ?').get(igUserId)
  if (!account) {
    return res.status(401).json({ error: 'Instagram account not connected', auth_url: '/auth/connect' })
  }

  const organicInput = req.body?.organic || null
  const organic = {
    reach: organicInput?.reach ?? null,
    impressions: organicInput?.impressions ?? null,
    likes: organicInput?.likes ?? null,
    comments: organicInput?.comments ?? null,
    shares: organicInput?.shares ?? null,
    saves: organicInput?.saves ?? null,
    video_views: organicInput?.video_views ?? null,
    source: organicInput ? 'request_body' : 'missing',
  }

  const adConnection = db.prepare('SELECT * FROM ad_connections WHERE ig_user_id = ?').get(igUserId)
  if (!adConnection) {
    return res.json({
      status: 'missing_ad_connection',
      instagram_media_id: instagramMediaId,
      organic,
      action_required: 'Connect ad account via /connections/meta-ads/init',
    })
  }

  const grantedPermissions = parseGrantedPermissions(adConnection.scopes)
  const missingPermissions = REQUIRED_ADS_PERMISSIONS.filter((p) => !grantedPermissions.includes(p))
  if (missingPermissions.length) {
    return res.status(403).json({
      status: 'missing_permissions',
      error: 'Required Meta Ads permissions are missing for this connection.',
      required_permissions: REQUIRED_ADS_PERMISSIONS,
      granted_permissions: grantedPermissions,
      missing_permissions: missingPermissions,
      action_required: 'Reconnect with Meta Ads and grant required permissions.',
      reconnect_url: '/connections/meta-ads/init',
    })
  }

  if (adConnection.expires_at && adConnection.expires_at < Math.floor(Date.now() / 1000)) {
    return res.status(401).json({
      status: 'expired_ad_connection',
      error: 'Meta Ads token expired. Reconnect ad account.',
      reconnect_url: '/connections/meta-ads/init',
    })
  }

  try {
    const adsClient = new MetaAdsClient(adConnection.access_token)

    let mapping = db
      .prepare('SELECT * FROM content_paid_mapping WHERE instagram_media_id = ?')
      .get(instagramMediaId)

    if (!mapping) {
      const discovered = await adsClient.findAdForInstagramMedia(adConnection.ad_account_id, instagramMediaId)

      if (!discovered) {
        return res.json({
          status: 'no_boost_mapping_found',
          instagram_media_id: instagramMediaId,
          ad_account_id: adConnection.ad_account_id,
          organic,
          note: 'Boost mapping was not found in the selected ad account. Verify correct ad account authorization.',
        })
      }

      db.prepare(`
        INSERT INTO content_paid_mapping
          (instagram_media_id, ig_user_id, ad_account_id, ad_id, adset_id, campaign_id, creative_id,
           effective_object_story_id, object_story_id, match_confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(instagram_media_id) DO UPDATE SET
          ig_user_id = excluded.ig_user_id,
          ad_account_id = excluded.ad_account_id,
          ad_id = excluded.ad_id,
          adset_id = excluded.adset_id,
          campaign_id = excluded.campaign_id,
          creative_id = excluded.creative_id,
          effective_object_story_id = excluded.effective_object_story_id,
          object_story_id = excluded.object_story_id,
          match_confidence = excluded.match_confidence,
          matched_at = unixepoch()
      `).run(
        instagramMediaId,
        igUserId,
        adConnection.ad_account_id,
        discovered.ad_id,
        discovered.adset_id,
        discovered.campaign_id,
        discovered.creative_id,
        discovered.effective_object_story_id,
        discovered.object_story_id,
        discovered.match_confidence
      )

      mapping = db
        .prepare('SELECT * FROM content_paid_mapping WHERE instagram_media_id = ?')
        .get(instagramMediaId)
    }

    const insightsData = await adsClient.getAdInsights(mapping.ad_id)
    const first = (insightsData.data || [])[0] || {}

    const paid = {
      ad_id: mapping.ad_id,
      impressions: toInt(first.impressions),
      reach: toInt(first.reach),
      clicks: toInt(first.clicks),
      spend: toFloat(first.spend),
      actions: flattenActions(first.actions),
    }

    db.prepare(`
      INSERT INTO paid_metrics
        (instagram_media_id, ig_user_id, ad_account_id, ad_id, impressions, reach, clicks, spend, actions_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instagram_media_id) DO UPDATE SET
        ig_user_id = excluded.ig_user_id,
        ad_account_id = excluded.ad_account_id,
        ad_id = excluded.ad_id,
        impressions = excluded.impressions,
        reach = excluded.reach,
        clicks = excluded.clicks,
        spend = excluded.spend,
        actions_json = excluded.actions_json,
        fetched_at = unixepoch()
    `).run(
      instagramMediaId,
      igUserId,
      adConnection.ad_account_id,
      mapping.ad_id,
      paid.impressions,
      paid.reach,
      paid.clicks,
      paid.spend,
      JSON.stringify(paid.actions || {})
    )

    const merged = mergeMetrics(organic, paid)

    return res.json({
      status: 'ok',
      instagram_media_id: instagramMediaId,
      mapping,
      organic,
      paid,
      merged,
    })
  } catch (err) {
    console.error('boosted metrics sync error:', err.meta || err.message)
    return res.status(500).json({
      status: 'sync_failed',
      error: err.meta || err.message,
    })
  }
})

// GET /api/campaign-content/:instagramMediaId/metrics?ig_user_id=
// Returns latest stored organic + paid + merged data.
router.get('/campaign-content/:instagramMediaId/metrics', (req, res) => {
  const igUserId = req.query.ig_user_id
  const instagramMediaId = req.params.instagramMediaId

  if (!igUserId) {
    return res.status(400).json({ error: 'Missing required query param: ig_user_id' })
  }

  const mapping = db
    .prepare('SELECT * FROM content_paid_mapping WHERE instagram_media_id = ? AND ig_user_id = ?')
    .get(instagramMediaId, igUserId)
  const paidStored = db
    .prepare('SELECT * FROM paid_metrics WHERE instagram_media_id = ? AND ig_user_id = ?')
    .get(instagramMediaId, igUserId)

  const organic = null

  const paid = paidStored
    ? {
        ad_id: paidStored.ad_id,
        impressions: paidStored.impressions,
        reach: paidStored.reach,
        clicks: paidStored.clicks,
        spend: paidStored.spend,
        actions: paidStored.actions_json ? JSON.parse(paidStored.actions_json) : {},
      }
    : null

  const merged = mergeMetrics(organic || {}, paid || {})

  res.json({
    instagram_media_id: instagramMediaId,
    ig_user_id: igUserId,
    mapping: mapping || null,
    organic,
    paid,
    merged,
    status: !mapping ? 'no_boost_mapping_found' : !paid ? 'paid_metrics_not_synced' : 'ok',
  })
})

module.exports = router
