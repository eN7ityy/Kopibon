import { useState, useEffect, useRef, useCallback, useMemo } from 'react'

// ─── Types ───────────────────────────────────────────────────────────────────

export type AutocompleteKind = 'artist' | 'series'

export interface AutocompleteInputProps {
  /** Which kind of autocomplete to query */
  kind: AutocompleteKind
  /** Current value of the input */
  value: string
  /** Called when the value changes (free-text or selected suggestion) */
  onChange: (value: string) => void
  /** Placeholder text */
  placeholder?: string
  /** Additional CSS classes */
  className?: string
  /** If true, allows free-text values not in suggestions (default: true) */
  allowFreeText?: boolean
  /** If true, input is disabled */
  disabled?: boolean
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function AutocompleteInput({
  kind,
  value,
  onChange,
  placeholder = 'Type to search...',
  className = '',
  allowFreeText = true,
  disabled = false
}: AutocompleteInputProps): React.JSX.Element {
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [highlightIndex, setHighlightIndex] = useState(-1)
  const [loading, setLoading] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ─── Debounced Query ──────────────────────────────────────────────────────

  const fetchSuggestions = useCallback(
    async (query: string) => {
      if (!query.trim()) {
        setSuggestions([])
        setIsOpen(false)
        return
      }

      setLoading(true)
      try {
        let result
        if (kind === 'artist') {
          result = await window.api.library.autocompleteArtists(query)
        } else {
          result = await window.api.library.autocompleteSeries(query)
        }

        if (result.success && Array.isArray(result.data)) {
          const names = result.data as string[]
          setSuggestions(names)
          if (names.length > 0) {
            setIsOpen(true)
            setHighlightIndex(-1)
          } else {
            setIsOpen(false)
          }
        } else {
          setSuggestions([])
          setIsOpen(false)
        }
      } catch {
        setSuggestions([])
        setIsOpen(false)
      } finally {
        setLoading(false)
      }
    },
    [kind]
  )

  // Debounced input handler
  const handleInputChange = useCallback(
    (newValue: string) => {
      onChange(newValue)

      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }

      debounceRef.current = setTimeout(() => {
        fetchSuggestions(newValue)
      }, 150)
    },
    [onChange, fetchSuggestions]
  )

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [])

  // ─── Close dropdown on outside click ──────────────────────────────────────

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // ─── Keyboard Navigation ──────────────────────────────────────────────────

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen || suggestions.length === 0) {
      if (e.key === 'Escape') {
        setIsOpen(false)
      }
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlightIndex((prev) =>
          prev < suggestions.length - 1 ? prev + 1 : 0
        )
        break

      case 'ArrowUp':
        e.preventDefault()
        setHighlightIndex((prev) =>
          prev > 0 ? prev - 1 : suggestions.length - 1
        )
        break

      case 'Enter':
        e.preventDefault()
        if (highlightIndex >= 0 && highlightIndex < suggestions.length) {
          selectSuggestion(suggestions[highlightIndex])
        } else if (allowFreeText) {
          // Just close the dropdown, the user has typed their own value
          setIsOpen(false)
        }
        break

      case 'Escape':
        e.preventDefault()
        setIsOpen(false)
        break
    }
  }

  const selectSuggestion = (suggestion: string) => {
    onChange(suggestion)
    setIsOpen(false)
    setSuggestions([])
    setHighlightIndex(-1)
    inputRef.current?.focus()
  }

  // ─── Highlight Matching ───────────────────────────────────────────────────

  const highlightMatch = useMemo(() => {
    return (text: string) => {
      const lowerText = text.toLowerCase()
      const lowerValue = value.toLowerCase()

      if (!value.trim() || !lowerText.includes(lowerValue)) {
        return <span>{text}</span>
      }

      const startIndex = lowerText.indexOf(lowerValue)
      const endIndex = startIndex + value.length

      return (
        <span>
          {text.slice(0, startIndex)}
          <mark className="bg-purple-200 dark:bg-purple-800 text-purple-900 dark:text-purple-100 rounded-sm px-0.5">
            {text.slice(startIndex, endIndex)}
          </mark>
          {text.slice(endIndex)}
        </span>
      )
    }
  }, [value])

  // ─── Focus Input ──────────────────────────────────────────────────────────

  const handleFocus = () => {
    if (value.trim() && suggestions.length === 0) {
      fetchSuggestions(value)
    } else if (suggestions.length > 0) {
      setIsOpen(true)
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          placeholder={placeholder}
          disabled={disabled}
          className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-purple-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
          autoComplete="off"
          role="combobox"
          aria-expanded={isOpen}
          aria-autocomplete="list"
          aria-controls="autocomplete-list"
        />
        {loading && (
          <div className="absolute right-3 top-2.5">
            <svg className="animate-spin h-4 w-4 text-gray-400" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        )}
      </div>

      {/* Dropdown */}
      {isOpen && suggestions.length > 0 && (
        <ul
          id="autocomplete-list"
          role="listbox"
          className="absolute z-50 mt-1 w-full max-h-48 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg"
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion}
              role="option"
              aria-selected={index === highlightIndex}
              onClick={() => selectSuggestion(suggestion)}
              onMouseEnter={() => setHighlightIndex(index)}
              className={`px-3 py-2 text-sm cursor-pointer transition-colors ${
                index === highlightIndex
                  ? 'bg-purple-50 dark:bg-purple-900/30 text-purple-900 dark:text-purple-100'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            >
              {highlightMatch(suggestion)}
            </li>
          ))}
        </ul>
      )}

      {/* No results message */}
      {isOpen && suggestions.length === 0 && !loading && value.trim() && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg px-3 py-2 text-sm text-gray-400">
          {allowFreeText
            ? 'No matches found. You can type your own value.'
            : 'No matches found.'}
        </div>
      )}
    </div>
  )
}
