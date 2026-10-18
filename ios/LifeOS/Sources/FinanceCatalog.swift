import SwiftUI

extension Color {
    init(hex: String) {
        var s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "# "))
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        self.init(red: Double((v >> 16) & 255) / 255, green: Double((v >> 8) & 255) / 255, blue: Double(v & 255) / 255)
    }
}

/// Banks and categories come from the bridge (`financeCatalog` in /api/lifeos-data) so the apps, the web
/// and the assistant all share one list.
enum FinanceCatalog {
    static func banks(_ data: JSON) -> [JSON] { data["financeCatalog"]["banks"].array }
    static func categories(_ data: JSON, kind: String) -> [JSON] {
        data["financeCatalog"]["categories"].array.filter { $0["kind"].str == kind }
    }
    static func category(_ name: String, in data: JSON) -> JSON? {
        data["financeCatalog"]["categories"].array.first { $0["name"].str.lowercased() == name.lowercased() }
    }
    /// An account's bank: by its catalogue id, else by matching the old free-text institution/name.
    static func bank(for account: JSON, in data: JSON) -> JSON? {
        let list = banks(data)
        let id = account["bank"].str
        if !id.isEmpty, let b = list.first(where: { $0["id"].str == id }) { return b }
        let names = [account["inst"].str, account["name"].str].map { $0.lowercased() }.filter { !$0.isEmpty }
        return list.first { names.contains($0["name"].str.lowercased()) }
    }
}

/// The bank's own site icon (fetched at runtime, nothing is bundled), over a coloured monogram that stays
/// when the icon can't be loaded or there is no bank.
struct BankLogo: View {
    let bank: JSON?
    var fallbackName = ""
    var size: CGFloat = 38

    private var initials: String {
        if let i = bank?["initials"].string, !i.isEmpty { return i }
        return String(fallbackName.prefix(2)).uppercased()
    }
    private var iconURL: URL? {
        guard let d = bank?["domain"].string, !d.isEmpty else { return nil }
        return URL(string: "https://www.google.com/s2/favicons?domain=\(d)&sz=128")
    }
    var body: some View {
        ZStack {
            Color(hex: bank?["color"].string ?? "#6B7280")
            Text(initials)
                .font(.system(size: size * (initials.count > 2 ? 0.26 : 0.34), weight: .heavy))
                .foregroundStyle(bank?["darkText"].bool == true ? Color.black : Color.white)
                .minimumScaleFactor(0.6)
            if let iconURL {
                AsyncImage(url: iconURL) { phase in
                    if case .success(let img) = phase {
                        img.resizable().scaledToFit().padding(size * 0.16).background(Color.white)
                    }
                }
            }
        }
        .frame(width: size, height: size).clipShape(Circle())
    }
}

struct CategoryBadge: View {
    let emoji: String
    var size: CGFloat = 36
    var body: some View {
        Text(emoji.isEmpty ? "🏷️" : emoji).font(.system(size: size * 0.5))
            .frame(width: size, height: size).background(T.glass, in: Circle())
    }
}

/// Choose a bank from the catalogue; `selected` is the catalogue id.
struct BankPickerSheet: View {
    @EnvironmentObject var app: AppState
    @Environment(\.dismiss) private var dismiss
    @Binding var selected: String
    var body: some View {
        NavigationStack {
            ZStack {
                Backdrop()
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(FinanceCatalog.banks(app.data).indices, id: \.self) { i in
                            let b = FinanceCatalog.banks(app.data)[i]
                            Button { selected = b["id"].str; dismiss() } label: {
                                HStack(spacing: 12) {
                                    BankLogo(bank: b, size: 36)
                                    Text(b["name"].str).font(.subheadline.weight(.semibold)).foregroundStyle(T.text1)
                                    Spacer()
                                    if selected == b["id"].str { Image(systemName: "checkmark").foregroundStyle(T.accent) }
                                }
                                .padding(10)
                                .background(T.glass, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            }.buttonStyle(.plain)
                        }
                    }.padding(16)
                }
            }
            .navigationTitle("Banca").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Chiudi") { dismiss() } } }
        }
    }
}

/// Built-in categories for the movement's kind, the user's own (deletable), and a field to make a new one.
struct CategoryPickerSheet: View {
    @EnvironmentObject var app: AppState
    @Environment(\.dismiss) private var dismiss
    let kind: String
    @Binding var selected: String
    @State private var newName = ""
    @State private var newEmoji = ""
    @State private var error: String?

    private var list: [JSON] { FinanceCatalog.categories(app.data, kind: kind) }

    private func row(_ c: JSON) -> some View {
        HStack(spacing: 12) {
            Button { selected = c["name"].str; dismiss() } label: {
                HStack(spacing: 12) {
                    CategoryBadge(emoji: c["emoji"].str, size: 34)
                    Text(c["name"].str).font(.subheadline.weight(.semibold)).foregroundStyle(T.text1)
                    Spacer()
                    if selected == c["name"].str { Image(systemName: "checkmark").foregroundStyle(T.accent) }
                }
            }.buttonStyle(.plain)
            if c["custom"].bool {
                Button(role: .destructive) { Task { _ = await app.financeOp("categories", "remove", id: c["id"].int) } } label: {
                    Image(systemName: "trash").font(.footnote).foregroundStyle(T.text3)
                }.buttonStyle(.plain)
            }
        }
        .padding(10).background(T.glass, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Backdrop()
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        CardLabel("NUOVA CATEGORIA")
                        HStack(spacing: 8) {
                            Field(placeholder: "🏷️", text: $newEmoji).frame(width: 64)
                            Field(placeholder: "Nome", text: $newName)
                            Button("Aggiungi") {
                                Task {
                                    let r = await app.financeOp("categories", "add", data: [
                                        "name": .string(newName), "kind": .string(kind), "emoji": .string(newEmoji)])
                                    if let e = r?["error"].string { error = e }
                                    else if r != nil { selected = newName.trimmingCharacters(in: .whitespaces); dismiss() }
                                }
                            }.buttonStyle(PillButtonStyle()).disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                        if let error { Text(error).font(.footnote).foregroundStyle(T.red) }
                        let mine = list.filter { $0["custom"].bool }
                        if !mine.isEmpty {
                            CardLabel("LE TUE").padding(.top, 8)
                            ForEach(mine.indices, id: \.self) { row(mine[$0]) }
                        }
                        CardLabel("PREDEFINITE").padding(.top, 8)
                        let builtIn = list.filter { !$0["custom"].bool }
                        ForEach(builtIn.indices, id: \.self) { row(builtIn[$0]) }
                    }.padding(16)
                }
            }
            .navigationTitle(kind == "entrata" ? "Categoria entrata" : "Categoria spesa").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Chiudi") { dismiss() } } }
        }
    }
}
