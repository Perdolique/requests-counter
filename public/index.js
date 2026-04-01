const dom = {
  availableTodayAlgorithmDefaultBadge: document.querySelector('#availableTodayAlgorithmDefaultBadge'),
  availableTodayAlgorithmDescription: document.querySelector('#availableTodayAlgorithmDescription'),
  availableTodayAlgorithmDialog: document.querySelector('#availableTodayAlgorithmDialog'),
  availableTodayAlgorithmDialogList: document.querySelector('#availableTodayAlgorithmDialogList'),
  availableTodayAlgorithmName: document.querySelector('#availableTodayAlgorithmName'),
  availableTodayAlgorithmSection: document.querySelector('#availableTodayAlgorithmSection'),
  authHealthBlock: document.querySelector('#authHealthBlock'),
  authHealthMessage: document.querySelector('#authHealthMessage'),
  authReconnectButton: document.querySelector('#authReconnectButton'),
  authorizedBlock: document.querySelector('#authorizedBlock'),
  budgetInput: document.querySelector('#budgetInput'),
  changeAvailableTodayAlgorithmButton: document.querySelector('#changeAvailableTodayAlgorithmButton'),
  closeAvailableTodayAlgorithmDialogButton: document.querySelector('#closeAvailableTodayAlgorithmDialogButton'),
  copyObsButton: document.querySelector('#copyObsButton'),
  dashboardStats: document.querySelector('#dashboardStats'),
  dashboardStatsContent: document.querySelector('#dashboardStatsContent'),
  deleteAccountButton: document.querySelector('#deleteAccountButton'),
  loadingBlock: document.querySelector('#loadingBlock'),
  logoutButton: document.querySelector('#logoutButton'),
  obsUrl: document.querySelector('#obsUrl'),
  obsTitleInput: document.querySelector('#obsTitleInput'),
  quotaSummary: document.querySelector('#quotaSummary'),
  regenerateButton: document.querySelector('#regenerateButton'),
  savePopover: document.querySelector('#savePopover'),
  statusBox: document.querySelector('#statusBox'),
  subscriptionPlanSelect: document.querySelector('#subscriptionPlanSelect'),
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
const MODEL_USAGE_VIEW_STORAGE_KEY = 'requests-counter:model-usage-view'
const SUBSCRIPTION_PLAN_PRO = 'pro'
const SUBSCRIPTION_PLAN_PRO_PLUS = 'pro_plus'
const MODEL_USAGE_PERIOD_MONTH = 'month'
const MODEL_USAGE_PERIOD_YESTERDAY = 'yesterday'
const MODEL_USAGE_PERIOD_TODAY = 'today'
const MODEL_USAGE_PERIOD_STORAGE_KEY = 'requests-counter:model-usage-period'
const AUTO_MODEL_PREFIX = 'Auto:'
const PREMIUM_REQUEST_PRICE_CENTS = 4
const OTHERS_MODEL_NAMES = new Set([
  'Coding Agent model',
  'Code Review model'
])

const state = {
  /** @type {{
    availableTodayAlgorithmId: string;
    availableTodayAlgorithms: Array<{
      description: string;
      examples: string[];
      explanation: string;
      id: string;
      isDefault: boolean;
      name: string;
    }>;
    budgetCents: number;
    budgetRequestQuota: number;
    githubAuthStatus: 'missing' | 'connected' | 'reconnect_required';
    obsTitle: string;
    planQuota: number;
    quotaBreakdown: {
      budgetRemaining: number;
      budgetRequestQuota: number;
      configuredTotal: number;
      planQuota: number;
      planRemaining: number;
      totalRemaining: number;
    };
    subscriptionPlan: 'pro' | 'pro_plus';
  } | null} */
  me: null,
  dashboardData: null,
  modelUsagePeriod: MODEL_USAGE_PERIOD_MONTH,
  modelUsageView: MODEL_USAGE_VIEW_ALL,
  obsUrl: '',
  debounceTimerIds: {
    quotaSettings: 0,
    obsTitle: 0
  },
  savePopoverTimerId: 0,
  saving: {
    availableTodayAlgorithm: false,
    quotaSettings: false,
    obsTitle: false
  }
}

const MS_IN_DAY = 24 * 60 * 60 * 1000
const MS_IN_HOUR = 60 * 60 * 1000
const MS_IN_MINUTE = 60 * 1000
const MS_IN_SECOND = 1000

let timeRemainingIntervalId = 0

/**
 * @param {string} periodResetDateISO
 * @returns {{ value: string, label: string }}
 */
function formatTimeRemaining(periodResetDateISO) {
  const diffMs = new Date(periodResetDateISO).getTime() - Date.now()

  if (diffMs <= 0) {
    return { value: '0', label: 'Time Remaining' }
  }

  if (diffMs > MS_IN_DAY) {
    return { value: String(Math.floor(diffMs / MS_IN_DAY)), label: 'Days Remaining' }
  }

  if (diffMs > MS_IN_HOUR) {
    return { value: String(Math.floor(diffMs / MS_IN_HOUR)), label: 'Hours Remaining' }
  }

  if (diffMs > MS_IN_MINUTE) {
    return { value: String(Math.floor(diffMs / MS_IN_MINUTE)), label: 'Minutes Remaining' }
  }

  return { value: String(Math.floor(diffMs / MS_IN_SECOND)).padStart(2, '0'), label: 'Seconds Remaining' }
}

function updateTimeRemainingDisplay() {
  const periodResetDate = state.dashboardData ? state.dashboardData.periodResetDate : null

  if (!periodResetDate) {
    return
  }

  const valueEl = document.getElementById('timeRemainingValue')
  const labelEl = document.getElementById('timeRemainingLabel')

  if (!valueEl || !labelEl) {
    return
  }

  const { value, label } = formatTimeRemaining(periodResetDate)

  valueEl.textContent = value
  labelEl.textContent = label
}

function startTimeRemainingTimer() {
  if (timeRemainingIntervalId) {
    clearInterval(timeRemainingIntervalId)
  }

  timeRemainingIntervalId = setInterval(updateTimeRemainingDisplay, MS_IN_SECOND)
}

function stopTimeRemainingTimer() {
  if (timeRemainingIntervalId) {
    clearInterval(timeRemainingIntervalId)
    timeRemainingIntervalId = 0
  }
}

function isKnownModelUsageView(value) {
  return value === MODEL_USAGE_VIEW_ALL || value === MODEL_USAGE_VIEW_GROUPED
}

function isKnownModelUsagePeriod(value) {
  return value === MODEL_USAGE_PERIOD_MONTH
    || value === MODEL_USAGE_PERIOD_YESTERDAY
    || value === MODEL_USAGE_PERIOD_TODAY
}

function isKnownSubscriptionPlan(value) {
  return value === SUBSCRIPTION_PLAN_PRO || value === SUBSCRIPTION_PLAN_PRO_PLUS
}

function isRecord(value) {
  const isObject = typeof value === 'object' && value !== null && !Array.isArray(value)

  return isObject
}

function loadStoredModelUsageView() {
  try {
    const storedView = window.localStorage.getItem(MODEL_USAGE_VIEW_STORAGE_KEY)

    if (isKnownModelUsageView(storedView)) {
      return storedView
    }
  } catch {
    // Ignore browser storage restrictions and fall back to default view.
  }

  return MODEL_USAGE_VIEW_ALL
}

function saveStoredModelUsageView(view) {
  if (!isKnownModelUsageView(view)) {
    return
  }

  try {
    window.localStorage.setItem(MODEL_USAGE_VIEW_STORAGE_KEY, view)
  } catch {
    // Ignore browser storage restrictions and keep in-memory state only.
  }
}

function loadStoredModelUsagePeriod() {
  try {
    const storedPeriod = window.localStorage.getItem(MODEL_USAGE_PERIOD_STORAGE_KEY)

    if (isKnownModelUsagePeriod(storedPeriod)) {
      return storedPeriod
    }
  } catch {
    // Ignore browser storage restrictions and fall back to default period.
  }

  return MODEL_USAGE_PERIOD_MONTH
}

function saveStoredModelUsagePeriod(period) {
  if (!isKnownModelUsagePeriod(period)) {
    return
  }

  try {
    window.localStorage.setItem(MODEL_USAGE_PERIOD_STORAGE_KEY, period)
  } catch {
    // Ignore browser storage restrictions and keep in-memory state only.
  }
}

function getPlanQuotaForSubscriptionPlan(subscriptionPlan) {
  if (subscriptionPlan === SUBSCRIPTION_PLAN_PRO_PLUS) {
    return 1500
  }

  return 300
}

function getBudgetRequestQuotaFromCents(budgetCents) {
  const safeBudgetCents = Number.isFinite(budgetCents) ? Math.max(0, Math.floor(budgetCents)) : 0

  return Math.floor(safeBudgetCents / PREMIUM_REQUEST_PRICE_CENTS)
}

function formatBudgetInputValue(budgetCents) {
  const safeBudgetCents = Number.isFinite(budgetCents) ? Math.max(0, Math.floor(budgetCents)) : 0
  const dollars = safeBudgetCents / 100

  return dollars.toFixed(2)
}

function formatBudgetDisplayValue(budgetCents) {
  const dollars = (Number.isFinite(budgetCents) ? Math.max(0, Math.floor(budgetCents)) : 0) / 100
  const formatter = new Intl.NumberFormat('en-US', {
    currency: 'USD',
    minimumFractionDigits: 2,
    style: 'currency'
  })

  return formatter.format(dollars)
}

function formatRequestsValue(value) {
  const formatter = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2
  })

  return formatter.format(value)
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function parseAvailableTodayAlgorithm(value) {
  const isObject = isRecord(value)

  if (!isObject) {
    return null
  }

  const id = typeof value.id === 'string' ? value.id : ''
  const name = typeof value.name === 'string' ? value.name : ''
  const description = typeof value.description === 'string' ? value.description : ''
  const explanation = typeof value.explanation === 'string' ? value.explanation : ''
  const isDefault = value.isDefault === true
  const rawExamples = Array.isArray(value.examples) ? value.examples : []
  const examples = rawExamples.filter((example) => typeof example === 'string' && example.length > 0)
  const hasRequiredFields = id.length > 0
    && name.length > 0
    && description.length > 0
    && explanation.length > 0
    && examples.length > 0

  if (!hasRequiredFields) {
    return null
  }

  return {
    description,
    examples,
    explanation,
    id,
    isDefault,
    name
  }
}

