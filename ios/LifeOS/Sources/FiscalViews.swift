import SwiftUI

// The Fiscale tab of Finanze: 730 deductions and an ISEE estimate. The figures come from the bridge
// (`fiscal` in /api/lifeos-data, computed in bridge/lifeos-fiscal.mjs); they are estimates, and the page says so.

struct FiscalSection: View {
    @EnvironmentObject var app: AppState
    @State private var sheet: FiscalSheet?

    enum FiscalSheet: String, Identifiable { case settings, property; var id: String { rawValue } }

    private var f: JSON { app.data["fiscal"] }
    private var tax: JSON { f["tax"] }
    private var isee: JSON { f["isee"] }

    private func eur(_ v: Double) -> String { Fmt.eur(v, decimals: 2) }

    var body: some View {
        Group {
            if f.isNull {
                Card { Text("Le stime fiscali non sono disponibili: ricarica la schermata.").font(.subheadline).foregroundStyle(T.text3) }
            } else {
                #if os(macOS)
                Row([1]) { noteCard }
                Row([2, 1]) { deductionsCard; iseeCard }
                Row([2, 1]) { settingsCard; propertiesCard }
                #else
                noteCard
                deductionsCard
                iseeCard
                settingsCard
                propertiesCard
                #endif
            }
        }
        .sheet(item: $sheet) { s in
            switch s {
            case .settings: FiscalSettingsForm()
            case .property: PropertyForm()
            }
        }
    }

    private var noteCard: some View {
        Card {
            CardLabel("STIME FISCALI")
            Text("Sono stime per ragionare, non una dichiarazione: i dati veri sono la tua CU, le ricevute e quello che compila il CAF. Aliquote e soglie sono quelle in vigore per il \(tax["year"].int) (i dati dell'ISEE seguono la legge di bilancio 2026) e vanno verificate prima di usarle.")
                .font(.footnote).foregroundStyle(T.text3)
        }
    }

    // MARK: 730

