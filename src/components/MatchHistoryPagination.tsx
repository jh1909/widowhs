import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

export default function MatchHistoryPagination({ page, totalPages, onPageChange }: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  // Keep the same number of buttons, including near the first and last pages.
  const visiblePages = Math.min(5, totalPages);
  const firstPage = Math.max(1, Math.min(page - 2, totalPages - visiblePages + 1));
  const buttonClass = "h-9 w-7 sm:w-9 inline-flex items-center justify-center rounded bg-surface-container-high hover:bg-surface-container-highest disabled:opacity-40 disabled:cursor-not-allowed font-mono text-xs tabular-nums transition-colors focus-visible:outline focus-visible:outline-toxic-purple";

  return (
    <nav aria-label="Match history pages" className="mt-4 flex items-center justify-between gap-2">
      <div className="flex gap-1">
        <button type="button" aria-label="First page" title="First page" disabled={page === 1}
          onClick={() => onPageChange(1)} className={buttonClass}><ChevronsLeft size={16} /></button>
        <button type="button" aria-label="Previous page" title="Previous page" disabled={page === 1}
          onClick={() => onPageChange(page - 1)} className={buttonClass}><ChevronLeft size={16} /></button>
      </div>
      <div className="hidden sm:flex gap-1">
        {Array.from({ length: visiblePages }, (_, index) => firstPage + index).map(number => (
          <button type="button" key={number} aria-label={`Page ${number}`} aria-current={number === page ? "page" : undefined}
            onClick={() => onPageChange(number)}
            className={`${buttonClass} ${number === page ? "text-toxic-purple ring-1 ring-toxic-purple/50" : "text-zinc-400"}`}>
            {number}
          </button>
        ))}
      </div>
      <select aria-label="Go to match history page" value={page} onChange={event => onPageChange(Number(event.target.value))}
        className="sm:hidden h-9 w-24 rounded bg-surface-container-high px-1 text-xs font-mono tabular-nums text-zinc-300 focus-visible:outline focus-visible:outline-toxic-purple">
        {Array.from({ length: totalPages }, (_, index) => index + 1).map(number => (
          <option key={number} value={number}>{number} / {totalPages}</option>
        ))}
      </select>
      <div className="flex gap-1">
        <button type="button" aria-label="Next page" title="Next page" disabled={page === totalPages}
          onClick={() => onPageChange(page + 1)} className={buttonClass}><ChevronRight size={16} /></button>
        <button type="button" aria-label="Last page" title="Last page" disabled={page === totalPages}
          onClick={() => onPageChange(totalPages)} className={buttonClass}><ChevronsRight size={16} /></button>
      </div>
    </nav>
  );
}
