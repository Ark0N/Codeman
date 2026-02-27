import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { colors, fonts } from '../lib/theme';

type TitleCardProps = {
  text: string;
  subtitle: string;
  showUrl?: boolean;
};

export const TitleCard: React.FC<TitleCardProps> = ({
  text,
  subtitle,
  showUrl = false,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Logo fade + scale in
  const logoOpacity = interpolate(frame, [0, 0.5 * fps], [0, 1], {
    extrapolateRight: 'clamp',
  });
  const logoScale = interpolate(frame, [0, 0.5 * fps], [0.8, 1], {
    extrapolateRight: 'clamp',
  });

  // Subtitle fades in slightly after logo
  const subtitleOpacity = interpolate(
    frame,
    [0.3 * fps, 0.8 * fps],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  // URL fades in last
  const urlOpacity = showUrl
    ? interpolate(frame, [0.6 * fps, 1.1 * fps], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 0;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: colors.bg.dark,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      {/* Lightning bolt icon */}
      <div
        style={{
          opacity: logoOpacity,
          transform: `scale(${logoScale})`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 16,
        }}
      >
        <svg width="64" height="64" viewBox="0 0 32 32">
          <defs>
            <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#60a5fa" />
              <stop offset="100%" stopColor="#3b82f6" />
            </linearGradient>
          </defs>
          <rect width="32" height="32" rx="6" fill="#0a0a0a" />
          <path d="M18 4L8 18h6l-2 10 10-14h-6z" fill="url(#g)" />
        </svg>

        <div
          style={{
            fontFamily: fonts.ui,
            fontSize: 72,
            fontWeight: 700,
            color: colors.accent.blue,
            letterSpacing: -1,
          }}
        >
          {text}
        </div>
      </div>

      <div
        style={{
          opacity: subtitleOpacity,
          fontFamily: fonts.ui,
          fontSize: 28,
          color: colors.text.dim,
          marginTop: 12,
        }}
      >
        {subtitle}
      </div>

      {showUrl && (
        <div
          style={{
            opacity: urlOpacity,
            fontFamily: fonts.mono,
            fontSize: 18,
            color: colors.text.muted,
            marginTop: 24,
          }}
        >
          github.com/Ark0N/Codeman
        </div>
      )}
    </AbsoluteFill>
  );
};
