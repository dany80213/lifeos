import SwiftUI
import UniformTypeIdentifiers

// MARK: - State

extension AppState {
    /// Sends a bank statement (BuddyBank .xls, Revolut .csv, Satispay .xlsx) to the bridge, which recognises it,
    /// files the movements under the right account and queues whatever it isn't sure about (`pendingImports`).
    func importStatement(_ file: Data) async -> JSON? {
        await mutate { try await api.request("/api/lifeos-import", method: "POST", body: ["data": .string(file.base64EncodedString())]) }
    }

    /// The answer to one pop-up: a category, "tra amici" or "giroconto, ignora". The bridge remembers it.
    func resolveImport(_ id: Int, kind: String, category: String = "") async -> Bool {
        var choice: [String: JSON] = ["kind": .string(kind)]
        if !category.isEmpty { choice["category"] = .string(category) }
        let r = await mutate { try await api.request("/api/lifeos-import-resolve", method: "POST", body: ["id": .number(Double(id)), "choice": .object(choice)]) }
        return r != nil && r?["error"].string == nil
    }

    var pendingImports: [JSON] { data["pendingImports"].array }
}

// MARK: - Import card

struct StatementImportCard: View {
    @EnvironmentObject var app: AppState
    @Binding var asking: Bool
    @State private var picking = false
    @State private var busy = false
    @State private var report: String?

    var body: some View {
        Card {
            CardLabel("IMPORTA ESTRATTO CONTO")
            Text("Scegli il file di BuddyBank, Revolut o Satispay: riconosco la banca, registro i movimenti nel conto giusto e ti chiedo solo quando ho un dubbio.")
                .font(.footnote).foregroundStyle(T.text3)
            Button { picking = true } label: {
                HStack { if busy { ProgressView() } else { Image(systemName: "square.and.arrow.down") }; Text(busy ? "Importo…" : "Scegli file") }
            }.buttonStyle(PillButtonStyle()).disabled(busy)
            if let report { Text(report).font(.footnote).foregroundStyle(T.text2) }
            if !app.pendingImports.isEmpty {
                Button { asking = true } label: {
                    HStack {
                        Image(systemName: "questionmark.bubble.fill")
                        Text("\(app.pendingImports.count) movimenti da classificare")
                        Spacer(); Image(systemName: "chevron.right").font(.caption)
                    }.font(.subheadline.weight(.semibold)).foregroundStyle(T.accent)
                }.buttonStyle(.plain)
            }
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.data], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            Task { await run(urls) }
        }
    }

    private func run(_ urls: [URL]) async {
        busy = true; defer { busy = false }
        var lines: [String] = []
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let bytes = try? Data(contentsOf: url) else { lines.append("\(url.lastPathComponent): file non leggibile."); continue }
            if let r = await app.importStatement(bytes) {
                lines.append("\(r["account"].str): \(r["added"].int) nuovi, \(r["duplicates"].int) già presenti, \(r["ownTransfers"].int) giroconti ignorati" +
                    (r["toAsk"].int > 0 ? ", \(r["toAsk"].int) da classificare" : "") + ".")
            } else {
                lines.append("\(url.lastPathComponent): \(app.error ?? "formato non riconosciuto").")
            }
        }
        report = lines.joined(separator: "\n")
        if !app.pendingImports.isEmpty { asking = true }
    }
}

// MARK: - The pop-up

/// One doubtful movement at a time. Every answer is remembered by the bridge, so the same merchant or person
/// never asks twice, and the other waiting movements of theirs are filed at once.
struct ImportQuestionSheet: View {
    @EnvironmentObject var app: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var pickingCategory = false
    @State private var picked = ""

    private var item: JSON? { app.pendingImports.first }

    var body: some View {
        NavigationStack {
            ZStack {
                Backdrop()
                if let q = item {
                    ScrollView { VStack(spacing: 14) { content(q) }.padding(16) }
                        .id(q["id"].int)
                } else {
                    Text("Tutto classificato.").foregroundStyle(T.text3)
                }
            }
            .navigationTitle("Da classificare").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Dopo") { dismiss() } } }
        }
        .presentationDetents([.large])
        .onChange(of: app.pendingImports.isEmpty) { _, empty in if empty { dismiss() } }
        .sheet(isPresented: $pickingCategory) {
            CategoryPickerSheet(kind: item?["type"].str == "entrata" ? "entrata" : "spesa", selected: $picked)
        }
        .onChange(of: picked) { _, name in
            guard !name.isEmpty, let q = item else { return }
            picked = ""
            answer(q, "category", name)
        }
    }

