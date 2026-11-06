# Android APK build (Expo EAS)

**Status:** configuration prepared and validated locally. **No EAS build has been run, and
the app has never been installed on a device.** EAS builds may count against a paid plan, so
start one only with approval.

## What is configured

| File                   | Setting                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `apps/mobile/eas.json` | Profiles `preview` and `production-apk`, both `buildType: apk`, distribution `internal`. There is no AAB profile.        |
| `apps/mobile/eas.json` | Node 22.20.0 and pnpm 11.21.0, matching CI's Node major and the repository's `packageManager`. Not yet exercised on EAS. |
| `apps/mobile/app.json` | Package `com.nikahmate.app`, `versionCode` 1, version 0.1.0                                                              |

`production-apk` is an APK for direct distribution. A Play Store upload needs an AAB, which
would be a separate decision.

## Before you start (company)

1. **Expo:** an account with access to the company's organisation.
2. **Use the reviewed code.** Build from the branch `review/phases-2-5-handover`, which must exist
   first, or from `main` only after the changes have been merged into it.
3. **Supabase:** the hosted project with all migrations applied, and the app's redirect URL
   `nikahmate://auth/callback` added under **Authentication → URL Configuration**. Without it,
   email verification links will not return to the app.
4. **API:** deployed at an **`https://`** address. Android release builds block plain `http://`,
   so a `localhost` or LAN URL will not work in an APK.

## Build steps

Install the CLI once. `npx eas-cli` crashed on Windows with Node 24 during validation
(`ERR_MODULE_NOT_FOUND`), while a normal install ran correctly. A global install does not
change the project.

```bash
npm install --global eas-cli
```

Run everything else from `apps/mobile`.

```bash
cd apps/mobile
```

```bash
eas login
```

Link the project once. This writes `owner` and the `projectId` into `app.json`; commit that
change.

```bash
eas init
```

Set the three client values. **EAS does not read `apps/mobile/.env`**, because it is gitignored
and never uploaded. Without these values the app opens on its "not configured" screen. All three
are public values, so `plaintext` is correct. Never add a server secret here.

```bash
eas env:create --environment preview --name EXPO_PUBLIC_SUPABASE_URL --value "https://<project-ref>.supabase.co" --visibility plaintext
```

```bash
eas env:create --environment preview --name EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY --value "<publishable key>" --visibility plaintext
```

```bash
eas env:create --environment preview --name EXPO_PUBLIC_API_BASE_URL --value "https://<api-host>" --visibility plaintext
```

Check what the build will use. This needs the login, and does not start a build.

```bash
eas config --platform android --profile preview
```

Start the build. **This is the step that needs approval.** Run it interactively the first time,
and let EAS generate the Android keystore in the company's account. Every later update must be
signed with the same key.

```bash
eas build --platform android --profile preview
```

EAS prints a link to download the APK when the build finishes. To install it, allow installs from
that source on the Android device when prompted.

For `production-apk`, repeat the three `env:create` commands with `--environment production` and
pass `--profile production-apk`. Increase `versionCode` in `app.json` before each build you
distribute, because Android will not install a lower one over a higher one.

## Validated locally

| Check                                            | Result                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| `eas.json` against EAS's own schema              | Valid; both profiles resolve to `apk`, with the Node and pnpm versions above |
| `eas env:create --help` (eas-cli 27.4.1)         | The flags used above exist                                                   |
| `expo export --platform android` (Hermes bundle) | Succeeds (5 MB)                                                              |
| `expo prebuild --platform android --no-install`  | Generates the native project; the output was then removed                    |
| Native autolinking                               | Includes every native module, `expo-font` among them                         |
| `expo-doctor` config schema                      | Passes                                                                       |
| `buildConfig.test.ts`                            | Every profile is APK; no values in `eas.json`; env examples match the code   |

**Not validated:** `eas login`, `eas init`, `eas config` and `eas build` (they need the company's
account), a Gradle compile (this machine has no Android SDK), and any install or run on a device
or emulator. The first real build may therefore still reveal problems.

## `expo-doctor`: open items (dependency changes need approval)

- **Six patch versions behind SDK 57's expected versions:** `expo`, `expo-router`,
  `expo-constants`, `expo-linking`, `expo-splash-screen`, `@expo/metro-runtime`.
- **`expo-font` is not a direct dependency** of `apps/mobile`, although `@expo/vector-icons` asks
  for it. It does reach the native build through `expo`, so this is not expected to stop the app.
  The recommended fix is `npx expo install expo-font`.

## First-install checklist

Sign up and verify email through the link; complete onboarding; upload a photo; open another
member's profile; send an interest; check the notifications inbox; chat after a match; open a
family invitation link; sign out and back in; reinstall and confirm the session behaves.