function parseAvailableTodayAlgorithms(value) {
  const isArray = Array.isArray(value)

  if (!isArray) {
    return []
  }

  const output = []

  for (const item of value) {
    const algorithm = parseAvailableTodayAlgorithm(item)

    if (!algorithm) {
      continue
    }

    output.push(algorithm)
  }

  return output
}

function getDefaultAvailableTodayAlgorithm(algorithms) {
  const defaultAlgorithm = algorithms.find((algorithm) => algorithm.isDefault)

  if (defaultAlgorithm) {
    return defaultAlgorithm
  }

  return algorithms[0] ?? null
}

function getActiveAvailableTodayAlgorithm() {
  if (!state.me) {
    return null
  }

  const currentAlgorithm = state.me.availableTodayAlgorithms.find(
    (algorithm) => algorithm.id === state.me.availableTodayAlgorithmId
  )

  if (currentAlgorithm) {
    return currentAlgorithm
  }

  return getDefaultAvailableTodayAlgorithm(state.me.availableTodayAlgorithms)
}

function parseBudgetCents(rawValue) {
  const normalized = typeof rawValue === 'string' ? rawValue.trim() : ''
  const hasValue = normalized.length > 0

  if (!hasValue) {
    return 0
  }

  const isValidFormat = /^\d+(\.\d{0,2})?$/.test(normalized)

  if (!isValidFormat) {
    return null
  }

  const parts = normalized.split('.')
  const wholePart = Number.parseInt(parts[0], 10)
  const fractionalPartRaw = parts[1] ?? ''
  const fractionalPart = Number.parseInt(fractionalPartRaw.padEnd(2, '0'), 10)
  const safeFractionalPart = Number.isInteger(fractionalPart) ? fractionalPart : 0
  const totalCents = wholePart * 100 + safeFractionalPart
  const isValidTotal = Number.isInteger(totalCents) && totalCents >= 0 && totalCents <= 1_000_000_000

  if (!isValidTotal) {
    return null
  }

  return totalCents
}