    @ViewBuilder private func content(_ q: JSON) -> some View {
        let isIn = q["type"].str == "entrata"
        Card {
            CardLabel("\(app.pendingImports.count) DA CLASSIFICARE · \(q["account"].str.uppercased())")
            Text(q["description"].str).font(.title3.weight(.bold))
            Text("\(isIn ? "+" : "−")\(Fmt.eur(q["amount"].num, decimals: 2))")
                .font(.system(size: 34, weight: .heavy)).monospacedDigit().foregroundStyle(isIn ? T.green : T.text1)
            Text([Fmt.date(q["date"].str).map { Fmt.it($0, "d MMMM yyyy") }, q["detail"].string].compactMap { $0 }.filter { !$0.isEmpty && $0 != q["description"].str }.joined(separator: " · "))
                .font(.caption).foregroundStyle(T.text3).lineLimit(3)
        }
        if q["person"].bool {
            bigButton("Tra amici", "person.2.fill", tint: T.accent) { answer(q, "amici") }
        }
        let suggestion = q["suggestion"].str
        let cats = FinanceCatalog.categories(app.data, kind: isIn ? "entrata" : "spesa")
        VStack(alignment: .leading, spacing: 8) {
            CardLabel(q["person"].bool ? "OPPURE UNA CATEGORIA" : "CATEGORIA")
            ForEach(cats.indices, id: \.self) { i in
                let c = cats[i]
                Button { answer(q, "category", c["name"].str) } label: {
                    HStack(spacing: 12) {
                        CategoryBadge(emoji: c["emoji"].str, size: 34)
                        Text(c["name"].str).font(.subheadline.weight(.semibold)).foregroundStyle(T.text1)
                        Spacer()
                        if c["name"].str == suggestion { Text("suggerita").font(.caption2).foregroundStyle(T.text3) }
                    }
                    .padding(10).background(T.glass, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }.buttonStyle(.plain)
            }
            Button { pickingCategory = true } label: {
                Label("Nuova categoria…", systemImage: "plus.circle").font(.subheadline.weight(.semibold))
            }.buttonStyle(.plain).foregroundStyle(T.accent).padding(.top, 4)
        }
        if !q["person"].bool {
            bigButton("Tra amici", "person.2", tint: T.text2) { answer(q, "amici") }
        }
        bigButton("Giroconto: ignora", "arrow.left.arrow.right", tint: T.text3) { answer(q, "ignore") }
        Text("Ricordo la scelta: la prossima volta non te lo chiedo più.").font(.caption).foregroundStyle(T.text3)
    }

    private func bigButton(_ title: String, _ icon: String, tint: Color, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon).font(.subheadline.weight(.bold)).foregroundStyle(tint)
                .frame(maxWidth: .infinity).padding(.vertical, 13)
                .background(T.glass, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }.buttonStyle(.plain).disabled(busy)
    }

    private func answer(_ q: JSON, _ kind: String, _ category: String = "") {
        guard !busy else { return }
        busy = true
        Task { _ = await app.resolveImport(q["id"].int, kind: kind, category: category); busy = false }
    }
}

// MARK: - Friends

/// Money moved with friends, kept out of spese/entrate. Per person the balance is what they owe you (+, green)
/// or what you owe them (−, red): what you sent them minus what they sent you.
struct FriendsCard: View {
    @EnvironmentObject var app: AppState

    private struct Friend: Identifiable { let id: String; let name: String; let net: Double; let rows: [JSON] }

    private var friends: [Friend] {
        let rows = app.data["friendTx"].array
        let groups = Dictionary(grouping: rows) { $0["friend"].str.lowercased() }
        return groups.map { k, v in
            Friend(id: k, name: v[0]["friend"].str, net: -v.reduce(0) { $0 + $1["amount"].num },
                   rows: v.sorted { $0["date"].str > $1["date"].str })
        }.sorted { abs($0.net) > abs($1.net) }
    }

    var body: some View {
        Card {
            CardLabel("TRA AMICI")
            if friends.isEmpty {
                Text("Nessun movimento tra amici. Quando importi un estratto e scegli «Tra amici», compare qui.")
                    .font(.subheadline).foregroundStyle(T.text3)
            }
            ForEach(friends) { f in
                DisclosureGroup {
                    ForEach(f.rows.indices, id: \.self) { i in
                        let r = f.rows[i]
                        HStack {
                            Text(Fmt.date(r["date"].str).map { Fmt.it($0, "d MMM yyyy") } ?? "").font(.caption).foregroundStyle(T.text3)
                            Text(r["account"].str).font(.caption).foregroundStyle(T.text3)
                            Spacer()
                            Text("\(r["amount"].num >= 0 ? "+" : "−")\(Fmt.eur(abs(r["amount"].num), decimals: 2))")
                                .font(.footnote.weight(.semibold)).monospacedDigit().foregroundStyle(r["amount"].num >= 0 ? T.green : T.text1)
                            Button(role: .destructive) { Task { _ = await app.financeOp("friendTx", "remove", id: r["id"].int) } } label: {
                                Image(systemName: "trash").font(.footnote).foregroundStyle(T.text3)
                            }.buttonStyle(.plain)
                        }.padding(.top, 4)
                    }
                } label: {
                    HStack {
                        Image(systemName: "person.crop.circle.fill").foregroundStyle(T.text3)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(f.name).font(.subheadline.weight(.semibold))
                            Text(abs(f.net) < 0.005 ? "In pari" : f.net > 0 ? "Ti deve questa somma" : "Gli devi questa somma")
                                .font(.caption).foregroundStyle(T.text3)
                        }
                        Spacer()
                        Text("\(f.net >= 0 ? "+" : "−")\(Fmt.eur(abs(f.net), decimals: 2))")
                            .font(.subheadline.weight(.semibold)).monospacedDigit().foregroundStyle(abs(f.net) < 0.005 ? T.text3 : f.net > 0 ? T.green : T.red)
                    }
                }.tint(T.text3)
            }
        }
    }
}
