import SwiftUI

// The Budget tab of Finanze. Every number comes ready-made from the bridge (`budget` in /api/lifeos-data,
// computed in bridge/lifeos-budget.mjs) so the apps and the web show the same thing; this only draws it.

struct BudgetSection: View {
    @EnvironmentObject var app: AppState
    @State private var sheet: BudgetSheet?

    enum BudgetSheet: Identifiable {
        case limit(category: String, current: Double), newLimit, newGoal, deposit(goal: JSON)
        var id: String {
            switch self {
            case .limit(let c, _): return "limit-\(c)"
            case .newLimit: return "newLimit"
            case .newGoal: return "newGoal"
            case .deposit(let g): return "deposit-\(g["id"].int)"
            }
        }
    }

    private var b: JSON { app.data["budget"] }
    private var forecast: JSON { b["forecast"] }
    private var hasLimits: Bool { b["totalLimit"].num > 0 }

    private func color(_ status: String) -> Color { status == "over" ? T.red : status == "warn" ? T.amber : T.green }

    private var monthTitle: String {
        guard let d = Fmt.date(b["month"].str + "-01") else { return "" }
        return Fmt.it(d, "LLLL yyyy").uppercased()
    }

    var body: some View {
        Group {
            if b.isNull {
                Card { Text("Il budget non è disponibile: ricarica la schermata.").font(.subheadline).foregroundStyle(T.text3) }
            } else {
                #if os(macOS)
                Row([2, 1]) { summaryCard; forecastCard }
                Row([2, 1]) { categoriesCard; goalsCard }
                #else
                summaryCard
                categoriesCard
                forecastCard
                goalsCard
                #endif
            }
        }
        .sheet(item: $sheet) { s in
            switch s {
            case .limit(let c, let cur): LimitForm(category: c, current: cur)
            case .newLimit: LimitForm(category: "", current: 0)
            case .newGoal: GoalForm()
            case .deposit(let g): DepositForm(goal: g)
            }
        }
    }

    // MARK: Summary

