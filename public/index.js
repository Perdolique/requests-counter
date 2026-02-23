const dom = {
  authHealthBlock: document.querySelector('#authHealthBlock'),
  authHealthMessage: document.querySelector('#authHealthMessage'),
  authReconnectButton: document.querySelector('#authReconnectButton'),
  authorizedBlock: document.querySelector('#authorizedBlock'),
  copyObsButton: document.querySelector('#copyObsButton'),
  dashboardStats: document.querySelector('#dashboardStats'),
  dashboardStatsContent: document.querySelector('#dashboardStatsContent'),
  deleteAccountButton: document.querySelector('#deleteAccountButton'),
  loadingBlock: document.querySelector('#loadingBlock'),
  logoutButton: document.querySelector('#logoutButton'),
  obsUrl: document.querySelector('#obsUrl'),
  obsTitleInput: document.querySelector('#obsTitleInput'),
  quotaInput: document.querySelector('#quotaInput'),
  regenerateButton: document.querySelector('#regenerateButton'),
  savePopover: document.querySelector('#savePopover'),
  statusBox: document.querySelector('#statusBox'),
  subtitle: document.querySelector('#subtitle'),
  userActions: document.querySelector('#userActions'),
  unauthorizedBlock: document.querySelector('#unauthorizedBlock')
}

const SAVE_POPOVER_DURATION_MS = 1_800
const SAVE_INPUT_DEBOUNCE_MS = 1_000
const OBS_URL_MASKED_LABEL = 'URL hidden for stream safety. Use Copy URL.'
const OBS_URL_MISSING_LABEL = 'URL unavailable. Try regenerate.'
const NO_USAGE_PLACEHOLDER = 'No data'
const MODEL_USAGE_VIEW_ALL = 'all'
const MODEL_USAGE_VIEW_GROUPED = 'grouped'
const AUTO_MODEL_PREFIX = 'Auto:'
const OTHERS_MODEL_NAMES = new Set([
  'Coding Agent model',
  'Code Review model'
])

const state = {
  /** @type {{ githubAuthStatus: 'missing' | 'connected' | 'reconnect_required'; monthlyQuota: number | null; obsTitle: string } | null} */
  me: null,
  dashboardData: null,
  modelUsageView: MODEL_USAGE_VIEW_ALL,
  obsUrl: '',
  debounceTimerIds: {
    monthlyQuota: 0,
    obsTitle: 0
  },
  savePopoverTimerId: 0,
  saving: {
    monthlyQuota: false,
    obsTitle: false
  }
}

function readErrorMessage(payload) {
  const hasPayload = typeof payload === 'object' && payload !== null

  if (!hasPayload) {
    return 'Unexpected error'
  }

  const payloadObject = /** @type {{ error?: { message?: string } }} */ (payload)
  const hasMessage =
    typeof payloadObject.error === 'object' &&
    payloadObject.error !== null &&
    typeof payloadObject.error.message === 'string'

  if (!hasMessage) {
    return 'Unexpected error'
  }

  return payloadObject.error.message
}

function showStatus(message, kind) {
  dom.statusBox.textContent = message
  dom.statusBox.classList.remove('hidden', 'error', 'success')
  dom.statusBox.classList.add(kind)
}

function hideStatus() {
  dom.statusBox.textContent = ''
  dom.statusBox.classList.add('hidden')
  dom.statusBox.classList.remove('error', 'success')
}

function setAuthorized(isAuthorized) {
  dom.authorizedBlock.classList.toggle('hidden', !isAuthorized)
  dom.userActions.classList.toggle('hidden', !isAuthorized)
  dom.unauthorizedBlock.classList.toggle('hidden', isAuthorized)
}

async function fetchJson(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  const hasText = text.length > 0
  let payload = null

  if (hasText) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  const isOk = response.ok

  if (!isOk) {
    const message = readErrorMessage(payload)

    throw new Error(message)
  }

  return payload
}

