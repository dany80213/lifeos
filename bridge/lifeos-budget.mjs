/**
 * Finanze's Budget section, computed once here so the web page, the iPhone and the Mac all show the
 * same numbers: per-category limits against what was really spent this month, the month's forecast,
 * the emergency fund in months of expenses, and the savings goals.
 *
 * Everything is derived from the store (transactions, accounts, budgets, goals); nothing here is saved.
 * Friends' money (store.friendTx) is a separate list, so it never counts as spending or income.
 */

import { buildCatalog } from './lifeos-finance-catalog.mjs'

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`

/** The calendar month `back` months before `now`, as { key, start, end } (end exclusive). */
function monthRange(now, back = 0) {
  const start = new Date(now.getFullYear(), now.getMonth() - back, 1)
  const end = new Date(now.getFullYear(), now.getMonth() - back + 1, 1)
  return { key: monthKey(start), start, end }
}

function totalsFor(transactions, range) {
  const spentBy = {}
  let income = 0
  let spent = 0
  for (const t of transactions) {
    const d = new Date(t.date)
    if (Number.isNaN(d.getTime()) || d < range.start || d >= range.end) continue
    const amount = Number(t.amount) || 0
    if (t.type === 'entrata') income += amount
    else {
      spent += amount
      spentBy[t.category] = (spentBy[t.category] ?? 0) + amount
    }
  }
  return { income, spent, spentBy }
}

/** Whole months from `now` to a YYYY-MM-DD deadline, at least 1 while it's still ahead. */
function monthsUntil(deadline, now) {
  const d = new Date(`${deadline}T12:00:00`)
  if (Number.isNaN(d.getTime())) return null
  if (d <= now) return 0
  return Math.max(1, (d.getFullYear() - now.getFullYear()) * 12 + d.getMonth() - now.getMonth())
}

export function summarizeBudget(store, now = new Date()) {
  const transactions = store.transactions ?? []
  const catalog = buildCatalog(store.categories).categories
  const emoji = (name) => catalog.find((c) => c.name === name)?.emoji ?? '📦'

  const thisMonth = totalsFor(transactions, monthRange(now, 0))
  const previous = [1, 2, 3].map((back) => totalsFor(transactions, monthRange(now, back)))
  const prev = previous[0]

  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const day = now.getDate()
  const daysLeft = daysInMonth - day + 1 // today still counts

  // Average of the closed months that actually have spending, so a brand-new store doesn't dilute it.
  const withSpend = previous.filter((m) => m.spent > 0)
  const avgSpent = withSpend.length ? withSpend.reduce((s, m) => s + m.spent, 0) / withSpend.length : 0
  const avgOf = (cat) => (withSpend.length ? withSpend.reduce((s, m) => s + (m.spentBy[cat] ?? 0), 0) / withSpend.length : 0)

  const limits = new Map((store.budgets ?? []).map((b) => [b.category, b]))
  const names = new Set([...limits.keys(), ...Object.keys(thisMonth.spentBy)])
  const categories = [...names]
    .map((name) => {
      const limit = limits.get(name)?.amount ?? null
      const spent = thisMonth.spentBy[name] ?? 0
      const pct = limit ? spent / limit : null
      return {
        name,
        emoji: emoji(name),
        budgetId: limits.get(name)?.id ?? null,
        limit,
        spent: round2(spent),
        prev: round2(prev.spentBy[name] ?? 0),
        avg: round2(avgOf(name)),
        pct: pct == null ? null : round2(pct),
        status: pct == null ? 'free' : pct >= 1 ? 'over' : pct >= 0.8 ? 'warn' : 'ok',
      }
    })
    // Categories with a limit first (the most consumed on top), then the free ones by amount.
    .sort((a, b) => (b.limit != null) - (a.limit != null) || (b.pct ?? 0) - (a.pct ?? 0) || b.spent - a.spent)

  const limited = categories.filter((c) => c.limit != null)
  const totalLimit = limited.reduce((s, c) => s + c.limit, 0)
  const spentOnLimited = limited.reduce((s, c) => s + c.spent, 0)

  // Forecast: spending so far plus the daily pace for the days left. Rough on purpose — rent and bills
  // are lumpy — so it's labelled as an estimate by the clients.
  const pace = day > 0 ? thisMonth.spent / day : 0
  const projectedSpent = thisMonth.spent + pace * (daysInMonth - day)
  const remaining = totalLimit - spentOnLimited

  // Emergency fund: liquidity (bank accounts only) over the typical monthly spending.
  const liquidity = (store.accounts ?? []).filter((a) => a.type === 'banche').reduce((s, a) => s + (Number(a.balance) || 0), 0)
  const monthlyBase = avgSpent || projectedSpent
  const emergencyMonths = monthlyBase > 0 ? liquidity / monthlyBase : null

  const saved = thisMonth.income - thisMonth.spent
  const goals = (store.goals ?? []).map((g) => {
    const target = Number(g.target) || 0
    const savedSoFar = Number(g.saved) || 0
    const left = Math.max(0, target - savedSoFar)
    const months = g.deadline ? monthsUntil(g.deadline, now) : null
    return {
      id: g.id,
      name: g.name,
      emoji: g.emoji || '🎯',
      target: round2(target),
      saved: round2(savedSoFar),
      deadline: g.deadline || '',
      pct: target > 0 ? round2(Math.min(1, savedSoFar / target)) : 0,
      done: target > 0 && savedSoFar >= target,
      monthsLeft: months,
      monthlyNeeded: months ? round2(left / months) : null,
      late: !!g.deadline && months === 0 && left > 0,
    }
  })

  return {
    month: monthKey(now),
    day,
    daysInMonth,
    daysLeft,
    income: round2(thisMonth.income),
    spent: round2(thisMonth.spent),
    saved: round2(saved),
    savingsRate: thisMonth.income > 0 ? round2(saved / thisMonth.income) : null,
    prevIncome: round2(prev.income),
    prevSpent: round2(prev.spent),
    avgSpent: round2(avgSpent),
    categories,
    totalLimit: round2(totalLimit),
    spentOnLimited: round2(spentOnLimited),
    remaining: round2(remaining),
    status: totalLimit > 0 ? (spentOnLimited >= totalLimit ? 'over' : spentOnLimited >= totalLimit * 0.8 ? 'warn' : 'ok') : 'free',
    forecast: {
      projectedSpent: round2(projectedSpent),
      projectedSaved: round2(thisMonth.income - projectedSpent),
      dailyPace: round2(pace),
      // What's still free to spend each day to stay inside the total limit; null without limits.
      dailyAllowance: totalLimit > 0 ? round2(Math.max(0, remaining) / daysLeft) : null,
      overBudget: totalLimit > 0 && spentOnLimited + (spentOnLimited / day) * (daysInMonth - day) > totalLimit,
    },
    emergency: { liquidity: round2(liquidity), months: emergencyMonths == null ? null : round2(emergencyMonths), monthlyBase: round2(monthlyBase) },
    goals,
  }
}
