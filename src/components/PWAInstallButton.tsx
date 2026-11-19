import React, { useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  compact?: boolean;
  className?: string;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  compact = false,
  className = '',
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        className={`inline-flex items-center justify-center gap-2 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-medium transition-colors whitespace-nowrap shrink-0 ${
          compact ? 'px-3 py-2 text-xs min-h-[40px]' : 'px-4 py-2.5 text-sm min-h-[44px]'
        } ${className}`}
      >
        <Download className="w-4 h-4 shrink-0" />
        <span>{compact ? 'Install' : 'Install Territory Rx'}</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className={`inline-flex items-center justify-center gap-2 rounded-xl border border-[#E2E8F0] dark:border-[#334155] bg-white dark:bg-[#1E293B] text-[#0F172A] dark:text-[#F8FAFC] hover:bg-[#F1F5F9] dark:hover:bg-[#334155] font-medium transition-colors whitespace-nowrap shrink-0 ${
            compact ? 'px-3 py-2 text-xs min-h-[40px]' : 'px-4 py-2.5 text-sm min-h-[44px]'
          } ${className}`}
        >
          <Share className="w-4 h-4 shrink-0" />
          <span>{compact ? 'Add to Home' : 'Install on iPhone / iPad'}</span>
        </button>

        {showIOSGuide && (
          <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm p-4"
            role="dialog"
            aria-modal="true"
            aria-label="Install Territory Rx on iOS"
          >
            <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] p-6 shadow-xl">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-semibold text-[#0F172A] dark:text-[#F8FAFC]">
                  Install on iPhone / iPad
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  className="p-2 -mr-2 text-[#475569] dark:text-[#CBD5E1] hover:text-[#0F172A] dark:hover:text-white rounded-lg"
                  aria-label="Close install guide"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <ol className="space-y-2.5 text-sm text-[#475569] dark:text-[#CBD5E1]">
                <li>
                  1. Tap the <strong className="text-[#0F172A] dark:text-white">Share</strong> button in Safari&apos;s toolbar.
                </li>
                <li>
                  2. Scroll down and tap <strong className="text-[#0F172A] dark:text-white">Add to Home Screen</strong>.
                </li>
                <li>
                  3. Tap <strong className="text-[#0F172A] dark:text-white">Add</strong> to launch Territory Rx full-screen with offline cache.
                </li>
              </ol>
              <p className="mt-4 text-xs text-[#475569] dark:text-[#CBD5E1] bg-[#F1F5F9] dark:bg-[#334155] rounded-xl p-3">
                Note for iOS Safari: Apple pauses background sync when closed. Offline edits are safely stored in IndexedDB and sync automatically as soon as you reopen the app.
              </p>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-4 w-full min-h-[44px] rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-sm font-medium transition-colors"
              >
                Got it
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
