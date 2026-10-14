import SwiftUI

/// The LifeOS "L" with a dot, as one vector outline (same geometry as Branding/logo.svg).
struct LifeMarkShape: Shape {
    func path(in r: CGRect) -> Path {
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: r.minX + x * r.width, y: r.minY + y * r.height) }
        var stroke = Path()
        stroke.move(to: pt(0.36, 0.24))
        stroke.addLine(to: pt(0.36, 0.72))
        stroke.addLine(to: pt(0.68, 0.72))
        let l = stroke.strokedPath(StrokeStyle(lineWidth: 0.115 * r.width, lineCap: .round, lineJoin: .round))
        var out = l
        out.addEllipse(in: CGRect(x: pt(0.68, 0.30).x - 0.07 * r.width, y: pt(0.68, 0.30).y - 0.07 * r.width,
                                  width: 0.14 * r.width, height: 0.14 * r.width))
        return out
    }
}

/// App logo: gradient tile with the mark in Liquid Glass on iOS 26+, frosted material before that.
struct LogoMark: View {
    var size: CGFloat = 88

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.225, style: .continuous)
                .fill(LinearGradient(colors: [Color(red: 0.24, green: 0.55, blue: 1.0), Color(red: 0.48, green: 0.30, blue: 0.88)],
                                     startPoint: .topLeading, endPoint: .bottomTrailing))
            mark
        }
        .frame(width: size, height: size)
        .shadow(color: .black.opacity(0.25), radius: size * 0.08, y: size * 0.04)
        .accessibilityLabel("Logo LifeOS")
    }

    @ViewBuilder private var mark: some View {
        #if os(macOS)
        // On the Mac the glass mark washes out on the gradient at small sizes: draw it solid, like Branding/logo-mark.svg.
        LifeMarkShape()
            .fill(.white)
            .shadow(color: .black.opacity(0.18), radius: size * 0.03, y: size * 0.015)
            .frame(width: size, height: size)
            .overlay(
                RoundedRectangle(cornerRadius: size * 0.225, style: .continuous)
                    .stroke(LinearGradient(colors: [.white.opacity(0.45), .white.opacity(0.05)], startPoint: .top, endPoint: .bottom), lineWidth: max(0.5, size * 0.02))
            )
        #else
        if #available(iOS 26.0, macOS 26.0, *) {
            Color.clear
                .frame(width: size, height: size)
                .glassEffect(.regular.tint(.white.opacity(0.18)), in: LifeMarkShape())
        } else {
            LifeMarkShape()
                .fill(.ultraThinMaterial)
                .overlay(LifeMarkShape().stroke(.white.opacity(0.55), lineWidth: max(1, size * 0.006)))
                .frame(width: size, height: size)
        }
        #endif
    }
}
