import Foundation

/// Where the LifeOS bridge lives. Change this to your own server's address
/// (the folder is the bridge's /lifeos route), e.g. "https://lifeos.example.com/lifeos".
/// It is only the first-run default: the app remembers whatever was used before.
enum ServerConfig {
    static let defaultBase = "https://retenasa.duckdns.org:8444/lifeos"
}
