/**
 * Finanze's "Fiscale" section: the deductible expenses for the 730 and an ISEE estimate, computed here
 * so the web page and the apps show the same figures.
 *
 * These are ESTIMATES to plan with — not a tax return and not a DSU. The rates, caps and thresholds are
 * collected in RULES below, each with the year it was written for, so they are easy to check and update
 * when the law changes. The household, income and property data are the user's own (store.fiscal and
 * store.properties); anything not entered yet is reported in `missing` instead of being guessed.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

export const RULES = {
  // 730: deduction of 19% on what exceeds the franchise, with an optional cap per category.
  year: 2025,
  deductionRate: 0.19,
  childOver21Deduction: 950,
  childOver21Phaseout: 95000,
  healthFranchise: 129.11,
  insuranceCap: 530,
  mortgageInterestCap: 4000,
  // IRPEF brackets (tax year 2025) and the employee deduction (art. 13 TUIR).
  brackets: [
    { upTo: 28000, rate: 0.23 },
    { upTo: 50000, rate: 0.35 },
    { upTo: Infinity, rate: 0.43 },
  ],
  // ISEE.
  isee: {
    mobiliareFranchise: 6000, // + 2000 per member after the first, up to 10000
    mobiliareFranchisePerMember: 2000,
    mobiliareFranchiseMax: 10000,
    mobiliareFranchisePerChildAfterSecond: 1000,
    homeFranchise: 91500, // main home, law 199/2025 (was 52500)
    homeFranchisePerChildAfterFirst: 2500,
    equivalence: { 1: 1, 2: 1.57, 3: 2.04, 4: 2.46, 5: 2.85 }, // +0.35 per member beyond 5
    equivalenceExtraPerMember: 0.35,
    bothParentsWorkingBonus: 0.2, // minor children, both parents working
    propertyWeight: 0.2, // ISE = ISR + 20% of the equity (ISP)
  },
}

/** Categories of the catalogue that can give a 19% deduction, and how. */
const DEDUCTIBLE = [
  { category: 'Salute', label: 'Spese sanitarie', franchise: RULES.healthFranchise, note: 'Solo spese mediche, farmaci e dispositivi con scontrino parlante, pagate in modo tracciabile.' },
  { category: 'Istruzione', label: 'Spese per istruzione', note: 'Scuola dell\'obbligo: fino a 800 € a studente. Università: dipende dall\'ateneo.' },
  { category: 'Assicurazioni', label: 'Assicurazioni vita e infortuni', cap: RULES.insuranceCap, note: 'Solo vita e infortuni (tetto 530 €), non l\'auto.' },
  { category: 'Animali', label: 'Spese veterinarie', franchise: RULES.healthFranchise, cap: 550, include: false, note: 'Conta solo il veterinario, non il cibo: controlla prima di includerla.' },
]

function irpef(income) {
  let tax = 0
  let from = 0
  for (const b of RULES.brackets) {
    if (income > from) tax += (Math.min(income, b.upTo) - from) * b.rate
    from = b.upTo
  }
  return tax
}

/** Employee deduction for the year (art. 13 TUIR), by total income. */
function employeeDeduction(income) {
  if (income <= 15000) return 1955
  if (income <= 28000) return 1910 + 1190 * ((28000 - income) / 13000)
  if (income <= 50000) return 1910 * ((50000 - income) / 22000)
  return 0
}

function equivalenceScale(size, { children, adults, bothWork }) {
  const e = RULES.isee.equivalence
  // `children` here are the minors: the bonus is for families with minor children.
  let scale = size <= 5 ? e[Math.max(1, size)] : e[5] + (size - 5) * RULES.isee.equivalenceExtraPerMember
  if (bothWork && children > 0 && adults >= 2) scale += RULES.isee.bothParentsWorkingBonus
  return scale
}

