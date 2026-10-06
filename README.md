# Whisper

Whisper is a web-first messenger with a Windows Aero appearance, a minimal theme, and an optional dark theme. It is built as a static site for GitHub Pages, with Supabase providing account authentication, message storage, realtime updates, private profile photos, and one-time attachments.

## Features

- Email and password sign-up with a public username, plus sign-in across devices.
- Username-based message requests that create a conversation after acceptance.
- Realtime text messages and emoji reactions, stored in Supabase.
- Private profile photos and one-time attachments up to 3 MB. The recipient downloads the file and the Edge Function removes the server copy.
- A call notification signal. It does not carry audio or video.
- PWA installation and a service worker for the app shell.
- Browser notification permission for alerts while Whisper is open in a browser. Closed-app push delivery needs additional notification service setup.

## Deployment

The GitHub Actions workflow at `.github/workflows/pages.yml` publishes the static client to [GitHub Pages](https://zenosama0.github.io/whisper-aero/). The Supabase URL and publishable browser key are in `app-config.js`. The publishable key is intended for browser use and is protected by database row-level security. Never put a service-role key in client code.

The sitemap and robots file use `https://zenosama0.github.io/whisper-aero/`.

## Supabase

The live project is `gotwpxxvwolmtieinlmz` in the Mumbai region. Its schema is in `supabase/schema.sql`; the deployed attachment Edge Function is under `supabase/functions/attachments/`. Account confirmation links must be allowed to redirect to the GitHub Pages URL in the Supabase Auth URL configuration. The database uses row-level security for profiles, requests, conversations, messages, reactions, attachments, and call invites.
