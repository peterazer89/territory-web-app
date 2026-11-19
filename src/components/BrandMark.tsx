import React from 'react';

/**
 * Custom Territory Rx Blue Map Pin Logo:
 * Vertical gradient #0096FF -> #073B8A, white circle inside with blue medical "+" cross,
 * and white curved road swoosh underneath.
 */
export const TerritoryRxPinLogo: React.FC<{ className?: string }> = ({ className = 'w-14 h-14' }) => (
  <svg
    viewBox="0 0 80 86"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-hidden="true"
  >
    <defs>
      <linearGradient id="trxPinGrad" x1="40" y1="4" x2="40" y2="74" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#0096FF" />
        <stop offset="100%" stopColor="#073B8A" />
      </linearGradient>
    </defs>
    {/* Map Pin Body */}
    <path
      d="M40 4C22.327 4 8 18.327 8 36C8 55.2 31.8 73.2 37.9 77.6C39.15 78.5 40.85 78.5 42.1 77.6C48.2 73.2 72 55.2 72 36C72 18.327 57.673 4 40 4Z"
      fill="url(#trxPinGrad)"
    />
    {/* White Inner Circle */}
    <circle cx="40" cy="34" r="19" fill="#FFFFFF" />
    {/* Blue Medical Cross */}
    <rect x="35.5" y="22.5" width="9" height="23" rx="2.2" fill="#0A6BFF" />
    <rect x="28.5" y="29.5" width="23" height="9" rx="2.2" fill="#0A6BFF" />
    {/* White Curved Road Swoosh underneath */}
    <path
      d="M11 76C25 65 48 56 69 51"
      stroke="#FFFFFF"
      strokeWidth="5"
      strokeLinecap="round"
    />
  </svg>
);

/**
 * 34px circular gradient badge (#2563EB -> #0F766E) with white pharmacy mortar icon
 * used in the Center-Aligned Top App Bar.
 */
export const PharmacyBadgeIcon: React.FC<{ className?: string }> = ({ className = 'w-[34px] h-[34px]' }) => (
  <span
    className={`${className} rounded-full bg-gradient-to-br from-[#2563EB] via-[#0EA5E9] to-[#2DD4BF] inline-flex items-center justify-center shrink-0 shadow-xs`}
    aria-hidden="true"
  >
    <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" fill="none">
      {/* Pestle */}
      <path d="M15.8 4.2L18.2 5.4L15.6 9.8H13.1L15.8 4.2Z" fill="#071633" />
      {/* Mortar Bowl */}
      <path
        d="M5 10.5H19V12.5L17.4 18.4C17.1 19.3 16.3 20 15.3 20H8.7C7.7 20 6.9 19.3 6.6 18.4L5 12.5V10.5Z"
        fill="#071633"
      />
      {/* Medical Cross */}
      <path d="M11.1 12.6H12.9V14.4H14.7V16.2H12.9V18H11.1V16.2H9.3V14.4H11.1V12.6Z" fill="#FFFFFF" />
    </svg>
  </span>
);
