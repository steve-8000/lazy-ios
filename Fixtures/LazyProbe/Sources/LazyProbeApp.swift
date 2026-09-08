import SwiftUI

/// Smallest app that can prove the whole lazy-ios pipeline end to end.
///
/// Every control carries a stable accessibility identifier, because that is
/// what `ios_run` steps match on — labels are localised and change, ids do not.
@main
struct LazyProbeApp: App {
	var body: some Scene {
		WindowGroup {
			ProbeView()
		}
	}
}

struct ProbeView: View {
	@State private var taps = 0
	@State private var entered = ""

	/// The single string the smoke test asserts on. It changes on tap, so a
	/// passing assertion proves the tap reached the app rather than proving
	/// only that the screen rendered.
	private var status: String {
		taps == 0 ? "LazyProbe Ready" : "Tapped \(taps)"
	}

	var body: some View {
		VStack(spacing: 24) {
			Text(status)
				.font(.title2.weight(.semibold))
				.accessibilityIdentifier("probe.status")

			Button("Tap Me") {
				taps += 1
			}
			.buttonStyle(.borderedProminent)
			.accessibilityIdentifier("probe.button")

			TextField("Type here", text: $entered)
				.textFieldStyle(.roundedBorder)
				.padding(.horizontal, 40)
				.accessibilityIdentifier("probe.field")

			Text(entered.isEmpty ? "empty" : "echo: \(entered)")
				.font(.footnote)
				.foregroundStyle(.secondary)
				.accessibilityIdentifier("probe.echo")
		}
		.padding()
	}
}
