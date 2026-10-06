# Whisper

A web-first messaging interface with Windows Aero-inspired and minimal appearances. The static client is designed for GitHub Pages, with a Supabase schema draft under `supabase/schema.sql`.

## Preview

Serve the folder with a local static server or publish it with GitHub Pages. The current chat interactions use this browser's local storage. They are not yet connected to real accounts or cross-device sync.

## GitHub Pages

The workflow at `.github/workflows/pages.yml` deploys the static files from `main`. It reads the public Supabase project URL and anon key from repository secrets named `WHISPER_SUPABASE_URL` and `WHISPER_SUPABASE_ANON_KEY`. The public anon key is designed for browser use when every database table has correct row-level security. Never put a service-role key in client code.

The sitemap and robots file are set to `https://zenosama0.github.io/whisper-aero/`. Update them if the GitHub owner or repository name changes.

## Supabase setup

Create a Supabase project, apply `supabase/schema.sql` in its SQL editor, and configure the Auth site URL and allowed redirect URL for the GitHub Pages site. Add the project URL and anon key as the two repository secrets above. The database schema includes profiles, contact requests, conversations, messages, reactions, private avatar storage, and a 3 MB attachment metadata table.

Authentication and the chat client still need to be connected to this schema. The current prototype's messages, requests, and profile edits remain local until that integration is complete. A server-side attachment download/delete function and push notifications also remain to be implemented.
