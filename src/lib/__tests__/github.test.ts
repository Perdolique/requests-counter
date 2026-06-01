import { describe, expect, test } from 'vitest'
import {
  extractConsumedCredits,
  extractUsageByLabel,
  type CopilotCreditUsageReport
} from '../github'

function createUsageReport(
  usageItems: CopilotCreditUsageReport['usageItems']
): CopilotCreditUsageReport {
  return {
    usageItems
  }
}

describe('Copilot AI Credits usage parsing', () => {
  test('should count gross quantity from credit rows', () => {
    const report = createUsageReport([
      {
        grossQuantity: 12.345,
        product: 'Copilot',
        sku: 'copilot_ai_credit',
        unitType: 'credits'
      }
    ])

    const credits = extractConsumedCredits(report)

    expect(credits).toBe(12.35)
  })

  test('should count live Copilot ai-units rows as credits', () => {
    const report = createUsageReport([
      {
        grossQuantity: 1.25,
        product: 'Copilot',
        sku: 'copilot_ai_unit',
        unitType: 'ai-units'
      }
    ])

    const credits = extractConsumedCredits(report)

    expect(credits).toBe(1.25)
  })

  test('should count discount and net quantity when gross quantity is absent', () => {
    const report = createUsageReport([
      {
        discountQuantity: 2.25,
        netQuantity: 7.5,
        product: 'Copilot',
        sku: 'copilot_ai_credit',
        unitType: 'ai_credits'
      }
    ])

    const credits = extractConsumedCredits(report)

    expect(credits).toBe(9.75)
  })

  test('should convert USD amount to credits for Copilot credit rows without quantity', () => {
    const report = createUsageReport([
      {
        grossAmount: 1.23,
        product: 'Copilot',
        sku: 'copilot_ai_credit'
      }
    ])

    const credits = extractConsumedCredits(report)

    expect(credits).toBe(123)
  })

  test('should ignore legacy premium request rows in AIC-only mode', () => {
    const report = createUsageReport([
      {
        grossQuantity: 42,
        product: 'Copilot',
        sku: 'copilot_premium_request',
        unitType: 'requests'
      }
    ])

    const credits = extractConsumedCredits(report)

    expect(credits).toBe(0)
  })

  test('should ignore non-Copilot billing products', () => {
    const report = createUsageReport([
      {
        grossQuantity: 60,
        product: 'Actions',
        sku: 'actions_linux',
        unitType: 'minutes'
      }
    ])

    const credits = extractConsumedCredits(report)

    expect(credits).toBe(0)
  })

  test('should aggregate positive credit rows by billing label', () => {
    const report = createUsageReport([
      {
        grossQuantity: 10,
        product: 'Copilot',
        sku: 'copilot_ai_credit',
        unitType: 'credits'
      },
      {
        grossQuantity: 3.333,
        product: 'Copilot',
        sku: 'copilot_ai_credit',
        unitType: 'credits'
      }
    ])

    const usageByLabel = extractUsageByLabel(report)

    expect(usageByLabel).toStrictEqual([
      {
        credits: 13.33,
        label: 'copilot_ai_credit'
      }
    ])
  })
})
