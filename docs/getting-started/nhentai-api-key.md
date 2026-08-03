# nhentai API key

The app works entirely without a nhentai account: you can search, browse and
download as normal. Adding an API key unlocks the Favorites tab and raises most
per-endpoint rate limits, because the app then talks to nhentai as a signed-in
user rather than as an anonymous visitor. The key is optional and can be added
or removed at any time from Settings → nhentai.

## Why get one

| Benefit | What changes |
| --- | --- |
| **Favorites tab** | Browse, search and manage your nhentai favourites in the app |
| **Favorite toggle** | The heart on a gallery's detail page favourites / unfavourites it |
| **Higher rate limits** | Most endpoints allow more requests per minute when authenticated |
| **Favourite status** | The detail page can tell you whether a gallery is already favourited |

## Where to get it

1. Log in at [nhentai.net](https://nhentai.net).
2. Go to **User Settings**.
3. Open the **API Keys** section and create a new key.

Copy the key — you will only see it once.

## How to add it

1. Open **Settings → nhentai**.
2. Paste the key into the **API Key** field.
3. Press **Validate & Save**.

The app calls nhentai to check the key and, if it is valid, shows a
green **API Key Configured** card with your username. The key is then used for
every request. Press **Remove** to clear it and drop back to anonymous limits.

## How it's stored

The key is not kept in plaintext. It is encrypted with Electron's
`safeStorage`, which on Linux and Windows is backed by the operating system's
keychain, and only the encrypted value is written to the database. If the OS
keychain is unavailable, the key is stored as-is rather than failing — but on a
normal desktop install it is encrypted.

The app re-validates a saved key at startup. If it has been revoked on nhentai's
side, the stored copy is cleared and the app falls back to anonymous mode.

## Rate limits

The app rate limits requests per endpoint with a token bucket, using nhentai's
documented limits (see [`nhentai-api-v2-reference.md`](../../nhentai-api-v2-reference.md)
section C). Authenticating raises the allowances that nhentai makes conditional
on being signed in:

| Endpoint | Anonymous | With API key |
| --- | --- | --- |
| Search (`GET /search`) | 10/min | 20/min |
| Gallery list (`GET /galleries`) | 15/min | 30/min |
| Gallery detail (`GET /galleries/{id}`) | 20/min | 45/min |
| Related (`GET /galleries/{id}/related`) | 12/min | 30/min |
| Popular (`GET /galleries/popular`) | 8/min | 8/min |
| Favorites / favorite toggle | 15/min | 15/min |
| Tag lookup (`GET /tags/ids`) | 15/min | 15/min |
| Tag search (`POST /tags/search`) | 30/min | 30/min |
| Config (`GET /cdn`, `GET /config`) | 30/min | 30/min |

The limits are encoded in [`rate-limiter.ts`](../../src/main/services/rate-limiter.ts)
and the same table drives the batch sync's pacing, so the two never drift apart.
A `429` response is honoured by waiting out `Retry-After` before retrying.

## What works without one

Everything except the favourites features: search, browse, gallery detail,
downloads, the library, metadata, conversion and sync all work anonymously.
Gallery detail simply omits the `is_favorited` flag, so the heart is shown
unfilled.

## See also

- [nhentai integration](../features/nhentai-integration.md) — what the search, browse and favourites tabs do
- [Sync](../features/sync.md) — batch syncing uses the same authenticated limits
- [External tools](../reference/external-tools.md) — the other thing worth setting up after install
