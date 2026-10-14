import SwiftUI

private func dyn(_ dark: PlatformColor, _ light: PlatformColor) -> Color {
    #if os(iOS)
    Color(UIColor { $0.userInterfaceStyle == .dark ? dark : light })
    #else
    Color(NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light })
    #endif
}
private func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> PlatformColor { PlatformColor(red: r, green: g, blue: b, alpha: a) }

enum T {
    static let bg = dyn(rgb(0.055, 0.06, 0.075), rgb(0.945, 0.953, 0.968))
    static let text1 = dyn(rgb(0.96, 0.965, 0.975), rgb(0.1, 0.115, 0.14))
    static let text2 = dyn(rgb(0.74, 0.76, 0.8), rgb(0.33, 0.36, 0.42))
    static let text3 = dyn(rgb(0.55, 0.57, 0.63), rgb(0.48, 0.51, 0.57))
    static let glass = dyn(rgb(1, 1, 1, 0.07), rgb(1, 1, 1, 0.65))
    static let glassSoft = dyn(rgb(1, 1, 1, 0.045), rgb(1, 1, 1, 0.45))
    static let border = dyn(rgb(1, 1, 1, 0.14), rgb(1, 1, 1, 0.85))
    static let track = dyn(rgb(1, 1, 1, 0.09), rgb(0, 0, 0, 0.07))
    static let accent = dyn(rgb(0.27, 0.6, 1.0), rgb(0.1, 0.45, 0.95))
    static let green = dyn(rgb(0.36, 0.82, 0.52), rgb(0.12, 0.6, 0.32))
    static let red = dyn(rgb(0.97, 0.4, 0.4), rgb(0.82, 0.22, 0.22))
    static let amber = dyn(rgb(1.0, 0.72, 0.3), rgb(0.85, 0.5, 0.05))
}


// MARK: - Liquid Glass (iOS 26+) with a frosted fallback

@available(iOS 26.0, macOS 26.0, *)
private func makeGlass(tint: Color?, interactive: Bool) -> Glass {
    var g = Glass.regular
    if let tint { g = g.tint(tint) }
    if interactive { g = g.interactive() }
    return g
}

struct AdaptiveGlass<S: Shape>: ViewModifier {
    let shape: S
    var tint: Color?
    var interactive: Bool
    var fallback: Color

    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content.glassEffect(makeGlass(tint: tint, interactive: interactive), in: shape)
        } else {
            content
                .background(tint?.opacity(0.85) ?? fallback, in: shape)
                .overlay(shape.stroke(T.border, lineWidth: 1))
        }
    }
}

extension View {
    /// Apple's Liquid Glass on iOS 26 and later (`glassEffect`), a translucent fill before that.
    func adaptiveGlass<S: Shape>(_ shape: S, tint: Color? = nil, interactive: Bool = false, fallback: Color = T.glass) -> some View {
        modifier(AdaptiveGlass(shape: shape, tint: tint, interactive: interactive, fallback: fallback))
    }

    /// Groups nearby glass shapes so they blend and render as one layer (GlassEffectContainer on iOS 26).
    @ViewBuilder func glassGroup(spacing: CGFloat = 12) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) { GlassEffectContainer(spacing: spacing) { self } } else { self }
    }
}

/// Background colour fields. Dark: graphite with cool blue/teal glows; light: soft white-blue. No purple.
struct BackdropColors {
    let blobs: [(color: Color, opacity: Double)]
    init(_ scheme: ColorScheme) {
        if scheme == .dark {
            blobs = [(Color(red: 0.10, green: 0.40, blue: 0.62), 0.50),   // deep sky
                     (Color(red: 0.08, green: 0.50, blue: 0.52), 0.38),   // teal
                     (Color(red: 0.16, green: 0.28, blue: 0.58), 0.42),   // indigo-blue
                     (Color(red: 0.20, green: 0.55, blue: 0.62), 0.22),
                     (Color(red: 0.30, green: 0.45, blue: 0.70), 0.20)]
        } else {
            blobs = [(Color(red: 0.55, green: 0.76, blue: 0.98), 0.60),
                     (Color(red: 0.55, green: 0.88, blue: 0.86), 0.45),
                     (Color(red: 0.70, green: 0.80, blue: 0.98), 0.50),
                     (Color(red: 0.80, green: 0.90, blue: 0.98), 0.35),
                     (Color(red: 0.62, green: 0.84, blue: 0.92), 0.30)]
        }
    }
}

