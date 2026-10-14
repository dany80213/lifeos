import SwiftUI

struct ChatMessage: Identifiable { let id = UUID(); let fromUser: Bool; var text: String }

/// The "chat with Jarvis" bar of each web page, as a sheet. `section` picks the model and
/// which actions the local model may take, exactly like LifeOSJarvis.ask(text, null, section).
struct ChatSheet: View {
    @EnvironmentObject var app: AppState
    @Environment(\.dismiss) private var dismiss
    let section: AISection
    let title: String
    @State private var messages: [ChatMessage] = []
    @State private var input = ""
    @State private var busy = false
    @State private var model: String?   // nil = whatever Profilo assigns to this section

    var body: some View {
        NavigationStack {
            ZStack {
                Backdrop()
                VStack(spacing: 0) {
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 10) {
                                if messages.isEmpty {
                                    Text("Chiedi a Jarvis: aggiungi un promemoria, registra una spesa o un pasto, analizza la settimana.")
                                        .font(.callout).foregroundStyle(T.text3).padding(.top, 20)
                                }
                                ForEach(messages) { m in
                                    HStack {
                                        if m.fromUser { Spacer(minLength: 40) }
                                        Text(m.text.isEmpty ? "…" : m.text)
                                            .padding(.horizontal, 14).padding(.vertical, 10)
                                            .adaptiveGlass(RoundedRectangle(cornerRadius: 20, style: .continuous), tint: m.fromUser ? T.accent : nil)
                                            .foregroundStyle(m.fromUser ? Color.white : T.text1)
                                            .textSelection(.enabled)
                                        if !m.fromUser { Spacer(minLength: 40) }
                                    }.id(m.id)
                                }
                            }
                            .padding(16)
                        }
                        .onChange(of: messages.last?.text) { _, _ in
                            if let last = messages.last { proxy.scrollTo(last.id, anchor: .bottom) }
                        }
                    }
                    HStack(spacing: 10) {
                        TextField("Scrivi a Jarvis…", text: $input, axis: .vertical)
                            .lineLimit(1...4)
                            .padding(12)
                            .adaptiveGlass(RoundedRectangle(cornerRadius: 20, style: .continuous), interactive: true)
                            .foregroundStyle(T.text1)
                            .onSubmit(send)
                        Button(action: send) {
                            Image(systemName: busy ? "ellipsis" : "arrow.up.circle.fill").font(.system(size: 32))
                        }
                        .disabled(busy || input.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    .padding(12)
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        ForEach(AppState.aiModels, id: \.self) { name in
                            Button { model = name } label: { Label(name, systemImage: name == activeModel ? "checkmark" : "") }
                        }
                    } label: {
                        HStack(spacing: 4) { Text(activeModel).font(.subheadline.weight(.semibold)); Image(systemName: "chevron.down").font(.caption2) }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) { Button("Chiudi") { dismiss() } }
            }
        }
        .presentationDetents([.large])
    }

    private var activeModel: String { model ?? app.sectionAssignments[section.rawValue] ?? "Claude" }

    private func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !busy else { return }
        input = ""; busy = true
        messages.append(ChatMessage(fromUser: true, text: text))
        let reply = ChatMessage(fromUser: false, text: "")
        messages.append(reply)
        Task {
            do {
                let r = try await app.ask(text, section: section, model: activeModel) { delta in
                    Task { @MainActor in
                        if let i = messages.firstIndex(where: { $0.id == reply.id }) { messages[i].text += delta }
                    }
                }
                if let i = messages.firstIndex(where: { $0.id == reply.id }) {
                    let final = r["text"].str
                    if !final.isEmpty { messages[i].text = final }
                }
            } catch {
                if let i = messages.firstIndex(where: { $0.id == reply.id }) {
                    messages[i].text = "Non riesco a rispondere: \(error.localizedDescription)"
                }
            }
            busy = false
        }
    }
}
