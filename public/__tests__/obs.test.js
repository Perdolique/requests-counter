import { describe, expect, test } from 'vitest'
import { getWidgetRenderState } from '../obs.js'

describe(getWidgetRenderState, () => {
  test('uses hard pace as the primary widget display when its limit is higher', () => {
    const data = {
      configuredTotal: 1_200,
      dailyTarget: 150,
      display: '70/150',
      hardPaceDailyTarget: 300,
      hardPaceDisplay: '120/300',
      hardPaceTodayAvailable: 120,
      monthRemaining: 900,
      todayAvailable: 70
    }

    const result = getWidgetRenderState(data)

    expect(result).toStrictEqual({
      displayValue: '120/300',
      periodCurrentValue: 900,
      periodMaxValue: 1_200,
      primaryDailyTarget: 300,
      primaryTodayAvailable: 120,
      secondaryValue: '',
      useHardPaceAsPrimary: true
    })
  })

  test('keeps the normal widget display when hard pace is not higher', () => {
    const data = {
      configuredTotal: 1_200,
      dailyTarget: 150,
      display: '70/150',
      hardPaceDailyTarget: 120,
      hardPaceDisplay: '50/120',
      hardPaceTodayAvailable: 50,
      monthRemaining: 900,
      todayAvailable: 70
    }

    const result = getWidgetRenderState(data)

    expect(result).toStrictEqual({
      displayValue: '70/150',
      periodCurrentValue: 50,
      periodMaxValue: 120,
      primaryDailyTarget: 150,
      primaryTodayAvailable: 70,
      secondaryValue: 'Hard pace: 50/120',
      useHardPaceAsPrimary: false
    })
  })
})
