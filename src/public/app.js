function byId(id) {
  return document.getElementById(id)
}

function toJsonString(data) {
  return JSON.stringify(data, null, 2)
}

function setResult(id, data) {
  byId(id).textContent = typeof data === 'string' ? data : toJsonString(data)
}

function flash(message, isError = false) {
  const el = byId('flash')
  el.textContent = message
  el.className = `flash ${isError ? 'error' : 'ok'}`
}

function getIgUserId() {
  return byId('ig-user-id').value.trim()
}

function setIgUserId(value) {
  byId('ig-user-id').value = value || ''
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })

  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }

  if (!response.ok) {
    throw new Error(data.error || data.details || `Request failed: ${response.status}`)
  }
  return data
}

async function loadInstagramStatus() {
  const data = await api('/auth/status')
  const accounts = data.connected_accounts || []

  setResult('ig-status', {
    total_connected: accounts.length,
    connected_accounts: accounts,
  })

  const select = byId('influencer-select')
  const currentValue = select.value

  select.innerHTML = '<option value="">— select an influencer —</option>'
  for (const account of accounts) {
    const option = document.createElement('option')
    option.value = account.ig_user_id
    option.textContent = `${account.username || account.ig_user_id} (${account.ig_user_id}) — expires ${account.expires_at}`
    select.appendChild(option)
  }

  // Restore previous selection if still valid
  if (currentValue && accounts.some((a) => a.ig_user_id === currentValue)) {
    select.value = currentValue
  }
}

async function connectMetaAds() {
  const igUserId = getIgUserId()
  if (!igUserId) throw new Error('Enter IG User ID first')

  const params = new URLSearchParams({
    ig_user_id: igUserId,
    return_to: '/ui',
  })
  const data = await api(`/connections/meta-ads/init?${params.toString()}`)
  setResult('meta-ads-status', data)
  flash('Redirecting to Meta authorization...')
  window.location.href = data.authUrl
}

async function loadMetaAdsStatus() {
  const igUserId = getIgUserId()
  if (!igUserId) throw new Error('Enter IG User ID first')
  const data = await api(`/connections/meta-ads/status?ig_user_id=${encodeURIComponent(igUserId)}`)
  setResult('meta-ads-status', data)
}

async function loadMetaAdsPermissions() {
  const igUserId = getIgUserId()
  if (!igUserId) throw new Error('Enter IG User ID first')
  const data = await api(`/connections/meta-ads/permissions?ig_user_id=${encodeURIComponent(igUserId)}`)
  setResult('meta-ads-status', data)
  if (data.permissions?.missing_required?.length) {
    flash(`Missing required permissions: ${data.permissions.missing_required.join(', ')}`, true)
  } else {
    flash('Required permissions are granted')
  }
}

async function loadAdAccounts() {
  const igUserId = getIgUserId()
  if (!igUserId) throw new Error('Enter IG User ID first')
  const data = await api(`/connections/meta-ads/ad-accounts?ig_user_id=${encodeURIComponent(igUserId)}`)
  setResult('ad-account-status', data)

  const select = byId('ad-account-select')
  select.innerHTML = ''
  for (const account of data.ad_accounts || []) {
    const option = document.createElement('option')
    option.value = account.id
    option.textContent = `${account.name || account.id} (${account.id})`
    if (data.selected_ad_account_id && data.selected_ad_account_id === account.id) {
      option.selected = true
    }
    select.appendChild(option)
  }

  // Auto-select the first account if none is already saved
  if (!data.selected_ad_account_id && select.options.length > 0) {
    select.selectedIndex = 0
    await saveAdAccountSelection()
  }
}

async function saveAdAccountSelection() {
  const igUserId = getIgUserId()
  const selected = byId('ad-account-select').value
  if (!igUserId) throw new Error('Enter IG User ID first')
  if (!selected) throw new Error('Load and choose an ad account first')

  const data = await api('/connections/meta-ads/select-ad-account', {
    method: 'POST',
    body: JSON.stringify({
      ig_user_id: igUserId,
      ad_account_id: selected,
    }),
  })
  setResult('ad-account-status', data)
  flash('Ad account selection saved')
}

function deliveryColor(status) {
  switch (status) {
    case 'ACTIVE':      return '#16a34a'
    case 'PREPARING':
    case 'IN_PROCESS':  return '#d97706'
    case 'PAUSED':      return '#6b7280'
    case 'WITH_ISSUES': return '#dc2626'
    default:            return '#9ca3af'
  }
}

