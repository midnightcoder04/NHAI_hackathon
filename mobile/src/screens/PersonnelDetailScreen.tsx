import React, { useEffect, useRef, useState } from 'react';
import { Image, ScrollView, StyleSheet, View } from 'react-native';
import {
  Button,
  Dialog,
  Portal,
  Snackbar,
  Text,
  TextInput,
} from 'react-native-paper';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import {
  Camera,
  type CameraRef,
  useCameraDevice,
  useCameraPermission,
  usePhotoOutput,
} from 'react-native-vision-camera';
import { usePersonnelRepository } from '../db/repositories/PersonnelRepository';
import { useFaceImageRepository } from '../db/repositories/FaceImageRepository';
import { ImageStorageService, StorageFullError } from '../services/ImageStorageService';
import { EmbeddingModel } from '../ml/EmbeddingModel';
import type { RootStackParamList } from '../navigation/AppNavigator';

type RouteType = RouteProp<RootStackParamList, 'PersonnelDetail'>;

// Stub: replaced by SyncOutboxRepository.enqueue in T042
async function enqueueSyncStub(): Promise<void> {}

export default function PersonnelDetailScreen() {
  const navigation = useNavigation();
  const route = useRoute<RouteType>();
  const { personnelId } = route.params ?? {};
  const isEditMode = Boolean(personnelId);

  const personnelRepo = usePersonnelRepository();
  const faceRepo = useFaceImageRepository();

  const [fullName, setFullName] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [role, setRole] = useState('');
  const [capturedImagePath, setCapturedImagePath] = useState<string | null>(null);
  const [capturedEmbedding, setCapturedEmbedding] = useState<Float32Array | null>(null);
  const [snackMsg, setSnackMsg] = useState('');
  const [deleteDialogVisible, setDeleteDialogVisible] = useState(false);
  const [saving, setSaving] = useState(false);

  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  const cameraRef = useRef<CameraRef>(null);
  const photoOutput = usePhotoOutput();

  useEffect(() => {
    if (!isEditMode || !personnelId) return;
    personnelRepo.findById(personnelId).then(p => {
      if (!p) return;
      setFullName(p.fullName);
      setEmployeeId(p.employeeId);
      setRole(p.role);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personnelId]);

  useEffect(() => {
    if (!hasPermission) requestPermission();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function capturePhoto() {
    try {
      const photo = await photoOutput.capturePhotoToFile({}, {});
      const now = Date.now();
      const fileName = `${personnelId ?? 'new'}_${now}.jpg`;
      const savedPath = await ImageStorageService.save(photo.filePath, fileName);
      const embedding = await EmbeddingModel.extractEmbedding(savedPath);
      setCapturedImagePath(savedPath);
      setCapturedEmbedding(embedding);
    } catch (err) {
      if (err instanceof StorageFullError) {
        setSnackMsg('Not enough storage to save photo.');
      } else {
        setSnackMsg('Failed to capture photo.');
      }
    }
  }

  async function handleSave() {
    if (!fullName.trim() || !employeeId.trim() || !role.trim()) {
      setSnackMsg('All fields are required.');
      return;
    }
    setSaving(true);
    try {
      const now = new Date().toISOString();

      if (isEditMode && personnelId) {
        await personnelRepo.update(personnelId, { fullName, employeeId, role });
      } else {
        const created = await personnelRepo.create({
          employeeId,
          fullName,
          role,
          registeredAt: now,
          updatedAt: now,
          syncStatus: 'pending',
        });

        if (capturedImagePath && capturedEmbedding) {
          await faceRepo.create({
            personnelId: created.id,
            imagePath: capturedImagePath,
            embedding: capturedEmbedding,
            createdAt: now,
            syncStatus: 'pending',
          });
        }
        await enqueueSyncStub();
      }

      navigation.goBack();
    } catch {
      setSnackMsg('Save failed. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleteDialogVisible(false);
    if (!personnelId) return;
    try {
      ImageStorageService.deleteByPersonnelId(personnelId);
      await personnelRepo.delete(personnelId);
      navigation.goBack();
    } catch {
      setSnackMsg('Delete failed. Please try again.');
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <TextInput
        label="Full Name"
        value={fullName}
        onChangeText={setFullName}
        style={styles.input}
        mode="outlined"
      />
      <TextInput
        label="Employee ID"
        value={employeeId}
        onChangeText={setEmployeeId}
        style={styles.input}
        mode="outlined"
      />
      <TextInput
        label="Role"
        value={role}
        onChangeText={setRole}
        style={styles.input}
        mode="outlined"
      />

      {hasPermission && device ? (
        <View style={styles.cameraContainer}>
          <Camera
            ref={cameraRef}
            style={styles.camera}
            device={device}
            isActive
            outputs={[photoOutput]}
          />
          <Button mode="contained" onPress={capturePhoto} style={styles.captureBtn}>
            Capture Photo
          </Button>
        </View>
      ) : (
        <View style={styles.cameraPlaceholder}>
          <Text>Camera permission required for photo capture.</Text>
          <Button onPress={requestPermission}>Grant Permission</Button>
        </View>
      )}

      {capturedImagePath ? (
        <Image
          source={{ uri: `file://${capturedImagePath}` }}
          style={styles.thumbnail}
          resizeMode="cover"
        />
      ) : null}

      <Button
        mode="contained"
        onPress={handleSave}
        loading={saving}
        disabled={saving}
        style={styles.saveBtn}
      >
        {isEditMode ? 'Save Changes' : 'Register Personnel'}
      </Button>

      {isEditMode ? (
        <Button
          mode="outlined"
          textColor="red"
          onPress={() => setDeleteDialogVisible(true)}
          style={styles.deleteBtn}
        >
          Delete
        </Button>
      ) : null}

      <Portal>
        <Dialog visible={deleteDialogVisible} onDismiss={() => setDeleteDialogVisible(false)}>
          <Dialog.Title>Delete Personnel</Dialog.Title>
          <Dialog.Content>
            <Text>This will permanently delete this record and all associated photos.</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeleteDialogVisible(false)}>Cancel</Button>
            <Button textColor="red" onPress={handleDelete}>Delete</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <Snackbar
        visible={Boolean(snackMsg)}
        onDismiss={() => setSnackMsg('')}
        duration={3000}
      >
        {snackMsg}
      </Snackbar>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, paddingBottom: 40 },
  input: { marginBottom: 12 },
  cameraContainer: { marginBottom: 12 },
  camera: { height: 240, borderRadius: 8 },
  captureBtn: { marginTop: 8 },
  cameraPlaceholder: {
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    backgroundColor: '#f0f0f0',
    borderRadius: 8,
  },
  thumbnail: { width: '100%', height: 160, borderRadius: 8, marginBottom: 12 },
  saveBtn: { marginBottom: 8 },
  deleteBtn: { borderColor: 'red' },
});
