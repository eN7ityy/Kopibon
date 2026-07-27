export default function LibraryPage(): React.JSX.Element {
  return (
    <div className="flex flex-col h-full">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Library</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Browse your downloaded doujinshi collection
        </p>
      </div>

      <div className="flex-1 flex items-center justify-center border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl">
        <div className="text-center text-gray-400 dark:text-gray-500">
          <span className="text-5xl block mb-3">📚</span>
          <p className="text-lg font-medium">Library is empty</p>
          <p className="text-sm mt-1">
            Download your first doujin or add a custom entry to get started
          </p>
        </div>
      </div>
    </div>
  )
}
