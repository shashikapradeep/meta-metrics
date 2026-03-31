const express = require('express')
const db = require('../../../db')
const MetaAdsClient = require('../meta-ads')

const router = express.Router()
const REQUIRED_ADS_PERMISSIONS = ['ads_read']
const OPTIONAL_ADS_PERMISSIONS = ['business_management']

function encodeState(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

function decodeState(state) {
  try {
    return JSON.parse(Buffer.from(String(state), 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

function normalizeReturnPath(returnTo) {
  if (!returnTo || typeof returnTo !== 'string') return null
  if (!returnTo.startsWith('/')) return null
  if (returnTo.startsWith('//')) return null
  return returnTo
}
function hasUnresolvedTemplate(value) {
  return typeof value === 'string' && value.includes('${')
}

function normalizeGrantedPermissions(rawPermissions) {
  return (rawPermissions || [])
    .filter((p) => p && p.status === 'granted' && typeof p.permission === 'string')
    .map((p) => p.permission)
}

function buildPermissionSummary(granted) {
  const grantedSet = new Set(granted)
  const missingRequired = REQUIRED_ADS_PERMISSIONS.filter((p) => !grantedSet.has(p))
  const missingOptional = OPTIONAL_ADS_PERMISSIONS.filter((p) => !grantedSet.has(p))
  return {
    required: REQUIRED_ADS_PERMISSIONS,
    optional: OPTIONAL_ADS_PERMISSIONS,
    granted,
    missing_required: missingRequired,
    missing_optional: missingOptional,
    has_required: missingRequired.length === 0,
  }
}

function initMetaAdsConnection(req, res) {
  const igUserId = req.body?.ig_user_id || req.query?.ig_user_id
  const preferredAdAccountId = req.body?.ad_account_id || req.query?.ad_account_id || null
  const returnTo = normalizeReturnPath(req.body?.return_to || req.query?.return_to)

  if (!igUserId) {
    return res.status(400).json({ error: 'Missing required ig_user_id' })
  }

  const connected = db.prepare('SELECT ig_user_id FROM connected_accounts WHERE ig_user_id = ?').get(igUserId)
  if (!connected) {
    return res.status(401).json({
      error: 'Instagram account not connected yet',
      auth_url: '/auth/connect',
    })
  }

  if (!process.env.META_ADS_REDIRECT_URI || hasUnresolvedTemplate(process.env.META_ADS_REDIRECT_URI)) {
    return res.status(500).json({
      error: 'META_ADS_REDIRECT_URI is not configured',
      note: 'META_ADS_REDIRECT_URI must be a fully resolved absolute URL. Do not use ${...} placeholders.',
    })
  }

  const state = encodeState({
    ig_user_id: igUserId,
    preferred_ad_account_id: preferredAdAccountId,
    return_to: returnTo,
    nonce: Date.now(),
  })

  const authUrl = MetaAdsClient.buildAuthUrl(state)
  return res.json({
    ig_user_id: igUserId,
    authUrl,
    note: 'Influencer/business owner must authorize the ad account used for boost.',
  })
}

router.post('/connections/meta-ads/init', initMetaAdsConnection)
router.get('/connections/meta-ads/init', initMetaAdsConnection)

router.get('/connections/meta-ads/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query

  if (error) {
    const parsedState = decodeState(state)
    const returnTo = normalizeReturnPath(parsedState?.return_to)
    if (returnTo) {
      const params = new URLSearchParams({
        meta_ads_connected: '0',
        error: String(error),
        error_description: String(error_description || ''),
      })
      return res.redirect(`${returnTo}?${params.toString()}`)
    }
    return res.status(400).json({ error, error_description })
  }

  if (!code || !state) {
    return res.status(400).json({ error: 'Missing required code/state in callback' })
  }

  const parsedState = decodeState(state)
  if (!parsedState?.ig_user_id) {
    return res.status(400).json({ error: 'Invalid state payload' })
  }

  try {
    const shortTokenData = await MetaAdsClient.exchangeCode(code)
    const longTokenData = await MetaAdsClient.exchangeLongLived(shortTokenData.access_token)

    const accessToken = longTokenData.access_token || shortTokenData.access_token
    const expiresAt = Math.floor(Date.now() / 1000) + (longTokenData.expires_in || shortTokenData.expires_in || 3600)

    const adsClient = new MetaAdsClient(accessToken)
    const me = await adsClient.getMe()
    const permissionsData = await adsClient.getPermissions()
    const grantedPermissions = normalizeGrantedPermissions(permissionsData.data)
    const permissionSummary = buildPermissionSummary(grantedPermissions)
    const adAccountsData = await adsClient.listAdAccounts()
    const adAccounts = adAccountsData.data || []

    if (!adAccounts.length) {
      return res.status(400).json({
        connected: false,
        error: 'No ad accounts are accessible for this user token',
      })
    }

    const preferred = parsedState.preferred_ad_account_id
    const selected = adAccounts.find((a) => a.id === preferred || a.account_id === preferred) || adAccounts[0]

    db.prepare(`
      INSERT INTO ad_connections (ig_user_id, meta_user_id, meta_user_name, ad_account_id, access_token, scopes, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ig_user_id) DO UPDATE SET
        meta_user_id = excluded.meta_user_id,
        meta_user_name = excluded.meta_user_name,
        ad_account_id = excluded.ad_account_id,
        access_token = excluded.access_token,
        scopes = excluded.scopes,
        expires_at = excluded.expires_at,
        updated_at = unixepoch()
    `).run(
      parsedState.ig_user_id,
      me.id,
      me.name,
      selected.id,
      accessToken,
      grantedPermissions.join(','),
      expiresAt
    )

    const returnTo = normalizeReturnPath(parsedState.return_to)
    if (returnTo) {
      const params = new URLSearchParams({
        meta_ads_connected: permissionSummary.has_required ? '1' : '0',
        ig_user_id: String(parsedState.ig_user_id),
        ad_account_id: String(selected.id),
        missing_permissions: permissionSummary.missing_required.join(','),
      })
      return res.redirect(`${returnTo}?${params.toString()}`)
    }

    return res.json({
      connected: true,
      ig_user_id: parsedState.ig_user_id,
      meta_user_id: me.id,
      selected_ad_account_id: selected.id,
      ad_accounts: adAccounts,
      permissions: permissionSummary,
      token_expires: new Date(expiresAt * 1000).toISOString(),
      next: '/api/campaign-content/:instagramMediaId/boosted-metrics/sync?ig_user_id=...',
    })
  } catch (err) {
    console.error('Meta Ads OAuth error:', err.meta || err.message)
    res.status(500).json({ error: 'Meta Ads OAuth failed', details: err.meta || err.message })
  }
})

router.get('/connections/meta-ads/status', (req, res) => {
  const igUserId = req.query?.ig_user_id
  if (!igUserId) {
    return res.status(400).json({ error: 'Missing required query param: ig_user_id' })
  }

  const row = db
    .prepare('SELECT ig_user_id, meta_user_id, meta_user_name, ad_account_id, scopes, expires_at, updated_at FROM ad_connections WHERE ig_user_id = ?')
    .get(igUserId)

  if (!row) {
    return res.json({ connected: false, ig_user_id: igUserId })
  }

  const granted = String(row.scopes || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const permissions = buildPermissionSummary(granted)

  return res.json({
    connected: true,
    ...row,
    permissions,
    expires_at_iso: row.expires_at ? new Date(row.expires_at * 1000).toISOString() : null,
    updated_at_iso: row.updated_at ? new Date(row.updated_at * 1000).toISOString() : null,
  })
})

router.get('/connections/meta-ads/permissions', async (req, res) => {
  const igUserId = req.query?.ig_user_id
  if (!igUserId) {
    return res.status(400).json({ error: 'Missing required query param: ig_user_id' })
  }

  const connection = db.prepare('SELECT * FROM ad_connections WHERE ig_user_id = ?').get(igUserId)
  if (!connection) {
    return res.status(404).json({ error: 'No Meta Ads connection found for this ig_user_id' })
  }

  if (connection.expires_at && connection.expires_at < Math.floor(Date.now() / 1000)) {
    return res.status(401).json({
      error: 'Meta Ads token expired. Reconnect ad account.',
      reconnect_url: '/connections/meta-ads/init',
    })
  }

  try {
    const adsClient = new MetaAdsClient(connection.access_token)
    const permissionsData = await adsClient.getPermissions()
    const grantedPermissions = normalizeGrantedPermissions(permissionsData.data)
    const summary = buildPermissionSummary(grantedPermissions)

    db.prepare('UPDATE ad_connections SET scopes = ?, updated_at = unixepoch() WHERE ig_user_id = ?')
      .run(grantedPermissions.join(','), igUserId)

    return res.json({
      ig_user_id: igUserId,
      permissions: summary,
    })
  } catch (err) {
    console.error('Meta Ads permissions check error:', err.meta || err.message)
    return res.status(500).json({ error: 'Failed to fetch permissions', details: err.meta || err.message })
  }
})

router.get('/connections/meta-ads/ad-accounts', async (req, res) => {
  const igUserId = req.query?.ig_user_id
  if (!igUserId) {
    return res.status(400).json({ error: 'Missing required query param: ig_user_id' })
  }

  const connection = db.prepare('SELECT * FROM ad_connections WHERE ig_user_id = ?').get(igUserId)
  if (!connection) {
    return res.status(404).json({ error: 'No Meta Ads connection found for this ig_user_id' })
  }

  if (connection.expires_at && connection.expires_at < Math.floor(Date.now() / 1000)) {
    return res.status(401).json({
      error: 'Meta Ads token expired. Reconnect ad account.',
      reconnect_url: '/connections/meta-ads/init',
    })
  }

  try {
    const adsClient = new MetaAdsClient(connection.access_token)
    const adAccountsData = await adsClient.listAdAccounts()
    const adAccounts = adAccountsData.data || []

    return res.json({
      ig_user_id: igUserId,
      selected_ad_account_id: connection.ad_account_id,
      ad_accounts: adAccounts,
    })
  } catch (err) {
    console.error('Meta Ads list ad accounts error:', err.meta || err.message)
    return res.status(500).json({ error: 'Failed to fetch ad accounts', details: err.meta || err.message })
  }
})

router.post('/connections/meta-ads/select-ad-account', (req, res) => {
  const { ig_user_id: igUserId, ad_account_id: adAccountId } = req.body || {}

  if (!igUserId || !adAccountId) {
    return res.status(400).json({ error: 'Missing required ig_user_id and ad_account_id' })
  }

  const existing = db.prepare('SELECT * FROM ad_connections WHERE ig_user_id = ?').get(igUserId)
  if (!existing) {
    return res.status(404).json({ error: 'No Meta Ads connection found for this ig_user_id' })
  }

  db.prepare('UPDATE ad_connections SET ad_account_id = ?, updated_at = unixepoch() WHERE ig_user_id = ?').run(adAccountId, igUserId)

  res.json({
    updated: true,
    ig_user_id: igUserId,
    ad_account_id: adAccountId,
  })
})

// GET /connections/meta-ads/campaigns?ig_user_id=
// Returns the last 10 campaigns for the connected ad account.
router.get('/connections/meta-ads/campaigns', async (req, res) => {
  const igUserId = req.query?.ig_user_id
  if (!igUserId) {
    return res.status(400).json({ error: 'Missing required query param: ig_user_id' })
  }

  const connection = db.prepare('SELECT * FROM ad_connections WHERE ig_user_id = ?').get(igUserId)
  if (!connection) {
    return res.status(404).json({ error: 'No Meta Ads connection found' })
  }

  if (!connection.ad_account_id) {
    return res.status(400).json({ error: 'No ad account selected. Complete step 3 first.' })
  }

  try {
    const adsClient = new MetaAdsClient(connection.access_token)
    const data = await adsClient.listCampaigns(connection.ad_account_id)
    return res.json({
      ig_user_id: igUserId,
      ad_account_id: connection.ad_account_id,
      campaigns: data.data || [],
    })
  } catch (err) {
    console.error('List campaigns error:', err.meta || err.message)
    return res.status(500).json({ error: 'Failed to fetch campaigns', details: err.meta || err.message })
  }
})

// GET /connections/meta-ads/debug-ads?ig_user_id=&limit=10
// Returns raw ad + creative data from the connected ad account so you can inspect
// what fields (instagram_permalink_url, effective_object_story_id, etc.) are present.
router.get('/connections/meta-ads/debug-ads', async (req, res) => {
  const igUserId = req.query?.ig_user_id
  if (!igUserId) {
    return res.status(400).json({ error: 'Missing required query param: ig_user_id' })
  }

  const connection = db.prepare('SELECT * FROM ad_connections WHERE ig_user_id = ?').get(igUserId)
  if (!connection) {
    return res.status(404).json({ error: 'No Meta Ads connection found' })
  }

  try {
    const adsClient = new MetaAdsClient(connection.access_token)
    const limit = Math.min(Number(req.query.limit) || 10, 50)
    const data = await adsClient.graphGet(`/act_${String(connection.ad_account_id).replace('act_', '')}/ads`, {
      fields: 'id,name,effective_status,creative{id,effective_object_story_id,object_story_id,instagram_actor_id,instagram_permalink_url}',
      limit,
    })
    return res.json({
      ad_account_id: connection.ad_account_id,
      total_returned: (data.data || []).length,
      has_next_page: !!data.paging?.next,
      ads: data.data || [],
    })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch ads', details: err.meta || err.message })
  }
})

module.exports = router
