import React from 'react';
import {
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

type ClickCursorProps = {
  /** X position to move to */
  x: number;
  /** Y position to move to */
  y: number;
  /** Frame at which cursor starts moving (local frame) */
  moveStart: number;
  /** Frame at which click happens */
  clickAt: number;
  /** Starting X (defaults to center-right) */
  fromX?: number;
  /** Starting Y */
  fromY?: number;
};

export const ClickCursor: React.FC<ClickCursorProps> = ({
  x,
  y,
  moveStart,
  clickAt,
  fromX = 960,
  fromY = 400,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Move animation (spring-based)
  const moveProgress = spring({
    frame: Math.max(0, frame - moveStart),
    fps,
    config: { damping: 200 },
    durationInFrames: Math.max(1, clickAt - moveStart),
  });

  const cursorX = interpolate(moveProgress, [0, 1], [fromX, x]);
  const cursorY = interpolate(moveProgress, [0, 1], [fromY, y]);

  // Click pulse
  const clickProgress =
    frame >= clickAt
      ? interpolate(frame - clickAt, [0, 8], [0, 1], {
          extrapolateRight: 'clamp',
        })
      : 0;
  const clickScale = interpolate(clickProgress, [0, 0.5, 1], [0, 1.2, 0], {
    extrapolateRight: 'clamp',
  });
  const clickOpacity = interpolate(clickProgress, [0, 0.5, 1], [0, 0.6, 0], {
    extrapolateRight: 'clamp',
  });

  // Hide cursor before it starts moving
  const cursorOpacity =
    frame < moveStart
      ? 0
      : interpolate(frame - moveStart, [0, 5], [0, 1], {
          extrapolateRight: 'clamp',
        });

  return (
    <div
      style={{
        position: 'absolute',
        left: cursorX,
        top: cursorY,
        opacity: cursorOpacity,
        zIndex: 100,
        pointerEvents: 'none',
      }}
    >
      {/* Click pulse ring */}
      <div
        style={{
          position: 'absolute',
          width: 30,
          height: 30,
          borderRadius: '50%',
          border: '2px solid rgba(255,255,255,0.5)',
          transform: `translate(-50%, -50%) scale(${clickScale})`,
          opacity: clickOpacity,
        }}
      />
      {/* Cursor arrow */}
      <svg
        width="20"
        height="24"
        viewBox="0 0 20 24"
        fill="none"
        style={{ filter: 'drop-shadow(1px 2px 3px rgba(0,0,0,0.5))' }}
      >
        <path
          d="M2 2L2 20L7 15L12 22L15 20L10 13L17 13L2 2Z"
          fill="white"
          stroke="black"
          strokeWidth="1.5"
        />
      </svg>
    </div>
  );
};