    private var deductionsCard: some View {
        Card {
            CardLabel("730 · SPESE DETRAIBILI \(f["expensesYear"].int)")
            ForEach(f["deductions"].array.indices, id: \.self) { i in
                let d = f["deductions"].array[i]
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(d["label"].str).font(.subheadline.weight(.semibold))
                        Spacer()
                        Text(eur(d["spent"].num)).font(.footnote).monospacedDigit()
                        Text(d["counted"].bool ? "→ \(eur(d["detraction"].num))" : "da verificare")
                            .font(.footnote.weight(.bold)).monospacedDigit()
                            .foregroundStyle(d["counted"].bool ? T.green : T.text3)
                    }
                    Text(deductionNote(d)).font(.caption2).foregroundStyle(T.text3)
                }
            }
            Divider().overlay(T.border)
            line("Reddito complessivo", eur(tax["income"].num))
            line("IRPEF lorda", eur(tax["grossTax"].num))
            if tax["childDeduction"].num > 0 { line("Detrazione figli a carico (21+)", "− \(eur(tax["childDeduction"].num))", T.green) }
            line(tax["employee"].bool ? "Detrazione lavoro dipendente" : "Detrazione lavoro (non applicata)", "− \(eur(tax["workDeduction"].num))", T.green)
            line("Detrazioni al 19%", "− \(eur(tax["deductions19"].num))", T.green)
            line("IRPEF netta stimata", eur(tax["netTax"].num), bold: true)
            if let bal = tax["balance"].double {
                line(bal >= 0 ? "Rimborso stimato" : "Da versare stimato", eur(abs(bal)), bal >= 0 ? T.green : T.red, bold: true)
            } else {
                line("Saldo (inserisci le ritenute della CU)", "—", T.text3)
            }
            Text("Prima delle addizionali regionale e comunale. Le detrazioni per i figli sotto i 21 anni non ci sono più: le ha sostituite l'assegno unico.")
                .font(.caption2).foregroundStyle(T.text3)
        }
    }

    private func deductionNote(_ d: JSON) -> String {
        var s = ""
        if d["franchise"].num > 0 { s += "Franchigia \(eur(d["franchise"].num)). " }
        if let cap = d["cap"].double { s += "Tetto \(eur(cap)). " }
        return s + d["note"].str
    }

    private func line(_ l: String, _ v: String, _ tint: Color = T.text1, bold: Bool = false) -> some View {
        HStack {
            Text(l).font(.footnote).foregroundStyle(T.text2)
            Spacer()
            Text(v).font(.footnote.weight(bold ? .heavy : .semibold)).monospacedDigit().foregroundStyle(tint)
        }
    }

    // MARK: ISEE

    private var iseeCard: some View {
        Card {
            CardLabel("ISEE STIMATO")
            Text(eur(isee["isee"].num)).font(.system(size: 32, weight: .heavy)).monospacedDigit()
            Text("ISE \(eur(isee["ise"].num)) diviso scala di equivalenza \(Fmt.num(isee["scale"].num, 2).replacingOccurrences(of: ".", with: ",")) (\(f["household"]["size"].int) persone). Riferito al \(isee["referenceYear"].int).")
                .font(.footnote).foregroundStyle(T.text3)
            line("Reddito (ISR)", eur(isee["isr"].num))
            line("Patrimonio mobiliare" + (isee["mobiliare"]["estimated"].bool ? " (saldi di oggi)" : ""), eur(isee["mobiliare"]["value"].num))
            line("Franchigia mobiliare", "− \(eur(isee["mobiliare"]["franchise"].num))")
            line("Patrimonio immobiliare contato", eur(isee["immobiliare"]["isp"].num))
            line("Franchigia prima casa", eur(isee["immobiliare"]["homeFranchise"].num))
            line("Patrimonio (ISP) × 20%", eur(isee["isp"].num * 0.2))
            ForEach(isee["missing"].array.indices, id: \.self) { i in
                Text(isee["missing"].array[i].str).font(.caption).foregroundStyle(T.amber)
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(T.glassSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }
    }

    // MARK: Household + properties

    private var settingsCard: some View {
        Card {
            HStack { CardLabel("NUCLEO E REDDITO"); Spacer()
                Button { sheet = .settings } label: { Image(systemName: "pencil.circle.fill").font(.title3) } }
            let s = f["settings"]
            line("Adulti / figli", "\(f["household"]["adults"].int) / \(f["household"]["children"].int) (\(f["household"]["adultChildren"].int) maggiorenni, \(f["household"]["childrenOver21"].int) con 21+)")
            line("Reddito complessivo", eur(s["income"].num))
            line("Ritenute della CU", s["withholdings"].num > 0 ? eur(s["withholdings"].num) : "da inserire", s["withholdings"].num > 0 ? T.text1 : T.text3)
            line("Lavoro", s["employee"].bool ? "Dipendente" : "Autonomo / altro")
            line("Patrimonio mobiliare al 31/12", s["mobiliare"].double.map { eur($0) } ?? "da inserire", s["mobiliare"].double == nil ? T.text3 : T.text1)
        }
    }

    private var propertiesCard: some View {
        Card {
            HStack { CardLabel("IMMOBILI"); Spacer()
                Button { sheet = .property } label: { Image(systemName: "plus.circle.fill").font(.title3) } }
            let items = isee["immobiliare"]["items"].array
            if items.isEmpty {
                Text("Nessun immobile registrato. Servono per l'ISEE: valore ai fini IMU, quota posseduta e mutuo residuo al 31/12.")
                    .font(.footnote).foregroundStyle(T.text3)
            }
            ForEach(items.indices, id: \.self) { i in
                let p = items[i]
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(p["name"].str + (p["main"].bool ? " · abitazione principale" : "")).font(.subheadline.weight(.semibold))
                        Spacer()
                        Text(eur(p["value"].num)).font(.footnote.weight(.semibold)).monospacedDigit()
                        Button(role: .destructive) { Task { _ = await app.financeOp("properties", "remove", id: p["id"].int) } } label: {
                            Image(systemName: "trash").font(.footnote).foregroundStyle(T.text3)
                        }.buttonStyle(.plain)
                    }
                    Text("mutuo residuo \(eur(p["mortgage"].num)) · patrimonio \(eur(p["equity"].num)) · conta per l'ISEE \(eur(p["counted"].num))")
                        .font(.caption2).foregroundStyle(T.text3)
                }
            }
        }
    }
}

// MARK: - Forms