function setObsUrl(url) {
  const hasUrl = typeof url === 'string' && url.length > 0

  state.obsUrl = hasUrl ? url : ''
  dom.obsUrl.textContent = hasUrl ? OBS_URL_MASKED_LABEL : OBS_URL_MISSING_LABEL
}

function setHidden(element, shouldHide) {
  if (!(element instanceof HTMLElement)) {
    return
  }

  element.classList.toggle('hidden', shouldHide)
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function parseMonthlyUsageByModel(rawValue) {
  const isArray = Array.isArray(rawValue)

  if (!isArray) {
    return []
  }

  const output = []

  for (const item of rawValue) {
    const isObject = typeof item === 'object' && item !== null

    if (!isObject) {
      continue
    }

    const modelValue = item.model
    const requestsValue = item.requests
    const hasModel = typeof modelValue === 'string'
    const model = hasModel ? modelValue.trim() : ''
    const hasValidModel = model.length > 0
    const hasValidRequests =
      typeof requestsValue === 'number' && Number.isFinite(requestsValue) && requestsValue > 0

    if (!hasValidModel || !hasValidRequests) {
      continue
    }

    output.push({
      model,
      requests: requestsValue
    })
  }

  output.sort((left, right) => {
    const usageDifference = right.requests - left.requests
    const hasUsageDifference = usageDifference !== 0

    if (hasUsageDifference) {
      return usageDifference
    }

    return left.model.localeCompare(right.model)
  })

  return output
}

function buildModelUsageToggleButtonHtml(label, view, activeView) {
  const isActive = view === activeView
  const activeClassName = isActive ? ' is-active' : ''
  const ariaPressed = isActive ? 'true' : 'false'

  return `
    <button
      type="button"
      class="model-usage-toggle${activeClassName}"
      data-model-usage-view="${view}"
      aria-pressed="${ariaPressed}"
    >${label}</button>
  `
}

function buildModelUsageRowsHtml(items, formatter) {
  const itemsCount = items.length

  if (itemsCount === 0) {
    return ''
  }

  const maxRequests = items[0].requests
  let rowsHtml = ''

  for (const item of items) {
    const ratio = maxRequests > 0 ? item.requests / maxRequests : 0
    const widthPercent = clamp(ratio * 100, 0, 100)
    const formattedRequests = formatter.format(item.requests)
    const safeModelName = escapeHtml(item.model)

    rowsHtml += `
      <div class="model-usage-item">
        <div class="model-usage-row">
          <div class="model-usage-label">${safeModelName}</div>
          <div class="model-usage-value">${formattedRequests} requests</div>
        </div>
        <div class="model-usage-track">
          <div class="model-usage-fill" style="width: ${widthPercent}%;"></div>
        </div>
      </div>
    `
  }

  return rowsHtml
}

function buildModelUsageListHtml(items, formatter) {
  const rowsHtml = buildModelUsageRowsHtml(items, formatter)
  const hasRowsHtml = rowsHtml.length > 0

  if (!hasRowsHtml) {
    return ''
  }

  return `
    <div class="model-usage-list">
      ${rowsHtml}
    </div>
  `
}

function isAutoSelectedModelName(modelName) {
  return modelName.startsWith(AUTO_MODEL_PREFIX)
}

function isOthersModelName(modelName) {
  return OTHERS_MODEL_NAMES.has(modelName)
}

function groupMonthlyUsageByModel(items) {
  const regularItems = []
  const autoItems = []
  const othersItems = []

  for (const item of items) {
    const modelName = item.model
    const isAutoSelected = isAutoSelectedModelName(modelName)

    if (isAutoSelected) {
      autoItems.push(item)
      continue
    }

    const isOthersModel = isOthersModelName(modelName)

    if (isOthersModel) {
      othersItems.push(item)
      continue
    }

    regularItems.push(item)
  }

  return [
    {
      items: regularItems,
      key: 'regular',
      title: 'Regular Models'
    },
    {
      items: autoItems,
      key: 'auto',
      title: 'Auto-selected Models'
    },
    {
      items: othersItems,
      key: 'others',
      title: 'Others'
    }
  ]
}

function buildGroupedMonthlyUsageByModelHtml(items, formatter) {
  const groups = groupMonthlyUsageByModel(items)
  let groupsHtml = ''

  for (const group of groups) {
    const groupItems = group.items
    const groupItemsCount = groupItems.length

    if (groupItemsCount === 0) {
      continue
    }

    const listHtml = buildModelUsageListHtml(groupItems, formatter)

    groupsHtml += `
      <section class="model-usage-group" data-model-usage-group="${group.key}">
        <div class="model-usage-group-title">${group.title}</div>
        ${listHtml}
      </section>
    `
  }

  return groupsHtml
}

function buildMonthlyUsageByModelHtml(items, formatter, view) {
  const itemsCount = items.length

  if (itemsCount === 0) {
    return ''
  }

  const activeView = view === MODEL_USAGE_VIEW_GROUPED
    ? MODEL_USAGE_VIEW_GROUPED
    : MODEL_USAGE_VIEW_ALL
  const controlsHtml = `
    <div class="model-usage-controls" role="group" aria-label="Monthly usage model view">
      ${buildModelUsageToggleButtonHtml('All Models', MODEL_USAGE_VIEW_ALL, activeView)}
      ${buildModelUsageToggleButtonHtml('Grouped', MODEL_USAGE_VIEW_GROUPED, activeView)}
    </div>
  `
  const bodyHtml = activeView === MODEL_USAGE_VIEW_GROUPED
    ? `<div class="model-usage-groups">${buildGroupedMonthlyUsageByModelHtml(items, formatter)}</div>`
    : buildModelUsageListHtml(items, formatter)

  return `
    <div class="model-usage-section">
      <div class="model-usage-header">
        <div class="model-usage-title">Monthly Usage by Model</div>
        ${controlsHtml}
      </div>
      ${bodyHtml}
    </div>
  `
}

function renderAuthHealth() {
  const hasProfile = state.me !== null

  if (!hasProfile) {
    setHidden(dom.authHealthBlock, true)
    return
  }

  const githubAuthStatus = state.me.githubAuthStatus
  const isConnected = githubAuthStatus === 'connected'

  if (isConnected) {
    setHidden(dom.authHealthBlock, true)
    return
  }

  if (dom.authHealthMessage) {
    dom.authHealthMessage.textContent = githubAuthStatus === 'reconnect_required'
      ? 'GitHub authorization expired or was revoked. Reconnect GitHub to refresh data.'
      : 'GitHub authorization is missing. Sign in again to continue.'
  }

  setHidden(dom.authHealthBlock, false)
}

function renderDashboardStats(dashboardData) {
  if (!dashboardData) {
    dom.dashboardStats.classList.add('hidden')
    dom.dashboardStatsContent.innerHTML = ''
    return
  }

  dom.dashboardStats.classList.remove('hidden')
  const hasUsageData =
    typeof dashboardData.hasUsageData === 'boolean' ? dashboardData.hasUsageData : true

  if (!hasUsageData) {
    dom.dashboardStatsContent.innerHTML = `
      <div class="stat-card">
        <div class="stat-label">Usage Data</div>
        <div class="stat-value">${NO_USAGE_PLACEHOLDER}</div>
      </div>
    `
    return
  }

  const formatter = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2
  })
  const availableTodayValue = dashboardData.display
  const daysRemainingValue = String(dashboardData.daysRemaining)
  const totalRemainingValue = formatter.format(dashboardData.monthRemaining)
  const monthlyUsageByModel = parseMonthlyUsageByModel(dashboardData.monthlyUsageByModel)
  const monthlyUsageByModelHtml = buildMonthlyUsageByModelHtml(
    monthlyUsageByModel,
    formatter,
    state.modelUsageView
  )

  dom.dashboardStatsContent.innerHTML = `
    <div class="dashboard-grid">
      <div class="stat-card">
        <div class="stat-label">Available Today</div>
        <div class="stat-value">${availableTodayValue}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Days Remaining</div>
        <div class="stat-value">${daysRemainingValue}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Requests Remaining</div>
        <div class="stat-value">${totalRemainingValue}</div>
      </div>
    </div>
    ${monthlyUsageByModelHtml}
  `
}

