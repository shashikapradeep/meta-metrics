const express = require('express')
const db = require('../../../db')
const InstagramClient = require('../instagram-client')

const router = express.Router()

// Instagram Login scopes for Instagram API with Instagram Login.
// Keep configurable for quick dashboard-alignment during POC.
const DEFAULT_SCOPES = 'instagram_basic,instagram_manage_insights,pages_show_list,pages_read_engagement,ads_read,business_management'
const SCOPES = process.env.INSTAGRAM_OAUTH_SCOPES || DEFAULT_SCOPES
function hasUnresolvedTemplate(value) {
  return typeof value === 'string' && value.includes('${')
}

router.get('/connect', (req, res) => {
  if (!process.env.META_REDIRECT_URI || hasUnresolvedTemplate(process.env.META_REDIRECT_URI)) {
    return res.status(500).json({
      error: 'Instagram OAuth is not configured',
      required_env: ['META_REDIRECT_URI', 'INSTAGRAM_APP_ID (or META_APP_ID)', 'INSTAGRAM_APP_SECRET (or META_APP_SECRET)'],
      note: 'META_REDIRECT_URI must be a fully resolved absolute URL. Do not use ${...} placeholders.',
    })
  }

  const state = `ig_${Date.now()}`
  const authUrl = InstagramClient.buildAuthUrl(state, SCOPES)
  return res.redirect(authUrl)
})

// GET /auth/debug-url
// Helps diagnose OAuth misconfiguration by showing the exact URL used.
router.get('/debug-url', (req, res) => {
  const state = req.query.state || `debug_${Date.now()}`
  const authUrl = InstagramClient.buildAuthUrl(state, SCOPES)
  return res.json({
    auth_url: authUrl,
    expected_redirect_uri: process.env.META_REDIRECT_URI,
    instagram_app_id_in_use: process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID,
    scopes: SCOPES,
  })
})

router.get('/callback', async (req, res) => {
  console.log('[auth/callback] query params:', JSON.stringify(req.query, null, 2))
  const { code, error, error_description } = req.query

  if (error) {
    return res.status(400).json({ error, error_description })
  }
  if (!code) {
    return res.status(400).json({ error: 'No code in callback' })
  }

  try {
    const shortTokenData = await InstagramClient.exchangeCode(code)
    const longTokenData = await InstagramClient.exchangeLongLived(shortTokenData.access_token)

    const accessToken = longTokenData.access_token || shortTokenData.access_token
    const expiresAt = Math.floor(Date.now() / 1000) + (longTokenData.expires_in || shortTokenData.expires_in || 3600)

    const client = new InstagramClient(accessToken)
    const me = await client.getMe()

    db.prepare(`
      INSERT INTO connected_accounts (ig_user_id, username, access_token, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(ig_user_id) DO UPDATE SET
        username = excluded.username,
        access_token = excluded.access_token,
        expires_at = excluded.expires_at,
        updated_at = unixepoch()
    `).run(me.id, me.username || me.id, accessToken, expiresAt)

    // The Instagram token already carries ads_read + business_management scopes,
    // so we can seed the ad_connections row immediately — no second OAuth needed.
    // The influencer still picks their ad account in step 3.
    db.prepare(`
      INSERT INTO ad_connections (ig_user_id, access_token, scopes, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(ig_user_id) DO UPDATE SET
        access_token = excluded.access_token,
        scopes = excluded.scopes,
        expires_at = excluded.expires_at,
        updated_at = unixepoch()
    `).run(me.id, accessToken, SCOPES, expiresAt)

    const params = new URLSearchParams({ ig_user_id: me.id, ig_connected: '1' })
    return res.redirect(`/ui?${params.toString()}`)
  } catch (err) {
    console.error('Instagram Login OAuth error:', err.meta || err.message)
    return res.status(500).json({ error: 'OAuth failed', details: err.meta || err.message })
  }
})

router.get('/status', (req, res) => {
  const accounts = db
    .prepare('SELECT ig_user_id, username, expires_at FROM connected_accounts ORDER BY updated_at DESC')
    .all()
    .map((a) => ({
      ...a,
      expires_at: new Date(a.expires_at * 1000).toISOString(),
    }))
  res.json({ connected_accounts: accounts })
})

router.delete('/disconnect/:igUserId', (req, res) => {
  db.prepare('DELETE FROM connected_accounts WHERE ig_user_id = ?').run(req.params.igUserId)
  db.prepare('DELETE FROM ad_connections WHERE ig_user_id = ?').run(req.params.igUserId)
  res.json({ disconnected: true })
})

// Tokens expiring within this many days are eligible for refresh.
const REFRESH_THRESHOLD_DAYS = 30

// Refreshes tokens for all accounts expiring within REFRESH_THRESHOLD_DAYS,
// or for a specific account if igUserId is provided (always refreshes that one).
// Returns { checked, results[] }.
async function refreshAccountTokens({ igUserId = null } = {}) {
  let accounts

  if (igUserId) {
    const row = db.prepare('SELECT * FROM connected_accounts WHERE ig_user_id = ?').get(igUserId)
    accounts = row ? [row] : []
  } else {
    const thresholdTs = Math.floor(Date.now() / 1000) + REFRESH_THRESHOLD_DAYS * 24 * 60 * 60
    accounts = db
      .prepare('SELECT * FROM connected_accounts WHERE expires_at <= ?')
      .all(thresholdTs)
  }

  const results = []

  for (const account of accounts) {
    try {
      const refreshed = await InstagramClient.refreshToken(account.access_token)
      const newToken = refreshed.access_token
      // Instagram returns expires_in in seconds; default 60 days if missing
      const newExpiresAt = Math.floor(Date.now() / 1000) + (refreshed.expires_in || 5_184_000)

      db.prepare(`
        UPDATE connected_accounts
        SET access_token = ?, expires_at = ?, updated_at = unixepoch()
        WHERE ig_user_id = ?
      `).run(newToken, newExpiresAt, account.ig_user_id)

      results.push({
        ig_user_id: account.ig_user_id,
        username: account.username,
        status: 'refreshed',
        new_expires_at: new Date(newExpiresAt * 1000).toISOString(),
      })
    } catch (err) {
      results.push({
        ig_user_id: account.ig_user_id,
        username: account.username,
        status: 'failed',
        error: err.meta?.message || err.message,
      })
    }
  }

  return { checked: accounts.length, results }
}

// POST /auth/refresh-tokens
// Refreshes all tokens expiring within 30 days.
// Pass ?ig_user_id= to force-refresh a specific account immediately.
router.post('/refresh-tokens', async (req, res) => {
  const igUserId = req.query.ig_user_id || req.body?.ig_user_id || null
  try {
    const result = await refreshAccountTokens({ igUserId })
    res.json(result)
  } catch (err) {
    console.error('Token refresh error:', err.message)
    res.status(500).json({ error: 'Token refresh failed', details: err.message })
  }
})

module.exports = router
module.exports.refreshAccountTokens = refreshAccountTokens