struct Backdrop: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        #if os(macOS)
        MacBackdrop()
        #else
        let c = BackdropColors(scheme).blobs
        ZStack {
            T.bg
            Circle().fill(c[0].color).frame(width: 340).blur(radius: 90).opacity(c[0].opacity).offset(x: -120, y: -300)
            Circle().fill(c[1].color).frame(width: 300).blur(radius: 90).opacity(c[1].opacity).offset(x: 140, y: -60)
            Circle().fill(c[2].color).frame(width: 320).blur(radius: 100).opacity(c[2].opacity).offset(x: -40, y: 320)
        }
        .ignoresSafeArea()
        #endif
    }
}

struct Card<Content: View>: View {
    var padding: CGFloat = 18
    #if os(macOS)
    @Environment(\.cardFill) private var fill
    #endif
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 14) { content }
            .padding(padding)
            #if os(macOS)
            .frame(maxWidth: .infinity, maxHeight: fill ? .infinity : nil, alignment: .topLeading)
            #else
            .frame(maxWidth: .infinity, alignment: .leading)
            #endif
            .adaptiveGlass(RoundedRectangle(cornerRadius: 24, style: .continuous))
            .foregroundStyle(T.text1)
    }
}

struct CardLabel: View {
    let text: String
    init(_ t: String) { text = t }
    var body: some View {
        Text(text).font(.caption2.weight(.bold)).tracking(1.4).foregroundStyle(T.text3)
    }
}

/// Top and bottom bars. On iOS 26 the system draws them in Liquid Glass by itself (floating tab bar,
/// glass navigation buttons, soft scroll edge); before that they get a frosted blur instead of an opaque bar.
struct GlassBars: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content
        } else {
            #if os(iOS)
            content
                .toolbarBackground(.ultraThinMaterial, for: .navigationBar)
                .toolbarBackground(.ultraThinMaterial, for: .tabBar)
                .toolbarBackground(.visible, for: .navigationBar)
                .toolbarBackground(.visible, for: .tabBar)
            #else
            content
            #endif
        }
    }
}

struct Screen<Content: View>: View {
    let title: String
    var chat: AISection? = nil
    @EnvironmentObject var app: AppState
    @State private var chatOpen = false
    @ViewBuilder var content: Content
    var body: some View {
        #if os(macOS)
        macBody
        #else
        NavigationStack {
            ZStack {
                Backdrop()
                ScrollView {
                    VStack(spacing: 16) {
                        if let e = app.error {
                            Text(e).font(.footnote).foregroundStyle(T.red)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(12).background(T.red.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                        }
                        content
                    }
                    .padding(.horizontal, 16).padding(.bottom, 24)
                    .frame(maxWidth: 960)
                    .frame(maxWidth: .infinity)
                }
                .refreshable { await app.refresh() }
                .scrollDismissesKeyboard(.interactively)
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.large)
            .modifier(GlassBars())
            .toolbar {
                if chat != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { chatOpen = true } label: { Image(systemName: "sparkles") }
                            .accessibilityLabel("Parla con l'IA")
                    }
                }
            }
            .sheet(isPresented: $chatOpen) {
                if let chat { ChatSheet(section: chat, title: "Jarvis · \(title)") }
            }
        }
        #endif
    }

    #if os(macOS)
    /// Web-like canvas: content up to 1440 pt wide in rows of cards, the Jarvis bar floating at the bottom.
    private var macBody: some View {
        ZStack(alignment: .bottom) {
            ScrollView {
                VStack(spacing: 20) {
                    if let e = app.error {
                        Text(e).font(.footnote).foregroundStyle(T.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12).background(T.red.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                    }
                    content
                }
                .padding(.horizontal, 32).padding(.top, 84).padding(.bottom, 110)
                .frame(maxWidth: 1440)
                .frame(maxWidth: .infinity)
            }
            .refreshable { await app.refresh() }
            if chat != nil { MacChatBar { chatOpen = true } }
        }
        .sheet(isPresented: $chatOpen) {
            if let chat { ChatSheet(section: chat, title: "Jarvis · \(title)").frame(minWidth: 560, minHeight: 640) }
        }
    }
    #endif
}

