import SwiftUI
#if os(iOS)
import UIKit
typealias PlatformColor = UIColor
typealias PlatformImage = UIImage
#else
import AppKit
typealias PlatformColor = NSColor
typealias PlatformImage = NSImage
#endif

// Small shims so the same SwiftUI views build on iOS and on macOS.

extension Image {
    init(platformImage: PlatformImage) {
        #if os(iOS)
        self.init(uiImage: platformImage)
        #else
        self.init(nsImage: platformImage)
        #endif
    }
}

extension PlatformImage {
    convenience init?(imageData data: Data) { self.init(data: data) }
}

#if os(macOS)
/// Mirrors UIKit's keyboard types so call sites stay identical; a Mac has one keyboard.
enum UIKeyboardType { case `default`, asciiCapable, emailAddress, phonePad, decimalPad, numberPad }

enum NavBarTitleMode { case inline, large, automatic }

extension View {
    func navigationBarTitleDisplayMode(_ mode: NavBarTitleMode) -> some View { self }
}

extension ToolbarItemPlacement {
    static var topBarLeading: ToolbarItemPlacement { .navigation }
    static var topBarTrailing: ToolbarItemPlacement { .primaryAction }
}
#endif

extension View {
    /// Keyboard type / capitalisation on iOS; nothing on macOS.
    @ViewBuilder func inputTraits(_ keyboard: UIKeyboardType) -> some View {
        #if os(iOS)
        self.keyboardType(keyboard)
            .textInputAutocapitalization(keyboard == .default ? .sentences : .never)
            .autocorrectionDisabled(keyboard != .default)
        #else
        self.autocorrectionDisabled(keyboard != .default)
        #endif
    }
}

enum SystemSettings {
    /// Opens the page of System Settings / Settings where the user can grant Reminders access.
    static func openPrivacy() {
        #if os(iOS)
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        #else
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders") { NSWorkspace.shared.open(url) }
        #endif
    }
}

/// A row that opens a detail screen: pushed on iOS, shown in a sheet on the Mac (which has no nav bar to go back from).
struct PushLink<Destination: View, Label: View>: View {
    private let destination: Destination
    private let label: Label
    #if os(macOS)
    @State private var open = false
    #endif
    init(@ViewBuilder destination: () -> Destination, @ViewBuilder label: () -> Label) {
        self.destination = destination(); self.label = label()
    }
    var body: some View {
        #if os(iOS)
        NavigationLink { destination } label: { label }
        #else
        Button { open = true } label: { label }
            .sheet(isPresented: $open) { MacSheet { destination } }
        #endif
    }
}
