#if os(macOS)
import SwiftUI
import AppKit

// The Mac layout: the web app's arrangement (cards side by side in rows) instead of the phone's single column,
// with the window's own toolbar carrying navigation in Liquid Glass.

private struct CardFillKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    /// True inside a `Row`: cards stretch to the height of the tallest card next to them.
    var cardFill: Bool {
        get { self[CardFillKey.self] }
        set { self[CardFillKey.self] = newValue }
    }
}

/// Lays children out side by side with widths in proportion to `ratios` (the web's `2fr 1fr` grids).
struct ProportionalRow: Layout {
    var ratios: [CGFloat]
    var spacing: CGFloat = 20

    private func widths(_ total: CGFloat, _ n: Int) -> [CGFloat] {
        let r = n >= ratios.count ? ratios + Array(repeating: 1, count: n - ratios.count) : Array(ratios.prefix(n))
        let usable = max(0, total - spacing * CGFloat(n - 1))
        let sum = r.reduce(0, +)
        return n == 1 ? [total] : r.map { usable * $0 / sum }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard !subviews.isEmpty else { return .zero }
        let total = proposal.width ?? 900
        let ws = widths(total, subviews.count)
        let h = zip(subviews, ws).map { $0.sizeThatFits(ProposedViewSize(width: $1, height: nil)).height }.max() ?? 0
        return CGSize(width: total, height: h)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard !subviews.isEmpty else { return }
        var x = bounds.minX
        for (sub, w) in zip(subviews, widths(bounds.width, subviews.count)) {
            sub.place(at: CGPoint(x: x, y: bounds.minY), anchor: .topLeading, proposal: ProposedViewSize(width: w, height: bounds.height))
            x += w + spacing
        }
    }
}

struct Row<Content: View>: View {
    let ratios: [CGFloat]
    @ViewBuilder var content: Content
    init(_ ratios: [CGFloat], @ViewBuilder content: () -> Content) { self.ratios = ratios; self.content = content() }
    var body: some View {
        ProportionalRow(ratios: ratios) { content }.environment(\.cardFill, true)
    }
}

/// Vivid colour blobs that drift slowly, like the web's background. Glass needs colour behind it to read as glass.
struct MacBackdrop: View {
    @Environment(\.colorScheme) private var scheme
    @State private var drift = false
    var body: some View {
        GeometryReader { g in
            let s = max(g.size.width, g.size.height)
            let w = g.size.width, h = g.size.height
            ZStack {
                T.bg
                let c = BackdropColors(scheme).blobs
                blob(c[0].color, s * 0.45, c[0].opacity, x: w * (drift ? 0.18 : 0.10), y: h * 0.14)
                blob(c[1].color, s * 0.38, c[1].opacity, x: w * (drift ? 0.86 : 0.93), y: h * (drift ? 0.36 : 0.26))
                blob(c[2].color, s * 0.42, c[2].opacity, x: w * (drift ? 0.46 : 0.56), y: h * (drift ? 0.96 : 0.86))
                blob(c[3].color, s * 0.22, c[3].opacity, x: w * (drift ? 0.70 : 0.62), y: h * (drift ? 0.62 : 0.70))
                blob(c[4].color, s * 0.18, c[4].opacity, x: w * (drift ? 0.28 : 0.36), y: h * (drift ? 0.55 : 0.48))
            }
        }
        .ignoresSafeArea()
        .onAppear { withAnimation(.easeInOut(duration: 14).repeatForever(autoreverses: true)) { drift = true } }
    }

    private func blob(_ c: Color, _ size: CGFloat, _ opacity: Double, x: CGFloat, y: CGFloat) -> some View {
        Circle().fill(c).frame(width: size).blur(radius: size * 0.25).opacity(opacity).position(x: x, y: y)
    }
}

/// A detail screen shown in a sheet on the Mac.
struct MacSheet<Content: View>: View {
    @Environment(\.dismiss) private var dismiss
    @ViewBuilder var content: Content
    var body: some View {
        NavigationStack {
            content.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Chiudi") { dismiss() } } }
        }
        .frame(minWidth: 560, minHeight: 640)
    }
}

/// The "ask Jarvis" bar the web pages keep at the bottom.
struct MacChatBar: View {
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: "sparkles").foregroundStyle(T.accent)
                Text("Chiedi a Jarvis…").foregroundStyle(T.text2)
                Spacer()
                Image(systemName: "return").font(.caption.weight(.semibold)).foregroundStyle(T.text3)
            }
            .font(.callout)
            .padding(.horizontal, 18).padding(.vertical, 12)
            .frame(width: 520)
            .adaptiveGlass(Capsule(), interactive: true)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .padding(.bottom, 22)
        .keyboardShortcut("k", modifiers: .command)
    }
}

