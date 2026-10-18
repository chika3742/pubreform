import { describe, expect, test } from 'bun:test'
import { computeWindow, firstSlotShowing } from '../src/clock.ts'

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

describe('firstSlotShowing', () => {
  const schedule = { cron: '0 9 * * 1', timezone: 'UTC' }
  test('is the first fire time at or after the publication plus the days', () => {
    // Wednesday 10:00 + 3 days = Saturday 10:00 -> Monday 09:00.
    expect(firstSlotShowing(schedule, 3, new Date('2026-10-14T10:00:00Z'))).toEqual(new Date('2026-10-19T09:00:00Z'))
  })
  test('a fire time equal to the publication plus the days shows the version', () => {
    expect(firstSlotShowing(schedule, 3, new Date('2026-10-16T09:00:00Z'))).toEqual(new Date('2026-10-19T09:00:00Z'))
    expect(firstSlotShowing(schedule, 3, new Date('2026-10-16T09:00:00.001Z'))).toEqual(new Date('2026-10-26T09:00:00Z'))
  })
  test('the slot shows the version', () => {
    const published = new Date('2026-10-14T10:00:00Z')
    const slot = firstSlotShowing(schedule, 3, published)
    expect(computeWindow(schedule, 3, slot).cutoff >= published).toBe(true)
    expect(computeWindow(schedule, 3, new Date(slot.getTime() - 1)).cutoff >= published).toBe(false)
  })
})
