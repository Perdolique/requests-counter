const FALLBACK_VALUE = '¯\\_(ツ)_/¯'
const REFRESH_INTERVAL_MS = 60_000
const DEFAULT_TITLE = 'Copilot premium requests available today'
const NO_USAGE_DISPLAY_PLACEHOLDER = 'No data'
const PROGRESS_BLUE_COLOR = '#60a5fa'
const PROGRESS_YELLOW_COLOR = '#facc15'
const PROGRESS_RED_COLOR = '#f87171'
const WIDGET_INTEGER_FORMATTER = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0
})

const titleNode = typeof document === 'undefined' ? null : document.querySelector('#title')
const valueNode = typeof document === 'undefined' ? null : document.querySelector('#value')
const secondaryValueNode = typeof document === 'undefined' ? null : document.querySelector('#secondaryValue')
const progressFillNode = typeof document === 'undefined' ? null : document.querySelector('#progressFill')
const periodProgressFillNode =
  typeof document === 'undefined' ? null : document.querySelector('#periodProgressFill')

function clamp(value, min, max) {
  const clamped = Math.min(max, Math.max(min, value))

  return clamped
}

function setProgressFill(fillPercent, color) {
  if (!progressFillNode) {
    return
  }

  const safeFillPercent = clamp(fillPercent, 0, 100)

  progressFillNode.style.width = `${safeFillPercent}%`
  progressFillNode.style.backgroundColor = color
}

function setPeriodProgressFill(fillPercent, color) {
  if (!periodProgressFillNode) {
    return
  }

  const safeFillPercent = clamp(fillPercent, 0, 100)

  periodProgressFillNode.style.width = `${safeFillPercent}%`
  periodProgressFillNode.style.backgroundColor = color
}

function resetProgress() {
  setProgressFill(0, PROGRESS_BLUE_COLOR)
}

function resetPeriodProgress() {
  setPeriodProgressFill(0, PROGRESS_BLUE_COLOR)
}

function getProgressFillColor(fillPercent) {
  if (fillPercent >= 90) {
    return PROGRESS_RED_COLOR
  }

  if (fillPercent >= 75) {
    return PROGRESS_YELLOW_COLOR
  }

  return PROGRESS_BLUE_COLOR
}

function getProgressFillPercent(todayAvailable, dailyTarget) {
  const hasTodayAvailable = typeof todayAvailable === 'number' && Number.isFinite(todayAvailable)
  const hasDailyTarget = typeof dailyTarget === 'number' && Number.isFinite(dailyTarget)

  if (!hasTodayAvailable || !hasDailyTarget) {
    return null
  }

  const isZeroBudgetAndZeroAvailable = dailyTarget === 0 && todayAvailable === 0

  if (isZeroBudgetAndZeroAvailable) {
    return 100
  }

  if (dailyTarget <= 0) {
    return null
  }

  const remainingRatio = todayAvailable / dailyTarget
  const fillRatio = clamp(1 - remainingRatio, 0, 1)

  return fillRatio * 100
}

function updateProgress(todayAvailable, dailyTarget) {
  const fillPercent = getProgressFillPercent(todayAvailable, dailyTarget)

  if (fillPercent === null) {
    resetProgress()
    return
  }

  const color = getProgressFillColor(fillPercent)

  setProgressFill(fillPercent, color)
}

function getPeriodFillPercent(monthRemaining, configuredTotal) {
  const hasMonthRemaining = typeof monthRemaining === 'number' && Number.isFinite(monthRemaining)
  const hasConfiguredTotal = typeof configuredTotal === 'number' && Number.isFinite(configuredTotal)

  if (!hasMonthRemaining || !hasConfiguredTotal) {
    return null
  }

  const isZeroTotal = configuredTotal === 0

  if (isZeroTotal) {
    return 100
  }

  if (configuredTotal < 0) {
    return null
  }

  const monthUsed = configuredTotal - monthRemaining
  const fillRatio = clamp(monthUsed / configuredTotal, 0, 1)

  return fillRatio * 100
}

function updatePeriodProgress(monthRemaining, configuredTotal) {
  const fillPercent = getPeriodFillPercent(monthRemaining, configuredTotal)

  if (fillPercent === null) {
    resetPeriodProgress()
    return
  }

  const color = getProgressFillColor(fillPercent)

  setPeriodProgressFill(fillPercent, color)
}

