/**
 * The scheduler behind Finanze's "Acquisti ricorrenti" (PAC) plans — a
 * plain interval check, no cron dependency needed for something that only
 * has to notice "has a day passed" at most once an hour. Runs inside the
 * same always-on bridge process as everything else (started from
 * server.mjs), so a plan set up once keeps buying with no further action.
 *
 * A failed execution (price lookup down, symbol gone) is left with its
 * nextRunIso untouched, so the very next hourly check retries it — nothing
 * here gives up on a cycle permanently on a transient failure.
 */

import { applyRecurringBuyExecution, getStore } from './lifeos-store.mjs'
import { lookupPrices } from './market-prices.mjs'

async function runDueBuys() {
  const store = await getStore()
  const now = new Date()
  for (const buy of store.recurringBuys ?? []) {
    if (!buy.active) continue
    if (new Date(buy.nextRunIso) > now) continue
    try {
      const { price } = await lookupPrices({ assetClass: buy.assetClass, symbol: buy.symbol })
      const qty = price > 0 ? buy.amountEur / price : 0
      await applyRecurringBuyExecution(buy.id, { price, qty })
      console.log(`[jarvis] PAC eseguito: ${buy.name} — ${qty.toFixed(6)} ${buy.symbol} a €${price.toFixed(2)}`)
    } catch (err) {
      console.error(`[jarvis] PAC "${buy.name}" fallito, riprovo al prossimo controllo:`, err?.message ?? err)
    }
  }
}

/** Called once from server.mjs at startup. */
export function startRecurringBuyScheduler() {
  runDueBuys().catch((err) => console.error('[jarvis] recurring-buys startup check failed:', err?.message ?? err))
  setInterval(() => {
    runDueBuys().catch((err) => console.error('[jarvis] recurring-buys check failed:', err?.message ?? err))
  }, 60 * 60 * 1000) // hourly is plenty of resolution for weekly/monthly plans
}