function parseQuotaBreakdown(rawValue) {
  const isObject = typeof rawValue === 'object' && rawValue !== null

  if (!isObject) {
    return null
  }

  const value = rawValue
  const fields = [
    'budgetRemaining',
    'budgetRequestQuota',
    'configuredTotal',
    'planQuota',
    'planRemaining',
    'totalRemaining'
  ]

  for (const field of fields) {
    const fieldValue = value[field]
    const hasValidField = typeof fieldValue === 'number' && Number.isFinite(fieldValue)

    if (!hasValidField) {
      return null
    }
  }

  return {
    budgetRemaining: value.budgetRemaining,
    budgetRequestQuota: value.budgetRequestQuota,
    configuredTotal: value.configuredTotal,
    planQuota: value.planQuota,
    planRemaining: value.planRemaining,
    totalRemaining: value.totalRemaining
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

function parseModelUsageByPeriod(rawValue) {
  const hasRawValue = typeof rawValue === 'object' && rawValue !== null
  const value = hasRawValue ? rawValue : {}

  return {
    month: parseMonthlyUsageByModel(value.month),
    yesterday: parseMonthlyUsageByModel(value.yesterday),
    today: parseMonthlyUsageByModel(value.today)
  }
}

function buildModelUsageToggleButtonHtml(label, value, activeValue, dataAttributeName) {
  const isActive = value === activeValue
  const activeClassName = isActive ? ' is-active' : ''
  const ariaPressed = isActive ? 'true' : 'false'

  return `
    <button
      type="button"
      class="model-usage-toggle${activeClassName}"
      ${dataAttributeName}="${value}"
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

function buildUsageByModelHtml(modelUsageByPeriod, formatter, view, period) {
  const hasAnyItems = modelUsageByPeriod.month.length > 0
    || modelUsageByPeriod.yesterday.length > 0
    || modelUsageByPeriod.today.length > 0

  if (!hasAnyItems) {
    return ''
  }

  const activePeriod = isKnownModelUsagePeriod(period)
    ? period
    : MODEL_USAGE_PERIOD_MONTH
  const activeView = view === MODEL_USAGE_VIEW_GROUPED
    ? MODEL_USAGE_VIEW_GROUPED
    : MODEL_USAGE_VIEW_ALL
  const items = modelUsageByPeriod[activePeriod]
  const periodControlsHtml = `
    <div class="model-usage-controls" role="group" aria-label="Usage by model period">
      ${buildModelUsageToggleButtonHtml('Month', MODEL_USAGE_PERIOD_MONTH, activePeriod, 'data-model-usage-period')}
      ${buildModelUsageToggleButtonHtml('Yesterday', MODEL_USAGE_PERIOD_YESTERDAY, activePeriod, 'data-model-usage-period')}
      ${buildModelUsageToggleButtonHtml('Today', MODEL_USAGE_PERIOD_TODAY, activePeriod, 'data-model-usage-period')}
    </div>
  `
  const viewControlsHtml = `
    <div class="model-usage-controls" role="group" aria-label="Usage by model view">
      ${buildModelUsageToggleButtonHtml('All Models', MODEL_USAGE_VIEW_ALL, activeView, 'data-model-usage-view')}
      ${buildModelUsageToggleButtonHtml('Grouped', MODEL_USAGE_VIEW_GROUPED, activeView, 'data-model-usage-view')}
    </div>
  `
  let bodyHtml = '<div class="model-usage-empty">No data</div>'

  if (items.length > 0) {
    bodyHtml = activeView === MODEL_USAGE_VIEW_GROUPED
      ? `<div class="model-usage-groups">${buildGroupedMonthlyUsageByModelHtml(items, formatter)}</div>`
      : buildModelUsageListHtml(items, formatter)
  }

  return `
    <div class="model-usage-section">
      <div class="model-usage-header">
        <div class="model-usage-title">Usage by Model</div>
        <div class="model-usage-toolbar">
          ${periodControlsHtml}
          ${viewControlsHtml}
        </div>
      </div>
      ${bodyHtml}
    </div>
  `
}

function renderQuotaSummary() {
  const hasProfile = state.me !== null

  if (!(dom.quotaSummary instanceof HTMLElement)) {
    return
  }

  if (!hasProfile) {
    dom.quotaSummary.innerHTML = ''
    return
  }

  const quotaBreakdown = state.me.quotaBreakdown
  const budgetValue = `${formatBudgetDisplayValue(state.me.budgetCents)} -> ${formatRequestsValue(state.me.budgetRequestQuota)} requests`

  dom.quotaSummary.innerHTML = `
    <div class="quota-summary-card">
      <div class="quota-summary-label">Plan Quota</div>
      <div class="quota-summary-value">${formatRequestsValue(state.me.planQuota)}</div>
    </div>
    <div class="quota-summary-card">
      <div class="quota-summary-label">Budget Requests</div>
      <div class="quota-summary-value">${formatRequestsValue(state.me.budgetRequestQuota)}</div>
      <div class="inline-hint">${budgetValue}</div>
    </div>
    <div class="quota-summary-card">
      <div class="quota-summary-label">Configured Total</div>
      <div class="quota-summary-value">${formatRequestsValue(quotaBreakdown.configuredTotal)}</div>
      <div class="inline-hint">Plan remaining: ${formatRequestsValue(quotaBreakdown.planRemaining)}</div>
      <div class="inline-hint">Budget remaining: ${formatRequestsValue(quotaBreakdown.budgetRemaining)}</div>
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
  stopTimeRemainingTimer()

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
  const modelUsageFormatter = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2
  })
  const quotaBreakdown = state.me ? state.me.quotaBreakdown : null
  const availableTodayValue = dashboardData.display
  const timeRemaining = dashboardData.periodResetDate
    ? formatTimeRemaining(dashboardData.periodResetDate)
    : { value: String(dashboardData.daysRemaining), label: 'Days Remaining' }
  const totalRemainingValue = formatter.format(
    quotaBreakdown ? quotaBreakdown.totalRemaining : dashboardData.monthRemaining
  )
  const planRemainingValue = formatter.format(quotaBreakdown ? quotaBreakdown.planRemaining : 0)
  const budgetRemainingValue = formatter.format(quotaBreakdown ? quotaBreakdown.budgetRemaining : 0)
  const modelUsageByPeriod = parseModelUsageByPeriod(dashboardData.modelUsageByPeriod)
  const usageByModelHtml = buildUsageByModelHtml(
    modelUsageByPeriod,
    modelUsageFormatter,
    state.modelUsageView,
    state.modelUsagePeriod
  )

  dom.dashboardStatsContent.innerHTML = `
    <div class="dashboard-grid">
      <div class="stat-card">
        <div class="stat-label">Available Today</div>
        <div class="stat-value">${availableTodayValue}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label" id="timeRemainingLabel">${timeRemaining.label}</div>
        <div class="stat-value" id="timeRemainingValue">${timeRemaining.value}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Plan Remaining</div>
        <div class="stat-value">${planRemainingValue}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Budget Remaining</div>
        <div class="stat-value">${budgetRemainingValue}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Remaining</div>
        <div class="stat-value">${totalRemainingValue}</div>
      </div>
    </div>
    ${usageByModelHtml}
  `

  if (dashboardData.periodResetDate) {
    startTimeRemainingTimer()
  }
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

function syncQuotaSettingsForm() {
  if (!state.me) {
    return
  }

  dom.subscriptionPlanSelect.value = state.me.subscriptionPlan
  dom.budgetInput.value = formatBudgetInputValue(state.me.budgetCents)
  renderQuotaSummary()
}

function parseProfilePayload(me) {
  const availableTodayAlgorithms = parseAvailableTodayAlgorithms(me.availableTodayAlgorithms)
  const defaultAvailableTodayAlgorithm = getDefaultAvailableTodayAlgorithm(availableTodayAlgorithms)
  const availableTodayAlgorithmId = typeof me.availableTodayAlgorithmId === 'string'
    ? me.availableTodayAlgorithmId
    : (defaultAvailableTodayAlgorithm ? defaultAvailableTodayAlgorithm.id : '')
  const subscriptionPlan = isKnownSubscriptionPlan(me.subscriptionPlan)
    ? me.subscriptionPlan
    : SUBSCRIPTION_PLAN_PRO
  const budgetCents = typeof me.budgetCents === 'number' && Number.isFinite(me.budgetCents)
    ? Math.max(0, Math.floor(me.budgetCents))
    : 0
  const planQuota = typeof me.planQuota === 'number' && Number.isFinite(me.planQuota)
    ? me.planQuota
    : getPlanQuotaForSubscriptionPlan(subscriptionPlan)
  const budgetRequestQuota = typeof me.budgetRequestQuota === 'number'
    && Number.isFinite(me.budgetRequestQuota)
    ? me.budgetRequestQuota
    : getBudgetRequestQuotaFromCents(budgetCents)
  const configuredTotal = planQuota + budgetRequestQuota
  const quotaBreakdown = parseQuotaBreakdown(me.quotaBreakdown) ?? {
    budgetRemaining: budgetRequestQuota,
    budgetRequestQuota,
    configuredTotal,
    planQuota,
    planRemaining: planQuota,
    totalRemaining: configuredTotal
  }

  return {
    availableTodayAlgorithmId,
    availableTodayAlgorithms,
    budgetCents,
    budgetRequestQuota,
    githubAuthStatus:
      me.githubAuthStatus === 'reconnect_required' ? 'reconnect_required' : (
        me.githubAuthStatus === 'connected' ? 'connected' : 'missing'
      ),
    obsTitle: typeof me.obsTitle === 'string' ? me.obsTitle : '',
    planQuota,
    quotaBreakdown,
    subscriptionPlan
  }
}

function closeAvailableTodayAlgorithmDialog() {
  const dialog = dom.availableTodayAlgorithmDialog
  const hasDialog = dialog instanceof HTMLDialogElement

  if (!hasDialog) {
    return
  }

  const isOpen = dialog.open

  if (isOpen) {
    dialog.close()
  }
}

function setAvailableTodayAlgorithmDialogBusy(isBusy) {
  if (dom.closeAvailableTodayAlgorithmDialogButton instanceof HTMLButtonElement) {
    dom.closeAvailableTodayAlgorithmDialogButton.disabled = isBusy
  }

  if (!(dom.availableTodayAlgorithmDialogList instanceof HTMLElement)) {
    return
  }

  const actionButtons = dom.availableTodayAlgorithmDialogList.querySelectorAll(
    'button[data-available-today-algorithm-id]'
  )

  for (const actionButton of actionButtons) {
    const isButton = actionButton instanceof HTMLButtonElement

    if (!isButton) {
      continue
    }

    actionButton.disabled = isBusy
  }
}

function renderAvailableTodayAlgorithmSummary() {
  if (!(dom.availableTodayAlgorithmSection instanceof HTMLElement)) {
    return
  }

  const activeAlgorithm = getActiveAvailableTodayAlgorithm()

  if (!activeAlgorithm) {
    dom.availableTodayAlgorithmSection.classList.add('hidden')
    return
  }

  dom.availableTodayAlgorithmSection.classList.remove('hidden')

  if (dom.availableTodayAlgorithmName instanceof HTMLElement) {
    dom.availableTodayAlgorithmName.textContent = activeAlgorithm.name
  }

  if (dom.availableTodayAlgorithmDescription instanceof HTMLElement) {
    dom.availableTodayAlgorithmDescription.textContent = activeAlgorithm.description
  }

  if (dom.availableTodayAlgorithmDefaultBadge instanceof HTMLElement) {
    dom.availableTodayAlgorithmDefaultBadge.classList.toggle('hidden', !activeAlgorithm.isDefault)
  }
}

function renderAvailableTodayAlgorithmDialog() {
  if (!(dom.availableTodayAlgorithmDialogList instanceof HTMLElement)) {
    return
  }

  if (!state.me || state.me.availableTodayAlgorithms.length === 0) {
    dom.availableTodayAlgorithmDialogList.innerHTML = ''
    return
  }

  const cards = state.me.availableTodayAlgorithms.map((algorithm) => {
    const isCurrent = algorithm.id === state.me.availableTodayAlgorithmId
    const badges = []

    if (isCurrent) {
      badges.push('<span class="algorithm-badge current">Current</span>')
    }

    if (algorithm.isDefault) {
      badges.push('<span class="algorithm-badge default">Default</span>')
    }

    const exampleItems = algorithm.examples.map((example) => {
      const escapedExample = escapeHtml(example)

      return `<li>${escapedExample}</li>`
    })
    const buttonClassName = isCurrent ? 'secondary' : ''
    const buttonClassAttribute = buttonClassName.length > 0 ? ` class="${buttonClassName}"` : ''

    return `
      <article class="algorithm-card">
        <div class="algorithm-card-content">
          <div class="algorithm-card-header">
            <div class="stack">
              <div class="algorithm-summary-title-row">
                <span class="algorithm-card-title">${escapeHtml(algorithm.name)}</span>
                ${badges.join('')}
              </div>
              <p class="algorithm-card-copy">${escapeHtml(algorithm.description)}</p>
            </div>
          </div>

          <div class="stack">
            <p class="algorithm-section-title">How it works</p>
            <p class="algorithm-card-copy">${escapeHtml(algorithm.explanation)}</p>
          </div>

          <div class="stack">
            <p class="algorithm-section-title">Examples</p>
            <ul class="algorithm-card-examples">${exampleItems.join('')}</ul>
          </div>
        </div>

        <div class="algorithm-card-actions">
          <button type="button"${buttonClassAttribute} data-available-today-algorithm-id="${escapeHtml(algorithm.id)}">Use algorithm</button>
        </div>
      </article>
    `
  })

  dom.availableTodayAlgorithmDialogList.innerHTML = cards.join('')
  setAvailableTodayAlgorithmDialogBusy(state.saving.availableTodayAlgorithm)
}

function openAvailableTodayAlgorithmDialog() {
  if (!state.me) {
    return
  }

  const dialog = dom.availableTodayAlgorithmDialog
  const hasDialog = dialog instanceof HTMLDialogElement

  if (!hasDialog) {
    return
  }

  renderAvailableTodayAlgorithmDialog()

  const isOpen = dialog.open

  if (!isOpen) {
    dialog.showModal()
  }
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

  const periodToggleButton = target.closest('[data-model-usage-period]')
  const hasPeriodToggleButton = periodToggleButton instanceof HTMLButtonElement

  if (hasPeriodToggleButton) {
    const nextPeriod = periodToggleButton.dataset.modelUsagePeriod
    const isKnownPeriod = isKnownModelUsagePeriod(nextPeriod)

    if (!isKnownPeriod || state.modelUsagePeriod === nextPeriod) {
      return
    }

    state.modelUsagePeriod = nextPeriod
    saveStoredModelUsagePeriod(nextPeriod)
    renderDashboardStats(state.dashboardData)
    return
  }

  const toggleButton = target.closest('[data-model-usage-view]')
  const hasToggleButton = toggleButton instanceof HTMLButtonElement

  if (!hasToggleButton) {
    return
  }

  const nextView = toggleButton.dataset.modelUsageView
  const isKnownView = isKnownModelUsageView(nextView)

  if (!isKnownView || state.modelUsageView === nextView) {
    return
  }

  state.modelUsageView = nextView
  saveStoredModelUsageView(nextView)
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
      state.me = parseProfilePayload(me)
      dom.obsTitleInput.value = state.me.obsTitle
      syncQuotaSettingsForm()
      renderAvailableTodayAlgorithmSummary()
      renderAvailableTodayAlgorithmDialog()
      renderDashboardStats(state.dashboardData)
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
      if (dom.quotaSummary instanceof HTMLElement) {
        dom.quotaSummary.innerHTML = ''
      }
      if (dom.availableTodayAlgorithmSection instanceof HTMLElement) {
        dom.availableTodayAlgorithmSection.classList.add('hidden')
      }
      closeAvailableTodayAlgorithmDialog()
      renderDashboardStats(null)
      renderAuthHealth()
    })
  }
}