async function loadCampaigns() {
  const igUserId = getIgUserId()
  if (!igUserId) throw new Error('Select an influencer first')

  const data = await api(`/connections/meta-ads/campaigns?ig_user_id=${encodeURIComponent(igUserId)}`)
  const campaigns = data.campaigns || []

  const list = byId('campaigns-list')
  list.innerHTML = ''

  if (!campaigns.length) {
    list.textContent = 'No campaigns found in this ad account.'
    return
  }

  for (const c of campaigns) {
    const budget = c.daily_budget
      ? `$${(c.daily_budget / 100).toFixed(2)}/day`
      : c.lifetime_budget
        ? `$${(c.lifetime_budget / 100).toFixed(2)} lifetime`
        : '—'
    const created = c.created_time ? new Date(c.created_time).toLocaleDateString() : '—'
    const campColor = deliveryColor(c.effective_status)

    const campaignEl = document.createElement('div')
    campaignEl.className = 'campaign-block'
    campaignEl.innerHTML = `
      <div class="campaign-header">
        <span class="post-badge" style="background:${campColor};color:#fff">${c.effective_status}</span>
        <div class="post-info">
          <div class="post-caption">${c.name}</div>
          <div class="post-meta">ID: ${c.id} · ${c.objective || '—'} · Budget: ${budget} · Created: ${created}</div>
        </div>
      </div>
    `

    const ads = c.ads?.data || []
    if (ads.length) {
      const adsEl = document.createElement('div')
      adsEl.className = 'campaign-ads'

      for (const ad of ads) {
        const adColor = deliveryColor(ad.effective_status)
        const permalink = ad.creative?.instagram_permalink_url || null
        const storyId = ad.creative?.effective_object_story_id || '—'
        const delivery = ad.effective_status

        const adEl = document.createElement('div')
        adEl.className = 'post-item'
        adEl.innerHTML = `
          <span class="post-badge" style="background:${adColor};color:#fff">${delivery}</span>
          <div class="post-info">
            <div class="post-caption">${ad.name}</div>
            <div class="post-meta">Ad ID: ${ad.id}${permalink ? ` · <a href="${permalink}" target="_blank">${permalink}</a>` : ` · Story: ${storyId}`}</div>
          </div>
          ${permalink ? `<button class="post-use-btn" data-url="${permalink}">Use URL</button>` : ''}
        `

        if (permalink) {
          adEl.querySelector('.post-use-btn').addEventListener('click', (e) => {
            e.stopPropagation()
            byId('post-url').value = permalink
            byId('ad-post-url').value = permalink
            flash(`URL set: ${permalink}`)
          })
        }

        adsEl.appendChild(adEl)
      }

      campaignEl.appendChild(adsEl)
    } else {
      const empty = document.createElement('div')
      empty.className = 'post-meta'
      empty.style.padding = '0.4rem 0.75rem'
      empty.textContent = 'No ads in this campaign.'
      campaignEl.appendChild(empty)
    }

    list.appendChild(campaignEl)
  }

  flash(`Loaded ${campaigns.length} campaigns from ${data.ad_account_id}`)
}

async function fetchPostMetrics() {
  const igUserId = getIgUserId()
  const postUrl = byId('post-url').value.trim()
  if (!igUserId) throw new Error('Select an influencer first')
  if (!postUrl) throw new Error('Enter an Instagram post URL')

  const params = new URLSearchParams({ ig_user_id: igUserId, post_url: postUrl })
  const data = await api(`/api/media/full-metrics-by-url?${params.toString()}`)
  setResult('post-metrics-result', data)

  if (data.organic_media_id) {
    const paidNote = data.paid_status === 'ok' ? '(organic + paid)' : `(organic only — paid: ${data.paid_status})`
    flash(`Metrics loaded for ${data.username} ${paidNote}`)
  }
}

