import React from 'react';
import { spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { colors } from '../lib/theme';

type PhoneFrameProps = {
  children: React.ReactNode;
  /** Width of the phone viewport */
  width?: number;
  /** Height of the phone viewport */
  height?: number;
};

export const PhoneFrame: React.FC<PhoneFrameProps> = ({
  children,
  width = 375,
  height = 812,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Scale-in animation
  const scale = spring({
    frame,
    fps,
    config: { damping: 15, stiffness: 80 },
  });

  const bezelW = width + 24;
  const bezelH = height + 24;

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        width: '100%',
        height: '100%',
        transform: `scale(${scale})`,
      }}
    >
      <div
        style={{
          width: bezelW,
          height: bezelH,
          borderRadius: 44,
          background: '#1a1a1a',
          border: '2px solid #333',
          padding: 12,
          position: 'relative',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
        }}
      >
        {/* Notch / Dynamic Island */}
        <div
          style={{
            position: 'absolute',
            top: 10,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 120,
            height: 28,
            borderRadius: 14,
            background: '#000',
            zIndex: 20,
          }}
        />

        {/* Screen content */}
        <div
          style={{
            width,
            height,
            borderRadius: 32,
            overflow: 'hidden',
            background: colors.bg.dark,
            position: 'relative',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
};
