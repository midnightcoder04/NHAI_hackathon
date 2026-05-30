/**
 * T068: BackupStatusScreen — operator backup management panel.
 * T069: Retry button resets failed outbox entries and re-triggers sync.
 * T070: Cancel button sets the SyncService cancellation flag.
 * T071: Registered in AppNavigator as 'BackupStatus' route.
 */
import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Banner,
  Button,
  Card,
  Divider,
  Text,
} from 'react-native-paper';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import { useBackupStatusService } from '../services/BackupStatusService';
import { triggerSync, requestCancel } from '../services/SyncService';
import type { BackupJob } from '../models/BackupJob';

interface StatusState {
  lastSyncTime?: string;
  pendingCount: number;
  latestJob: BackupJob | null;
}

const STATUS_LABELS: Record<BackupJob['status'], string> = {
  in_progress: 'In progress',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function formatIso(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function BackupStatusScreen() {
  const db = useSQLiteContext();
  const service = useBackupStatusService();

  const [status, setStatus] = useState<StatusState | null>(null);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(async () => {
    const s = await service.getStatus();
    setStatus(s);
  }, [service]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const handleRetry = useCallback(async () => {
    setSyncing(true);
    try {
      await triggerSync(db);
    } finally {
      setSyncing(false);
      await refresh();
    }
  }, [db, refresh]);

  const handleCancel = useCallback(async () => {
    requestCancel();
    if (status?.latestJob?.id) {
      await service.cancelJob(status.latestJob.id);
    }
    await refresh();
  }, [service, status, refresh]);

  if (!status) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  const job = status.latestJob;
  const isInProgress = job?.status === 'in_progress';
  const isFailed = job?.status === 'failed';

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Card style={styles.card}>
        <Card.Title title="Sync Status" />
        <Card.Content>
          <Text variant="bodyMedium">
            Last successful sync: {formatIso(status.lastSyncTime)}
          </Text>
          <Text variant="bodyMedium" style={styles.row}>
            Pending records: {status.pendingCount}
          </Text>
        </Card.Content>
      </Card>

      {job ? (
        <Card style={styles.card}>
          <Card.Title title="Latest Backup Job" />
          <Card.Content>
            <Text variant="bodyMedium">Status: {STATUS_LABELS[job.status]}</Text>
            <Text variant="bodyMedium">Started: {formatIso(job.startedAt)}</Text>
            {job.completedAt ? (
              <Text variant="bodyMedium">Completed: {formatIso(job.completedAt)}</Text>
            ) : null}
            {job.status === 'completed' && (
              <>
                <Divider style={styles.divider} />
                <Text variant="bodySmall">Personnel: {job.recordsPersonnel}</Text>
                <Text variant="bodySmall">Verifications: {job.recordsVerification}</Text>
                <Text variant="bodySmall">Images: {job.recordsImages}</Text>
              </>
            )}
            {job.errorMessage ? (
              <>
                <Divider style={styles.divider} />
                <Banner
                  visible
                  icon="alert-circle"
                  actions={[]}
                >
                  {job.errorMessage}
                </Banner>
              </>
            ) : null}
          </Card.Content>
          <Card.Actions>
            {isFailed && (
              <Button
                mode="contained"
                onPress={handleRetry}
                loading={syncing}
                disabled={syncing}
                icon="refresh"
              >
                Retry
              </Button>
            )}
            {isInProgress && (
              <Button
                mode="outlined"
                onPress={handleCancel}
                icon="stop-circle"
              >
                Cancel
              </Button>
            )}
          </Card.Actions>
        </Card>
      ) : (
        <Text style={styles.empty}>No recent backup</Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 12 },
  card: {},
  row: { marginTop: 4 },
  divider: { marginVertical: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { textAlign: 'center', marginTop: 32, color: '#888' },
});
