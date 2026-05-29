/**
 * T038: verification result overlay — the five FR-009 outcomes each render their
 * distinct label/colour/icon, and Authorized surfaces the matched personnel.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import VerificationResultOverlay, {
  outcomePresentation,
} from '../../../src/components/VerificationResultOverlay';
import type { VerificationOutcome } from '../../../src/models/VerificationRecord';

const renderOverlay = (props: Partial<React.ComponentProps<typeof VerificationResultOverlay>> = {}) =>
  render(
    <PaperProvider>
      <VerificationResultOverlay outcome="unauthorized" onDismiss={jest.fn()} {...props} />
    </PaperProvider>,
  );

describe('outcomePresentation', () => {
  const outcomes: VerificationOutcome[] = [
    'authorized',
    'unauthorized',
    'liveness_failed',
    'low_confidence',
    'quality_insufficient',
  ];

  it('gives_every_outcome_a_distinct_label_colour_and_icon', () => {
    const labels = new Set<string>();
    const colors = new Set<string>();
    for (const o of outcomes) {
      const p = outcomePresentation(o);
      expect(p.label).toBeTruthy();
      expect(p.icon).toBeTruthy();
      labels.add(p.label);
      colors.add(p.color);
    }
    expect(labels.size).toBe(outcomes.length);
    expect(colors.size).toBe(outcomes.length);
  });
});

describe('VerificationResultOverlay', () => {
  it('given_authorized_then_shows_personnel_name_and_role', () => {
    renderOverlay({
      outcome: 'authorized',
      personnel: { fullName: 'Asha Rao', role: 'Inspector' },
      confidenceScore: 0.91,
    });
    expect(screen.getByText('Authorized')).toBeTruthy();
    expect(screen.getByText('Asha Rao')).toBeTruthy();
    expect(screen.getByText('Inspector')).toBeTruthy();
  });

  it('given_unauthorized_then_shows_unauthorized_label', () => {
    renderOverlay({ outcome: 'unauthorized' });
    expect(screen.getByText('Unauthorized')).toBeTruthy();
  });

  it('given_liveness_failed_then_shows_liveness_label', () => {
    renderOverlay({ outcome: 'liveness_failed' });
    expect(screen.getByText('Liveness Check Failed')).toBeTruthy();
  });

  it('given_low_confidence_then_prompts_secondary_check', () => {
    renderOverlay({ outcome: 'low_confidence', confidenceScore: 0.55 });
    expect(screen.getByText('Low Confidence — Secondary Check Required')).toBeTruthy();
  });

  it('given_quality_insufficient_then_prompts_reposition', () => {
    renderOverlay({ outcome: 'quality_insufficient' });
    expect(screen.getByText('Image Quality Insufficient — Reposition Camera')).toBeTruthy();
  });

  it('given_dismiss_pressed_then_calls_onDismiss', () => {
    const onDismiss = jest.fn();
    renderOverlay({ onDismiss });
    fireEvent.press(screen.getByText('Done'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
