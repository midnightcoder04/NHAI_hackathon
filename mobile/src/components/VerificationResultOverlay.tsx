import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Icon, Surface, Text } from 'react-native-paper';
import type { VerificationOutcome } from '../models/VerificationRecord';

export interface OutcomePresentation {
  label: string;
  color: string;
  icon: string;
}

/**
 * Maps each FR-009 outcome to its label, colour, and icon. Result is conveyed by
 * text + icon (not colour alone) per Constitution IV / WCAG 2.1 AA.
 */
export function outcomePresentation(outcome: VerificationOutcome): OutcomePresentation {
  switch (outcome) {
    case 'authorized':
      return { label: 'Authorized', color: '#2E7D32', icon: 'check-circle' };
    case 'unauthorized':
      return { label: 'Unauthorized', color: '#C62828', icon: 'close-circle' };
    case 'liveness_failed':
      return { label: 'Liveness Check Failed', color: '#FF8F00', icon: 'shield-alert' };
    case 'low_confidence':
      return {
        label: 'Low Confidence — Secondary Check Required',
        color: '#EF6C00',
        icon: 'help-circle',
      };
    case 'quality_insufficient':
      return {
        label: 'Image Quality Insufficient — Reposition Camera',
        color: '#616161',
        icon: 'camera-retake',
      };
  }
}

export interface VerificationResultOverlayProps {
  outcome: VerificationOutcome;
  personnel?: { fullName: string; role: string } | null;
  confidenceScore?: number;
  onDismiss: () => void;
}

export default function VerificationResultOverlay({
  outcome,
  personnel,
  confidenceScore,
  onDismiss,
}: VerificationResultOverlayProps) {
  const { label, color, icon } = outcomePresentation(outcome);

  return (
    <Surface
      style={[styles.container, { backgroundColor: color }]}
      accessibilityRole="summary"
      accessibilityLabel={`Verification result: ${label}`}
    >
      <Icon source={icon} size={96} color="white" />
      <Text variant="headlineSmall" style={styles.label}>
        {label}
      </Text>

      {outcome === 'authorized' && personnel ? (
        <View style={styles.details}>
          <Text variant="titleLarge" style={styles.name}>
            {personnel.fullName}
          </Text>
          <Text variant="bodyLarge" style={styles.sub}>
            {personnel.role}
          </Text>
        </View>
      ) : null}

      {confidenceScore !== undefined ? (
        <Text variant="bodyMedium" style={styles.sub}>
          Confidence: {(confidenceScore * 100).toFixed(0)}%
        </Text>
      ) : null}

      <Button
        mode="contained-tonal"
        onPress={onDismiss}
        style={styles.dismiss}
        accessibilityLabel="Dismiss result and verify again"
      >
        Done
      </Button>
    </Surface>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  label: { color: 'white', textAlign: 'center', fontWeight: '700' },
  details: { alignItems: 'center', gap: 4, marginTop: 8 },
  name: { color: 'white', fontWeight: '700' },
  sub: { color: 'white' },
  dismiss: { marginTop: 24 },
});