function normalizeNegativeZero(value) {
  const isNegativeZero = Object.is(value, -0)

  if (isNegativeZero) {
    return 0
  }

  return value
}

function isFiniteNumber(value) {
  const isNumber = typeof value === 'number'

  return isNumber && Number.isFinite(value)
}

function formatWidgetDisplayValue(rawTodayAvailable, rawDailyTarget) {
  const hasTodayAvailable = isFiniteNumber(rawTodayAvailable)
  const hasDailyTarget = isFiniteNumber(rawDailyTarget)

  if (!hasTodayAvailable || !hasDailyTarget) {
    return null
  }

  const todayAvailable = normalizeNegativeZero(rawTodayAvailable)
  const dailyTarget = Math.max(0, rawDailyTarget)
  const left = WIDGET_INTEGER_FORMATTER.format(todayAvailable)
  const right = WIDGET_INTEGER_FORMATTER.format(dailyTarget)

  return `${left}/${right}`
}

function shouldUseHardPaceAsPrimary(data) {
  const hasDailyTarget = isFiniteNumber(data.dailyTarget)
  const hasHardPaceDailyTarget = isFiniteNumber(data.hardPaceDailyTarget)
  const hasHardPaceTodayAvailable = isFiniteNumber(data.hardPaceTodayAvailable)

  if (!hasDailyTarget || !hasHardPaceDailyTarget || !hasHardPaceTodayAvailable) {
    return false
  }

  return data.hardPaceDailyTarget > data.dailyTarget
}

export function getWidgetRenderState(data) {
  const hasHardPaceDisplay = typeof data.hardPaceDisplay === 'string'
    && data.hardPaceDisplay.length > 0
  const useHardPaceAsPrimary = shouldUseHardPaceAsPrimary(data)
  const primaryTodayAvailable = useHardPaceAsPrimary
    ? data.hardPaceTodayAvailable
    : data.todayAvailable
  const primaryDailyTarget = useHardPaceAsPrimary
    ? data.hardPaceDailyTarget
    : data.dailyTarget
  const formattedPrimaryDisplayValue =
    formatWidgetDisplayValue(primaryTodayAvailable, primaryDailyTarget)
  const secondaryValue = useHardPaceAsPrimary
    ? ''
    : (hasHardPaceDisplay ? `Hard pace: ${data.hardPaceDisplay}` : '')
  const periodCurrentValue = useHardPaceAsPrimary || !hasHardPaceDisplay
    ? data.monthRemaining
    : data.hardPaceTodayAvailable
  const periodMaxValue = useHardPaceAsPrimary || !hasHardPaceDisplay
    ? data.configuredTotal
    : data.hardPaceDailyTarget

  return {
    displayValue: formattedPrimaryDisplayValue ?? data.display,
    periodCurrentValue,
    periodMaxValue,
    primaryDailyTarget,
    primaryTodayAvailable,
    secondaryValue,
    useHardPaceAsPrimary
  }
}

function setSecondaryValue(value) {
  const hasSecondaryValue = typeof value === 'string' && value.length > 0

  if (!secondaryValueNode) {
    return
  }

  secondaryValueNode.textContent = hasSecondaryValue ? value : ''
  secondaryValueNode.classList.toggle('hidden', !hasSecondaryValue)
}

function setError(message) {
  titleNode.textContent = DEFAULT_TITLE
  valueNode.textContent = FALLBACK_VALUE
  setSecondaryValue('')
  resetProgress()
  resetPeriodProgress()
}

