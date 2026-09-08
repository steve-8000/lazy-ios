# lazy-ios

One MCP server for iOS build/test automation. Replaces three moving parts —
`appium-mcp`, `xcrun mcpbridge`, and the `baguette` CLI driven by hand — with a
single process that owns the whole lifecycle.

The merge is not packaging convenience. Both defects that motivated it are
*ownership* problems, and no individual server could fix either, because each
one only ever saw its own slice.

| defect | measured before | cause | fix |
| --- | --- | --- | --- |
| simulator leak | 14 simulators, **5 booted**, none reclaimed | nothing recorded who created a device, so nothing dared delete one | ledger-backed leases; only devices lazy-ios created can be shut down or deleted |
| real device fails every time | 5 consecutive `RemoteXPC is not available for this session` | the RemoteXPC tunnel for the UDID was never registered; the driver's error text blames the session | preflight checks the registry *by UDID* before a session is attempted and names the missing step |
| helper process leak | 5 orphan `appium-mcp` + 2 stray `appium` servers | one helper per client connection, none supervised | one supervised Appium server, recorded by pid, adopted on reconnect |

## Install

```bash
bun install
```

Register it (this replaces the `appium` and `xcode` entries):

```json
{
  "mcpServers": {
    "lazy-ios": {
      "type": "stdio",
      "command": "bun",
      "args": ["/path/to/lazy-ios/src/index.ts"],
      "timeout": 1800000
    }
  }
}
```

Requires Xcode 26+, `baguette >= 0.1.96` (`brew install baguette`), and — for
physical devices only — Appium with the XCUITest driver.

## The lazy path

```jsonc
// ios_run
{
  "path": "/path/to/MyApp",
  "steps": [
    { "expect": "Sign in" },
    { "tap": "login.button" },
    { "text": "hello@example.com" },
    { "expect": "Welcome" }
  ]
}
```

That single call discovers the project, resolves a scheme, builds, takes a
simulator under lease (reusing an idle scratch device when one matches),
installs, launches, waits for the accessibility tree to populate, runs the
steps, writes screenshot + AX evidence, and releases the device. The release
runs even when a phase throws, and a failed release fails the run.

Measured on this machine, `Fixtures/LazyProbe`:

```
discover  0.6s   target 18.3s (created)   build 7.0s   install 7.0s
launch    0.6s   settle  3.7s             steps 3.7s   release 3.2s   → 45s
```

Second run against the same device type:

```
target 2.3s (reused)  → 26s total
```

## Tools

| tool | purpose |
| --- | --- |
| `ios_run` | build → launch → drive → evidence → release, in one call |
| `ios_doctor` | every precondition, measured; `fix:true` applies ownership-scoped repairs only |
| `ios_devices` | simulators and phones annotated with the lease that holds them |
| `ios_session` | open/close a leased target for interactive work |
| `ios_ui` | describe / find / tap / swipe / text / screenshot, same verbs on both backends |
| `ios_project` | schemes, configurations, targets |
| `ios_cleanup` | reclaim leases whose holder is gone |
| `ios_device_preflight` | just the real-device chain, with the exact fix for each failure |

## Ownership rule

The rule the whole codebase is built on:

> lazy-ios may shut down or delete **only** a device it created itself and
> recorded in the ledger. A device that already existed is *adopted*: usable,
> never destroyed, never even shut down unless lazy-ios was the one that
> booted it.

`~/.lazy-ios/ledger.json` records provenance (`created` / `adopted`), the
holding pid, and a lease deadline. Four independent triggers return a device:
an explicit close, the end of `ios_run`, an idle sweep, and process exit. A
lease whose holder pid is gone is reclaimable by the next run, which is the
backstop for `kill -9`.

Foreign booted simulators are *reported* by `ios_doctor`, with the `simctl`
command to shut them down — and never touched.

## Real devices

The preflight encodes what was diagnosed in
`folio-v2/Docs/ios-real-device-automation-setup.md`:

1. device connected, paired, developer mode on
2. `appium-ios-remotexpc` importable from `APPIUM_HOME`
3. `appium-ios-tuntap` native module built
4. **a tunnel registered for this exact UDID** in the registry on port 42314
5. no Appium server older than the remotexpc install — the driver caches
   "module unavailable" for the lifetime of the process

Step 4 needs root. lazy-ios never runs `sudo`; it prints the command:

```bash
sudo env APPIUM_HOME="$HOME/.appium" $(command -v appium) \
  driver run xcuitest tunnel-creation --udid <UDID>
```

Leave that running. Port 42314 is Appium's own registry —
`pymobiledevice3 remote tunneld` on 49151 is a different thing and does not
satisfy the driver.

Without it, `ios_session open kind:device` refuses in under a second with that
exact instruction, instead of spending 180 s to fail with a message that blames
the session.

## Backends

| | simulator | physical device |
| --- | --- | --- |
| UI | `baguette` (private SimulatorHID) | WebDriverAgent over Appium |
| install | `simctl install` | `mobile: installApp` |
| coordinates | AX points from `describe-ui` | AX points from `window/rect` |
| text entry | pasteboard | `mobile: type` |

Text entry never uses HID keystrokes: with a Korean keyboard active, typing
`" abc123"` has been measured to land as `뮻123` because the keystrokes pass
through the IME.

Coordinates are always accessibility points from the same tree `describe`
returns. Screenshot pixels are 3× larger and feeding them to a tap silently
misses.

## Fixture

`Fixtures/LazyProbe` is a ~40-line SwiftUI app used to verify the pipeline
itself. Its status text changes on tap, so a passing smoke run proves the tap
reached the app rather than proving only that a screen rendered.

```bash
cd Fixtures/LazyProbe && xcodegen generate
```