function clamp(value, min, max) {
  const clamped = Math.min(max, Math.max(min, value))

  return clamped
}

function positionSavePopover(popover, anchor) {
  if (!(anchor instanceof Element)) {
    return
  }

  const anchorRect = anchor.getBoundingClientRect()
  const popoverRect = popover.getBoundingClientRect()
  const viewportPadding = 12
  const gap = 10
  const maxLeft = window.innerWidth - popoverRect.width - viewportPadding
  const desiredLeft = anchorRect.left + anchorRect.width / 2 - popoverRect.width / 2
  const left = clamp(
    desiredLeft,
    viewportPadding,
    Math.max(viewportPadding, maxLeft)
  )
  const aboveTop = anchorRect.top - popoverRect.height - gap
  const belowTop = anchorRect.bottom + gap
  const maxTop = window.innerHeight - popoverRect.height - viewportPadding
  const top = aboveTop >= viewportPadding
    ? aboveTop
    : clamp(belowTop, viewportPadding, Math.max(viewportPadding, maxTop))

  popover.style.left = `${Math.round(left)}px`
  popover.style.top = `${Math.round(top)}px`
}

function showSavePopover(message, anchor) {
  const hasMessage = typeof message === 'string' && message.length > 0
  const popover = dom.savePopover

  if (!hasMessage || !(popover instanceof HTMLElement)) {
    return
  }

  popover.textContent = message

  if (!popover.matches(':popover-open')) {
    popover.showPopover()
  }

  window.requestAnimationFrame(() => {
    positionSavePopover(popover, anchor)
  })

  if (state.savePopoverTimerId > 0) {
    window.clearTimeout(state.savePopoverTimerId)
  }

  state.savePopoverTimerId = window.setTimeout(() => {
    if (popover.matches(':popover-open')) {
      popover.hidePopover()
    }

    state.savePopoverTimerId = 0
  }, SAVE_POPOVER_DURATION_MS)
}

