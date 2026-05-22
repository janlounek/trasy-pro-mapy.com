# Trasy pro mapy.com — Privacy Policy

_Last updated: 2026-05-22_

This Chrome extension ("Trasy pro mapy.com", "the extension") is provided by
Jan Lounek (the "developer"). This page explains what information the
extension collects, where it goes, and how to remove it.

If you want your data deleted or have any question, contact
**jan.lounek@etnetera.cz**.

## 1. What the extension does

Trasy pro mapy.com lets you save your own hiking, cycling, and walking routes on
[mapy.com](https://mapy.com) and — optionally — publish them to a small
community pool that other users of the extension can browse.

## 2. Data we collect

### Stored locally on your computer (`chrome.storage`)

- Your routes: name, description, polyline coordinates, distance, duration,
  elevation profile, route type, difficulty, parking flag, folder, attached
  photos (resized to ≤ 1200 px JPEG).
- Folder names and collapse state.
- Your Seznam **`oauth_user_id`** — a stable but opaque identifier provided by
  Seznam after you sign in. It is not your email, name, or username.
- Your Seznam **OAuth access and refresh tokens**, used to talk to the
  community backend on your behalf.

Local data never leaves your machine unless you explicitly enable sharing
(see below).

### Sent to the community backend when you share a route

The extension runs a small Cloudflare Worker backend at
`https://mapy-for-chrome-backend.trasypromapy.workers.dev`. When you toggle
**"Sdílet s komunitou"** on a route and save, the following is uploaded:

- Your `oauth_user_id` (as the owner ID — used for ownership checks).
- The route's name, description, route type, difficulty, parking flag.
- The route's geometry, start/end coordinates and reverse-geocoded labels.
- Distance, duration, elevation gain/loss, elevation profile, shape.
- Like and dislike counts per route (aggregate only).

**We deliberately do NOT upload, store, or share:**

- Your real name (first, last).
- Your email address.
- Your IP address (beyond what Cloudflare's edge needs to route the request,
  which we do not log or persist).
- Your photos (photo sync is not implemented).
- Any of your routes that you have not marked as shared.

### Data Seznam returns to us during sign-in

When you sign in with Seznam, Seznam's `identity` OAuth scope returns
`oauth_user_id`, `email`, `firstname`, `lastname`. The extension reads only
`oauth_user_id` and immediately discards the other fields — they are never
written to disk, sent to the backend, or shown in the UI.

## 3. What other users see about you

When other people install the extension and browse the community section,
they see the routes you have explicitly shared. They see:

- The route's name, description, stats, geometry, photos (when photos are
  added later).
- An anonymous owner reference ("Sdíleno komunitou"). **No real name.**
- The like/dislike counts.

If you cast a vote on someone else's route, your `oauth_user_id` is stored in
a `route_votes` row so we can enforce one vote per user. No other user can
see who voted for what.

## 4. Where the data lives

- **Locally**: in Chrome's per-profile extension storage on your computer.
- **Backend**: in a Cloudflare D1 (SQLite) database operated by the developer.
- **Seznam**: when you sign in, Seznam handles its own user data per Seznam's
  privacy policy at <https://o.seznam.cz/ochrana-udaju/>.

## 5. Retention

- Local data persists until you uninstall the extension or clear Chrome
  extension storage.
- Backend data persists until you unshare a route (toggles off
  "Sdílet s komunitou" and saves) or delete it locally, at which point the
  route is removed from the backend. The backend also keeps a short-lived
  cache of verified OAuth tokens (≤ 15 minutes) so that repeated requests
  don't hammer Seznam's userinfo endpoint.
- Vote rows persist for as long as the route exists.

## 6. Your rights

You can at any time:

- **View** all your locally stored data via Chrome DevTools on the extension's
  service worker (`chrome://extensions/` → service worker → Application →
  Storage).
- **Delete a single shared route** by editing it and unchecking "Sdílet s
  komunitou", or by deleting the route entirely.
- **Stop sharing entirely** by unsharing each of your shared routes and
  signing out of Seznam in the extension.
- **Delete all your shared data on request** by emailing
  jan.lounek@etnetera.cz with your `oauth_user_id` (visible in the extension's
  service worker console via `chrome.storage.local.get('user')`). We will
  remove every route, vote, and cached token tied to that ID within 7 days.

You also have rights under the EU General Data Protection Regulation (GDPR)
including the right to access, rectify, erase, and port your data, and the
right to lodge a complaint with a supervisory authority (in the Czech
Republic, Úřad pro ochranu osobních údajů, <https://www.uoou.gov.cz>).

## 7. What we don't do

- We do not display any advertising.
- We do not use analytics services (no Google Analytics, no Sentry, no
  fingerprinting).
- We do not sell or share data with third parties.
- We do not use cookies — the extension stores everything via Chrome's
  extension storage and OAuth tokens via Seznam's standard flow.
- We do not track your browsing on mapy.com beyond reading the public URL
  parameters (latitude/longitude/zoom) needed to position the overlay.

## 8. Children

The extension is not directed at children under 13. We do not knowingly
collect personal information from children.

## 9. Changes to this policy

If we materially change what data is collected or how it is used, the
"Last updated" date at the top of this document will change and an
explanation will appear in the Chrome Web Store change log for that release.

## 10. Contact

Jan Lounek
Email: jan.lounek@etnetera.cz