struct MarketChip: View {
    let name: String
    let quote: JSON
    var body: some View {
        HStack(spacing: 6) {
            Text(name).font(.caption.weight(.bold)).foregroundStyle(T.text3)
            Text(quote["price"].isNull ? "—" : Fmt.eur(quote["price"].num, decimals: quote["price"].num < 1000 ? 2 : 0))
                .font(.subheadline.weight(.semibold))
            if !quote["d24"].isNull {
                Text("\(quote["d24"].num >= 0 ? "▲" : "▼") \(String(format: "%.1f", abs(quote["d24"].num)))%")
                    .font(.caption.weight(.semibold)).foregroundStyle(quote["d24"].num >= 0 ? T.green : T.red)
            }
        }
    }
}

/// Lets the backdrop run under the whole window: no title bar strip, content up to the edges.
private struct TransparentTitlebar: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        DispatchQueue.main.async {
            guard let w = v.window else { return }
            w.titlebarAppearsTransparent = true
            w.titleVisibility = .hidden
            w.styleMask.insert(.fullSizeContentView)
            w.isMovableByWindowBackground = true
        }
        return v
    }
    func updateNSView(_ nsView: NSView, context: Context) {}
}

/// The web's navbar, drawn in Liquid Glass: logo, sections, market chips, clock, theme, profile.
struct MacNavBar: View {
    @Binding var selection: AppTab
    @EnvironmentObject var app: AppState
    @State private var fullScreen = false

    private var sections: [AppTab] { AppTab.allCases.filter { $0 != .profilo } }

    var body: some View {
        HStack(spacing: 14) {
            HStack(spacing: 8) {
                LogoMark(size: 28)
                Text("LifeOS").font(.system(size: 17, weight: .heavy))
            }
            HStack(spacing: 4) {
                ForEach(sections, id: \.self) { tab in
                    Button { withAnimation(.snappy(duration: 0.25)) { selection = tab } } label: {
                        Text(tab.title).font(.subheadline.weight(.semibold))
                            .foregroundStyle(selection == tab ? .white : T.text2)
                            .padding(.horizontal, 16).frame(height: 30)
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .adaptiveGlass(Capsule(), tint: selection == tab ? T.accent : nil, interactive: true, fallback: .clear)
                }
            }
            .padding(4).frame(height: 38)
            .adaptiveGlass(Capsule())
            .glassGroup(spacing: 6)
            Spacer(minLength: 12)
            HStack(spacing: 14) {
                MarketChip(name: "BTC", quote: app.data["marketPulse"]["btc"])
                MarketChip(name: "EUNL", quote: app.data["marketPulse"]["eunl"])
                HStack(spacing: 6) {
                    Text(Fmt.it(app.now, "HH:mm")).font(.subheadline.weight(.bold)).monospacedDigit()
                    Text(Fmt.it(app.now, "EEE d MMM").capitalized).font(.caption).foregroundStyle(T.text3)
                }
            }
            .lineLimit(1).fixedSize()
            .padding(.horizontal, 16).frame(height: 38)
            .adaptiveGlass(Capsule())
            Button {
                app.themePref = app.themePref == "light" ? "dark" : "light"
                app.pushProfile(theme: app.themePref)
            } label: {
                Image(systemName: app.themePref == "light" ? "moon.fill" : "sun.max.fill").frame(width: 38, height: 38)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain).adaptiveGlass(Circle(), interactive: true).help("Cambia tema")
            Button { selection = .profilo } label: {
                ProfileAvatar(size: 28).frame(width: 38, height: 38).contentShape(Circle())
            }
            .buttonStyle(.plain)
            .adaptiveGlass(Circle(), tint: selection == .profilo ? T.accent : nil, interactive: true).help("Profilo")
        }
        .foregroundStyle(T.text1)
        .padding(.leading, fullScreen ? 20 : 84).padding(.trailing, 20)
        .padding(.top, 10).padding(.bottom, 8)
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didEnterFullScreenNotification)) { _ in fullScreen = true }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didExitFullScreenNotification)) { _ in fullScreen = false }
    }
}

/// Mac shell: the navbar floats over the content (which scrolls beneath it) and the selected section fills the window.
struct MacShell<Detail: View>: View {
    @State private var selection: AppTab = .home
    @ViewBuilder var detail: (AppTab) -> Detail

    var body: some View {
        ZStack(alignment: .top) {
            MacBackdrop()
            detail(selection).id(selection)
            MacNavBar(selection: $selection)
        }
        .background(TransparentTitlebar())
        .onReceive(NotificationCenter.default.publisher(for: .lifeosSelectTab)) { n in
            if let tab = n.object as? AppTab { selection = tab }
        }
    }
}
#endif
