# nhentai integration

The Search and Favorites tabs are a full nhentai client in their own right:
you can search, browse, open gallery details, favourite or unfavourite, and
jump to related work — all without leaving the app. It talks to nhentai's v2
API through [`api-client.ts`](../../src/main/services/api-client.ts), which is
described in full in [`nhentai-api-v2-reference.md`](../../nhentai-api-v2-reference.md).

## Searching and browsing

- **Search** — type a query in the box. It supports nhentai's own syntax:
  `artist:name`, `tag:"big breasts"`, `-word` to exclude, and more.
- **Sort** — switch between **Date** (newest), **Popular (All-Time)**,
  **Popular (Today)**, **Popular (Week)** and **Popular (Month)**.
- **Auto-load latest** — an empty search box loads the latest galleries
  (`GET /galleries`). Choosing **Popular (Today)** loads the popular listing
  (`GET /galleries/popular`), which is a flat list rather than a search.

Search results show a card per gallery with an in-library tick, format, artist
and language. Results are refreshed every couple of seconds, so a card gains
its status the moment a download finishes.

## Gallery detail

Clicking a card opens a detail panel showing:

- The **title** (pretty, English and Japanese variants)
- **Artist** and **group** chips
- All **tags**, grouped by type (genre, languages, parodies, characters)
- **Page count** and **favourites count**
- **Related galleries** — up to twelve, clickable to open another detail

The panel offers **Download**, **Read** (opens the gallery viewer) and a
**favourite** heart. It also shows the download status of the gallery and, when
it is already in the library, lets you remove or delete it.

`is_favorited` is folded into the gallery detail response: the app requests it
with `?include=favorite` when an API key is configured, so there is no separate
"check favourite" call. Without a key the field is null and the heart is shown
unfilled.

## Favorites tab

The **Favorites** tab lists your nhentai favourites and requires an API key
(see [`../getting-started/nhentai-api-key.md`](../getting-started/nhentai-api-key.md)).
It is paginated, has its own search box (`q`), and reuses the same gallery grid
and detail panel. Un-favouriting a gallery removes its card from the list in
place, preserving your page and scroll position.

## Favourite toggle

The heart on a gallery's detail page adds or removes the gallery from your
nhentai favourites. It only appears when signed in.

## Sync from nhentai

Any library item that has an nhentai ID can be **synced** — the app re-fetches
the gallery's metadata and re-writes it into the file. Sync is available per
item (Library detail → Sync), for a selection, and for a whole series. See
[`sync.md`](sync.md).

## Tag and artist clicks

Clicking an artist, group, parody or character chip runs an **in-app search**
for that entity instead of opening the browser — the query box is filled with
`artist:"Name"` and the results load immediately. In the Favorites tab, where
searching is not meaningful, the click closes the detail panel.

## Related galleries

Below the detail panel's tags, a horizontally scrolling row shows galleries
nhentai lists as related. Clicking one navigates the panel to it. Each card
shows the same in-library facts as the grids.

## Rate limiting

Every API call is rate limited per endpoint with a token bucket, so a burst of
work does not become a burst of requests. The limits switch between anonymous
and authenticated sets when you add or remove an API key, and a `429` response
is honoured by waiting out `Retry-After`. See the table in
[`../getting-started/nhentai-api-key.md`](../getting-started/nhentai-api-key.md).

## See also

- [nhentai API key](../getting-started/nhentai-api-key.md) — what an account unlocks
- [Downloading](downloading.md) — turning a found gallery into a file
- [Sync](sync.md) — keeping a downloaded file's metadata current
- [Search settings](search-settings.md) — defaults and blocked values applied to search