struct FiscalSettingsForm: View {
    @EnvironmentObject var app: AppState
    @State private var adults = ""
    @State private var children = ""
    @State private var adultChildren = ""
    @State private var over21 = ""
    @State private var income = ""
    @State private var withholdings = ""
    @State private var mobiliare = ""
    @State private var interest = ""
    @State private var donations = ""
    @State private var employee = true
    @State private var bothWork = false

    var body: some View {
        FormShell(title: "Nucleo e reddito", canSave: Fmt.parse(adults) >= 1) {
            var d: [String: JSON] = [
                "adults": .number(Fmt.parse(adults)), "children": .number(Fmt.parse(children)), "adultChildren": .number(Fmt.parse(adultChildren)), "childrenOver21": .number(Fmt.parse(over21)), "income": .number(Fmt.parse(income)),
                "withholdings": .number(Fmt.parse(withholdings)), "mortgageInterest": .number(Fmt.parse(interest)),
                "donations": .number(Fmt.parse(donations)), "employee": .bool(employee), "bothWork": .bool(bothWork),
            ]
            d["mobiliare"] = mobiliare.trimmingCharacters(in: .whitespaces).isEmpty ? .null : .number(Fmt.parse(mobiliare))
            return await app.financeOp("fiscal", "add", data: .object(d)) != nil
        } content: {
            Field(placeholder: "Adulti nel nucleo", text: $adults, keyboard: .numberPad)
            Field(placeholder: "Figli (tutti)", text: $children, keyboard: .numberPad)
            Field(placeholder: "Di cui maggiorenni", text: $adultChildren, keyboard: .numberPad)
            Field(placeholder: "Di cui con 21 anni o più", text: $over21, keyboard: .numberPad)
            Field(placeholder: "Reddito complessivo in € l'anno", text: $income, keyboard: .decimalPad)
            Field(placeholder: "Ritenute della CU in €", text: $withholdings, keyboard: .decimalPad)
            Field(placeholder: "Patrimonio mobiliare al 31/12 in € (vuoto = saldi di oggi)", text: $mobiliare, keyboard: .decimalPad)
            Field(placeholder: "Interessi del mutuo pagati in €", text: $interest, keyboard: .decimalPad)
            Field(placeholder: "Erogazioni liberali in €", text: $donations, keyboard: .decimalPad)
            Toggle("Lavoro dipendente", isOn: $employee)
            Toggle("Entrambi i genitori lavorano", isOn: $bothWork)
        }
        .onAppear {
            let f = app.data["fiscal"]; let s = f["settings"]
            func n(_ v: Double) -> String { v == 0 ? "" : Fmt.num(v, v == v.rounded() ? 0 : 2) }
            adults = "\(f["household"]["adults"].int)"; children = "\(f["household"]["children"].int)"; adultChildren = "\(f["household"]["adultChildren"].int)"; over21 = "\(f["household"]["childrenOver21"].int)"
            income = n(s["income"].num); withholdings = n(s["withholdings"].num); interest = n(s["mortgageInterest"].num)
            donations = n(s["donations"].num); mobiliare = s["mobiliare"].double.map { n($0) } ?? ""
            employee = s["employee"].bool; bothWork = s["bothWork"].bool
        }
    }
}

struct PropertyForm: View {
    @EnvironmentObject var app: AppState
    @State private var name = ""
    @State private var value = ""
    @State private var share = ""
    @State private var mortgage = ""
    @State private var main = false

    var body: some View {
        FormShell(title: "Nuovo immobile", canSave: !name.isEmpty && Fmt.parse(value) > 0) {
            let r = await app.financeOp("properties", "add", data: [
                "name": .string(name), "value": .number(Fmt.parse(value)), "share": .number(share.isEmpty ? 100 : Fmt.parse(share)),
                "mortgage": .number(Fmt.parse(mortgage)), "main": .bool(main),
            ])
            return r != nil
        } content: {
            Field(placeholder: "Nome (es. Casa)", text: $name)
            Field(placeholder: "Valore ai fini IMU in €", text: $value, keyboard: .decimalPad)
            Field(placeholder: "Quota posseduta in % (vuoto = 100)", text: $share, keyboard: .decimalPad)
            Field(placeholder: "Mutuo residuo al 31/12 in €", text: $mortgage, keyboard: .decimalPad)
            Toggle("Abitazione principale", isOn: $main)
        }
    }
}
