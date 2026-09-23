import { useEffect, useRef, useState } from 'react';

// 32x32 native pixel-art frames (upscaled crisp via image-rendering: pixelated).
const WALK_FRAMES = [
  '/koni_png/swan_walk_1.png',
  '/koni_png/swan_walk_2.png',
  '/koni_png/swan_walk_3.png',
  '/koni_png/swan_walk_4.png',
];
const JUMP_FRAMES = [
  '/koni_png/swan_jump_1.png',
  '/koni_png/swan_jump_2.png',
  '/koni_png/swan_jump_3.png',
  '/koni_png/swan_jump_4.png',
];

const MIN_X = 3; // left bound (% of lane width)
const MAX_X = 80; // right bound (bigger swan → keep it off the right edge)
const STEP = 1.6; // % moved per tick
const TICK_MS = 150; // walk frame + move cadence
const JUMP_FRAME_MS = 140; // per jump frame
const JUMP_MS = JUMP_FRAMES.length * JUMP_FRAME_MS; // full hop duration (~560ms, matches koniHop)

const reducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * A pixel-art KONI swan that waddles back and forth above the composer and hops
 * now and then (playing a 4-frame jump animation + a CSS vertical hop). Purely
 * decorative: aria-hidden, no interaction. Goes fully still under
 * prefers-reduced-motion and pauses while the panel is hidden.
 */
export default function KoniMascot() {
  const posRef = useRef(MIN_X);
  const dirRef = useRef(1); // 1 = moving/facing right, -1 = left
  const [{ pos, frame, facing }, setState] = useState({ pos: MIN_X, frame: 0, facing: 1 });
  const [jump, setJump] = useState<number | null>(null); // null = walking, 0..3 = jump frame
  const [reduced, setReduced] = useState(reducedMotion);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);

  // React to reduced-motion preference changes and tab/panel visibility.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const onMotion = () => setReduced(!!mq?.matches);
    const onVisibility = () => setHidden(document.hidden);
    mq?.addEventListener?.('change', onMotion);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mq?.removeEventListener?.('change', onMotion);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const animate = !reduced && !hidden;

  // Walk loop: move horizontally, turn at the edges, cycle the leg frame.
  useEffect(() => {
    if (!animate) return;
    let frameIndex = 0;
    const id = setInterval(() => {
      let next = posRef.current + dirRef.current * STEP;
      if (next >= MAX_X) {
        next = MAX_X;
        dirRef.current = -1;
      } else if (next <= MIN_X) {
        next = MIN_X;
        dirRef.current = 1;
      }
      posRef.current = next;
      frameIndex = (frameIndex + 1) % WALK_FRAMES.length;
      setState({ pos: next, frame: frameIndex, facing: dirRef.current });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [animate]);

  // Random hop every 3.5–8.5s: play the jump frames once + CSS vertical hop.
  useEffect(() => {
    if (!animate) {
      setJump(null);
      return;
    }
    let startT: ReturnType<typeof setTimeout>;
    let stepT: ReturnType<typeof setInterval>;
    let endT: ReturnType<typeof setTimeout>;
    const schedule = () => {
      startT = setTimeout(
        () => {
          let jf = 0;
          setJump(0);
          stepT = setInterval(() => {
            jf = Math.min(jf + 1, JUMP_FRAMES.length - 1);
            setJump(jf);
          }, JUMP_FRAME_MS);
          endT = setTimeout(() => {
            clearInterval(stepT);
            setJump(null);
            schedule();
          }, JUMP_MS);
        },
        3500 + Math.random() * 5000,
      );
    };
    schedule();
    return () => {
      clearTimeout(startT);
      clearInterval(stepT);
      clearTimeout(endT);
    };
  }, [animate]);

  const jumping = jump !== null;

  return (
    <div className="koni-mascot-lane" aria-hidden="true">
      <div className="koni-mascot" style={{ left: `${pos}%` }}>
        <div className={jumping ? 'koni-hopper koni-hopping' : 'koni-hopper'}>
          <img
            src={jumping ? JUMP_FRAMES[jump] : WALK_FRAMES[frame]}
            alt=""
            style={{ transform: `scaleX(${facing})` }}
          />
        </div>
      </div>
    </div>
  );
}