export function summarizeFiscal(store, { assets = store.assets ?? [], now = new Date() } = {}) {
  const f = store.fiscal ?? {}
  const adults = Math.max(1, Math.round(Number(f.adults) || 1))
  const children = Math.max(0, Math.round(Number(f.children) || 0))
  const adultChildren = Math.min(children, Math.max(0, Math.round(Number(f.adultChildren) || 0)))
  const over21 = Math.min(adultChildren, Math.max(0, Math.round(Number(f.childrenOver21) || 0)))
  const minors = children - adultChildren
  const size = adults + children
  const income = Math.max(0, Number(f.income) || 0)
  const year = now.getFullYear()

  // --- 730: deductible expenses of the current calendar year -------------------------------
  const spentBy = {}
  for (const t of store.transactions ?? []) {
    const d = new Date(t.date)
    if (t.type === 'entrata' || Number.isNaN(d.getTime()) || d.getFullYear() !== year) continue
    spentBy[t.category] = (spentBy[t.category] ?? 0) + (Number(t.amount) || 0)
  }
  const deductions = DEDUCTIBLE.map((d) => {
    const spent = spentBy[d.category] ?? 0
    const afterFranchise = Math.max(0, spent - (d.franchise ?? 0))
    const eligible = d.cap ? Math.min(afterFranchise, d.cap) : afterFranchise
    const counted = d.include !== false
    return {
      category: d.category, label: d.label, spent: round2(spent), franchise: d.franchise ?? 0, cap: d.cap ?? null,
      eligible: round2(eligible), detraction: round2(eligible * RULES.deductionRate), counted, note: d.note,
    }
  })
  const interest = Math.min(Math.max(0, Number(f.mortgageInterest) || 0), RULES.mortgageInterestCap)
  if (interest > 0) deductions.push({ category: 'Mutuo', label: 'Interessi passivi del mutuo', spent: round2(Number(f.mortgageInterest) || 0), franchise: 0, cap: RULES.mortgageInterestCap, eligible: round2(interest), detraction: round2(interest * RULES.deductionRate), counted: true, note: 'Mutuo sulla prima casa: tetto 4.000 € di interessi.' })
  const donations = Math.max(0, Number(f.donations) || 0)
  if (donations > 0) deductions.push({ category: 'Erogazioni', label: 'Erogazioni liberali e altre al 19%', spent: round2(donations), franchise: 0, cap: null, eligible: round2(donations), detraction: round2(donations * RULES.deductionRate), counted: true, note: 'Inserite a mano.' })
  const detractionTotal = deductions.filter((d) => d.counted).reduce((s, d) => s + d.detraction, 0)

  const employee = f.employee !== false
  const grossTax = irpef(income)
  const workDeduction = employee ? employeeDeduction(income) : 0
  // Dependent children aged 21+: a deduction that shrinks as income grows (the under-21s get the assegno unico
  // instead, so they give none). Written from memory of art. 12 TUIR — flagged in the page as to be checked.
  const childDeduction = over21 * Math.max(0, RULES.childOver21Deduction * ((RULES.childOver21Phaseout - income) / RULES.childOver21Phaseout))
  const netTax = Math.max(0, grossTax - workDeduction - childDeduction - detractionTotal)
  const withholdings = Math.max(0, Number(f.withholdings) || 0)
  const tax = {
    year: RULES.year, income, employee,
    grossTax: round2(grossTax), workDeduction: round2(workDeduction), childDeduction: round2(childDeduction), deductions19: round2(detractionTotal),
    netTax: round2(netTax),
    withholdings: round2(withholdings),
    // Positive = refund (credit), negative = to pay; null until the withholdings of the CU are entered.
    balance: withholdings > 0 ? round2(withholdings - netTax) : null,
  }

  // --- ISEE ------------------------------------------------------------------------------
  const R = RULES.isee
  const missing = []
  const accounts = store.accounts ?? []
  const todayMobiliare = accounts.reduce((s, a) => s + (Number(a.balance) || 0), 0) + assets.reduce((s, a) => s + (Number(a.qty) || 0) * (Number(a.price) || 0), 0)
  const manualMobiliare = f.mobiliare === '' || f.mobiliare == null ? null : Number(f.mobiliare)
  const mobiliare = manualMobiliare ?? todayMobiliare
  if (manualMobiliare == null) missing.push('Patrimonio mobiliare al 31/12: sto usando i saldi di oggi, inserisci quello vero (e la giacenza media se è più alta).')
  const mobFranchise = Math.min(
    R.mobiliareFranchiseMax,
    R.mobiliareFranchise + R.mobiliareFranchisePerMember * Math.max(0, size - 1),
  ) + R.mobiliareFranchisePerChildAfterSecond * Math.max(0, children - 2)
  const mobIsp = Math.max(0, mobiliare - mobFranchise)

  const properties = (store.properties ?? []).map((p) => {
    const value = (Number(p.value) || 0) * ((Number(p.share) || 100) / 100)
    const equity = Math.max(0, value - (Number(p.mortgage) || 0))
    return { id: p.id, name: p.name, main: !!p.main, value: round2(value), mortgage: round2(Number(p.mortgage) || 0), equity: round2(equity) }
  })
  if (properties.length === 0) missing.push('Immobili: non ne ho registrati, quindi il patrimonio immobiliare conta 0.')
  const homeFranchise = R.homeFranchise + R.homeFranchisePerChildAfterFirst * Math.max(0, children - 1)
  let franchiseLeft = homeFranchise
  let immIsp = 0
  for (const p of properties) {
    let net = p.equity
    if (p.main) {
      const used = Math.min(net, franchiseLeft)
      franchiseLeft -= used
      net -= used
    }
    p.counted = round2(net)
    immIsp += net
  }

  const bothWork = !!f.bothWork
  if (adultChildren > 0) missing.push('Figlio maggiorenne: se vive con voi entra nel nucleo ISEE con il suo reddito e il suo patrimonio, che qui non ho.')
  const scale = equivalenceScale(size, { children: minors, adults, bothWork })
  const isp = mobIsp + immIsp
  const ise = income + R.propertyWeight * isp
  const isee = {
    referenceYear: year - 1,
    isr: round2(income),
    mobiliare: { value: round2(mobiliare), franchise: round2(mobFranchise), isp: round2(mobIsp), estimated: manualMobiliare == null },
    immobiliare: { items: properties, homeFranchise: round2(homeFranchise), isp: round2(immIsp) },
    isp: round2(isp),
    ise: round2(ise),
    scale: round2(scale),
    isee: round2(ise / scale),
    missing,
  }

  return {
    expensesYear: year,
    household: { adults, children, adultChildren, childrenOver21: over21, minors, size },
    settings: { employee, childrenOver21: over21, bothWork, income, withholdings, mortgageInterest: Number(f.mortgageInterest) || 0, donations, mobiliare: manualMobiliare },
    tax, deductions, isee,
    rules: { year: RULES.year, healthFranchise: RULES.healthFranchise },
  }
}
