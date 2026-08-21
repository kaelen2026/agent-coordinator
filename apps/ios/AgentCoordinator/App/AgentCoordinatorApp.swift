import SwiftUI

@main
struct AgentCoordinatorApp: App {
    private let launch = AppLaunch.live()

    var body: some Scene {
        WindowGroup {
            switch launch {
            case let .ready(session):
                RootView(session: session)
            case let .misconfigured(error):
                ConfigurationErrorView(error: error)
            }
        }
    }
}
