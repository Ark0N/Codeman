import React from 'react';
import {
  AbsoluteFill,
  Img,
  interpolate,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { colors } from '../lib/theme';
import { TitleCard } from '../components/TitleCard';
import { PhoneFrame } from '../components/PhoneFrame';
import { ClickCursor } from '../components/ClickCursor';

// ─── Scene timing (frames @ 30fps) ───
const TITLE_START = 0;
const TITLE_DUR = 45;

const DESKTOP_START = 45;
const WELCOME_DUR = 75; // 2.5s — show welcome screen
const CLAUDE_DUR = 90; // 3s — single Claude tab
const BOTH_OPENCODE_DUR = 90; // 3s — both tabs, OpenCode active
const TAB_SWITCH_DUR = 120; // 4s — tab switching animation
const DESKTOP_DUR = WELCOME_DUR + CLAUDE_DUR + BOTH_OPENCODE_DUR + TAB_SWITCH_DUR; // 375

const TRANSITION_START = DESKTOP_START + DESKTOP_DUR; // 420
const TRANSITION_DUR = 60;

const MOBILE_START = TRANSITION_START + TRANSITION_DUR; // 480
const MOBILE_DUR = 240;

const OUTRO_START = MOBILE_START + MOBILE_DUR; // 720
const OUTRO_DUR = 75;

export const TOTAL_FRAMES = OUTRO_START + OUTRO_DUR; // 795

// ─── Screenshot paths ───
const SCREENSHOTS = {
  desktopWelcome: staticFile('desktop-welcome.png'),
  desktopClaude: staticFile('desktop-claude.png'),
  desktopBothClaude: staticFile('desktop-both-claude.png'),
  desktopBothOpencode: staticFile('desktop-both-opencode.png'),
  mobileClaude: staticFile('mobile-claude.png'),
  mobileOpencode: staticFile('mobile-opencode.png'),
};

// ─── Desktop scene ───
const DesktopDemo: React.FC = () => {
  const frame = useCurrentFrame();

  // Key frames within the desktop scene (local frames)
  const claudeClickFrame = WELCOME_DUR - 15; // cursor clicks near end of welcome
  const claudeStart = WELCOME_DUR;

  const bothStart = WELCOME_DUR + CLAUDE_DUR; // both tabs appear
  const switchBase = bothStart + BOTH_OPENCODE_DUR;
  const switch1Frame = switchBase + 30; // switch to Claude
  const switch2Frame = switchBase + 75; // switch back to OpenCode

  // Determine which screenshot to show and cross-fade
  // Phase 1: Welcome (0 → WELCOME_DUR)
  // Phase 2: Claude single tab (WELCOME_DUR → bothStart)
  // Phase 3: Both tabs, OpenCode active (bothStart → switchBase)
  // Phase 4: Tab switching — OpenCode→Claude→OpenCode (switchBase → end)

  // Cross-fade durations
  const FADE = 10;

  // Welcome → Claude cross-fade
  const welcomeOpacity =
    frame < claudeStart - FADE
      ? 1
      : frame < claudeStart
        ? interpolate(frame, [claudeStart - FADE, claudeStart], [1, 0], {
            extrapolateRight: 'clamp',
          })
        : 0;

  const claudeSoloOpacity =
    frame < claudeStart
      ? 0
      : frame < claudeStart + FADE
        ? interpolate(frame, [claudeStart, claudeStart + FADE], [0, 1], {
            extrapolateRight: 'clamp',
          })
        : frame < bothStart - FADE
          ? 1
          : frame < bothStart
            ? interpolate(frame, [bothStart - FADE, bothStart], [1, 0], {
                extrapolateRight: 'clamp',
              })
            : 0;

  // Both tabs — determine which one is active
  let bothOpenCodeOpacity = 0;
  let bothClaudeOpacity = 0;

  if (frame >= bothStart) {
    // Fade in both-opencode initially
    if (frame < bothStart + FADE) {
      bothOpenCodeOpacity = interpolate(
        frame,
        [bothStart, bothStart + FADE],
        [0, 1],
        { extrapolateRight: 'clamp' },
      );
    } else if (frame < switch1Frame) {
      // Showing OpenCode
      bothOpenCodeOpacity = 1;
      bothClaudeOpacity = 0;
    } else if (frame < switch1Frame + FADE) {
      // Cross-fade OpenCode → Claude
      const t = interpolate(
        frame,
        [switch1Frame, switch1Frame + FADE],
        [0, 1],
        { extrapolateRight: 'clamp' },
      );
      bothOpenCodeOpacity = 1 - t;
      bothClaudeOpacity = t;
    } else if (frame < switch2Frame) {
      // Showing Claude
      bothOpenCodeOpacity = 0;
      bothClaudeOpacity = 1;
    } else if (frame < switch2Frame + FADE) {
      // Cross-fade Claude → OpenCode
      const t = interpolate(
        frame,
        [switch2Frame, switch2Frame + FADE],
        [0, 1],
        { extrapolateRight: 'clamp' },
      );
      bothOpenCodeOpacity = t;
      bothClaudeOpacity = 1 - t;
    } else {
      // Back to OpenCode
      bothOpenCodeOpacity = 1;
      bothClaudeOpacity = 0;
    }
  }

  // Welcome button positions for cursor (measured from actual screenshot)
  const welcomeBtnClaudeX = 651;
  const welcomeBtnClaudeY = 434;
  const welcomeBtnOpenCodeX = 803;
  const welcomeBtnOpenCodeY = 434;

  return (
    <AbsoluteFill style={{ background: colors.bg.dark }}>
      {/* Welcome screenshot */}
      {welcomeOpacity > 0 && (
        <AbsoluteFill style={{ opacity: welcomeOpacity }}>
          <Img
            src={SCREENSHOTS.desktopWelcome}
            style={{ width: 1920, height: 1080 }}
          />
        </AbsoluteFill>
      )}

      {/* Single Claude tab screenshot */}
      {claudeSoloOpacity > 0 && (
        <AbsoluteFill style={{ opacity: claudeSoloOpacity }}>
          <Img
            src={SCREENSHOTS.desktopClaude}
            style={{ width: 1920, height: 1080 }}
          />
        </AbsoluteFill>
      )}

      {/* Both tabs — OpenCode active */}
      {bothOpenCodeOpacity > 0 && (
        <AbsoluteFill style={{ opacity: bothOpenCodeOpacity }}>
          <Img
            src={SCREENSHOTS.desktopBothOpencode}
            style={{ width: 1920, height: 1080 }}
          />
        </AbsoluteFill>
      )}

      {/* Both tabs — Claude active */}
      {bothClaudeOpacity > 0 && (
        <AbsoluteFill style={{ opacity: bothClaudeOpacity }}>
          <Img
            src={SCREENSHOTS.desktopBothClaude}
            style={{ width: 1920, height: 1080 }}
          />
        </AbsoluteFill>
      )}

      {/* Cursor: click Claude Code button on welcome screen */}
      <Sequence
        from={claudeClickFrame - 20}
        durationInFrames={35}
        layout="none"
      >
        <ClickCursor
          fromX={960}
          fromY={300}
          x={welcomeBtnClaudeX}
          y={welcomeBtnClaudeY}
          moveStart={0}
          clickAt={20}
        />
      </Sequence>

      {/* Cursor: click to add OpenCode tab */}
      <Sequence
        from={bothStart - 20}
        durationInFrames={35}
        layout="none"
      >
        <ClickCursor
          fromX={welcomeBtnClaudeX}
          fromY={welcomeBtnClaudeY}
          x={welcomeBtnOpenCodeX}
          y={welcomeBtnOpenCodeY}
          moveStart={0}
          clickAt={20}
        />
      </Sequence>

      {/* Cursor: switch to Claude tab (first tab in header) */}
      <Sequence
        from={switch1Frame - 15}
        durationInFrames={20}
        layout="none"
      >
        <ClickCursor
          fromX={500}
          fromY={300}
          x={128}
          y={17}
          moveStart={0}
          clickAt={15}
        />
      </Sequence>

      {/* Cursor: switch back to OpenCode tab (second tab in header) */}
      <Sequence
        from={switch2Frame - 15}
        durationInFrames={20}
        layout="none"
      >
        <ClickCursor
          fromX={128}
          fromY={17}
          x={245}
          y={17}
          moveStart={0}
          clickAt={15}
        />
      </Sequence>
    </AbsoluteFill>
  );
};

// ─── Device transition ───
const DeviceTransition: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Desktop shrinks down
  const shrinkProgress = spring({
    frame,
    fps,
    config: { damping: 200 },
    durationInFrames: 45,
  });

  const desktopScale = interpolate(shrinkProgress, [0, 1], [1, 0.35]);
  const desktopOpacity = interpolate(shrinkProgress, [0, 1], [1, 0], {
    extrapolateRight: 'clamp',
  });

  // Phone frame fades in
  const phoneOpacity = interpolate(frame, [20, 40], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const phoneScale = interpolate(frame, [20, 50], [0.8, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        background: colors.bg.dark,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      {/* Shrinking desktop screenshot */}
      <div
        style={{
          position: 'absolute',
          width: 1920,
          height: 1080,
          transform: `scale(${desktopScale})`,
          opacity: desktopOpacity,
        }}
      >
        <Img
          src={SCREENSHOTS.desktopBothClaude}
          style={{ width: 1920, height: 1080 }}
        />
      </div>

      {/* Phone frame appearing */}
      <div
        style={{
          opacity: phoneOpacity,
          transform: `scale(${phoneScale})`,
        }}
      >
        <PhoneFrame width={375} height={700}>
          <Img
            src={SCREENSHOTS.mobileClaude}
            style={{ width: 375, height: 700, objectFit: 'cover' }}
          />
        </PhoneFrame>
      </div>
    </AbsoluteFill>
  );
};

// ─── Mobile scene ───
const MobileDemo: React.FC = () => {
  const frame = useCurrentFrame();

  // Mobile: Claude for 90 frames, then swipe to OpenCode
  const swipeFrame = 90;
  const swipeDuration = 20;

  const isOpenCode = frame >= swipeFrame + swipeDuration;
  const isSwiping =
    frame >= swipeFrame && frame < swipeFrame + swipeDuration;

  // Slide offset
  const slideProgress = isSwiping
    ? interpolate(frame - swipeFrame, [0, swipeDuration], [0, 1], {
        extrapolateRight: 'clamp',
      })
    : isOpenCode
      ? 1
      : 0;

  const slideX = interpolate(slideProgress, [0, 1], [0, -375]);

  return (
    <PhoneFrame width={375} height={700}>
      <div
        style={{
          width: 375,
          height: 700,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {/* Sliding container with both screenshots */}
        <div
          style={{
            display: 'flex',
            width: 750,
            height: 700,
            transform: `translateX(${slideX}px)`,
          }}
        >
          <Img
            src={SCREENSHOTS.mobileClaude}
            style={{ width: 375, height: 700, flexShrink: 0, objectFit: 'cover' }}
          />
          <Img
            src={SCREENSHOTS.mobileOpencode}
            style={{ width: 375, height: 700, flexShrink: 0, objectFit: 'cover' }}
          />
        </div>

        {/* Swipe indicator */}
        {isSwiping && (
          <SwipeIndicator
            frame={frame - swipeFrame}
            duration={swipeDuration}
          />
        )}
      </div>
    </PhoneFrame>
  );
};

// Swipe gesture indicator
const SwipeIndicator: React.FC<{ frame: number; duration: number }> = ({
  frame,
  duration,
}) => {
  const progress = interpolate(frame, [0, duration], [0, 1], {
    extrapolateRight: 'clamp',
  });
  const x = interpolate(progress, [0, 1], [300, 75]);
  const opacity = interpolate(
    progress,
    [0, 0.2, 0.8, 1],
    [0, 0.7, 0.7, 0],
    { extrapolateRight: 'clamp' },
  );

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 60,
        left: x,
        width: 40,
        height: 40,
        borderRadius: '50%',
        background: 'rgba(255,255,255,0.15)',
        border: '2px solid rgba(255,255,255,0.3)',
        opacity,
        zIndex: 20,
      }}
    />
  );
};

// ─── Main composition ───
export const CodemanDemo: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: colors.bg.dark }}>
      {/* Scene 1: Title */}
      <Sequence durationInFrames={TITLE_DUR} premountFor={0}>
        <TitleCard text="Codeman" subtitle="AI Session Manager" />
      </Sequence>

      {/* Scene 2-5: Desktop flow (cross-fading screenshots) */}
      <Sequence
        from={DESKTOP_START}
        durationInFrames={DESKTOP_DUR}
        premountFor={15}
      >
        <DesktopDemo />
      </Sequence>

      {/* Scene 6: Desktop → Mobile transition */}
      <Sequence
        from={TRANSITION_START}
        durationInFrames={TRANSITION_DUR}
        premountFor={15}
      >
        <DeviceTransition />
      </Sequence>

      {/* Scene 7-9: Mobile flow (swipe between Claude/OpenCode) */}
      <Sequence
        from={MOBILE_START}
        durationInFrames={MOBILE_DUR}
        premountFor={15}
      >
        <AbsoluteFill
          style={{
            background: colors.bg.dark,
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <MobileDemo />
        </AbsoluteFill>
      </Sequence>

      {/* Scene 10: Outro */}
      <Sequence
        from={OUTRO_START}
        durationInFrames={OUTRO_DUR}
        premountFor={15}
      >
        <TitleCard
          text="Codeman"
          subtitle="Manage any AI coding tool"
          showUrl
        />
      </Sequence>
    </AbsoluteFill>
  );
};
