import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface State {
  hasError: boolean;
  errorMessage: string;
  firestoreContext: { operationType?: string; path?: string; error?: string } | null;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '', firestoreContext: null };
  }

  static getDerivedStateFromError(error: Error): State {
    let firestoreContext: State['firestoreContext'] = null;
    try {
      const parsed = JSON.parse(error.message);
      if (parsed && typeof parsed === 'object' && 'operationType' in parsed) {
        firestoreContext = parsed;
      }
    } catch {
      // Standard runtime error
    }
    return {
      hasError: true,
      errorMessage: firestoreContext?.error || error.message || 'An unexpected error occurred.',
      firestoreContext,
    };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#F8FAFC] dark:bg-[#0F172A] p-6">
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] p-6 shadow-sm">
            <div className="flex items-center gap-3 text-[#DC2626] mb-3">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <h2 className="text-base font-semibold text-[#0F172A] dark:text-[#F8FAFC]">
                Something went wrong
              </h2>
            </div>
            <p className="text-sm text-[#475569] dark:text-[#CBD5E1] leading-relaxed">
              {this.state.errorMessage}
            </p>
            {this.state.firestoreContext?.path && (
              <p className="mt-3 text-xs font-mono text-[#475569] dark:text-[#CBD5E1] bg-[#F1F5F9] dark:bg-[#334155] rounded-lg px-3 py-2 break-all">
                {this.state.firestoreContext.operationType?.toUpperCase()} · {this.state.firestoreContext.path}
              </p>
            )}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-5 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-sm font-medium py-2.5 px-4 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Reload Territory Rx
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
