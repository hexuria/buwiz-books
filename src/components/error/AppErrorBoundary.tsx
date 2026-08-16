import React from "react";
import { createLogger } from "../../lib/logger";

const logger = createLogger("ui.error-boundary");

interface AppErrorBoundaryProps {
  children: React.ReactNode;
  contextLabel?: string;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

export class AppErrorBoundary extends React.Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.error("Unhandled UI exception", {
      contextLabel: this.props.contextLabel ?? "Application",
      error,
      componentStack: errorInfo.componentStack,
    });
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-white/60 dark:bg-slate-900/60 backdrop-blur-sm">
        {/* Modal */}
        <div className="relative w-[512px] max-w-full rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-800 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/20 flex items-center justify-center shrink-0">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#ef4444"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">
                {this.props.contextLabel ?? "Application"}
              </p>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-white mt-0.5">
                Something went wrong
              </h2>
            </div>
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
            The page hit an unexpected runtime error. Retry this section first; reload the app if
            the problem persists.
          </p>
          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-100 dark:hover:bg-slate-700"
            >
              Reload App
            </button>
            <button
              type="button"
              onClick={this.handleRetry}
              className="rounded-xl bg-[#ef4444] px-4 py-2 text-sm font-medium text-white transition hover:bg-red-600"
            >
              Retry Action
            </button>
          </div>
          <details className="mt-6 group">
            <summary className="cursor-pointer text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 select-none flex items-center gap-1.5 focus:outline-none transition-colors w-fit list-none [&::-webkit-details-marker]:hidden">
              <svg
                className="w-4 h-4 transition-transform group-open:rotate-90"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M9 5l7 7-7 7"
                />
              </svg>
              View Error Details
            </summary>
            <div className="mt-3 rounded-xl bg-slate-50 p-4 font-mono text-[11px] leading-relaxed text-slate-600 dark:bg-slate-900/50 dark:text-slate-400 border border-slate-200 dark:border-slate-700/50 break-words break-all whitespace-pre-wrap max-h-[30vh] overflow-y-auto">
              <span className="font-semibold text-slate-800 dark:text-slate-200 block mb-1">
                Message:
              </span>
              {this.state.error.message}
              {this.state.error.stack && (
                <>
                  <span className="font-semibold text-slate-800 dark:text-slate-200 block mt-3 mb-1">
                    Stack trace:
                  </span>
                  <span className="opacity-80">{this.state.error.stack}</span>
                </>
              )}
            </div>
          </details>
        </div>
      </div>
    );
  }
}
