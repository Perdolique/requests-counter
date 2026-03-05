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

const titleNode = document.querySelector('#title')
const valueNode = document.querySelector('#value')
const progressFillNode = document.querySelector('#progressFill')

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

function resetProgress() {
  setProgressFill(0, PROGRESS_BLUE_COLOR)
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

function normalizeNegativeZero(value) {
  const isNegativeZero = Object.is(value, -0)

  if (isNegativeZero) {
    return 0
  }

  return value
}

function formatWidgetDisplayValue(rawTodayAvailable, rawDailyTarget) {
  const hasTodayAvailable = typeof rawTodayAvailable === 'number' && Number.isFinite(rawTodayAvailable)
  const hasDailyTarget = typeof rawDailyTarget === 'number' && Number.isFinite(rawDailyTarget)

  if (!hasTodayAvailable || !hasDailyTarget) {
    return null
  }

  const todayAvailable = normalizeNegativeZero(rawTodayAvailable)
  const dailyTarget = Math.max(0, rawDailyTarget)
  const left = WIDGET_INTEGER_FORMATTER.format(todayAvailable)
  const right = WIDGET_INTEGER_FORMATTER.format(dailyTarget)

  return `${left}/${right}`
}

function setError(message) {
  titleNode.textContent = DEFAULT_TITLE
  valueNode.textContent = FALLBACK_VALUE
  resetProgress()
}

function parseObsPayload(payload) {
  const isObject = typeof payload === 'object' && payload !== null

  if (!isObject) {
    throw new Error('Invalid payload')
  }

  const output = /** @type {{
    display?: unknown;
    dailyTarget?: unknown;
    hasUsageData?: unknown;
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

  return {
    dailyTarget: hasDailyTarget ? output.dailyTarget : null,
    display: output.display,
    hasUsageData,
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
    const roundedDisplayValue = formatWidgetDisplayValue(data.todayAvailable, data.dailyTarget)
    const displayValue = data.hasUsageData
      ? (roundedDisplayValue ?? data.display)
      : NO_USAGE_DISPLAY_PLACEHOLDER

    titleNode.textContent = data.title
    valueNode.textContent = displayValue

    if (!data.hasUsageData) {
      resetProgress()
      return
    }

    updateProgress(data.todayAvailable, data.dailyTarget)
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

bootstrap()
