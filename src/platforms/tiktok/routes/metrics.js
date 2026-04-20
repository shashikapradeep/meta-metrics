const express = require('express')
const db = require('../../../db')
const TikTokClient = require('../tiktok-client')

const router = express.Router()

function toInt(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? null : parsed
}

// Middleware: validates TikTok Login token and attaches TikTokClient to req.
function requireTikTokAuth(req, res, next) {
  const openId = req.query.open_id
  if (!openId) {
    return res.status(400).json({ error: 'Missing required query param: open_id' })
  }

  const account = db.prepare('SELECT * FROM tiktok_accounts WHERE open_id = ?').get(openId)
  if (!account) {
    return res.status(401).json({
      error: 'Account not connected. Influencer must authenticate first.',
      auth_url: '/tiktok/auth/connect',
    })
  }

  if (account.expires_at > 0 && account.expires_at < Math.floor(Date.now() / 1000)) {
    return res.status(401).json({
      error: 'TikTok access token expired. Use POST /tiktok/auth/refresh-tokens or re-authenticate.',
      auth_url: '/tiktok/auth/connect',
    })
  }

  req.ttClient = new TikTokClient(account.access_token, openId)
  req.openId = openId
  req.displayName = account.display_name
  next()
}

// GET /tiktok/api/videos?open_id=
// Lists the influencer's recent TikTok videos.
router.get('/videos', requireTikTokAuth, async (req, res) => {
  try {
    const result = await req.ttClient.getVideos({ maxCount: 20 })
    res.json({
      open_id: req.openId,
      display_name: req.displayName,
      videos: result.videos || [],
      has_more: result.has_more || false,
      next: `/tiktok/api/videos/insights?open_id=${req.openId}`,
    })
  } catch (err) {
    console.error('TikTok videos error:', err.meta || err.message)
    res.status(500).json({ error: 'Failed to fetch videos', details: err.meta || err.message })
  }
})

// GET /tiktok/api/videos/insights?open_id=
// Fetches and caches organic engagement metrics for all recent videos.
router.get('/videos/insights', requireTikTokAuth, async (req, res) => {
  try {
    const result = await req.ttClient.getVideos({ maxCount: 20 })
    const videos = result.videos || []

    for (const v of videos) {
      db.prepare(`
        INSERT INTO tiktok_video_insights
          (video_id, open_id, title, cover_url, share_url, duration, create_time,
           view_count, like_count, comment_count, share_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          view_count    = excluded.view_count,
          like_count    = excluded.like_count,
          comment_count = excluded.comment_count,
          share_count   = excluded.share_count,
          fetched_at    = unixepoch()
      `).run(
        v.id,
        req.openId,
        v.title || null,
        v.cover_image_url || null,
        v.share_url || null,
        toInt(v.duration),
        toInt(v.create_time),
        toInt(v.view_count),
        toInt(v.like_count),
        toInt(v.comment_count),
        toInt(v.share_count)
      )
    }

    res.json({
      open_id: req.openId,
      display_name: req.displayName,
      total_videos: videos.length,
      has_more: result.has_more || false,
      videos: videos.map((v) => ({
        video_id: v.id,
        title: v.title,
        share_url: v.share_url,
        create_time: v.create_time,
        view_count: v.view_count,
        like_count: v.like_count,
        comment_count: v.comment_count,
        share_count: v.share_count,
      })),
    })
  } catch (err) {
    console.error('TikTok video insights error:', err.meta || err.message)
    res.status(500).json({ error: 'Failed to fetch video insights', details: err.meta || err.message })
  }
})

// GET /tiktok/api/saved-metrics
// Returns all locally cached TikTok video insights.
router.get('/saved-metrics', (req, res) => {
  const rows = db.prepare('SELECT * FROM tiktok_video_insights ORDER BY fetched_at DESC').all()
  res.json({ count: rows.length, metrics: rows })
})

// POST /tiktok/api/campaign-content/:videoId/spark-metrics/sync?open_id=
// Fetches fresh organic metrics for the video and stores them.
router.post('/campaign-content/:videoId/spark-metrics/sync', async (req, res) => {
  const openId = req.query.open_id
  const videoId = req.params.videoId

  if (!openId) {
    return res.status(400).json({ error: 'Missing required query param: open_id' })
  }

  const account = db.prepare('SELECT * FROM tiktok_accounts WHERE open_id = ?').get(openId)
  if (!account) {
    return res.status(401).json({ error: 'TikTok account not connected', auth_url: '/tiktok/auth/connect' })
  }

  try {
    const ttClient = new TikTokClient(account.access_token, openId)
    const video = await ttClient.findVideoById(videoId)

    if (!video) {
      return res.status(404).json({ error: 'Video not found', video_id: videoId })
    }

    const organic = {
      view_count: toInt(video.view_count),
      like_count: toInt(video.like_count),
      comment_count: toInt(video.comment_count),
      share_count: toInt(video.share_count),
    }

    db.prepare(`
      INSERT INTO tiktok_video_insights
        (video_id, open_id, title, cover_url, share_url, duration, create_time,
         view_count, like_count, comment_count, share_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        view_count    = excluded.view_count,
        like_count    = excluded.like_count,
        comment_count = excluded.comment_count,
        share_count   = excluded.share_count,
        fetched_at    = unixepoch()
    `).run(
      videoId, openId,
      video.title || null, video.cover_image_url || null, video.share_url || null,
      toInt(video.duration), toInt(video.create_time),
      organic.view_count, organic.like_count, organic.comment_count, organic.share_count
    )

    return res.json({
      status: 'ok',
      video_id: videoId,
      organic,
    })
  } catch (err) {
    console.error('TikTok metrics sync error:', err.meta || err.message)
    return res.status(500).json({
      status: 'sync_failed',
      error: err.meta || err.message,
    })
  }
})

// GET /tiktok/api/campaign-content/:videoId/metrics?open_id=
// Returns the latest stored organic metrics from SQLite cache.
router.get('/campaign-content/:videoId/metrics', (req, res) => {
  const openId = req.query.open_id
  const videoId = req.params.videoId

  if (!openId) {
    return res.status(400).json({ error: 'Missing required query param: open_id' })
  }

  const stored = db
    .prepare('SELECT * FROM tiktok_video_insights WHERE video_id = ? AND open_id = ?')
    .get(videoId, openId)

  if (!stored) {
    return res.json({
      video_id: videoId,
      open_id: openId,
      organic: null,
      status: 'not_synced',
    })
  }

  return res.json({
    video_id: videoId,
    open_id: openId,
    organic: {
      view_count: stored.view_count,
      like_count: stored.like_count,
      comment_count: stored.comment_count,
      share_count: stored.share_count,
    },
    status: 'ok',
  })
})

module.exports = router
