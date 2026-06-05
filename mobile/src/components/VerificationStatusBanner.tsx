import React from 'react';
import { StyleSheet, View } from 'react-native';
import { ActivityIndicator, Icon, Surface, Text } from 'react-native-paper';
import type { VerificationOutcome } from '../models/VerificationRecord';
import type { LivenessReason } from '../ml/LivenessDetector';
import { outcomePresentation } from './VerificationResultOverlay';

/**
 * Operator-facing wording for each failing liveness layer. Kept deliberately calm and
 * production-y (no model jargon) while still telling the operator WHICH check failed so
 * a stuck scan is debuggable on-site.
 */
export function livenessReasonText(reason: LivenessReason): string | null {
  switch (reason) {
    case 'spoof':
      return 'Potential Spoof';
    case 'no_movement':
      return 'Movement Not Detected';
    case 'no_face':
      return 'Face Not Detected';
    case 'live':
      return null;
  }
}

export interface VerificationStatusBannerProps {
  /**
   *  - `prompt`   Phase 2: ask the operator to act (e.g. "Blink to verify").
   *  - `scanning` Phase 3: the one-shot execution burst is running.
   *  - `notice`   a transient message (e.g. liveness timed out — try again).
   *  - `result`   the resolved verification outcome.
   */
  status: 'prompt' | 'scanning' | 'notice' | 'result';
  message?: string;
  outcome?: VerificationOutcome;
  livenessReason?: LivenessReason | null;
  personnel?: { fullName: string; role: string } | null;
  confidenceScore?: number;
}

/**
 * Compact bottom banner for the continuous (hands-free) verification loop. Unlike the
 * old full-screen overlay it never blocks the camera or needs a "Done" tap — it just
 * reports the current phase / latest scan while the loop keeps watching for the next face.
 *
 * Result is conveyed by icon + text (not colour alone) per Constitution IV / WCAG 2.1 AA.
 */
export default function VerificationStatusBanner({
  status,
  message,
  outcome,
  livenessReason,
  personnel,
  confidenceScore,
}: VerificationStatusBannerProps) {
  if (status === 'prompt') {
    return (
      <Surface
        style={[styles.container, { backgroundColor: '#1565C0' }]}
        accessibilityRole="alert"
        accessibilityLabel={message ?? 'Blink to verify'}
      >
        <Icon source="eye-outline" size={40} color="white" />
        <View style={styles.text}>
          <Text variant="titleMedium" style={styles.label}>
            {message ?? 'Blink to verify'}
          </Text>
          <Text variant="bodySmall" style={styles.sub}>
            Keep your face in the frame
          </Text>
        </View>
      </Surface>
    );
  }

  if (status === 'scanning') {
    return (
      <Surface
        style={[styles.container, { backgroundColor: '#1565C0' }]}
        accessibilityRole="progressbar"
        accessibilityLabel="Verifying"
      >
        <ActivityIndicator animating color="white" />
        <View style={styles.text}>
          <Text variant="titleMedium" style={styles.label}>
            Verifying…
          </Text>
          <Text variant="bodySmall" style={styles.sub}>
            Hold still and look at the camera
          </Text>
        </View>
      </Surface>
    );
  }

  if (status === 'notice') {
    return (
      <Surface
        style={[styles.container, { backgroundColor: '#FF8F00' }]}
        accessibilityRole="alert"
        accessibilityLabel={message ?? ''}
      >
        <Icon source="information" size={40} color="white" />
        <View style={styles.text}>
          <Text variant="titleMedium" style={styles.label}>
            {message}
          </Text>
        </View>
      </Surface>
    );
  }

  if (!outcome) return null;
  const { label, color, icon } = outcomePresentation(outcome);
  // For a liveness failure, append the SPECIFIC failing layer so it's debuggable.
  const reasonText =
    outcome === 'liveness_failed' && livenessReason ? livenessReasonText(livenessReason) : null;

  return (
    <Surface
      style={[styles.container, { backgroundColor: color }]}
      accessibilityRole="summary"
      accessibilityLabel={`Verification result: ${label}${reasonText ? `, ${reasonText}` : ''}`}
    >
      <Icon source={icon} size={40} color="white" />
      <View style={styles.text}>
        <Text variant="titleMedium" style={styles.label}>
          {reasonText ? `${label} — ${reasonText}` : label}
        </Text>
        {outcome === 'authorized' && personnel ? (
          <Text variant="bodyMedium" style={styles.sub}>
            {personnel.fullName} · {personnel.role}
          </Text>
        ) : null}
        {confidenceScore !== undefined ? (
          <Text variant="bodySmall" style={styles.sub}>
            Confidence: {(confidenceScore * 100).toFixed(0)}%
          </Text>
        ) : null}
      </View>
    </Surface>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 20,
    paddingVertical: 18,
    paddingBottom: 28,
  },
  text: { flex: 1, gap: 2 },
  label: { color: 'white', fontWeight: '700' },
  sub: { color: 'white' },
});
