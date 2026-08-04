# ApkForge

A self-hosted web app that builds APKs from Expo project ZIPs by calling
**Expo's own EAS Build** cloud service on your behalf — using your free
Expo account's build quota, not a third party's.

It does not compile anything itself. It's a thin wrapper: it unpacks your
ZIP just long enough to patch `app.json`/`eas.json`, then hands the project
to the real `eas-cli`, which uploads it to Expo's build machines and reports
back a build ID. All the actual compiling happens on Expo's infrastructure.

## Requirements

- Node.js 18+
- A machine/host with internet access (Render, Railway, Fly.io, a VPS, or
  your own computer). This will **not** run inside a sandboxed environment
  with no network access.
- A free Expo account: https://expo.dev/signup
- A personal access token: https://expo.dev/settings/access-tokens

## Setup

```bash
npm install
npm start
```

Then open `http://localhost:4000` (or your host's URL). Paste your Expo
token, drop in an Expo project ZIP (must have `expo` in `package.json`
dependencies and an `app.json`), optionally set an Android package name,
and hit **Send to EAS Build**.

## What it does under the hood

1. Extracts your ZIP to a temp workspace on this server.
2. If you gave a package name, writes it to `expo.android.package` in
   `app.json`.
3. Writes/merges an `eas.json` build profile called `apkforge` that forces
   `buildType: "apk"` (EAS defaults to `.aab`, which isn't directly
   installable — this makes sure you get a real sideloadable `.apk`).
4. Runs `eas whoami` to confirm your token works before using a build slot.
5. Runs `eas init --non-interactive --force` to link the project to your
   account (harmless if it's already linked).
6. Runs `eas build --platform android --profile apkforge --non-interactive --no-wait --json`
   — this is the real upload-and-queue step. Your project source goes
   straight to Expo's servers via their own CLI.
7. Deletes the local temp copy immediately after (the CLI already sent
   everything to Expo, so there's no reason to keep it around).
8. The browser polls `GET /api/build/:id/status`, which itself calls
   `https://api.expo.dev/v2/builds/:id`, until the build finishes or
   errors. When finished, you get a direct download link hosted by Expo.

## Notes on quota and limits

Free Expo accounts get a limited number of EAS builds per month (this
changes over time — check your usage at expo.dev/accounts/[you]/settings/billing).
It resets monthly rather than being a fixed one-time allowance like some
third-party wrappers, but it is **not unlimited**.

## Security notes

- Your Expo token is never written to disk on this server — it's only
  held in memory for the duration of a request/response, and the frontend
  only stores it in your own browser's `localStorage` if you tick
  "Remember on this device."
- This has no user accounts or auth of its own — anyone who can reach the
  server can submit a build if they have a token. Treat it as a personal
  tool; don't deploy it publicly without adding your own auth in front of it.
- Uploaded ZIPs and their extracted contents are deleted right after each
  build is submitted.

## Limitations

- Expo/React Native projects only — no native Java/Kotlin project support
  (EAS Build itself handles that differently; out of scope here).
- No build cancellation UI — cancel directly from expo.dev if needed.
- The `eas init --force` step re-links the project on every build. Fine
  for solo use; if you're reusing the exact same project repeatedly, you
  can remove that step once `app.json` already has a stable
  `expo.extra.eas.projectId`.
