import SwiftUI
import Charts

struct FinanzeView: View {
    @EnvironmentObject var app: AppState
    @State private var sheet: FinSheet?

    enum FinSheet: String, Identifiable { case account, asset, liability, tx, recurring; var id: String { rawValue } }

    private var accounts: [JSON] { app.data["accounts"].array }
    private var assets: [JSON] { app.data["assets"].array }
    private var liabilities: [JSON] { app.data["liabilities"].array }
    private var txs: [JSON] { app.data["transactions"].array.sorted { $0["date"].str > $1["date"].str } }
    private var recurring: [JSON] { app.data["recurringBuys"].array }

    private var cash: Double { accounts.reduce(0) { $0 + $1["balance"].num } }
    private var invested: Double { assets.reduce(0) { $0 + $1["qty"].num * $1["price"].num } }
    private var cost: Double { assets.reduce(0) { $0 + $1["qty"].num * $1["avg"].num } }
    private var debt: Double { liabilities.reduce(0) { $0 + $1["resid"].num } }

    private var monthTx: [JSON] {
        let cal = Calendar.current
        return txs.filter { t in
            guard let d = Fmt.date(t["date"].str) else { return false }
            return cal.isDate(d, equalTo: app.now, toGranularity: .month)
        }
    }

    var body: some View {
        Screen(title: "Finanze", chat: .finanze) {
            #if os(macOS)
            Row([2, 1]) { summaryCard; accountsCard }
            Row([2, 1]) { assetsCard; liabilitiesCard }
            Row([2, 1]) { txCard; recurringCard }
            #else
            summaryCard
            accountsCard
            assetsCard
            liabilitiesCard
            txCard
            recurringCard
            #endif
        }
        .sheet(item: $sheet) { s in
            switch s {
            case .account: AccountForm()
            case .asset: AssetForm()
            case .liability: LiabilityForm()
            case .tx: TxForm(accounts: accounts.map { $0["name"].str })
            case .recurring: RecurringForm()
            }
        }
    }

