const express = require('express')
const db = require('../../../db')
const TikTokClient = require('../tiktok-client')

const router = express.Router()

// Scopes for TikTok Login Kit (Content API).
// user.info.basic  — read open_id, display_name, avatar_url
// video.list       — list the user's own videos with engagement counters
const DEFAULT_SCOPES = 'user.info.basic,video.list'
const SCOPES = process.env.TIKTOK_SCOPES || DEFAULT_SCOPES

function hasUnresolvedTemplate(value) {
  return typeof value === 'string' && value.includes('${')
}

// GET /tiktok/auth/connect
// Starts TikTok Login Kit OAuth. Redirects the influencer to TikTok's consent page.
router.get('/connect', (req, res) => {
  if (!process.env.TIKTOK_REDIRECT_URI || hasUnresolvedTemplate(process.env.TIKTOK_REDIRECT_URI)) {
    return res.status(500).json({
      error: 'TikTok OAuth is not configured',
      required_env: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI'],
    })
  }

  const state = `tt_${Date.now()}`
  const authUrl = TikTokClient.buildAuthUrl(state, SCOPES)
  return res.redirect(authUrl)
})

// GET /tiktok/auth/callback
// OAuth redirect target. Exchanges code → token, fetches user identity, upserts DB.
router.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query

  if (error) {
    return res.status(400).json({ error, error_description })
  }
  if (!code) {
    return res.status(400).json({ error: 'No code in callback' })
  }

  try {
    const tokenData = await TikTokClient.exchangeCode(code)

    // TikTok returns open_id alongside the token in the exchange response,
    // so we already know the user's identity without a separate /me call.
    const accessToken = tokenData.access_token
    const refreshToken = tokenData.refresh_token || null
    const openId = tokenData.open_id

    // access_token expires in 24 hours; refresh_token expires in 365 days.
    const expiresAt = Math.floor(Date.now() / 1000) + (tokenData.expires_in || 86400)
    const refreshExpiresAt = Math.floor(Date.now() / 1000) + (tokenData.refresh_expires_in || 31536000)

    // Fetch display name from the Content API
    const client = new TikTokClient(accessToken, openId)
    let displayName = openId
    let avatarUrl = null
    try {
      const me = await client.getMe()
      displayName = me.display_name || openId
      avatarUrl = me.avatar_url || null
    } catch {
      // Non-fatal: display_name is cosmetic only
    }

    db.prepare(`
      INSERT INTO tiktok_accounts
        (open_id, display_name, avatar_url, access_token, refresh_token, expires_at, refresh_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(open_id) DO UPDATE SET
        display_name      = excluded.display_name,
        avatar_url        = excluded.avatar_url,
        access_token      = excluded.access_token,
        refresh_token     = excluded.refresh_token,
        expires_at        = excluded.expires_at,
        refresh_expires_at = excluded.refresh_expires_at,
        updated_at        = unixepoch()
    `).run(openId, displayName, avatarUrl, accessToken, refreshToken, expiresAt, refreshExpiresAt)

    const params = new URLSearchParams({ tiktok_open_id: openId, tiktok_connected: '1' })
    return res.redirect(`/ui?${params.toString()}`)
  } catch (err) {
    console.error('TikTok OAuth error:', err.meta || err.message)
    return res.status(500).json({ error: 'TikTok OAuth failed', details: err.meta || err.message })
  }
})

// GET /tiktok/auth/status
// Lists connected TikTok accounts.
router.get('/status', (req, res) => {
  const accounts = db
    .prepare('SELECT open_id, display_name, avatar_url, expires_at FROM tiktok_accounts ORDER BY updated_at DESC')
    .all()
    .map((a) => ({
      ...a,
      expires_at: new Date(a.expires_at * 1000).toISOString(),
    }))
  res.json({ connected_accounts: accounts })
})

// DELETE /tiktok/auth/disconnect/:openId
// Removes the stored token and all associated data.
router.delete('/disconnect/:openId', (req, res) => {
  const { openId } = req.params
  db.prepare('DELETE FROM tiktok_accounts WHERE open_id = ?').run(openId)
  res.json({ disconnected: true, open_id: openId })
})

// Tokens expiring within this many days are eligible for refresh.
const REFRESH_THRESHOLD_DAYS = 1 // TikTok access tokens only live 24h; refresh before expiry

// Refreshes tokens for all accounts expiring within REFRESH_THRESHOLD_DAYS,
// or for a specific account if openId is provided.
// Returns { checked, results[] }.
async function refreshAccountTokens({ openId = null } = {}) {
  let accounts

  if (openId) {
    const row = db.prepare('SELECT * FROM tiktok_accounts WHERE open_id = ?').get(openId)
    accounts = row ? [row] : []
  } else {
    const thresholdTs = Math.floor(Date.now() / 1000) + REFRESH_THRESHOLD_DAYS * 24 * 60 * 60
    accounts = db
      .prepare('SELECT * FROM tiktok_accounts WHERE expires_at <= ?')
      .all(thresholdTs)
  }

  const results = []

  for (const account of accounts) {
    if (!account.refresh_token) {
      results.push({
        open_id: account.open_id,
        display_name: account.display_name,
        status: 'skipped',
        reason: 'no refresh_token stored',
      })
      continue
    }

    try {
      const refreshed = await TikTokClient.refreshToken(account.refresh_token)
      const newToken = refreshed.access_token
      const newRefreshToken = refreshed.refresh_token || account.refresh_token
      const newExpiresAt = Math.floor(Date.now() / 1000) + (refreshed.expires_in || 86400)
      const newRefreshExpiresAt = Math.floor(Date.now() / 1000) + (refreshed.refresh_expires_in || 31536000)

      db.prepare(`
        UPDATE tiktok_accounts
        SET access_token = ?, refresh_token = ?, expires_at = ?, refresh_expires_at = ?, updated_at = unixepoch()
        WHERE open_id = ?
      `).run(newToken, newRefreshToken, newExpiresAt, newRefreshExpiresAt, account.open_id)

      results.push({
        open_id: account.open_id,
        display_name: account.display_name,
        status: 'refreshed',
        new_expires_at: new Date(newExpiresAt * 1000).toISOString(),
      })
    } catch (err) {
      results.push({
        open_id: account.open_id,
        display_name: account.display_name,
        status: 'failed',
        error: err.meta?.message || err.message,
      })
    }
  }

  return { checked: accounts.length, results }
}

// POST /tiktok/auth/refresh-tokens
// Refreshes all tokens expiring within 24 hours.
// Pass ?open_id= to force-refresh a specific account.
router.post('/refresh-tokens', async (req, res) => {
  const openId = req.query.open_id || req.body?.open_id || null
  try {
    const result = await refreshAccountTokens({ openId })
    res.json(result)
  } catch (err) {
    console.error('TikTok token refresh error:', err.message)
    res.status(500).json({ error: 'Token refresh failed', details: err.message })
  }
})

module.exports = router
module.exports.refreshAccountTokens = refreshAccountTokens