    private var summaryCard: some View {
        Card {
            CardLabel("BUDGET DI \(monthTitle)")
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(Fmt.eur(b["spentOnLimited"].num, decimals: 2)).font(.system(size: 32, weight: .heavy)).monospacedDigit()
                if hasLimits {
                    Text("di \(Fmt.eur(b["totalLimit"].num)) · restano \(Fmt.eur(max(0, b["remaining"].num)))")
                        .font(.footnote).foregroundStyle(T.text2)
                } else {
                    Text("nelle categorie con un limite").font(.footnote).foregroundStyle(T.text2)
                }
            }
            if hasLimits { ProgressBar(value: b["spentOnLimited"].num / b["totalLimit"].num, tint: color(b["status"].str)) }
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                stat("ENTRATE", Fmt.eur(b["income"].num, decimals: 2), T.green,
                     b["prevIncome"].num > 0 ? "mese scorso \(Fmt.eur(b["prevIncome"].num))" : "")
                stat("SPESE", Fmt.eur(b["spent"].num, decimals: 2), T.text1, spentDelta)
                stat("RISPARMIO", (b["saved"].num < 0 ? "−" : "") + Fmt.eur(abs(b["saved"].num), decimals: 2),
                     b["saved"].num < 0 ? T.red : T.text1,
                     b["savingsRate"].double.map { "\(Int(($0 * 100).rounded()))% delle entrate" } ?? "nessuna entrata registrata")
                stat("MEDIA SPESE", b["avgSpent"].num > 0 ? Fmt.eur(b["avgSpent"].num) : "—", T.text1, "al mese, mesi chiusi")
            }
        }
    }

    private var spentDelta: String {
        let prev = b["prevSpent"].num
        guard prev > 0 else { return "" }
        let d = (b["spent"].num - prev) / prev
        return "\(d >= 0 ? "+" : "−")\(Int((abs(d) * 100).rounded()))% sul mese scorso"
    }

    private func stat(_ label: String, _ value: String, _ tint: Color, _ note: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            CardLabel(label)
            Text(value).font(.headline.weight(.bold)).monospacedDigit().foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.7)
            if !note.isEmpty { Text(note).font(.caption2).foregroundStyle(T.text3).lineLimit(2) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12).background(T.glassSoft, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    // MARK: Categories

    private var categoriesCard: some View {
        Card {
            HStack {
                CardLabel("CATEGORIE DEL MESE"); Spacer()
                Button { sheet = .newLimit } label: { Image(systemName: "plus.circle.fill").font(.title3) }
            }
            let cats = b["categories"].array
            if cats.isEmpty {
                Text("Ancora nessuna spesa questo mese e nessun limite. Aggiungi un limite o importa un estratto conto.")
                    .font(.footnote).foregroundStyle(T.text3)
            }
            ForEach(cats.indices, id: \.self) { i in
                let c = cats[i]
                let limit = c["limit"].double
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 10) {
                        CategoryBadge(emoji: c["emoji"].str, size: 32)
                        Text(c["name"].str).font(.subheadline.weight(.semibold)).lineLimit(1)
                        Spacer()
                        Text(Fmt.eur(c["spent"].num, decimals: 2)).font(.subheadline.weight(.semibold)).monospacedDigit()
                            .foregroundStyle(limit == nil ? T.text1 : color(c["status"].str))
                        Button { sheet = .limit(category: c["name"].str, current: limit ?? 0) } label: {
                            Text(limit.map { "di \(Fmt.eur($0))" } ?? "Imposta limite").font(.caption.weight(.semibold)).foregroundStyle(T.accent)
                        }.buttonStyle(.plain)
                    }
                    if limit != nil { ProgressBar(value: c["pct"].num, tint: color(c["status"].str)) }
                    let note = categoryNote(c, limit)
                    if !note.isEmpty { Text(note).font(.caption2).foregroundStyle(T.text3) }
                }
            }
        }
    }

    private func categoryNote(_ c: JSON, _ limit: Double?) -> String {
        var parts: [String] = []
        if let limit { parts.append(c["spent"].num > limit ? "oltre di \(Fmt.eur(c["spent"].num - limit, decimals: 2))" : "restano \(Fmt.eur(limit - c["spent"].num, decimals: 2))") }
        if c["prev"].num > 0 { parts.append("mese scorso \(Fmt.eur(c["prev"].num, decimals: 2))") }
        if c["avg"].num > 0 { parts.append("media \(Fmt.eur(c["avg"].num, decimals: 2))") }
        return parts.joined(separator: " · ")
    }

    // MARK: Forecast + emergency fund

    private var forecastCard: some View {
        Card {
            CardLabel("PREVISIONE")
            Text(Fmt.eur(forecast["projectedSpent"].num, decimals: 2)).font(.system(size: 30, weight: .heavy)).monospacedDigit()
            Text("stima delle spese a fine mese, al ritmo di \(Fmt.eur(forecast["dailyPace"].num, decimals: 2)) al giorno (una stima, non una certezza)" +
                 (forecast["overBudget"].bool ? " — a questo ritmo sfori il budget" : ""))
                .font(.footnote).foregroundStyle(forecast["overBudget"].bool ? T.red : T.text3)
            row("Puoi spendere al giorno", forecast["dailyAllowance"].double.map { Fmt.eur($0, decimals: 2) } ?? "imposta dei limiti")
            row("Giorni rimasti", "\(b["daysLeft"].int)")
            row("Risparmio previsto", (forecast["projectedSaved"].num < 0 ? "−" : "") + Fmt.eur(abs(forecast["projectedSaved"].num), decimals: 2))
            Divider().overlay(T.border)
            CardLabel("FONDO EMERGENZA")
            if let months = b["emergency"]["months"].double {
                Text("\(Fmt.num(months, 1).replacingOccurrences(of: ".", with: ",")) mesi").font(.system(size: 30, weight: .heavy))
                Text("\(Fmt.eur(b["emergency"]["liquidity"].num)) di liquidità coprono le spese di \(Fmt.num(months, 1).replacingOccurrences(of: ".", with: ",")) mesi (\(Fmt.eur(b["emergency"]["monthlyBase"].num)) al mese). Una buona soglia è 3-6.")
                    .font(.footnote).foregroundStyle(T.text3)
            } else {
                Text("Servono delle spese registrate.").font(.footnote).foregroundStyle(T.text3)
            }
        }
    }

    private func row(_ l: String, _ v: String) -> some View {
        HStack { Text(l).font(.footnote).foregroundStyle(T.text2); Spacer(); Text(v).font(.footnote.weight(.semibold)).monospacedDigit() }
    }

    // MARK: Goals

    private var goalsCard: some View {
        Card {
            HStack {
                CardLabel("OBIETTIVI DI RISPARMIO"); Spacer()
                Button { sheet = .newGoal } label: { Image(systemName: "plus.circle.fill").font(.title3) }
            }
            let goals = b["goals"].array
            if goals.isEmpty {
                Text("Nessun obiettivo. Aggiungine uno: ti dico quanto mettere da parte ogni mese per arrivarci in tempo.")
                    .font(.footnote).foregroundStyle(T.text3)
            }
            ForEach(goals.indices, id: \.self) { i in
                let g = goals[i]
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 10) {
                        CategoryBadge(emoji: g["emoji"].str, size: 32)
                        Text(g["name"].str).font(.subheadline.weight(.semibold)).lineLimit(1)
                        Spacer()
                        Text("\(Fmt.eur(g["saved"].num)) / \(Fmt.eur(g["target"].num))").font(.footnote.weight(.semibold)).monospacedDigit()
                        Button { sheet = .deposit(goal: g) } label: { Text("Versa").font(.caption.weight(.semibold)).foregroundStyle(T.accent) }.buttonStyle(.plain)
                        Button(role: .destructive) { Task { _ = await app.financeOp("goals", "remove", id: g["id"].int) } } label: {
                            Image(systemName: "trash").font(.footnote).foregroundStyle(T.text3)
                        }.buttonStyle(.plain)
                    }
                    ProgressBar(value: g["pct"].num, tint: g["late"].bool ? T.red : g["done"].bool ? T.green : T.accent)
                    Text(goalNote(g)).font(.caption2).foregroundStyle(T.text3)
                }
            }
        }
    }

    private func goalNote(_ g: JSON) -> String {
        let left = max(0, g["target"].num - g["saved"].num)
        if g["done"].bool { return "Obiettivo raggiunto" }
        guard let d = Fmt.date(g["deadline"].str) else { return "Mancano \(Fmt.eur(left)) · nessuna scadenza" }
        let when = Fmt.it(d, "d MMM yyyy")
        if g["late"].bool { return "Scaduto il \(when) · mancano \(Fmt.eur(left))" }
        let months = g["monthsLeft"].int
        return "Entro il \(when) · metti da parte \(Fmt.eur(g["monthlyNeeded"].num)) al mese per \(months) \(months == 1 ? "mese" : "mesi")"
    }
}