    private var summaryCard: some View {
        Card {
            CardLabel("PATRIMONIO NETTO")
            Text(Fmt.eur(cash + invested - debt)).font(.system(size: 36, weight: .heavy)).monospacedDigit()
            HStack {
                stat("Liquidità", cash, T.accent)
                stat("Investito", invested, T.green)
                stat("Passività", debt, T.red)
            }
            if cost > 0 {
                let pl = invested - cost
                HStack(spacing: 6) {
                    Text("Rendimento").foregroundStyle(T.text3)
                    Text("\(pl >= 0 ? "+" : "")\(Fmt.eur(pl)) (\(String(format: "%.1f", pl / cost * 100))%)")
                        .foregroundStyle(pl >= 0 ? T.green : T.red).fontWeight(.semibold)
                }.font(.footnote)
            }
        }
    }
    private func stat(_ label: String, _ v: Double, _ c: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(T.text3)
            Text(Fmt.eur(v)).font(.subheadline.weight(.semibold)).foregroundStyle(c)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func header(_ label: String, _ s: FinSheet) -> some View {
        HStack {
            CardLabel(label); Spacer()
            Button { sheet = s } label: { Image(systemName: "plus.circle.fill").font(.title3) }
        }
    }

    private func removeButton(_ action: @escaping () async -> Void) -> some View {
        Button(role: .destructive) { Task { await action() } } label: { Image(systemName: "trash").font(.footnote).foregroundStyle(T.text3) }
            .buttonStyle(.plain)
    }

    private var accountsCard: some View {
        Card {
            header("CONTI", .account)
            if accounts.isEmpty { empty("Nessun conto.") }
            ForEach(accounts.indices, id: \.self) { i in
                let a = accounts[i]
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(a["name"].str).font(.subheadline.weight(.semibold))
                        Text("\(a["inst"].str.isEmpty ? "" : a["inst"].str + " · ")\(a["type"].str)").font(.caption).foregroundStyle(T.text3)
                    }
                    Spacer()
                    Text(Fmt.eur(a["balance"].num)).font(.subheadline.weight(.semibold)).monospacedDigit()
                    removeButton { _ = await app.financeOp("accounts", "remove", id: a["id"].int) }
                }
            }
        }
    }

    private var assetsCard: some View {
        Card {
            header("INVESTIMENTI", .asset)
            if assets.isEmpty { empty("Nessun investimento.") }
            ForEach(assets.indices, id: \.self) { i in
                PushLink { AssetDetail(assetId: assets[i]["id"].int) } label: { assetRow(assets[i]) }.buttonStyle(.plain)
                if i < assets.count - 1 { Divider().overlay(T.border) }
            }
        }
    }
    private func assetRow(_ a: JSON) -> some View {
        let value = a["qty"].num * a["price"].num
        let basis = a["qty"].num * a["avg"].num
        let pl = value - basis
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(a["name"].str).font(.subheadline.weight(.semibold))
                    Text("\(a["symbol"].str) · \(Fmt.num(a["qty"].num, 4).replacingOccurrences(of: #"\.?0+$"#, with: "", options: .regularExpression)) × \(Fmt.eur(a["price"].num, decimals: 2))")
                        .font(.caption).foregroundStyle(T.text3)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(Fmt.eur(value)).font(.subheadline.weight(.semibold)).monospacedDigit()
                    if basis > 0 {
                        Text("\(pl >= 0 ? "+" : "")\(Fmt.eur(pl)) (\(String(format: "%.1f", pl / basis * 100))%)")
                            .font(.caption.weight(.semibold)).foregroundStyle(pl >= 0 ? T.green : T.red)
                    }
                }
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(T.text3)
            }
            HStack(spacing: 14) {
                DeltaChip(label: "24h", pct: a["d24"].num)
                DeltaChip(label: "7g", pct: a["d7"].num)
                DeltaChip(label: "30g", pct: a["d30"].num)
                DeltaChip(label: "1a", pct: a["d1a"].num)
            }
        }
    }

    private var liabilitiesCard: some View {
        Card {
            header("PASSIVITÀ", .liability)
            if liabilities.isEmpty { empty("Nessuna passività.") }
            ForEach(liabilities.indices, id: \.self) { i in
                let l = liabilities[i]
                let orig = l["original"].num, resid = l["resid"].num
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(l["name"].str).font(.subheadline.weight(.semibold))
                        Spacer()
                        Text(Fmt.eur(resid)).font(.subheadline.weight(.semibold)).foregroundStyle(T.red).monospacedDigit()
                        removeButton { _ = await app.financeOp("liabilities", "remove", id: l["id"].int) }
                    }
                    ProgressBar(value: orig > 0 ? (orig - resid) / orig : 0, tint: T.green)
                    HStack {
                        Text("Originale \(Fmt.eur(orig))")
                        Spacer()
                        if !l["nextDate"].str.isEmpty { Text("Prossima rata \(l["nextDate"].str)") }
                    }.font(.caption).foregroundStyle(T.text3)
                }
            }
        }
    }

    private var txCard: some View {
        let spent = monthTx.filter { $0["type"].str == "spesa" }.reduce(0) { $0 + $1["amount"].num }
        let earned = monthTx.filter { $0["type"].str == "entrata" }.reduce(0) { $0 + $1["amount"].num }
        return Card {
            header("MOVIMENTI · \(Fmt.it(app.now, "MMMM").uppercased())", .tx)
            HStack {
                stat("Entrate", earned, T.green)
                stat("Spese", spent, T.red)
                stat("Saldo", earned - spent, earned >= spent ? T.green : T.red)
            }
            if txs.isEmpty { empty("Nessun movimento.") }
            ForEach(txs.prefix(12).indices, id: \.self) { i in
                let t = txs[i]
                let isIn = t["type"].str == "entrata"
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(t["category"].str).font(.subheadline.weight(.semibold))
                        Text([Fmt.date(t["date"].str).map { Fmt.it($0, "d MMM HH:mm") }, t["account"].string.flatMap { $0.isEmpty ? nil : $0 }]
                            .compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(T.text3)
                    }
                    Spacer()
                    Text("\(isIn ? "+" : "−")\(Fmt.eur(t["amount"].num, decimals: 2))")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(isIn ? T.green : T.text1).monospacedDigit()
                    removeButton { _ = await app.financeOp("transactions", "remove", id: t["id"].int) }
                }
            }
        }
    }

    private var recurringCard: some View {
        Card {
            header("PIANO DI ACCUMULO (PAC)", .recurring)
            if recurring.isEmpty { empty("Nessun acquisto ricorrente.") }
            ForEach(recurring.indices, id: \.self) { i in
                let r = recurring[i]
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(r["name"].str) (\(r["symbol"].str))").font(.subheadline.weight(.semibold))
                        Text("\(Fmt.eur(r["amountEur"].num)) · \(r["frequency"].str == "weekly" ? "settimanale" : "mensile") · prossimo \(Fmt.date(r["nextRunIso"].str).map { Fmt.it($0, "d MMM") } ?? "—")")
                            .font(.caption).foregroundStyle(T.text3)
                    }
                    Spacer()
                    Toggle("", isOn: Binding(get: { r["active"].bool }, set: { v in
                        Task { _ = await app.financeOp("recurringBuys", "update", id: r["id"].int, data: ["active": .bool(v)]) }
                    })).labelsHidden()
                    removeButton { _ = await app.financeOp("recurringBuys", "remove", id: r["id"].int) }
                }
            }
        }
    }

    private func empty(_ t: String) -> some View { Text(t).font(.subheadline).foregroundStyle(T.text3) }
}

