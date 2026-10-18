import { describe, expect, test } from 'bun:test'
import { computeWindow } from '../src/clock.ts'

const weekly = { cron: '0 9 * * 1', timezone: 'Asia/Tokyo' } // Mondays 09:00 JST = 00:00 UTC

describe('computeWindow', () => {
  test('slot is the latest fire time before now', () => {
    // 2026-10-18 is a Sunday.
    const { slot, cutoff } = computeWindow(weekly, 3, new Date('2026-10-18T12:00:00Z'))
    expect(slot.toISOString()).toBe('2026-10-12T00:00:00.000Z')
    expect(cutoff.toISOString()).toBe('2026-10-09T00:00:00.000Z')
  })
  test('a fire time equal to now is the slot', () => {
    const { slot } = computeWindow(weekly, 0, new Date('2026-10-19T00:00:00Z'))
    expect(slot.toISOString()).toBe('2026-10-19T00:00:00.000Z')
  })
  test('one millisecond before a fire time gives the previous slot', () => {
    const { slot } = computeWindow(weekly, 0, new Date('2026-10-18T23:59:59.999Z'))
    expect(slot.toISOString()).toBe('2026-10-12T00:00:00.000Z')
  })
  test('within the second after the fire time', () => {
    const { slot } = computeWindow(weekly, 0, new Date('2026-10-19T00:00:00.999Z'))
    expect(slot.toISOString()).toBe('2026-10-19T00:00:00.000Z')
  })
  test('time zone is applied', () => {
    const { slot } = computeWindow({ cron: '0 9 * * *', timezone: 'UTC' }, 0, new Date('2026-10-18T08:00:00Z'))
    expect(slot.toISOString()).toBe('2026-10-17T09:00:00.000Z')
  })
  test('days are subtracted as absolute time across a DST change', () => {
    // America/New_York leaves DST on 2026-11-01.
    const { slot, cutoff } = computeWindow(
      { cron: '0 9 * * *', timezone: 'America/New_York' },
      2,
      new Date('2026-11-02T15:00:00Z'),
    )
    expect(slot.toISOString()).toBe('2026-11-02T14:00:00.000Z')
    expect(cutoff.toISOString()).toBe('2026-10-31T14:00:00.000Z')
  })
})