function updateLocalProfile(nextValues) {
  if (!state.me) {
    return
  }

  state.me = {
    ...state.me,
    ...nextValues
  }
}

function parsePositiveQuota(rawValue) {
  const value = Number.parseInt(rawValue, 10)
  const isValid = Number.isInteger(value) && value > 0

  if (!isValid) {
    return null
  }

  return value
}

function scheduleDebouncedSave(field, callback, delayMs = SAVE_INPUT_DEBOUNCE_MS) {
  const timerId = state.debounceTimerIds[field]

  if (timerId > 0) {
    window.clearTimeout(timerId)
  }

  state.debounceTimerIds[field] = window.setTimeout(() => {
    state.debounceTimerIds[field] = 0
    void callback()
  }, delayMs)
}

function applyAuthFeedbackFromQuery() {
  const url = new URL(window.location.href)
  const auth = url.searchParams.get('auth')
  const authError = url.searchParams.get('authError')
  const hasAuth = typeof auth === 'string' && auth.length > 0
  const hasAuthError = typeof authError === 'string' && authError.length > 0

  if (!hasAuth && !hasAuthError) {
    return
  }

  if (auth === 'connected') {
    showStatus('Signed in with GitHub.', 'success')
  } else if (authError === 'cancelled') {
    showStatus('GitHub sign-in was cancelled.', 'error')
  } else if (authError === 'state') {
    showStatus('GitHub OAuth state check failed. Try again.', 'error')
  } else {
    showStatus('GitHub sign-in failed. Try again.', 'error')
  }

  url.searchParams.delete('auth')
  url.searchParams.delete('authError')
  window.history.replaceState({}, '', url.toString())
}