async function saveAvailableTodayAlgorithm(algorithmId) {
  if (!state.me) {
    return
  }

  if (state.saving.availableTodayAlgorithm) {
    return
  }

  state.saving.availableTodayAlgorithm = true
  setAvailableTodayAlgorithmDialogBusy(true)

  try {
    await fetchJson('/api/settings', {
      body: JSON.stringify({
        availableTodayAlgorithmId: algorithmId
      }),
      headers: {
        'Content-Type': 'application/json'
      },
      method: 'PUT'
    })

    closeAvailableTodayAlgorithmDialog()
    await loadMe()
    hideStatus()
    showSavePopover('Algorithm saved', dom.changeAvailableTodayAlgorithmButton)
  } catch (error) {
    const hasError = error instanceof Error
    const message = hasError ? error.message : 'Failed to save algorithm'

    showStatus(message, 'error')
  } finally {
    state.saving.availableTodayAlgorithm = false
    setAvailableTodayAlgorithmDialogBusy(false)
  }
}

async function saveQuotaSettings() {
  if (!state.me) {
    return
  }

  if (state.saving.quotaSettings) {
    scheduleDebouncedSave('quotaSettings', saveQuotaSettings, 250)
    return
  }

  const rawBudgetValue = dom.budgetInput.value
  const budgetCents = parseBudgetCents(rawBudgetValue)

  if (budgetCents === null) {
    showStatus('Budget must be a non-negative USD amount with up to 2 decimals.', 'error')
    syncQuotaSettingsForm()
    return
  }

  const subscriptionPlanValue = dom.subscriptionPlanSelect.value
  const subscriptionPlan = isKnownSubscriptionPlan(subscriptionPlanValue)
    ? subscriptionPlanValue
    : state.me.subscriptionPlan
  const hasChanges = subscriptionPlan !== state.me.subscriptionPlan
    || budgetCents !== state.me.budgetCents

  if (!hasChanges) {
    return
  }

  state.saving.quotaSettings = true

  try {
    await fetchJson('/api/settings', {
      body: JSON.stringify({
        budgetCents,
        subscriptionPlan
      }),
      headers: {
        'Content-Type': 'application/json'
      },
      method: 'PUT'
    })

    await loadMe()
    hideStatus()
    showSavePopover('Quota settings saved', dom.subscriptionPlanSelect)
  } catch (error) {
    const hasError = error instanceof Error
    const message = hasError ? error.message : 'Failed to save quota settings'

    showStatus(message, 'error')
    syncQuotaSettingsForm()
  } finally {
    state.saving.quotaSettings = false
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
  dom.changeAvailableTodayAlgorithmButton.addEventListener('click', openAvailableTodayAlgorithmDialog)
  dom.closeAvailableTodayAlgorithmDialogButton.addEventListener('click', closeAvailableTodayAlgorithmDialog)
  dom.dashboardStatsContent.addEventListener('click', handleDashboardStatsContentClick)
  dom.availableTodayAlgorithmDialog.addEventListener('click', (event) => {
    const target = event.target
    const isDialogClick = target === dom.availableTodayAlgorithmDialog

    if (isDialogClick) {
      closeAvailableTodayAlgorithmDialog()
    }
  })
  dom.availableTodayAlgorithmDialogList.addEventListener('click', (event) => {
    const target = event.target
    const hasElementTarget = target instanceof Element

    if (!hasElementTarget) {
      return
    }

    const algorithmButton = target.closest('[data-available-today-algorithm-id]')
    const hasAlgorithmButton = algorithmButton instanceof HTMLButtonElement

    if (!hasAlgorithmButton) {
      return
    }

    const algorithmId = algorithmButton.dataset.availableTodayAlgorithmId
    const hasAlgorithmId = typeof algorithmId === 'string' && algorithmId.length > 0

    if (!hasAlgorithmId) {
      return
    }

    void saveAvailableTodayAlgorithm(algorithmId)
  })
  dom.subscriptionPlanSelect.addEventListener('change', () => {
    scheduleDebouncedSave('quotaSettings', saveQuotaSettings, 150)
  })
  dom.budgetInput.addEventListener('input', () => {
    scheduleDebouncedSave('quotaSettings', saveQuotaSettings)
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
  state.modelUsagePeriod = loadStoredModelUsagePeriod()
  state.modelUsageView = loadStoredModelUsageView()
  bindEvents()
  renderAuthHealth()
  await loadMe()
  applyAuthFeedbackFromQuery()
}

void bootstrap()
