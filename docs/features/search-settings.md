# Search settings

Search settings shape how the Search tab behaves before you type anything, and
let you keep unwanted content out of results — either by hiding it entirely or
by showing it but marking it. Everything here is optional and applies
immediately when changed (Settings → nhentai → Search settings), so there is no
Save button to forget. The query-building and matching rules live in
[`search-query.ts`](../../src/main/services/search-query.ts); the stored entries
in [`blocked.repo.ts`](../../src/main/db/repositories/blocked.repo.ts).

## Defaults

These are applied **every time the Search tab opens**. A query you type
yourself always wins over them.

| Setting | What it does |
| --- | --- |
| **Default search** | A query pre-filled when the Search tab opens — e.g. `language:english` to always start in your language. Uses nhentai's own syntax. |
| **Sort** | Which sort the tab starts with (Date, Most popular, Popular today/week/month). |
| **Language** | Appended as `language:x` unless your query already names one. |
| **Min pages** | Appended as `pages:>N`. |
| **Min favourites** | Appended as `favorites:>=N`. |
| **Uploaded within (days)** | Appended as `uploaded:<Nd`. |
| **Dim nhentai-blacklisted** | Uses the `blacklisted` flag nhentai returns with each result (from your account's own blacklist) to visually dim matching cards. |

Defaults are only added for fields you have not already constrained yourself:
searching `language:japanese` with an English default never asks for both.

## Blocked values

Blocked values are per-type entries with two modes. The supported types map
onto nhentai's tag fields, plus one special case:

| Type | Meaning |
| --- | --- |
| `tag` / `artist` / `group` / `parody` / `character` / `language` | nhentai tag types |
| `text` | A free-text phrase matched against the title |

Each entry is either:

- **Hide** (`exclude`) — the gallery is kept out of search results.
- **Mark** (`dim`) — the gallery still appears, but is visually marked.

Blocked values never hide anything in your **Library or Favorites** — there they
only change how the tag itself looks.

## Exclude vs dim

An `exclude` entry becomes a **negation term in the query** (`-tag:"big
breasts"`, `-artist:Name`). A `dim` entry deliberately does **not**: the point
of dimming is that the gallery still arrives, so it is applied after the
results are loaded.

## How dim mode works

Search results only carry tag *IDs*, not names, so to mark a card the app
resolves the IDs back to names (batched through the cached `GET /tags/ids`
endpoint, 100 at a time) and compares them against your `dim` entries. Matching
cards get a **strikethrough chip** that says which blocked value matched. The
resolution runs after the results render, so it never slows down the grid; a
`text` dim entry is a case-insensitive substring match against the title.

## How blocked values work on browse views

The latest and popular views accept **no query at all**, so negations cannot be
sent with them. On those views `exclude` entries are applied **post-facto**: the
results are filtered by their resolved tags before they are shown, so a hidden
gallery never flashes on screen. `dim` entries mark cards there too.

## Tag autocomplete

When adding a blocked value, the input suggests **real nhentai tags** for the
chosen type. This matters: a value typed by hand that does not correspond to an
actual tag becomes a negation that silently matches nothing.

## See also

- [nhentai integration](nhentai-integration.md) — the Search and Browse tabs these settings control
- [nhentai API key](../getting-started/nhentai-api-key.md) — account settings behind the blacklist flag