function applyViewTransition(fn) {
  if (document.startViewTransition) {
    document.startViewTransition(fn)
  } else {
    fn()
  }
}

function handleDashboardStatsContentClick(event) {
  const target = event.target
  const hasElementTarget = target instanceof Element

  if (!hasElementTarget) {
    return
  }

  const toggleButton = target.closest('[data-model-usage-view]')
  const hasToggleButton = toggleButton instanceof HTMLButtonElement

  if (!hasToggleButton) {
    return
  }

  const nextView = toggleButton.dataset.modelUsageView
  const isKnownView = nextView === MODEL_USAGE_VIEW_ALL || nextView === MODEL_USAGE_VIEW_GROUPED

  if (!isKnownView || state.modelUsageView === nextView) {
    return
  }

  state.modelUsageView = nextView
  renderDashboardStats(state.dashboardData)
}

async function loadMe() {
  hideStatus()

  try {
    const me = await fetchJson('/api/me')

    applyViewTransition(() => {
      dom.loadingBlock.classList.add('hidden')
      setAuthorized(true)
      dom.subtitle.textContent = `Signed in as @${me.user.githubLogin}`
      setObsUrl(me.obsUrl)
      state.dashboardData = me.dashboardData ?? null
      renderDashboardStats(state.dashboardData)
      state.me = {
        githubAuthStatus:
          me.githubAuthStatus === 'reconnect_required' ? 'reconnect_required' : (
            me.githubAuthStatus === 'connected' ? 'connected' : 'missing'
          ),
        monthlyQuota: typeof me.monthlyQuota === 'number' ? me.monthlyQuota : null,
        obsTitle: typeof me.obsTitle === 'string' ? me.obsTitle : ''
      }
      dom.quotaInput.value = state.me.monthlyQuota === null ? '' : String(state.me.monthlyQuota)
      dom.obsTitleInput.value = state.me.obsTitle
      renderAuthHealth()
    })
  } catch {
    applyViewTransition(() => {
      dom.loadingBlock.classList.add('hidden')
      state.me = null
      state.dashboardData = null
      state.obsUrl = ''
      setAuthorized(false)
      dom.subtitle.textContent = 'Sign in with GitHub to manage your OBS widget settings.'
      renderDashboardStats(null)
      renderAuthHealth()
    })
  }
}

async function saveQuotaOnBlur() {
  if (!state.me) {
    return
  }

  if (state.saving.monthlyQuota) {
    scheduleDebouncedSave('monthlyQuota', saveQuotaOnBlur, 250)
    return
  }

  const quotaRaw = dom.quotaInput.value.trim()
  const hasQuotaInput = quotaRaw.length > 0
  const previousQuota = state.me.monthlyQuota

  if (!hasQuotaInput) {
    if (typeof previousQuota === 'number') {
      showStatus('Quota must be a positive integer.', 'error')
      dom.quotaInput.value = String(previousQuota)
    }

    return
  }

  const quota = parsePositiveQuota(quotaRaw)

  if (quota === null) {
    showStatus('Quota must be a positive integer.', 'error')
    dom.quotaInput.value = previousQuota === null ? '' : String(previousQuota)
    return
  }

  if (previousQuota === quota) {
    return
  }

  state.saving.monthlyQuota = true

  try {
    await fetchJson('/api/settings', {
      body: JSON.stringify({
        monthlyQuota: quota
      }),
      headers: {
        'Content-Type': 'application/json'
      },
      method: 'PUT'
    })

    updateLocalProfile({
      monthlyQuota: quota
    })
    hideStatus()
    showSavePopover('Quota saved', dom.quotaInput)
  } catch (error) {
    const hasError = error instanceof Error
    const message = hasError ? error.message : 'Failed to save quota'

    showStatus(message, 'error')
  } finally {
    state.saving.monthlyQuota = false
  }
}

