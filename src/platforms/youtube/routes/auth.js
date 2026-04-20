const express = require('express')
const db = require('../../../db')
const YoutubeClient = require('../youtube-client')

const router = express.Router()

function hasUnresolvedTemplate(value) {
  return typeof value === 'string' && value.includes('${')
}

// GET /youtube/auth/connect
// Starts Google OAuth for YouTube. Redirects to Google's consent page.
// access_type=offline + prompt=consent are set inside buildAuthUrl to ensure
// a refresh_token is always returned (required for the 1-hour access token cycle).
router.get('/connect', (req, res) => {
  if (!process.env.YOUTUBE_REDIRECT_URI || hasUnresolvedTemplate(process.env.YOUTUBE_REDIRECT_URI)) {
    return res.status(500).json({
      error: 'YouTube OAuth is not configured',
      required_env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'YOUTUBE_REDIRECT_URI'],
    })
  }

  const state = `yt_${Date.now()}`
  const authUrl = YoutubeClient.buildAuthUrl(state)
  return res.redirect(authUrl)
})

// GET /youtube/auth/callback
// Google OAuth redirect handler.
// Exchanges code → tokens, fetches channel identity, upserts youtube_channels row.
router.get('/callback', async (req, res) => {
  const { code, error, error_description } = req.query

  if (error) {
    return res.status(400).json({ error, error_description })
  }
  if (!code) {
    return res.status(400).json({ error: 'No code in callback' })
  }

  try {
    const tokenData = await YoutubeClient.exchangeCode(code)

    const accessToken = tokenData.access_token
    const refreshToken = tokenData.refresh_token || null
    const expiresAt = Math.floor(Date.now() / 1000) + (tokenData.expires_in || 3600)

    // Fetch the channel identity so we have a stable channel_id as primary key.
    const client = new YoutubeClient(accessToken)
    const channel = await client.getChannel()

    db.prepare(`
      INSERT INTO youtube_channels
        (channel_id, channel_title, access_token, refresh_token, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        channel_title = excluded.channel_title,
        access_token  = excluded.access_token,
        refresh_token = COALESCE(excluded.refresh_token, refresh_token),
        expires_at    = excluded.expires_at,
        updated_at    = unixepoch()
    `).run(
      channel.channel_id,
      channel.channel_title,
      accessToken,
      refreshToken,
      expiresAt
    )

    const params = new URLSearchParams({
      yt_channel_id: channel.channel_id,
      yt_connected: '1',
    })
    return res.redirect(`/ui?${params.toString()}`)
  } catch (err) {
    console.error('YouTube OAuth error:', err.meta || err.message)
    return res.status(500).json({ error: 'YouTube OAuth failed', details: err.meta || err.message })
  }
})

// GET /youtube/auth/status
// Lists all connected YouTube channels.
router.get('/status', (req, res) => {
  const channels = db
    .prepare('SELECT channel_id, channel_title, expires_at, updated_at FROM youtube_channels ORDER BY updated_at DESC')
    .all()
    .map((c) => ({
      ...c,
      expires_at_iso: new Date(c.expires_at * 1000).toISOString(),
    }))
  res.json({ connected_channels: channels })
})

// DELETE /youtube/auth/disconnect/:channelId
router.delete('/disconnect/:channelId', (req, res) => {
  const { channelId } = req.params
  db.prepare('DELETE FROM youtube_channels WHERE channel_id = ?').run(channelId)
  res.json({ disconnected: true, channel_id: channelId })
})

// Google access tokens expire every hour. We refresh any token expiring within
// 10 minutes (rather than TikTok's 24h threshold or Meta's 30-day threshold).
const REFRESH_THRESHOLD_SECONDS = 10 * 60

async function refreshAccountTokens({ channelId = null } = {}) {
  let channels

  if (channelId) {
    const row = db.prepare('SELECT * FROM youtube_channels WHERE channel_id = ?').get(channelId)
    channels = row ? [row] : []
  } else {
    const thresholdTs = Math.floor(Date.now() / 1000) + REFRESH_THRESHOLD_SECONDS
    channels = db
      .prepare('SELECT * FROM youtube_channels WHERE expires_at <= ?')
      .all(thresholdTs)
  }

  const results = []

  for (const ch of channels) {
    if (!ch.refresh_token) {
      results.push({
        channel_id: ch.channel_id,
        channel_title: ch.channel_title,
        status: 'skipped',
        reason: 'no refresh_token stored — user must re-authenticate',
      })
      continue
    }

    try {
      const refreshed = await YoutubeClient.refreshToken(ch.refresh_token)
      const newToken = refreshed.access_token
      const newExpiresAt = Math.floor(Date.now() / 1000) + (refreshed.expires_in || 3600)

      db.prepare(`
        UPDATE youtube_channels
        SET access_token = ?, expires_at = ?, updated_at = unixepoch()
        WHERE channel_id = ?
      `).run(newToken, newExpiresAt, ch.channel_id)

      results.push({
        channel_id: ch.channel_id,
        channel_title: ch.channel_title,
        status: 'refreshed',
        new_expires_at: new Date(newExpiresAt * 1000).toISOString(),
      })
    } catch (err) {
      results.push({
        channel_id: ch.channel_id,
        channel_title: ch.channel_title,
        status: 'failed',
        error: err.meta?.message || err.message,
      })
    }
  }

  return { checked: channels.length, results }
}

// POST /youtube/auth/refresh-tokens
// Pass ?channel_id= to force-refresh a specific channel's token.
router.post('/refresh-tokens', async (req, res) => {
  const channelId = req.query.channel_id || req.body?.channel_id || null
  try {
    const result = await refreshAccountTokens({ channelId })
    res.json(result)
  } catch (err) {
    console.error('YouTube token refresh error:', err.message)
    res.status(500).json({ error: 'Token refresh failed', details: err.message })
  }
})

module.exports = router
module.exports.refreshAccountTokens = refreshAccountTokens
