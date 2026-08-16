/**
 * ExportImportSection — Settings section with Export/Import tabs
 */
import { useState } from "react";
import { ExportPanel } from "./ExportPanel";
import { ImportPanel } from "./ImportPanel";

type Tab = "export" | "import";

export function ExportImportSection() {
  const [tab, setTab] = useState<Tab>("export");

  return (
    <div>
      <h2 className="text-xl font-semibold text-[#1e293b] dark:text-white mb-1">Export / Import</h2>
      <p className="text-sm text-[#64748b] dark:text-white/50 mb-6">
        Export your organization&apos;s data for backup or transfer, or import data from a
        previously exported file.
      </p>

      {/* Tab pills */}
      <div className="flex items-center gap-1 p-1 bg-[#f1f5f9] dark:bg-white/5 rounded-xl w-fit mb-6">
        {(["export", "import"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              tab === t
                ? "bg-white dark:bg-[#1e293b] text-[#0d9488] dark:text-teal-400 shadow-sm"
                : "text-[#64748b] dark:text-white/50 hover:text-[#1e293b] dark:hover:text-white"
            }`}
          >
            <span className="flex items-center gap-2">
              {t === "export" ? (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              ) : (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              )}
              {t === "export" ? "Export" : "Import"}
            </span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "export" ? <ExportPanel /> : <ImportPanel />}
    </div>
  );
}
