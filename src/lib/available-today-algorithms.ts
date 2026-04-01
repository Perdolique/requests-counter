import {
  calculateQuotaDailyMetrics,
  type QuotaDailyMetrics,
  type QuotaDailyMetricsInput
} from './quota'

export const DEFAULT_AVAILABLE_TODAY_ALGORITHM_ID = 'daily_pace'

export type AvailableTodayAlgorithmId = 'daily_pace'

export interface AvailableTodayAlgorithm {
  description: string;
  examples: string[];
  explanation: string;
  id: AvailableTodayAlgorithmId;
  isDefault: boolean;
  name: string;
}

const AVAILABLE_TODAY_ALGORITHMS: AvailableTodayAlgorithm[] = [
  {
    description: 'Spread the rest of your monthly requests evenly across the remaining days.',
    examples: [
      '120 left, 6 days left, 7 used today -> 13 available today',
      '40 left, 2 days left, 0 used today -> 20 available today'
    ],
    explanation: 'We take the requests left this month, divide them by the remaining days, and subtract what you already spent today.',
    id: 'daily_pace',
    isDefault: true,
    name: 'Daily Pace'
  }
]

export function getAvailableTodayAlgorithms(): AvailableTodayAlgorithm[] {
  return AVAILABLE_TODAY_ALGORITHMS.map((algorithm) => ({
    ...algorithm,
    examples: [...algorithm.examples]
  }))
}

export function isAvailableTodayAlgorithmId(value: string): value is AvailableTodayAlgorithmId {
  return value === DEFAULT_AVAILABLE_TODAY_ALGORITHM_ID
}

export function resolveAvailableTodayAlgorithmId(
  value: string | null | undefined
): AvailableTodayAlgorithmId {
  if (typeof value === 'string' && isAvailableTodayAlgorithmId(value)) {
    return value
  }

  return DEFAULT_AVAILABLE_TODAY_ALGORITHM_ID
}

export function getAvailableTodayAlgorithmById(
  value: string | null | undefined
): AvailableTodayAlgorithm {
  const algorithmId = resolveAvailableTodayAlgorithmId(value)
  const matchedAlgorithm = AVAILABLE_TODAY_ALGORITHMS.find((algorithm) => algorithm.id === algorithmId)

  if (matchedAlgorithm) {
    return {
      ...matchedAlgorithm,
      examples: [...matchedAlgorithm.examples]
    }
  }

  const defaultAlgorithm = AVAILABLE_TODAY_ALGORITHMS[0]

  return {
    ...defaultAlgorithm,
    examples: [...defaultAlgorithm.examples]
  }
}

export function calculateAvailableTodayMetrics(
  algorithmId: AvailableTodayAlgorithmId,
  input: QuotaDailyMetricsInput
): QuotaDailyMetrics {
  if (algorithmId === 'daily_pace') {
    return calculateQuotaDailyMetrics(input)
  }

  return calculateQuotaDailyMetrics(input)
}