struct PillButtonStyle: ButtonStyle {
    var tint: Color = T.accent
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, 16).padding(.vertical, 10)
            .adaptiveGlass(Capsule(), tint: tint, interactive: true)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .foregroundStyle(.white)
    }
}

struct Field: View {
    let placeholder: String
    @Binding var text: String
    var keyboard: UIKeyboardType = .default
    var secure = false
    var body: some View {
        Group {
            if secure { SecureField(placeholder, text: $text) }
            else { TextField(placeholder, text: $text) }
        }
        .inputTraits(keyboard)
        .textFieldStyle(.plain)
        .padding(12)
        .adaptiveGlass(RoundedRectangle(cornerRadius: 14, style: .continuous), fallback: T.glassSoft)
        .foregroundStyle(T.text1)
    }
}

struct ProgressBar: View {
    let value: Double
    var tint: Color = T.accent
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(T.track)
                Capsule().fill(tint).frame(width: g.size.width * min(max(value, 0), 1))
            }
        }.frame(height: 8)
    }
}

struct Ring: View {
    let value: Double
    var tint: Color = T.accent
    var lineWidth: CGFloat = 10
    var body: some View {
        ZStack {
            Circle().stroke(T.track, lineWidth: lineWidth)
            Circle().trim(from: 0, to: min(max(value, 0), 1))
                .stroke(tint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
    }
}

struct DeltaChip: View {
    let label: String
    let pct: Double
    var body: some View {
        HStack(spacing: 4) {
            Text(label).foregroundStyle(T.text3)
            Text("\(pct >= 0 ? "▲" : "▼") \(String(format: "%.1f", abs(pct)))%")
                .foregroundStyle(pct >= 0 ? T.green : T.red)
        }.font(.caption.weight(.semibold))
    }
}

enum Fmt {
    static func eur(_ v: Double, decimals: Int = 0) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency; f.currencyCode = "EUR"; f.locale = Locale(identifier: "it_IT")
        f.maximumFractionDigits = decimals; f.minimumFractionDigits = decimals
        return f.string(from: NSNumber(value: v)) ?? "€\(v)"
    }
    static func num(_ v: Double, _ d: Int = 0) -> String { String(format: "%.\(d)f", v) }
    static func parse(_ s: String) -> Double { Double(s.replacingOccurrences(of: ",", with: ".")) ?? 0 }
    static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    static let isoPlain = ISO8601DateFormatter()
    private static let localFormats: [DateFormatter] = ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd"].map {
        let f = DateFormatter(); f.dateFormat = $0; f.locale = Locale(identifier: "en_US_POSIX"); return f
    }
    /// The bridge sends events either as UTC ISO ("…Z") or as floating local time with no zone.
    static func date(_ s: String) -> Date? {
        if let d = iso.date(from: s) ?? isoPlain.date(from: s) { return d }
        for f in localFormats { if let d = f.date(from: s) { return d } }
        return nil
    }
    static func dayKey(_ d: Date) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.locale = Locale(identifier: "en_US_POSIX"); return f.string(from: d)
    }
    static func it(_ d: Date, _ fmt: String) -> String {
        let f = DateFormatter(); f.locale = Locale(identifier: "it_IT"); f.dateFormat = fmt; return f.string(from: d)
    }
}
