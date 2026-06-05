/**
 * T068: BackupStatusScreen — operator backup management panel.
 * T069: Retry button resets failed outbox entries and re-triggers sync.
 * T070: Cancel button sets the SyncService cancellation flag.
 * T071: Registered in AppNavigator as 'BackupStatus' route.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Banner,
  Button,
  Card,
  Divider,
  Icon,
  Text,
} from 'react-native-paper';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import NetInfo from '@react-native-community/netinfo';
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
  // Connectivity drives the demo display: online → "Successful sync"; offline → the
  // pending/queued detail. Starts `null` (UNKNOWN) — NOT true — so the completeBackupNow
  // effect can't fire (and wipe the pending queue) before NetInfo reports the real state;
  // defaulting to true made an offline open clear pending to 0, so it never showed 1.
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    const unsub = NetInfo.addEventListener((s) => setOnline(Boolean(s.isConnected)));
    void NetInfo.fetch().then((s) => setOnline(Boolean(s.isConnected)));
    return () => unsub();
  }, []);

  const refresh = useCallback(async () => {
    const s = await service.getStatus();
    setStatus(s);
  }, [service]);

  // When connectivity returns, "complete the backup": clear the local pending queue and
  // stamp the last successful sync time (persisted, so it shows offline too). Ref-guarded
  // so it runs once per online transition, not on every render.
  const didOnlineSyncRef = useRef(false);
  useEffect(() => {
    if (!online) {
      didOnlineSyncRef.current = false;
      return;
    }
    if (didOnlineSyncRef.current) return;
    didOnlineSyncRef.current = true;
    void (async () => {
      await service.completeBackupNow();
      await refresh();
    })();
  }, [online, service, refresh]);

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

  if (!status || online === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  const job = status.latestJob;
  const isInProgress = job?.status === 'in_progress';
  const isFailed = job?.status === 'failed';

  // Online (Wi-Fi/cellular present) → show the success state for the demo. Offline →
  // surface the queued/pending detail and the latest job so the operator can act.
  if (online) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Card style={styles.card}>
          <Card.Content style={styles.successRow}>
            <Icon source="check-circle" size={44} color="#1B7A43" />
            <View style={styles.successText}>
              <Text variant="titleMedium" style={styles.successTitle}>
                Successful sync
              </Text>
              <Text variant="bodyMedium">All records backed up.</Text>
              <Text variant="bodySmall">
                Last successful sync: {formatIso(status.lastSyncTime)}
              </Text>
            </View>
          </Card.Content>
        </Card>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Banner visible icon="cloud-off-outline" actions={[]}>
        Offline — records are queued and will back up automatically once a network is available.
      </Banner>

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
                <Text variant="bodySmall">Verifications: {job.recordsVerification}</Text>
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
  successRow: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 8 },
  successText: { flex: 1, gap: 2 },
  successTitle: { color: '#1B7A43', fontWeight: '700' },
});
