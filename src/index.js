require('dotenv').config()
const express = require('express')
const path = require('path')
const {
  authRoutes,
  metricsRoutes,
  connectionRoutes: ConnectionsRoutes,
  refreshAccountTokens,
} = require('./platforms/meta')

const app = express()
app.use(express.json())
app.use('/static', express.static(path.join(__dirname, 'public')))

app.get('/ui', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

app.get('/', (req, res) => {
  res.json({
    name: 'Meta Metrics POC',
    description: 'Fetch organic metrics and paid boosted-post metrics, then merge for campaign reporting',
    why: [
      'Organic influencer metrics and paid boosted metrics live in separate API surfaces.',
      'This POC keeps the existing media-side flow and adds a dedicated Meta Ads path.',
      'Instagram connection uses Instagram Login, while paid metrics use Meta Ads auth.',
      'Paid/non-organic metrics require ad-account authorization and Marketing API insights.',
      'Merged output should be validated against Instagram UI totals during the POC.',
    ].join(' '),
    required_oauth_scopes: ['instagram_business_basic', 'instagram_business_manage_insights', 'ads_read'],
    note: 'Paid metrics are unavailable unless the ad account that ran the boost is connected.',
    steps: [
      '1. GET /ui                      -> simple POC UI',
      '2. Connect Instagram in the UI',
      '3. Connect Meta Ads in the UI (influencer authorizes ad account)',
      '4. Upsert organic metrics (optional) and run boosted sync',
      '5. Compare merged output with Instagram UI',
    ],
    endpoints: {
      'GET /auth/connect':                              'Open Instagram Login for influencer',
      'GET /auth/callback':                             'OAuth redirect target (auto)',
      'GET /auth/status':                               'List connected influencer accounts',
      'DELETE /auth/disconnect/:igUserId':              'Remove stored token',
      'POST /auth/refresh-tokens':                      'Refresh all tokens expiring within 30 days (pass ?ig_user_id= to force one)',
      'POST /connections/meta-ads/init':        'Build Meta Ads OAuth URL for ad-account access',
      'GET /connections/meta-ads/callback':     'Meta Ads OAuth callback and token storage',
      'POST /connections/meta-ads/select-ad-account': 'Select ad account to use for boosts',
      'GET /connections/meta-ads/status?ig_user_id=': 'Check current Meta Ads connection',
      'GET /connections/meta-ads/permissions?ig_user_id=': 'Check granted/missing Meta Ads permissions',
      'GET /connections/meta-ads/ad-accounts?ig_user_id=': 'List accessible ad accounts for current token',
      'GET /api/media?ig_user_id=':                     'List influencer posts',
      'GET /api/media/insights?ig_user_id=':            'Instagram media-side insights (not paid breakout)',
      'GET /api/media/:mediaId/insights?ig_user_id=':   'Single-post media-side insights',
      'GET /api/saved-metrics':                         'View SQLite cache',
      'POST /api/organic-metrics/upsert':               'Push Phyllo organic metrics into this POC',
      'POST /api/campaign-content/:instagramMediaId/boosted-metrics/sync?ig_user_id=': 'Find linked ad, pull paid insights, merge',
      'GET /api/campaign-content/:instagramMediaId/metrics?ig_user_id=': 'Get latest organic + paid + merged view',
      'GET /ui':                                         'Simple influencer POC UI',
    },
  })
})

app.use('/auth', authRoutes)
app.use('/', ConnectionsRoutes)
app.use('/api', metricsRoutes)

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`\nMeta Metrics POC → http://localhost:${PORT}`)
  console.log(`Start here        → http://localhost:${PORT}/ui\n`)
  scheduleTokenRefresh()
})

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000 // every 24 hours

async function runTokenRefresh() {
  console.log('[token-refresh] Checking for tokens expiring within 30 days...')
  try {
    const result = await refreshAccountTokens()
    if (result.checked === 0) {
      console.log('[token-refresh] No tokens due for refresh.')
    } else {
      for (const r of result.results) {
        if (r.status === 'refreshed') {
          console.log(`[token-refresh] ✓ ${r.username || r.ig_user_id} refreshed → expires ${r.new_expires_at}`)
        } else {
          console.error(`[token-refresh] ✗ ${r.username || r.ig_user_id} failed: ${r.error}`)
        }
      }
    }
  } catch (err) {
    console.error('[token-refresh] Scheduler error:', err.message)
  }
}

function scheduleTokenRefresh() {
  // Run once 30 seconds after startup, then every 24 hours
  setTimeout(runTokenRefresh, 30_000)
  setInterval(runTokenRefresh, REFRESH_INTERVAL_MS)
}