function parseObsPayload(payload) {
  const isObject = typeof payload === 'object' && payload !== null

  if (!isObject) {
    throw new Error('Invalid payload')
  }

  const output = /** @type {{
    configuredTotal?: unknown;
    display?: unknown;
    dailyTarget?: unknown;
    hasUsageData?: unknown;
    hardPaceDailyTarget?: unknown;
    hardPaceDisplay?: unknown;
    hardPaceTodayAvailable?: unknown;
    monthRemaining?: unknown;
    tokenBucketCapacity?: unknown;
    tokenBucketDailyRefill?: unknown;
    title?: unknown;
    todayAvailable?: unknown;
  }} */ (payload)
  const hasDisplay = typeof output.display === 'string' && output.display.length > 0
  const hasTitle = typeof output.title === 'string' && output.title.length > 0

  if (!hasDisplay || !hasTitle) {
    throw new Error('Payload fields are missing')
  }

  const hasUsageData = typeof output.hasUsageData === 'boolean' ? output.hasUsageData : true
  const hasTodayAvailable = typeof output.todayAvailable === 'number'
    && Number.isFinite(output.todayAvailable)
  const hasDailyTarget = typeof output.dailyTarget === 'number'
    && Number.isFinite(output.dailyTarget)
  const hasHardPaceDisplay = typeof output.hardPaceDisplay === 'string'
    && output.hardPaceDisplay.length > 0
  const hasHardPaceTodayAvailable = typeof output.hardPaceTodayAvailable === 'number'
    && Number.isFinite(output.hardPaceTodayAvailable)
  const hasHardPaceDailyTarget = typeof output.hardPaceDailyTarget === 'number'
    && Number.isFinite(output.hardPaceDailyTarget)
  const hasConfiguredTotal = typeof output.configuredTotal === 'number'
    && Number.isFinite(output.configuredTotal)
  const hasMonthRemaining = typeof output.monthRemaining === 'number'
    && Number.isFinite(output.monthRemaining)
  const hasTokenBucketCapacity = typeof output.tokenBucketCapacity === 'number'
    && Number.isFinite(output.tokenBucketCapacity)
  const hasTokenBucketDailyRefill = typeof output.tokenBucketDailyRefill === 'number'
    && Number.isFinite(output.tokenBucketDailyRefill)

  return {
    configuredTotal: hasConfiguredTotal ? output.configuredTotal : null,
    dailyTarget: hasDailyTarget ? output.dailyTarget : null,
    display: output.display,
    hasUsageData,
    hardPaceDailyTarget: hasHardPaceDailyTarget ? output.hardPaceDailyTarget : null,
    hardPaceDisplay: hasHardPaceDisplay ? output.hardPaceDisplay : null,
    hardPaceTodayAvailable: hasHardPaceTodayAvailable ? output.hardPaceTodayAvailable : null,
    monthRemaining: hasMonthRemaining ? output.monthRemaining : null,
    tokenBucketCapacity: hasTokenBucketCapacity ? output.tokenBucketCapacity : null,
    tokenBucketDailyRefill: hasTokenBucketDailyRefill ? output.tokenBucketDailyRefill : null,
    title: output.title,
    todayAvailable: hasTodayAvailable ? output.todayAvailable : null
  }
}

async function loadObsData(uuid) {
  const url = `/api/obs-data?uuid=${encodeURIComponent(uuid)}`
  const response = await fetch(url, {
    cache: 'no-store'
  })
  const text = await response.text()
  let payload = null

  if (text.length > 0) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  const isOk = response.ok

  if (!isOk) {
    throw new Error('API request failed')
  }

  return parseObsPayload(payload)
}

async function refresh(uuid) {
  try {
    const data = await loadObsData(uuid)
    const renderState = getWidgetRenderState(data)
    const displayValue = data.hasUsageData
      ? renderState.displayValue
      : NO_USAGE_DISPLAY_PLACEHOLDER

    titleNode.textContent = data.title
    valueNode.textContent = displayValue
    setSecondaryValue(renderState.secondaryValue)

    if (!data.hasUsageData) {
      setSecondaryValue('')
      resetProgress()
      resetPeriodProgress()
      return
    }

    updateProgress(renderState.primaryTodayAvailable, renderState.primaryDailyTarget)
    updatePeriodProgress(renderState.periodCurrentValue, renderState.periodMaxValue)
  } catch {
    setError('GitHub data unavailable')
  }
}

function startLoop(uuid) {
  void refresh(uuid)

  setInterval(() => {
    void refresh(uuid)
  }, REFRESH_INTERVAL_MS)
}

function bootstrap() {
  const url = new URL(window.location.href)
  const uuid = url.searchParams.get('uuid')
  const hasUuid = typeof uuid === 'string' && uuid.length > 0

  if (!hasUuid) {
    setError('Missing uuid in URL query')
    return
  }

  startLoop(uuid)
}

if (typeof window !== 'undefined') {
  bootstrap()
}