async function loadRecentPosts() {
  const igUserId = getIgUserId()
  if (!igUserId) throw new Error('Select an influencer first')

  const data = await api(`/api/media?ig_user_id=${encodeURIComponent(igUserId)}`)
  const posts = (data.media || []).slice(0, 10)

  const list = byId('recent-posts-list')
  list.innerHTML = ''

  if (!posts.length) {
    list.textContent = 'No posts found.'
    return
  }

  for (const post of posts) {
    const item = document.createElement('div')
    item.className = 'post-item'

    const date = post.timestamp ? new Date(post.timestamp).toLocaleDateString() : '—'
    const caption = post.caption ? post.caption.substring(0, 80) : '(no caption)'

    item.innerHTML = `
      <span class="post-badge">${post.media_type || 'POST'}</span>
      <div class="post-info">
        <div class="post-caption">${caption}</div>
        <div class="post-meta">${date} · ${post.permalink}</div>
      </div>
      <button class="post-use-btn">Use URL</button>
    `

    item.querySelector('.post-use-btn').addEventListener('click', (e) => {
      e.stopPropagation()
      byId('post-url').value = post.permalink
      byId('ad-post-url').value = post.permalink
      flash(`URL set: ${post.permalink}`)
    })

    list.appendChild(item)
  }

  flash(`Loaded ${posts.length} recent posts for ${data.username}`)
}

async function fetchAdDetails() {
  const igUserId = getIgUserId()
  const postUrl = byId('ad-post-url').value.trim()
  if (!igUserId) throw new Error('Select an influencer first')
  if (!postUrl) throw new Error('Enter an Instagram post URL')

  const params = new URLSearchParams({ ig_user_id: igUserId, post_url: postUrl })
  const data = await api(`/api/media/full-metrics-by-url?${params.toString()}`)

  setResult('ad-details-result', {
    organic_media_id: data.organic_media_id,
    organic_permalink: data.organic_permalink,
    posted_at: data.posted_at,
    paid_status: data.paid_status,
    ad_mapping: data.ad_mapping,
    paid_metrics: data.paid,
  })

  const statusMsg = data.paid_status === 'ok'
    ? `Ad found — ${data.ad_mapping?.match_confidence} confidence match`
    : `No ad found — ${data.paid_status}`
  flash(statusMsg, data.paid_status !== 'ok')
}

function hydrateFromQueryParams() {
  const params = new URLSearchParams(window.location.search)
  const igUserId = params.get('ig_user_id')
  if (igUserId) setIgUserId(igUserId)

  if (params.get('ig_connected') === '1') {
    flash('Instagram account connected successfully')
    runSafely(loadInstagramStatus)
  }

  if (params.get('meta_ads_connected') === '1') {
    flash('Meta Ads authorization completed')
  }

  if (params.get('meta_ads_connected') === '0') {
    const missing = params.get('missing_permissions')
    const err = missing
      ? `Missing required permissions: ${missing}`
      : (params.get('error_description') || params.get('error') || 'Authorization failed')
    flash(err, true)
  }
}

function wireActions() {
  byId('load-ig-status').addEventListener('click', (e) => runSafely(loadInstagramStatus, e.currentTarget))
  byId('influencer-select').addEventListener('change', () => {
    const selected = byId('influencer-select').value
    if (selected) {
      setIgUserId(selected)
      runSafely(loadMetaAdsStatus)
    }
  })
  byId('connect-meta-ads').addEventListener('click', (e) => runSafely(connectMetaAds, e.currentTarget))
  byId('check-meta-ads').addEventListener('click', (e) => runSafely(loadMetaAdsStatus, e.currentTarget))
  byId('check-meta-perms').addEventListener('click', (e) => runSafely(loadMetaAdsPermissions, e.currentTarget))
  byId('load-ad-accounts').addEventListener('click', (e) => runSafely(loadAdAccounts, e.currentTarget))
  byId('ad-account-select').addEventListener('change', () => runSafely(saveAdAccountSelection))
  byId('load-campaigns').addEventListener('click', (e) => runSafely(loadCampaigns, e.currentTarget))
  byId('fetch-post-metrics').addEventListener('click', (e) => runSafely(fetchPostMetrics, e.currentTarget))
  byId('fetch-ad-details').addEventListener('click', (e) => runSafely(fetchAdDetails, e.currentTarget))
  byId('load-recent-posts').addEventListener('click', (e) => runSafely(loadRecentPosts, e.currentTarget))
}

async function runSafely(fn, btn) {
  if (btn) btn.classList.add('loading')
  try {
    await fn()
  } catch (err) {
    flash(err.message || 'Action failed', true)
  } finally {
    if (btn) btn.classList.remove('loading')
  }
}

hydrateFromQueryParams()
wireActions()
runSafely(loadInstagramStatus)