async function saveObsTitleOnBlur() {
  if (!state.me) {
    return
  }

  if (state.saving.obsTitle) {
    scheduleDebouncedSave('obsTitle', saveObsTitleOnBlur, 250)
    return
  }

  const obsTitle = dom.obsTitleInput.value.trim()
  const previousTitle = state.me.obsTitle

  if (obsTitle === previousTitle) {
    return
  }

  state.saving.obsTitle = true

  try {
    await fetchJson('/api/settings', {
      body: JSON.stringify({
        obsTitle
      }),
      headers: {
        'Content-Type': 'application/json'
      },
      method: 'PUT'
    })

    updateLocalProfile({
      obsTitle
    })
    hideStatus()
    showSavePopover(
      obsTitle.length > 0 ? 'Title saved' : 'Title reset to default',
      dom.obsTitleInput
    )
  } catch (error) {
    const hasError = error instanceof Error
    const message = hasError ? error.message : 'Failed to save title'

    showStatus(message, 'error')
  } finally {
    state.saving.obsTitle = false
  }
}

function reconnectGitHub() {
  if (!state.me) {
    return
  }

  window.location.href = '/api/auth/github/login'
}

async function regenerateObsUrl() {
  dom.regenerateButton.disabled = true

  try {
    const payload = await fetchJson('/api/obs/regenerate', {
      method: 'POST'
    })

    setObsUrl(payload.obsUrl)
    showStatus('OBS URL regenerated. Old URL is invalid now.', 'success')
  } catch (error) {
    const hasError = error instanceof Error
    const message = hasError ? error.message : 'Failed to regenerate OBS URL'

    showStatus(message, 'error')
  } finally {
    dom.regenerateButton.disabled = false
  }
}

async function logout() {
  dom.logoutButton.disabled = true

  try {
    await fetchJson('/api/auth/logout', {
      method: 'POST'
    })

    window.location.href = '/'
  } catch (error) {
    const hasError = error instanceof Error
    const message = hasError ? error.message : 'Failed to logout'

    showStatus(message, 'error')
    dom.logoutButton.disabled = false
  }
}

async function deleteAccount() {
  const confirmed = window.confirm(
    'Delete your account and all related data? This action cannot be undone.'
  )

  if (!confirmed) {
    return
  }

  dom.deleteAccountButton.disabled = true

  try {
    await fetchJson('/api/account', {
      method: 'DELETE'
    })

    window.location.href = '/'
  } catch (error) {
    const hasError = error instanceof Error
    const message = hasError ? error.message : 'Failed to delete account'

    showStatus(message, 'error')
    dom.deleteAccountButton.disabled = false
  }
}

async function copyObsUrl() {
  const text = state.obsUrl
  const hasText = text.length > 0

  if (!hasText) {
    showStatus('OBS URL is empty.', 'error')
    return
  }

  try {
    await navigator.clipboard.writeText(text)
    showStatus('OBS URL copied.', 'success')
  } catch {
    showStatus('Clipboard is blocked by browser policy.', 'error')
  }
}

function bindEvents() {
  dom.authReconnectButton.addEventListener('click', reconnectGitHub)
  dom.dashboardStatsContent.addEventListener('click', handleDashboardStatsContentClick)
  dom.quotaInput.addEventListener('input', () => {
    scheduleDebouncedSave('monthlyQuota', saveQuotaOnBlur)
  })
  dom.obsTitleInput.addEventListener('input', () => {
    scheduleDebouncedSave('obsTitle', saveObsTitleOnBlur)
  })
  dom.regenerateButton.addEventListener('click', regenerateObsUrl)
  dom.logoutButton.addEventListener('click', logout)
  dom.deleteAccountButton.addEventListener('click', deleteAccount)
  dom.copyObsButton.addEventListener('click', copyObsUrl)
}

async function bootstrap() {
  bindEvents()
  renderAuthHealth()
  await loadMe()
  applyAuthFeedbackFromQuery()
}

void bootstrap()
