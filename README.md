# HayGo

A fast, dark-themed mobile web browser for Android, built with Kotlin, Jetpack Compose and the system WebView.

`com.haygo` · Android 8.0+ (API 26) · Target SDK 36

## Features

**Browsing**
- Multiple tabs, with open tabs restored when you return
- Address bar that accepts a URL or a search; opens `https://` by default (router and local-network addresses use `http://`)
- Opens `http` and `https` links from other apps ("Open with")
- Mobile, Tablet and Desktop view with matching user agent and viewport
- Find in page, Reader mode with adjustable text size and theme, page translation
- Long-press menu for links and images, with image and link preview

**Media**
- Picture-in-Picture for playing video (the menu item appears only while a video plays)
- Background play with a media notification and playback controls

**Downloads and history**
- Download center with progress notifications
- Browsing history

**Privacy and safety**
- Built-in ad blocker (can be switched off)
- Certificate errors stop the page; only local-network addresses can be allowed to continue
- Per-site permission prompts for camera, microphone and location (Android permission rules apply)
- Website notifications, including push through Firebase Cloud Messaging

**Developer tools**
- Eruda developer console (Console, Elements, Network, Resources and more), downloaded on first use; the page reloads when you turn it off
- Crash screen that shows the error report on the device so you can copy or share it

**Polish**
- Custom error page that says why a site did not load (DNS, refused, timeout, certificate and more), plus a separate offline page
- Floating menu button, optional display over other apps

## Project structure

```
app/
  module.toml                      Module and dependency configuration
  src/main/
    AndroidManifest.xml
    assets/
      index.html                   Home page with shortcuts
      offline.html                 Shown when the device has no internet
      error.html                   Shown when a site fails to load, with the reason
    kotlin/com/haygo/
      MainActivity.kt              WebView, tabs, Picture-in-Picture, lifecycle
      FloatingMenu.kt              Menu UI (Compose): navigation, history, downloads, view modes
      PlaybackService.kt           Background play and media notification
      DownloadCenter.kt            Downloads
      AdBlocker.kt                 Ad blocking
      ErudaConsole.kt              Developer console loader
      ReaderMode.kt                Reader mode
      WebNotifications.kt          Website notifications
      ...
    res/                           Resources
```

## Build

HayGo was created with [CodeAssist](https://github.com/tyron12233/CodeAssist) (an Android IDE for Android) and is exported as a `.caproj` project. The module settings are in `app/module.toml`.

Main dependencies: Kotlin, Jetpack Compose (Material 3), AndroidX WebKit, AndroidX Media, Kotlin serialization, Firebase Messaging and Realtime Database.

Release builds are signed with your own key. Set your signing configuration before building a release; do not commit keystores or passwords.

### Firebase setup

Push notifications and notification history use Firebase. The Firebase client values are in `app/src/main/res/values/firebase_values.xml`.

To use your own Firebase project, replace those values with the ones from your own `google-services.json`. Firebase API keys are not secret, but restrict them in the Google Cloud console, and set secure Realtime Database rules.

## Permissions

Internet and network state, camera, microphone, location, notifications, media and storage access, biometric, vibrate, wake lock, audio settings, foreground service (media playback) and display over other apps. A permission is used only when a website or feature asks for it and you allow it. See the [privacy policy](PRIVACY_POLICY.md) for details.

## Privacy

HayGo keeps history, downloads, tabs and settings on your device and has no server of its own that stores them. Read the full [privacy policy](PRIVACY_POLICY.md).

## Contributing

Issues and pull requests are welcome. Please describe the problem or feature clearly, and include your Android version and device model for bugs.

## Author

Subhojit Haldar, West Bengal, India · business.tizongaming@gmail.com

## License

Released under the [MIT License](LICENSE).
