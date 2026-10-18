// slot and cutoff.
import { CronExpressionParser } from 'cron-parser'

const DAY_MS = 24 * 60 * 60 * 1000

export interface Window {
  /** The latest time the cron fired at or before `now`. */
  slot: Date
  /** Versions published after this are hidden. */
  cutoff: Date
}

/** The first slot whose cutoff shows a version published at `published`. */
export function firstSlotShowing(
  schedule: { cron: string; timezone: string },
  minReleaseAgeDays: number,
  published: Date,
): Date {
  // The first fire time at or after published + days. next() excludes currentDate, and the cron fires
  // on whole seconds, so start 1 second before that time rounded up to a second.
  const from = published.getTime() + minReleaseAgeDays * DAY_MS
  const expr = CronExpressionParser.parse(schedule.cron, {
    tz: schedule.timezone,
    currentDate: new Date(Math.ceil(from / 1000) * 1000 - 1000),
  })
  return expr.next().toDate()
}

export function computeWindow(
  schedule: { cron: string; timezone: string },
  minReleaseAgeDays: number,
  now: Date,
): Window {
  // prev() excludes a fire time equal to currentDate, so look from 1 second later.
  // Milliseconds are dropped first so that a fire time after `now` is never returned.
  const expr = CronExpressionParser.parse(schedule.cron, {
    tz: schedule.timezone,
    currentDate: new Date(Math.floor(now.getTime() / 1000) * 1000 + 1000),
  })
  const slot = expr.prev().toDate()
  return { slot, cutoff: new Date(slot.getTime() - minReleaseAgeDays * DAY_MS) }
}
