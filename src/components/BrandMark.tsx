import React, { useId } from 'react';

interface TerritoryRxIconProps {
  size?: number | string;
  rounded?: number | string;
  className?: string;
}

/**
 * Territory Rx Android launcher icon component:
 * Diagonal #0A3D62 -> #079992 gradient background with white medical map pin,
 * clipped to a rounded-square frame (default border-radius: 22%).
 */
export const TerritoryRxIcon: React.FC<TerritoryRxIconProps> = ({
  size = 40,
  rounded,
  className = '',
}) => {
  const gradId = useId().replace(/:/g, '');
  const borderRadius =
    rounded !== undefined
      ? typeof rounded === 'number'
        ? `${rounded}px`
        : rounded
      : '22%';

  return (
    <span
      className={`inline-block shrink-0 overflow-hidden select-none ${className}`}
      style={{
        width: typeof size === 'number' ? `${size}px` : size,
        height: typeof size === 'number' ? `${size}px` : size,
        borderRadius,
      }}
      aria-hidden="true"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 512 512"
        className="w-full h-full block"
      >
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#0A3D62" />
            <stop offset="100%" stopColor="#079992" />
          </linearGradient>
        </defs>
        <rect width="512" height="512" fill={`url(#${gradId})`} />
        <g transform="translate(44.8, 44.8) scale(17.6)">
          <path
            fill="#FFFFFF"
            fillRule="evenodd"
            d="M12,2C8.13,2 5,5.13 5,9c0,5.25 7,13 7,13s7,-7.75 7,-13c0,-3.87 -3.13,-7 -7,-7zM15,10h-2v2h-2v-2H9V8h2V6h2v2h2v2z"
          />
        </g>
      </svg>
    </span>
  );
};

export const TerritoryRxPinLogo: React.FC<{ className?: string }> = ({ className = '' }) => (
  <TerritoryRxIcon size={64} rounded={14} className={className} />
);

export const PharmacyBadgeIcon: React.FC<{ className?: string }> = ({ className = '' }) => (
  <TerritoryRxIcon size={36} rounded={8} className={className} />
);