// MARK: - Forms

/// Sets, changes or removes (amount 0) the monthly limit of a spending category.
struct LimitForm: View {
    @EnvironmentObject var app: AppState
    let category: String
    let current: Double
    @State private var chosen = ""
    @State private var amount = ""

    private var name: String { category.isEmpty ? chosen : category }
    private var cats: [JSON] { FinanceCatalog.categories(app.data, kind: "spesa") }

    var body: some View {
        FormShell(title: category.isEmpty ? "Nuovo limite" : "Limite mensile", canSave: !name.isEmpty && (Fmt.parse(amount) > 0 || current > 0)) {
            let r = await app.financeOp("budgets", "add", data: ["category": .string(name), "amount": .number(Fmt.parse(amount))])
            return r != nil
        } content: {
            if category.isEmpty {
                Picker("Categoria", selection: $chosen) {
                    Text("Scegli la categoria").tag("")
                    ForEach(cats.indices, id: \.self) { i in Text("\(cats[i]["emoji"].str) \(cats[i]["name"].str)").tag(cats[i]["name"].str) }
                }.pickerStyle(.menu).frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text(category).font(.headline).frame(maxWidth: .infinity, alignment: .leading)
            }
            Field(placeholder: "Limite al mese in €", text: $amount, keyboard: .decimalPad)
            if current > 0 {
                Text("Lascia 0 per togliere il limite (ora \(Fmt.eur(current))).").font(.footnote).foregroundStyle(T.text3)
            }
        }
        .onAppear { if current > 0 && amount.isEmpty { amount = Fmt.num(current, current == current.rounded() ? 0 : 2) } }
    }
}

struct GoalForm: View {
    @EnvironmentObject var app: AppState
    @State private var name = ""
    @State private var target = ""
    @State private var hasDeadline = false
    @State private var deadline = Calendar.current.date(byAdding: .month, value: 6, to: Date()) ?? Date()

    var body: some View {
        FormShell(title: "Nuovo obiettivo", canSave: !name.isEmpty && Fmt.parse(target) > 0) {
            var d: [String: JSON] = ["name": .string(name), "target": .number(Fmt.parse(target))]
            if hasDeadline { d["deadline"] = .string(Fmt.dayKey(deadline)) }
            let r = await app.financeOp("goals", "add", data: .object(d))
            return r != nil
        } content: {
            Field(placeholder: "Obiettivo (es. Viaggio)", text: $name)
            Field(placeholder: "Da raggiungere in €", text: $target, keyboard: .decimalPad)
            Toggle("Ha una scadenza", isOn: $hasDeadline)
            if hasDeadline { DatePicker("Entro il", selection: $deadline, in: Date()..., displayedComponents: .date) }
        }
    }
}

/// Adds money to a goal (or takes some out with a minus sign).
struct DepositForm: View {
    @EnvironmentObject var app: AppState
    let goal: JSON
    @State private var amount = ""

    var body: some View {
        FormShell(title: "Versa su \(goal["name"].str)", canSave: Fmt.parse(amount) != 0) {
            let saved = max(0, goal["saved"].num + Fmt.parse(amount))
            let r = await app.financeOp("goals", "update", id: goal["id"].int, data: ["saved": .number(saved)])
            return r != nil
        } content: {
            Text("Messi da parte: \(Fmt.eur(goal["saved"].num)) di \(Fmt.eur(goal["target"].num))").font(.footnote).foregroundStyle(T.text3)
                .frame(maxWidth: .infinity, alignment: .leading)
            #if os(macOS)
            Field(placeholder: "Importo in € (negativo per togliere)", text: $amount)
            #else
            Field(placeholder: "Importo in € (negativo per togliere)", text: $amount, keyboard: .numbersAndPunctuation)
            #endif
        }
    }
}
