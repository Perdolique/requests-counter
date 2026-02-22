const dom = {
  authorizedBlock: document.querySelector('#authorizedBlock'),
  copyObsButton: document.querySelector('#copyObsButton'),
  dashboardStats: document.querySelector('#dashboardStats'),
  dashboardStatsContent: document.querySelector('#dashboardStatsContent'),
  deleteAccountButton: document.querySelector('#deleteAccountButton'),
  githubConnectButton: document.querySelector('#githubConnectButton'),
  githubConnectionStatus: document.querySelector('#githubConnectionStatus'),
  githubDisconnectButton: document.querySelector('#githubDisconnectButton'),
  githubReconnectButton: document.querySelector('#githubReconnectButton'),
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

const state = {
  /** @type {{ githubAuthStatus: 'missing' | 'connected' | 'reconnect_required'; githubConnected: boolean; githubLogin: string | null; monthlyQuota: number | null; obsTitle: string } | null} */
  me: null,
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

function setButtonDisabled(button, isDisabled) {
  if (!(button instanceof HTMLButtonElement)) {
    return
  }

  button.disabled = isDisabled
}

function renderGitHubConnection() {
  const hasProfile = state.me !== null

  if (!hasProfile) {
    if (dom.githubConnectionStatus) {
      dom.githubConnectionStatus.textContent = 'GitHub is not connected.'
    }

    setHidden(dom.githubConnectButton, false)
    setHidden(dom.githubReconnectButton, true)
    setHidden(dom.githubDisconnectButton, true)
    return
  }

  const githubAuthStatus = state.me.githubAuthStatus
  const githubLogin = state.me.githubLogin
  const isConnected = state.me.githubConnected
  const hasGithubLogin = typeof githubLogin === 'string' && githubLogin.length > 0

  if (githubAuthStatus === 'reconnect_required') {
    if (dom.githubConnectionStatus) {
      dom.githubConnectionStatus.textContent = hasGithubLogin
        ? `GitHub connection for @${githubLogin} needs reconnect.`
        : 'GitHub connection needs reconnect.'
    }

    setHidden(dom.githubConnectButton, true)
    setHidden(dom.githubReconnectButton, false)
    setHidden(dom.githubDisconnectButton, false)
    return
  }

  if (isConnected) {
    if (dom.githubConnectionStatus) {
      dom.githubConnectionStatus.textContent = hasGithubLogin
        ? `Connected GitHub account: @${githubLogin}`
        : 'GitHub is connected.'
    }

    setHidden(dom.githubConnectButton, true)
    setHidden(dom.githubReconnectButton, false)
    setHidden(dom.githubDisconnectButton, false)
    return
  }

  if (dom.githubConnectionStatus) {
    dom.githubConnectionStatus.textContent = 'GitHub is not connected.'
  }

  setHidden(dom.githubConnectButton, false)
  setHidden(dom.githubReconnectButton, true)
  setHidden(dom.githubDisconnectButton, true)
}

function renderDashboardStats(dashboardData) {
  if (!dashboardData) {
    dom.dashboardStats.classList.add('hidden')
    dom.dashboardStatsContent.innerHTML = ''
    return
  }

  dom.dashboardStats.classList.remove('hidden')
  
  const formatter = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2
  })

  dom.dashboardStatsContent.innerHTML = `
    <div class="dashboard-grid">
      <div class="stat-card">
        <div class="stat-label">Available Today</div>
        <div class="stat-value">${dashboardData.display}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Days Remaining</div>
        <div class="stat-value">${dashboardData.daysRemaining}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Requests Remaining</div>
        <div class="stat-value">${formatter.format(dashboardData.monthRemaining)}</div>
      </div>
    </div>
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

function applyAuthErrorFromQuery() {
  const url = new URL(window.location.href)
  const authError = url.searchParams.get('authError')
  const hasAuthError = typeof authError === 'string' && authError.length > 0

  if (!hasAuthError) {
    return
  }

  showStatus('Twitch login failed. Please try again.', 'error')
  url.searchParams.delete('authError')
  window.history.replaceState({}, '', url.toString())
}

function applyGitHubAuthFeedbackFromQuery() {
  const url = new URL(window.location.href)
  const githubAuth = url.searchParams.get('githubAuth')
  const githubAuthError = url.searchParams.get('githubAuthError')
  const hasGitHubAuth = typeof githubAuth === 'string' && githubAuth.length > 0
  const hasGitHubAuthError = typeof githubAuthError === 'string' && githubAuthError.length > 0

  if (!hasGitHubAuth && !hasGitHubAuthError) {
    return
  }

  if (githubAuth === 'connected') {
    showStatus('GitHub connected.', 'success')
  } else if (githubAuthError === 'cancelled') {
    showStatus('GitHub connection was cancelled.', 'error')
  } else if (githubAuthError === 'state') {
    showStatus('GitHub OAuth state check failed. Try again.', 'error')
  } else if (githubAuthError === 'session_expired') {
    showStatus('Session expired during GitHub connect. Sign in again.', 'error')
  } else {
    showStatus('GitHub connection failed. Try again.', 'error')
  }

  url.searchParams.delete('githubAuth')
  url.searchParams.delete('githubAuthError')
  window.history.replaceState({}, '', url.toString())
}

function applyViewTransition(fn) {
  if (document.startViewTransition) {
    document.startViewTransition(fn)
  } else {
    fn()
  }
}

async function loadMe() {
  hideStatus()

  try {
    const me = await fetchJson('/api/me')

    applyViewTransition(() => {
      dom.loadingBlock.classList.add('hidden')
      setAuthorized(true)
      dom.subtitle.textContent = `Signed in as ${me.user.displayName} (@${me.user.login})`
      setObsUrl(me.obsUrl)
      renderDashboardStats(me.dashboardData)
      state.me = {
        githubAuthStatus:
          me.githubAuthStatus === 'reconnect_required' ? 'reconnect_required' : (
            me.githubAuthStatus === 'connected' ? 'connected' : 'missing'
          ),
        githubConnected: Boolean(me.githubConnected),
        githubLogin: typeof me.githubLogin === 'string' ? me.githubLogin : null,
        monthlyQuota: typeof me.monthlyQuota === 'number' ? me.monthlyQuota : null,
        obsTitle: typeof me.obsTitle === 'string' ? me.obsTitle : ''
      }
      dom.quotaInput.value = state.me.monthlyQuota === null ? '' : String(state.me.monthlyQuota)
      dom.obsTitleInput.value = state.me.obsTitle
      renderGitHubConnection()
    })
  } catch {
    applyViewTransition(() => {
      dom.loadingBlock.classList.add('hidden')
      state.me = null
      state.obsUrl = ''
      setAuthorized(false)
      dom.subtitle.textContent = 'Sign in with Twitch to manage your OBS widget settings.'
      renderDashboardStats(null)
      renderGitHubConnection()
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

function connectGitHub() {
  if (!state.me) {
    return
  }

  window.location.href = '/api/auth/github/login'
}

async function disconnectGitHub() {
  if (!state.me) {
    return
  }

  setButtonDisabled(dom.githubConnectButton, true)
  setButtonDisabled(dom.githubReconnectButton, true)
  setButtonDisabled(dom.githubDisconnectButton, true)

  try {
    await fetchJson('/api/auth/github/disconnect', {
      method: 'POST'
    })
    updateLocalProfile({
      githubAuthStatus: 'missing',
      githubConnected: false,
      githubLogin: null
    })
    renderGitHubConnection()
    renderDashboardStats(null)
    hideStatus()
    showStatus('GitHub disconnected.', 'success')
  } catch (error) {
    const hasError = error instanceof Error
    const message = hasError ? error.message : 'Failed to disconnect GitHub'

    showStatus(message, 'error')
  } finally {
    setButtonDisabled(dom.githubConnectButton, false)
    setButtonDisabled(dom.githubReconnectButton, false)
    setButtonDisabled(dom.githubDisconnectButton, false)
  }
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
  dom.githubConnectButton.addEventListener('click', connectGitHub)
  dom.githubReconnectButton.addEventListener('click', connectGitHub)
  dom.githubDisconnectButton.addEventListener('click', () => {
    void disconnectGitHub()
  })
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
  renderGitHubConnection()
  await loadMe()
  applyAuthErrorFromQuery()
  applyGitHubAuthFeedbackFromQuery()
}

void bootstrap()
