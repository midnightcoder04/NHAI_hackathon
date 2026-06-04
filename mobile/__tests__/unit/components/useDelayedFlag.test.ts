/**
 * T078: the 200 ms feedback-rule hook — a spinner shown for a sub-200 ms async op must
 * never flicker.
 */
import { renderHook, act } from '@testing-library/react-native';
import { useDelayedFlag } from '../../../src/components/useDelayedFlag';

describe('useDelayedFlag', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('stays false until the delay elapses, then becomes true', () => {
    const { result } = renderHook(() => useDelayedFlag(true, 200));
    expect(result.current).toBe(false);
    act(() => {
      jest.advanceTimersByTime(199);
    });
    expect(result.current).toBe(false);
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it('resets to false immediately when active goes false', () => {
    const { result, rerender } = renderHook((props: { a: boolean }) => useDelayedFlag(props.a, 200), {
      initialProps: { a: true },
    });
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(result.current).toBe(true);
    rerender({ a: false });
    expect(result.current).toBe(false);
  });

  it('never turns true for a sub-delay active burst (no flicker)', () => {
    const { result, rerender } = renderHook((props: { a: boolean }) => useDelayedFlag(props.a, 200), {
      initialProps: { a: true },
    });
    act(() => {
      jest.advanceTimersByTime(150);
    });
    rerender({ a: false }); // op finished before 200 ms
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(result.current).toBe(false);
  });
});
