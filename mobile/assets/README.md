# Assets

These files are referenced by `app.json` and must exist at the listed paths before `npm start`. Drop the real ZentroMeet brand assets here — same shapes the web app uses (`scheduling-saas/public/zentromeet-mark.svg`, `zentromeet-wordmark.svg`):

| File                  | Size       | Purpose                                |
|-----------------------|------------|----------------------------------------|
| `icon.png`            | 1024×1024  | App icon (iOS + Android)               |
| `adaptive-icon.png`   | 1024×1024  | Android adaptive icon (foreground)     |
| `splash.png`          | 1284×2778  | Splash screen image                    |
| `favicon.png`         | 48×48      | Web favicon                            |

Until you drop real assets in, Expo will use its default Expo logo on the splash and icon — totally fine for dev, just don't ship.
