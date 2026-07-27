import { useState } from 'react'

export default function SearchPage(): React.JSX.Element {
  const [query, setQuery] = useState('')

  const handleSearch = (e: React.FormEvent): void => {
    e.preventDefault()
    // Search functionality will be implemented in Phase 2
    console.log('Search query:', query)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Search</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Search nhentai for doujinshi to download
        </p>
      </div>

      {/* Search bar */}
      <form onSubmit={handleSearch} className="flex gap-2 mb-6">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by title, artist, or tags..."
          className="flex-1 px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
        />
        <button
          type="submit"
          className="px-6 py-2.5 rounded-lg bg-purple-600 text-white font-medium hover:bg-purple-700 transition-colors"
        >
          Search
        </button>
      </form>

      {/* Placeholder grid */}
      <div className="flex-1 flex items-center justify-center border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl">
        <div className="text-center text-gray-400 dark:text-gray-500">
          <span className="text-5xl block mb-3">🔍</span>
          <p className="text-lg font-medium">Search results will appear here</p>
          <p className="text-sm mt-1">Enter a search query to find doujinshi on nhentai</p>
        </div>
      </div>
    </div>
  )
}
