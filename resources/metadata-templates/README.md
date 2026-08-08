# Metadata templates

These two files decide the exact bytes this app writes into your files.

| File | Goes into | Read by |
| --- | --- | --- |
| `comicinfo.template` | `ComicInfo.xml`, the first entry in every CBZ | Kavita, Komga, ComicRack, most readers |
| `pdf-xmp.template` | The XMP packet in every PDF | Kavita, calibre |

They are plain text on purpose. If Kavita changes what it expects, or you move
to something else entirely, you edit a file here instead of waiting for a new
build.

## Which copy is in use

There are two copies:

- **The shipped defaults**: next to the application, never written to.
- **Your copy**: under the app's user data directory, in `metadata-templates/`.
  This is the one the app reads and the one to edit.
  - Linux: `~/.config/kopibon/metadata-templates/`
  - Windows: `%APPDATA%\kopibon\metadata-templates\`

Your copy is created from the defaults the first time the app starts, and is
never overwritten afterwards. **To restore a default, delete your copy of that
file**. The app falls back to the shipped one and re-creates yours on the next
start.

Edits take effect on the next file written. No restart needed.

The startup log line `Metadata templates: …` tells you which directory is in
use. To point the app somewhere else entirely, set `DOUJIN_TEMPLATE_DIR`.

## Template syntax

Four constructs. Everything else in the file is copied through exactly as
written, including whitespace.

### `{{name}}`: substitute a value

```xml
<Title>{{title}}</Title>
```

The line is always kept, even if the value is empty. Use this for elements that
must always be present.

A value that is a list is joined with `, `. So `{{writers}}` becomes
`Alice, Bob`.

### `{{name?}}`: substitute, or drop the whole line

```xml
<Summary>{{summary?}}</Summary>
```

If `summary` is empty, that entire line disappears. No empty `<Summary></Summary>`
element and no blank line left behind. This is how optional elements work.

If a line has several `?` placeholders, the line is dropped when **any** of them
is empty. That is deliberate: `<Year>{{year?}}</Year>` and its Month and Day
neighbours are all-or-nothing.

Note that `0` counts as a value, not as empty. `<PageCount>0</PageCount>` is a
real answer for an empty archive.

### `{{#name}} … {{/name}}`: a section

Kept when the value is non-empty, removed entirely otherwise.

Across lines, with the markers alone on their own lines:

```xml
{{#languageIso}}
      <dc:language>
        <rdf:Bag>
          <rdf:li>{{languageIso}}</rdf:li>
        </rdf:Bag>
      </dc:language>
{{/languageIso}}
```

Or inline, within a line:

```xml
<rdf:Bag>{{#publisher}}<rdf:li>{{publisher}}</rdf:li>{{/publisher}}</rdf:Bag>
```

Sections can be nested.

### `{{#each name}} … {{/each}}`: repeat per list item

`{{.}}` is the current item.

```xml
        <rdf:Seq>
{{#each creators}}
          <rdf:li>{{.}}</rdf:li>
{{/each}}
        </rdf:Seq>
```

An empty list produces nothing at all.

### Escaping

Values are XML-escaped before they reach the template, so a title containing
`&` or `<` cannot break the file. Do not escape them again yourself. Markup you
write in the template is passed through untouched. That is the whole point.

## Available values

Both templates get all of these. Most are not used by the shipped templates,
they are there so you can add them without a code change.

| Placeholder | What it is |
| --- | --- |
| `title` | The title to write |
| `titleEnglish`, `titleJapanese`, `titlePretty` | The other title variants, when known |
| `mediaId` | nhentai's media id, which its image URLs are built from |
| `favorites` | How many people favourited the gallery |
| `coverUrl`, `thumbnailUrl` | nhentai's own image URLs |
| `scanlator` | Always empty; nhentai does not populate it |
| `galleryId` | nhentai gallery number. Empty for anything added by hand |
| `seriesName` | The series, or empty |
| `partOfSeries` | True when a series name was given. Useful as a section |
| `artists` | Artist names |
| `groups` | Circle names |
| `writers` | Who to credit: artists, else circles, else `Unknown` |
| `characters`, `parodies` | From the gallery's tags |
| `categories` | nhentai `category` tags; `doujinshi`, `manga` |
| `genres` | **`categories` + `parodies`**; what goes in `<Genre>`. Kavita splits this on commas into separate genres, and links works sharing one under "Related". Use `{{categories?}}` instead if you want the category alone |
| `tags` | nhentai `tag` tags only |
| `allTags` | Every tag, whatever its type |
| `publisher` | The circle if there is one, else whatever was supplied |
| `description` | Summary text |
| `language` | Human-readable, e.g. `English` |
| `languageIso` | ISO 639-1 code, e.g. `en`. Empty when unrecognised |
| `pageCount` | Pages in the file |
| `galleryPageCount` | Pages the gallery claims, which can differ |
| `format` | `cbz` or `pdf` |
| `ageRating`, `manga` | ComicInfo AgeRating and reading direction |
| `producer` | `pikepdf 10.8.0` |

ComicInfo also gets:

| Placeholder | What it is |
| --- | --- |
| `series` | The series, falling back to the title. Never empty |
| `number` | Position in the series. Empty for a one-shot |
| `seriesIndex` | The raw index, ungated |
| `summary` | Same as `description` |
| `seriesGroup` | The first parody. Kavita reads it as a Collection |
| `localizedSeries` | The Japanese title, **for a one-shot only**. Kavita reads it as the series' Localized Name, and for a series member the Japanese title names that volume rather than the series. Use `{{titleJapanese?}}` if you want it regardless |
| `storyArc`, `storyArcNumber` | The series and its number again. Kavita turns these into a Reading List, a second way to walk a series |
| `year`, `month`, `day` | Release date parts, all empty together |
| `dateIso` | The release date in full |

PDF XMP also gets:

| Placeholder | What it is |
| --- | --- |
| `bom` | The U+FEFF byte-order mark the packet header needs (see below) |
| `creators` | Same as `writers` |
| `tags` | **Overridden** to `allTags`; dc:subject carries every tag |
| `date` | Release date, or the moment of writing if unknown |
| `metadataDate` | When the file was written |
| `seriesIndex` | Formatted to two decimals, as calibre writes it |
| `authorSort` | calibre's author_sort |

**About `{{bom}}`:** the XMP packet header must contain a literal U+FEFF
character. It is invisible in a text editor and easily deleted by accident, so
it is a placeholder rather than a literal. Leave it alone.

## How a value gets to the template

```
input shape  ──adapter──▶  FileMetadata  ──mapper──▶  values  ──template──▶  bytes
```

- **Adapters** (`src/main/services/metadata/file-metadata.ts`) pull facts out of
  whatever the caller has: an nhentai API gallery, a library row, or a flat edit
  payload. They make no decisions.
- **`FileMetadata`** is the one shape everything is written from. It carries more
  than the templates use, on purpose.
- **Mappers** (`src/main/services/metadata/mappers.ts`) make every decision.
  which series a file belongs to, who to credit and which language wins. They
  produce the values above. There is exactly one mapper per format.
- **Templates** decide where those values go.

So: to change *where* a value is written, or to add one, edit a template. To
change *what a value is*, edit `mappers.ts`. Nothing else writes metadata.

## What is not templated

- **The PDF `/Keywords` token list** (`nhentai:123`, `calibre_series:…`). These
  are plain-text tokens in a PDF Info dictionary rather than markup, and the
  app's own library scanner parses them back. They live in `buildKeywordTokens`.
- **Reading files.** `parseComicInfoXml` has to cope with everything already on
  disk, including files written by other tools, so it is not the inverse of any
  one template.

## If you break a template

- A placeholder you misspell renders as empty. A `{{name}}` line stays (with a
  gap where the value was); a `{{name?}}` line disappears.
- An unclosed `{{#section}}` throws, and the write fails with a message naming
  the line.
- A missing file throws, and the message lists every directory that was searched.
- Delete your copy of a file to get the shipped default back.

The test suite renders the real templates, so
`npx vitest run src/main/services/metadata` will tell you whether an edit still
satisfies the rules Kavita depends on.
