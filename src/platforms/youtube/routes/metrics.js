const express = require('express')
const db = require('../../../db')
const YoutubeClient = require('../youtube-client')

const router = express.Router()

function toInt(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? null : parsed
}

// Middleware: validates the YouTube token, runs lazy refresh if near-expiry,
// and attaches a fresh YoutubeClient to req.
async function requireYouTubeAuth(req, res, next) {
  const channelId = req.query.channel_id
  if (!channelId) {
    return res.status(400).json({ error: 'Missing required query param: channel_id' })
  }

  const channel = db.prepare('SELECT * FROM youtube_channels WHERE channel_id = ?').get(channelId)
  if (!channel) {
    return res.status(401).json({
      error: 'YouTube channel not connected',
      auth_url: '/youtube/auth/connect',
    })
  }

  try {
    const freshToken = await YoutubeClient.getValidToken(channelId)
    req.ytClient = new YoutubeClient(freshToken, channelId)
    req.channelId = channelId
    req.channelTitle = channel.channel_title
    next()
  } catch (err) {
    return res.status(401).json({
      error: 'YouTube token expired and could not be refreshed',
      details: err.message,
      auth_url: '/youtube/auth/connect',
    })
  }
}

// GET /youtube/api/videos?channel_id=
router.get('/videos', requireYouTubeAuth, async (req, res) => {
  try {
    const channelInfo = await req.ytClient.getChannel()
    if (!channelInfo.uploads_playlist_id) {
      return res.status(404).json({ error: 'No uploads playlist found for this channel' })
    }

    const videoIds = await req.ytClient.listUploadedVideoIds(channelInfo.uploads_playlist_id)
    const videos = await req.ytClient.getVideoStats(videoIds)

    res.json({
      channel_id: req.channelId,
      channel_title: req.channelTitle,
      total: videos.length,
      videos,
    })
  } catch (err) {
    console.error('YouTube videos error:', err.meta || err.message)
    res.status(500).json({ error: 'Failed to fetch videos', details: err.meta || err.message })
  }
})

// GET /youtube/api/videos/insights?channel_id=
// Fetches and caches organic metrics for all recent videos.
// Data API provides viewCount/likeCount/commentCount; Analytics API adds share_count
// and estimatedMinutesWatched.
router.get('/videos/insights', requireYouTubeAuth, async (req, res) => {
  try {
    const channelInfo = await req.ytClient.getChannel()
    if (!channelInfo.uploads_playlist_id) {
      return res.status(404).json({ error: 'No uploads playlist found for this channel' })
    }

    const videoIds = await req.ytClient.listUploadedVideoIds(channelInfo.uploads_playlist_id)
    const statsArr = await req.ytClient.getVideoStats(videoIds)

    const enriched = []
    for (const v of statsArr) {
      let analytics = null
      try {
        analytics = await req.ytClient.getVideoAnalytics(req.channelId, v.video_id)
      } catch {
        // Analytics may be unavailable for small channels or very new videos
      }

      const row = {
        ...v,
        share_count: analytics?.shares ?? null,
        estimated_minutes_watched: analytics?.estimated_minutes_watched ?? null,
      }

      db.prepare(`
        INSERT INTO youtube_video_insights
          (video_id, channel_id, title, published_at, thumbnail_url,
           view_count, like_count, comment_count, share_count, estimated_minutes_watched)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          view_count                = excluded.view_count,
          like_count                = excluded.like_count,
          comment_count             = excluded.comment_count,
          share_count               = excluded.share_count,
          estimated_minutes_watched = excluded.estimated_minutes_watched,
          fetched_at                = unixepoch()
      `).run(
        row.video_id, req.channelId, row.title, row.published_at, row.thumbnail_url,
        row.view_count, row.like_count, row.comment_count, row.share_count, row.estimated_minutes_watched
      )

      enriched.push(row)
    }

    res.json({
      channel_id: req.channelId,
      channel_title: req.channelTitle,
      total_videos: enriched.length,
      videos: enriched,
    })
  } catch (err) {
    console.error('YouTube video insights error:', err.meta || err.message)
    res.status(500).json({ error: 'Failed to fetch video insights', details: err.meta || err.message })
  }
})