// MARK: - Asset detail (chart + lots)

struct AssetDetail: View {
    @EnvironmentObject var app: AppState
    let assetId: Int
    private var asset: JSON { app.data["assets"].array.first { $0["id"].int == assetId } ?? .null }

    var body: some View {
        let points: [(Date, Double)] = asset["priceHistory"].array.compactMap { p in
            Fmt.date(p["date"].str).map { ($0, p["price"].num) }
        }
        ZStack {
            Backdrop()
            ScrollView {
                VStack(spacing: 16) {
                    Card {
                        Text(asset["name"].str).font(.title3.weight(.bold))
                        Text(Fmt.eur(asset["price"].num, decimals: 2)).font(.system(size: 32, weight: .heavy))
                        if points.count > 1 {
                            Chart {
                                ForEach(points.indices, id: \.self) { i in
                                    LineMark(x: .value("Data", points[i].0), y: .value("Prezzo", points[i].1))
                                        .foregroundStyle(T.accent).interpolationMethod(.monotone)
                                }
                                RuleMark(y: .value("Medio", asset["avg"].num))
                                    .foregroundStyle(T.amber).lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                            }
                            .chartYScale(domain: .automatic(includesZero: false))
                            .frame(height: 180)
                            Text("Linea tratteggiata: prezzo medio di carico \(Fmt.eur(asset["avg"].num, decimals: 2))")
                                .font(.caption).foregroundStyle(T.text3)
                        }
                    }
                    Card {
                        CardLabel("ACQUISTI")
                        let lots = asset["lots"].array
                        ForEach(lots.indices, id: \.self) { i in
                            let l = lots[i]
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("\(Fmt.num(l["qty"].num, 6).replacingOccurrences(of: #"\.?0+$"#, with: "", options: .regularExpression)) @ \(Fmt.eur(l["price"].num, decimals: 2))").font(.subheadline.weight(.semibold))
                                    Text(Fmt.date(l["date"].str).map { Fmt.it($0, "d MMM yyyy HH:mm") } ?? l["date"].str).font(.caption).foregroundStyle(T.text3)
                                }
                                Spacer()
                                Button(role: .destructive) {
                                    Task { _ = await app.financeOp("assets", "removeLot", id: assetId, lotId: l["id"].int) }
                                } label: { Image(systemName: "trash").foregroundStyle(T.text3) }
                            }
                        }
                        Button("Elimina posizione", role: .destructive) {
                            Task { _ = await app.financeOp("assets", "remove", id: assetId) }
                        }.font(.footnote)
                    }
                }.padding(16)
            }
        }
        .navigationTitle(asset["symbol"].str)
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Forms

