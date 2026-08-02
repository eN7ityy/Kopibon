import { describe, it, expect } from 'vitest'
import { renderTemplate } from './template-engine'

/**
 * The engine's whole job is to reproduce, from an editable file, the exact
 * bytes that used to come out of string concatenation. So these cases are
 * mostly about *absence*: which lines vanish, and whether anything is left
 * behind when they do.
 */

describe('renderTemplate — substitution', () => {
  it('substitutes a plain placeholder', () => {
    expect(renderTemplate('<T>{{title}}</T>', { title: 'Hi' })).toBe('<T>Hi</T>')
  })

  it('keeps the line when a plain placeholder is empty', () => {
    // <Title></Title> is what the old builder wrote, so the engine must too.
    expect(renderTemplate('<T>{{title}}</T>', { title: '' })).toBe('<T></T>')
  })

  it('substitutes several placeholders on one line', () => {
    expect(renderTemplate('{{a}}-{{b}}', { a: '1', b: '2' })).toBe('1-2')
  })

  it('joins arrays with a comma and a space', () => {
    expect(renderTemplate('<W>{{writers}}</W>', { writers: ['A', 'B'] })).toBe('<W>A, B</W>')
  })

  it('renders zero as a value, not as absence', () => {
    // PageCount 0 is a real answer for an empty archive.
    expect(renderTemplate('<P>{{n?}}</P>', { n: 0 })).toBe('<P>0</P>')
  })

  it('renders an unknown placeholder as empty rather than throwing', () => {
    expect(renderTemplate('<T>{{nope}}</T>', {})).toBe('<T></T>')
  })

  it('does not escape — the caller owns escaping', () => {
    expect(renderTemplate('<T>{{t}}</T>', { t: '&amp;' })).toBe('<T>&amp;</T>')
  })
})

describe('renderTemplate — optional lines', () => {
  it('drops a line whose optional value is empty', () => {
    expect(renderTemplate('a\n<S>{{s?}}</S>\nb', { s: '' })).toBe('a\nb')
  })

  it('keeps a line whose optional value is present', () => {
    expect(renderTemplate('a\n<S>{{s?}}</S>\nb', { s: 'x' })).toBe('a\n<S>x</S>\nb')
  })

  it('drops the line when any one of several optionals is empty', () => {
    expect(renderTemplate('<D>{{y?}}-{{m?}}</D>', { y: '2020', m: '' })).toBe('')
  })

  it('treats null, undefined and an empty array as empty', () => {
    const t = '{{a?}}\n{{b?}}\n{{c?}}\nkeep'
    expect(renderTemplate(t, { a: null, b: undefined, c: [] })).toBe('keep')
  })

  it('leaves no blank line behind', () => {
    const out = renderTemplate('one\n<S>{{s?}}</S>\ntwo', { s: null })
    expect(out.split('\n')).toEqual(['one', 'two'])
  })
})

describe('renderTemplate — sections', () => {
  const t = ['before', '{{#lang}}', '  <L>{{lang}}</L>', '{{/lang}}', 'after'].join('\n')

  it('renders the body when the value is present', () => {
    expect(renderTemplate(t, { lang: 'en' })).toBe('before\n  <L>en</L>\nafter')
  })

  it('removes the body and both markers when the value is absent', () => {
    expect(renderTemplate(t, { lang: null })).toBe('before\nafter')
  })

  it('accepts indented section markers', () => {
    const indented = ['  {{#x}}', '  body', '  {{/x}}'].join('\n')
    expect(renderTemplate(indented, { x: true })).toBe('  body')
  })

  it('handles a section inline within a line', () => {
    const line = '<Bag>{{#p}}<li>{{p}}</li>{{/p}}</Bag>'
    expect(renderTemplate(line, { p: 'Acme' })).toBe('<Bag><li>Acme</li></Bag>')
    expect(renderTemplate(line, { p: '' })).toBe('<Bag></Bag>')
  })

  it('handles two inline sections on the same line', () => {
    const line = '{{#a}}A{{/a}}{{#b}}B{{/b}}'
    expect(renderTemplate(line, { a: 1, b: '' })).toBe('A')
  })

  it('nests sections', () => {
    const nested = ['{{#o}}', 'o', '{{#i}}', 'i', '{{/i}}', '{{/o}}'].join('\n')
    expect(renderTemplate(nested, { o: true, i: true })).toBe('o\ni')
    expect(renderTemplate(nested, { o: true, i: false })).toBe('o')
    expect(renderTemplate(nested, { o: false, i: true })).toBe('')
  })

  it('drops an optional line inside a rendered section', () => {
    const s = ['{{#o}}', '<a>{{a}}</a>', '<b>{{b?}}</b>', '{{/o}}'].join('\n')
    expect(renderTemplate(s, { o: true, a: '1', b: null })).toBe('<a>1</a>')
  })

  it('reports an unclosed section', () => {
    expect(() => renderTemplate('{{#a}}\nx', {})).toThrow(/missing/)
  })

  it('reports a mismatched closer', () => {
    expect(() => renderTemplate('{{#a}}\nx\n{{/b}}', {})).toThrow(/expected/)
  })
})

describe('renderTemplate — each', () => {
  const t = ['<Seq>', '{{#each xs}}', '  <li>{{.}}</li>', '{{/each}}', '</Seq>'].join('\n')

  it('repeats the body once per item', () => {
    expect(renderTemplate(t, { xs: ['a', 'b'] })).toBe('<Seq>\n  <li>a</li>\n  <li>b</li>\n</Seq>')
  })

  it('emits nothing for an empty list', () => {
    expect(renderTemplate(t, { xs: [] })).toBe('<Seq>\n</Seq>')
  })

  it('emits nothing for a missing list', () => {
    expect(renderTemplate(t, {})).toBe('<Seq>\n</Seq>')
  })

  it('still sees the surrounding context inside the body', () => {
    const s = ['{{#each xs}}', '{{prefix}}:{{.}}', '{{/each}}'].join('\n')
    expect(renderTemplate(s, { xs: ['a'], prefix: 'p' })).toBe('p:a')
  })
})

describe('renderTemplate — file shape', () => {
  it('drops a single trailing newline so files match hand-built strings', () => {
    expect(renderTemplate('a\nb\n', {})).toBe('a\nb')
  })

  it('keeps a deliberate blank final line', () => {
    expect(renderTemplate('a\nb\n\n', {})).toBe('a\nb\n')
  })

  it('normalises CRLF, so an editor on Windows cannot corrupt the output', () => {
    expect(renderTemplate('a\r\nb\r\n', {})).toBe('a\nb')
  })
})
