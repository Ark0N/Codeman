import React from 'react';
import { Composition } from 'remotion';
import { CodemanDemo, TOTAL_FRAMES } from './compositions/CodemanDemo';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="CodemanDemo"
      component={CodemanDemo}
      durationInFrames={TOTAL_FRAMES}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