struct FormShell<Content: View>: View {
    let title: String
    let canSave: Bool
    let save: () async -> Bool
    @ViewBuilder var content: Content
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    var body: some View {
        NavigationStack {
            ZStack {
                Backdrop()
                ScrollView { VStack(spacing: 12) { content }.padding(16) }
            }
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annulla") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Salva") { Task { busy = true; if await save() { dismiss() }; busy = false } }
                        .disabled(!canSave || busy)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

struct AccountForm: View {
    @EnvironmentObject var app: AppState
    @State private var name = ""
    @State private var inst = ""
    @State private var balance = ""
    @State private var type = "banche"
    var body: some View {
        FormShell(title: "Nuovo conto", canSave: !name.isEmpty) {
            let r = await app.financeOp("accounts", "add", data: ["name": .string(name), "inst": .string(inst), "type": .string(type), "balance": .number(Fmt.parse(balance))])
            return r != nil
        } content: {
            Field(placeholder: "Nome", text: $name)
            Field(placeholder: "Istituto", text: $inst)
            Field(placeholder: "Saldo", text: $balance, keyboard: .decimalPad)
            Picker("Tipo", selection: $type) { Text("Banca").tag("banche"); Text("Broker").tag("broker"); Text("Crypto").tag("crypto") }.pickerStyle(.segmented)
        }
    }
}

struct AssetForm: View {
    @EnvironmentObject var app: AppState
    @State private var name = ""
    @State private var symbol = ""
    @State private var qty = ""
    @State private var assetClass = "stock"
    @State private var date = Date()
    @State private var err: String?
    var body: some View {
        FormShell(title: "Nuovo investimento", canSave: !name.isEmpty && !symbol.isEmpty && Fmt.parse(qty) > 0) {
            // The bridge resolves today's price and the historical cost basis from the purchase moment.
            let r = await app.financeOp("assets", "add", data: [
                "name": .string(name), "symbol": .string(symbol.uppercased()), "assetClass": .string(assetClass),
                "qty": .number(Fmt.parse(qty)), "purchaseDateIso": .string(Fmt.iso.string(from: date)),
            ])
            return r != nil
        } content: {
            Field(placeholder: "Nome (es. Bitcoin)", text: $name)
            Field(placeholder: "Simbolo (es. BTC, EUNL)", text: $symbol, keyboard: .asciiCapable)
            Field(placeholder: "Quantità", text: $qty, keyboard: .decimalPad)
            Picker("Classe", selection: $assetClass) { Text("Azione/ETF").tag("stock"); Text("Crypto").tag("crypto") }.pickerStyle(.segmented)
            DatePicker("Data acquisto", selection: $date, in: ...Date()).foregroundStyle(T.text1)
            if let e = app.error { Text(e).font(.footnote).foregroundStyle(T.red) }
        }
    }
}

struct LiabilityForm: View {
    @EnvironmentObject var app: AppState
    @State private var name = ""
    @State private var original = ""
    @State private var resid = ""
    @State private var next = ""
    var body: some View {
        FormShell(title: "Nuova passività", canSave: !name.isEmpty) {
            let r = await app.financeOp("liabilities", "add", data: ["name": .string(name), "original": .number(Fmt.parse(original)), "resid": .number(Fmt.parse(resid)), "nextDate": .string(next)])
            return r != nil
        } content: {
            Field(placeholder: "Nome (es. Mutuo)", text: $name)
            Field(placeholder: "Importo originale", text: $original, keyboard: .decimalPad)
            Field(placeholder: "Residuo", text: $resid, keyboard: .decimalPad)
            Field(placeholder: "Prossima rata (es. 05/11)", text: $next)
        }
    }
}

struct TxForm: View {
    @EnvironmentObject var app: AppState
    let accounts: [String]
    @State private var kind = "spesa"
    @State private var amount = ""
    @State private var category = ""
    @State private var account = ""
    var body: some View {
        FormShell(title: "Nuovo movimento", canSave: Fmt.parse(amount) > 0) {
            let r = await app.financeOp("transactions", "add", data: ["tx_type": .string(kind), "amount": .number(Fmt.parse(amount)), "category": .string(category), "account": .string(account)])
            return r != nil
        } content: {
            Picker("Tipo", selection: $kind) { Text("Spesa").tag("spesa"); Text("Entrata").tag("entrata") }.pickerStyle(.segmented)
            Field(placeholder: "Importo", text: $amount, keyboard: .decimalPad)
            Field(placeholder: "Categoria", text: $category)
            if !accounts.isEmpty {
                Picker("Conto", selection: $account) {
                    Text("—").tag("")
                    ForEach(accounts, id: \.self) { Text($0).tag($0) }
                }.tint(T.accent)
            }
        }
    }
}

struct RecurringForm: View {
    @EnvironmentObject var app: AppState
    @State private var name = ""
    @State private var symbol = ""
    @State private var amount = ""
    @State private var assetClass = "stock"
    @State private var freq = "monthly"
    @State private var next = Date()
    var body: some View {
        FormShell(title: "Nuovo PAC", canSave: !symbol.isEmpty && Fmt.parse(amount) > 0) {
            let r = await app.financeOp("recurringBuys", "add", data: [
                "name": .string(name.isEmpty ? symbol.uppercased() : name), "symbol": .string(symbol.uppercased()),
                "assetClass": .string(assetClass), "amountEur": .number(Fmt.parse(amount)),
                "frequency": .string(freq), "nextRunIso": .string(Fmt.iso.string(from: next)),
            ])
            return r != nil
        } content: {
            Field(placeholder: "Nome", text: $name)
            Field(placeholder: "Simbolo", text: $symbol, keyboard: .asciiCapable)
            Field(placeholder: "Importo in €", text: $amount, keyboard: .decimalPad)
            Picker("Classe", selection: $assetClass) { Text("Azione/ETF").tag("stock"); Text("Crypto").tag("crypto") }.pickerStyle(.segmented)
            Picker("Frequenza", selection: $freq) { Text("Mensile").tag("monthly"); Text("Settimanale").tag("weekly") }.pickerStyle(.segmented)
            DatePicker("Primo acquisto", selection: $next).foregroundStyle(T.text1)
        }
    }
}
