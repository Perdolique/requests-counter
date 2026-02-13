const FALLBACK_VALUE = '¯\\_(ツ)_/¯'
const REFRESH_INTERVAL_MS = 60_000
const DEFAULT_TITLE = 'Copilot requests available today'

const titleNode = document.querySelector('#title')
const valueNode = document.querySelector('#value')

function setError(message) {
  titleNode.textContent = DEFAULT_TITLE
  valueNode.textContent = FALLBACK_VALUE
}

function parseObsPayload(payload) {
  const isObject = typeof payload === 'object' && payload !== null

  if (!isObject) {
    throw new Error('Invalid payload')
  }

  const output = /** @type {{ display?: unknown; title?: unknown }} */ (payload)
  const hasDisplay = typeof output.display === 'string' && output.display.length > 0
  const hasTitle = typeof output.title === 'string' && output.title.length > 0

  if (!hasDisplay || !hasTitle) {
    throw new Error('Payload fields are missing')
  }

  return {
    display: output.display,
    title: output.title
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

    titleNode.textContent = data.title
    valueNode.textContent = data.display
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
