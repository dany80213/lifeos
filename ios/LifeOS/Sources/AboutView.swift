import SwiftUI

struct ChangelogEntry: Identifiable {
    let id = UUID()
    let version: String
    let date: String
    let intro: String
    let sections: [(title: String, items: [String])]
}

/// Reads the CHANGELOG.md bundled with the app, so what is shown here is exactly what was released.
enum Changelog {
    static func load() -> [ChangelogEntry] {
        guard let url = Bundle.main.url(forResource: "CHANGELOG", withExtension: "md"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        var entries: [ChangelogEntry] = []
        for block in text.components(separatedBy: "\n## ").dropFirst() {
            var lines = block.components(separatedBy: "\n")
            let header = lines.removeFirst()                       // "1.0.0 — 2026-10-08"
            let parts = header.components(separatedBy: " — ")
            guard let version = parts.first, version.first?.isNumber == true else { continue }
            var intro: [String] = []
            var sections: [(String, [String])] = []
            for line in lines {
                if line.hasPrefix("**"), line.hasSuffix("**") {
                    sections.append((String(line.dropFirst(2).dropLast(2)), []))
                } else if line.hasPrefix("- "), !sections.isEmpty {
                    sections[sections.count - 1].1.append(String(line.dropFirst(2)))
                } else if sections.isEmpty, !line.trimmingCharacters(in: .whitespaces).isEmpty {
                    intro.append(line)
                }
            }
            entries.append(ChangelogEntry(version: version, date: parts.count > 1 ? parts[1] : "",
                                          intro: intro.joined(separator: " "), sections: sections))
        }
        return entries
    }
}

struct AboutView: View {
    @EnvironmentObject var app: AppState
    private let entries = Changelog.load()
    @State private var expanded: Set<String> = []

    private var version: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?" }
    private var build: String { Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?" }
    private var host: String { URL(string: app.api.base)?.host ?? app.api.base }

    var body: some View {
        ZStack {
            Backdrop()
            ScrollView {
                VStack(spacing: 16) {
                    header
                    infoCard
                    sourcesCard
                    changelogCard
                }.padding(16)
            }
        }
        .navigationTitle("Informazioni")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { if let first = entries.first { expanded = [first.version] } }
    }

    private var header: some View {
        VStack(spacing: 8) {
            LogoMark(size: 96)
            Text("LifeOS").font(.title.weight(.heavy)).foregroundStyle(T.text1)
            Text("Versione \(version) · build \(build)").font(.subheadline).foregroundStyle(T.text2)
        }.frame(maxWidth: .infinity).padding(.top, 8)
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label).font(.subheadline).foregroundStyle(T.text3)
            Spacer()
            Text(value).font(.subheadline.weight(.semibold)).multilineTextAlignment(.trailing)
        }
    }

    private var infoCard: some View {
        Card {
            CardLabel("APP")
            row("Autore", "Daniele Porcaro")
            Divider().overlay(T.border)
            row("Versione", "\(version) (build \(build))")
            Divider().overlay(T.border)
            row("Piattaforma", "iOS 17 o successivo")
            Divider().overlay(T.border)
            row("Server", host)
            Divider().overlay(T.border)
            row("Tema", app.themePref == "light" ? "Chiaro" : app.themePref == "system" ? "Sistema" : "Scuro")
        }
    }

    private var sourcesCard: some View {
        Card {
            CardLabel("COLLEGAMENTI")
            source("checklist", "Apple Promemoria", "aggiunta e completamento dei promemoria")
            source("heart.fill", "Apple Salute", "passi, calorie, sonno, peso, battito (solo lettura)")
            source("fork.knife", "FatSecret", "diario alimentare sincronizzato dal server")
            source("sparkles", "IA", "Claude, Gemini e Groq, scelte per sezione")
            Text("I dati di LifeOS restano sul tuo server. Apple Promemoria e Apple Salute vengono letti solo sul telefono.")
                .font(.caption).foregroundStyle(T.text3)
        }
    }

    private func source(_ icon: String, _ name: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).foregroundStyle(T.accent).frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(name).font(.subheadline.weight(.semibold))
                Text(detail).font(.caption).foregroundStyle(T.text3)
            }
        }
    }

    private var changelogCard: some View {
        Card {
            CardLabel("NOVITÀ E VERSIONI")
            if entries.isEmpty { Text("Registro non disponibile.").font(.subheadline).foregroundStyle(T.text3) }
            ForEach(entries) { e in
                let open = expanded.contains(e.version)
                VStack(alignment: .leading, spacing: 8) {
                    Button {
                        if open { expanded.remove(e.version) } else { expanded.insert(e.version) }
                    } label: {
                        HStack {
                            Text(e.version).font(.headline.weight(.bold))
                            if e.version == version {
                                Text("attuale").font(.caption2.weight(.bold)).padding(.horizontal, 7).padding(.vertical, 2)
                                    .background(T.accent.opacity(0.2), in: Capsule()).foregroundStyle(T.accent)
                            }
                            Spacer()
                            Text(e.date).font(.caption).foregroundStyle(T.text3)
                            Image(systemName: open ? "chevron.up" : "chevron.down").font(.caption).foregroundStyle(T.text3)
                        }.contentShape(Rectangle())
                    }.buttonStyle(.plain)
                    if open {
                        if !e.intro.isEmpty { Text(e.intro).font(.footnote).foregroundStyle(T.text2) }
                        ForEach(e.sections.indices, id: \.self) { i in
                            let s = e.sections[i]
                            Text(s.title.uppercased()).font(.caption2.weight(.bold)).tracking(1).foregroundStyle(T.text3)
                            ForEach(s.items, id: \.self) { item in
                                HStack(alignment: .top, spacing: 8) {
                                    Text("•").foregroundStyle(T.accent)
                                    Text(item).font(.footnote)
                                }
                            }
                        }
                    }
                }
                Divider().overlay(T.border)
            }
        }
    }
}