// GET /youtube/api/saved-metrics
router.get('/saved-metrics', (req, res) => {
  const rows = db.prepare('SELECT * FROM youtube_video_insights ORDER BY fetched_at DESC').all()
  res.json({ count: rows.length, metrics: rows })
})

// POST /youtube/api/campaign-content/:videoId/ad-metrics/sync?channel_id=
// Fetches fresh organic metrics for the video and stores them.
router.post('/campaign-content/:videoId/ad-metrics/sync', async (req, res) => {
  const channelId = req.query.channel_id
  const videoId = req.params.videoId

  if (!channelId) {
    return res.status(400).json({ error: 'Missing required query param: channel_id' })
  }

  const channel = db.prepare('SELECT * FROM youtube_channels WHERE channel_id = ?').get(channelId)
  if (!channel) {
    return res.status(401).json({ error: 'YouTube channel not connected', auth_url: '/youtube/auth/connect' })
  }

  try {
    const freshToken = await YoutubeClient.getValidToken(channelId)
    const ytClient = new YoutubeClient(freshToken, channelId)

    const [statsArr, analytics] = await Promise.allSettled([
      ytClient.getVideoStats([videoId]),
      ytClient.getVideoAnalytics(channelId, videoId),
    ])

    const stats = statsArr.status === 'fulfilled' ? (statsArr.value[0] || {}) : {}
    const anl   = analytics.status === 'fulfilled' ? (analytics.value || {}) : {}

    if (!stats.video_id) {
      return res.status(404).json({ error: 'Video not found', video_id: videoId })
    }

    const organic = {
      view_count: stats.view_count ?? null,
      like_count: stats.like_count ?? null,
      comment_count: stats.comment_count ?? null,
      share_count: anl.shares ?? null,
      estimated_minutes_watched: anl.estimated_minutes_watched ?? null,
    }

    db.prepare(`
      INSERT INTO youtube_video_insights
        (video_id, channel_id, title, published_at, thumbnail_url,
         view_count, like_count, comment_count, share_count, estimated_minutes_watched)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        view_count                = excluded.view_count,
        like_count                = excluded.like_count,
        comment_count             = excluded.comment_count,
        share_count               = excluded.share_count,
        estimated_minutes_watched = excluded.estimated_minutes_watched,
        fetched_at                = unixepoch()
    `).run(
      videoId, channelId, stats.title ?? null, stats.published_at ?? null, stats.thumbnail_url ?? null,
      organic.view_count, organic.like_count, organic.comment_count,
      organic.share_count, organic.estimated_minutes_watched
    )

    return res.json({
      status: 'ok',
      video_id: videoId,
      organic,
    })
  } catch (err) {
    console.error('YouTube metrics sync error:', err.meta || err.message)
    return res.status(500).json({
      status: 'sync_failed',
      error: err.meta || err.message,
    })
  }
})

// GET /youtube/api/campaign-content/:videoId/metrics?channel_id=
// Returns latest stored organic metrics from SQLite cache.
router.get('/campaign-content/:videoId/metrics', (req, res) => {
  const channelId = req.query.channel_id
  const videoId = req.params.videoId

  if (!channelId) {
    return res.status(400).json({ error: 'Missing required query param: channel_id' })
  }

  const stored = db
    .prepare('SELECT * FROM youtube_video_insights WHERE video_id = ? AND channel_id = ?')
    .get(videoId, channelId)

  if (!stored) {
    return res.json({
      video_id: videoId,
      channel_id: channelId,
      organic: null,
      status: 'not_synced',
    })
  }

  return res.json({
    video_id: videoId,
    channel_id: channelId,
    organic: {
      view_count: stored.view_count,
      like_count: stored.like_count,
      comment_count: stored.comment_count,
      share_count: stored.share_count,
      estimated_minutes_watched: stored.estimated_minutes_watched,
    },
    status: 'ok',
  })
})

module.exports = router
