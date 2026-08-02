/**
 * A very small line-oriented template engine.
 *
 * It exists so the exact XML this app writes into CBZ and PDF files lives in
 * editable text files rather than in string concatenation spread across seven
 * builders. Kavita is not the only consumer these files could ever have, and
 * when it changes its mind about a field the change should be an edit to one
 * template, not a code change in three workers.
 *
 * Deliberately not a general templating language. Four constructs, all of them
 * chosen because the two real templates need them:
 *
 *   {{name}}            Substitute the value. The line is always kept.
 *   {{name?}}           Substitute the value, but drop the whole line when the
 *                       value is empty. This is how optional XML elements
 *                       disappear instead of being written empty.
 *   {{#name}}…{{/name}} Section. Kept when the value is non-empty, removed
 *                       otherwise. Works either across lines (open and close
 *                       each alone on their own line) or inline within a line.
 *   {{#each name}}…{{/each}}
 *                       Repeat the enclosed lines once per array item, with
 *                       {{.}} standing for the item.
 *
 * Values are substituted verbatim: whoever builds the context is responsible
 * for XML-escaping. That is on purpose — a template is allowed to contain
 * markup, so the engine cannot tell which parts should be escaped, and doing it
 * here would double-escape the mapper's output.
 */

/** Anything a template placeholder can resolve to. */
export type TemplateValue = string | number | boolean | string[] | null | undefined

/** The flat bag of values a template is rendered against. */
export type TemplateContext = Record<string, TemplateValue>

/** `{{name}}`, `{{name?}}`, `{{.}}` — the `?` marks the line as droppable. */
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*|\.)\s*(\?)?\s*\}\}/g

/** A section opener sitting alone on its line, e.g. `  {{#each tags}}`. */
const BLOCK_OPEN = /^\{\{#(each\s+)?([A-Za-z_][A-Za-z0-9_]*)\}\}$/

/** Any section closer sitting alone on its line. */
const BLOCK_CLOSE = /^\{\{\/(each|[A-Za-z_][A-Za-z0-9_]*)\}\}$/

/** An inline section: opener and closer on the same line. */
const INLINE_SECTION = /\{\{#([A-Za-z_][A-Za-z0-9_]*)\}\}([\s\S]*?)\{\{\/\1\}\}/

/**
 * Whether a value counts as "not there".
 *
 * Note that `0` and `'0'` are *present*: PageCount is legitimately zero on an
 * empty archive and must still be written.
 */
function isEmpty(value: TemplateValue): boolean {
  if (value == null || value === false) return true
  if (value === true) return false
  if (Array.isArray(value)) return value.length === 0
  return String(value).length === 0
}

/**
 * Render a value into a line.
 *
 * Arrays join with `, ` because every list this app writes into a single
 * element — Writer, Genre, Tags, Characters — is comma-separated.
 */
function scalar(value: TemplateValue): string {
  if (value == null || value === false) return ''
  if (value === true) return 'true'
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

/**
 * Find the line index closing the section opened at `start`.
 *
 * Tracks depth so a section nested inside another does not close the outer one.
 */
function findClose(lines: string[], start: number, expected: string): number {
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (BLOCK_OPEN.test(trimmed)) {
      depth++
    } else if (BLOCK_CLOSE.test(trimmed)) {
      depth--
      if (depth === 0) {
        if (trimmed !== expected) {
          throw new Error(`Template: expected ${expected} on line ${i + 1}, found ${trimmed}`)
        }
        return i
      }
    }
  }
  throw new Error(`Template: ${expected} is missing (section opened on line ${start + 1})`)
}

/** Expand inline sections until none are left, so several can share a line. */
function expandInlineSections(line: string, ctx: TemplateContext): string {
  let out = line
  for (;;) {
    const match = out.match(INLINE_SECTION)
    if (!match) return out
    const [whole, name, body] = match
    out = out.replace(whole, isEmpty(ctx[name]) ? '' : body)
  }
}

function renderLines(lines: string[], ctx: TemplateContext, item?: string): string[] {
  const out: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].trim().match(BLOCK_OPEN)

    if (open) {
      const isEach = Boolean(open[1])
      const name = open[2]
      const close = findClose(lines, i, isEach ? '{{/each}}' : `{{/${name}}}`)
      const body = lines.slice(i + 1, close)
      const value = ctx[name]

      if (isEach) {
        // An empty list contributes no lines at all — the surrounding markup
        // (an rdf:Bag, say) is left holding nothing rather than a blank line.
        const items = Array.isArray(value) ? value : []
        for (const entry of items) out.push(...renderLines(body, ctx, entry))
      } else if (!isEmpty(value)) {
        out.push(...renderLines(body, ctx, item))
      }

      i = close
      continue
    }

    let dropLine = false
    const rendered = expandInlineSections(lines[i], ctx).replace(
      PLACEHOLDER,
      (_match, name: string, optional: string | undefined) => {
        const value = name === '.' ? item : ctx[name]
        if (optional && isEmpty(value)) dropLine = true
        return scalar(value)
      }
    )

    if (!dropLine) out.push(rendered)
  }

  return out
}

/**
 * Render `template` against `ctx`.
 *
 * Line endings are normalised to `\n` and one trailing newline is dropped, so a
 * template file saved by any editor — including one that insists on CRLF —
 * produces the same bytes as the hand-built strings this replaced.
 */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  const normalised = template.replace(/\r\n/g, '\n').replace(/\n$/, '')
  return renderLines(normalised.split('\n'), ctx).join('\n')
}
